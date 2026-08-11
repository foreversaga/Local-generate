import { API_ERROR_CODES, LoraTrainingError, invalid, normalizeRevision, normalizeUuid } from './schema.mjs';
import { jobStore } from './store.mjs';
import { datasetService } from './dataset.mjs';
import { captionService } from './captioner.mjs';
import { createPreflightService } from './preflight.mjs';

function apiError(error, fallbackCode = 'ORCHESTRATION_FAILED') {
  if (error instanceof LoraTrainingError) return error;
  return new LoraTrainingError(fallbackCode, error?.message || 'LoRA training operation failed', { status: 500, details: { retryable: false } });
}

function summary(records, total) {
  return { total, confirmed: records.filter((item) => ['ready', 'edited'].includes(item.status)).length, failed: records.filter((item) => item.status === 'failed').length };
}

const TOP_LEVEL_STATUSES = new Set(['draft', 'ready', 'queued', 'running', 'succeeded', 'failed', 'canceled']);

export function createLoraTrainingController({
  store = jobStore,
  dataset = datasetService,
  captions = captionService,
  preflight,
  queue,
  resolveSource,
  now = () => new Date(),
} = {}) {
  const preflightService = preflight ?? createPreflightService({ dataset, readCaptions: captions.readCaptions });
  const locks = new Map();

  function serialized(jobId, operation) {
    const previous = locks.get(jobId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation).finally(() => { if (locks.get(jobId) === current) locks.delete(jobId); });
    locks.set(jobId, current);
    return current;
  }

  async function mutate(jobId, operation, patch = {}) {
    const current = await store.readJob(jobId);
    const resolvedPatch = typeof patch === 'function' ? patch(current) : patch;
    const { status, ...orchestrationPatch } = resolvedPatch;
    if (status !== undefined && !TOP_LEVEL_STATUSES.has(status)) throw invalid('top-level job status is unsupported');
    const orchestration = { ...(current.config.orchestration ?? {}), ...orchestrationPatch, phase: operation, updatedAt: now().toISOString() };
    return store.updateJob(jobId, { ...(status === undefined ? {} : { status }), config: { ...current.config, orchestration } }, { expectedRevision: current.revision });
  }

  async function create(request) {
    if (!request || typeof request !== 'object') throw invalid('job request must be an object');
    const job = await store.createJob({
      slug: request.slug, displayName: request.displayName, family: request.family,
      captionReviewMode: request.captionReviewMode ?? 'auto', triggerWords: request.triggerWords,
      assetIds: request.assetIds ?? request.sourceAssetIds ?? [], config: { ...(request.config ?? {}), family: request.family },
      provenance: { ...(request.provenance ?? {}), sourceAssets: request.assetIds ?? request.sourceAssetIds ?? [] },
    });
    if (request.images?.length) await dataset.importImages(job.id, request.images, { resolver: resolveSource });
    else if ((request.assetIds ?? request.sourceAssetIds)?.length) await dataset.importImages(job.id, (request.assetIds ?? request.sourceAssetIds).map((assetId) => ({ assetId })), { resolver: resolveSource });
    return get(job.id);
  }

  async function get(jobId) {
    const job = await store.readJob(jobId);
    const [manifest, captionManifest] = await Promise.all([dataset.readManifest(job.id), captions.readCaptions(job.id)]);
    return { job, dataset: manifest, captions: summary(captionManifest.records, manifest.images.length), queuePosition: queue?.position?.(job.id) ?? null };
  }

  async function list(filters = {}) { return store.listJobs(filters); }

  async function createAndStart(request) {
    const created = await create(request);
    return start(created.job.id, { expectedRevision: created.job.revision });
  }

  async function runCaptioning(jobId, { imageIds } = {}) {
    await mutate(jobId, 'captioning', { progress: { stage: 'captioning', completed: 0 } });
    const job = await store.readJob(jobId);
    const outcome = await captions.generate(job.id, job.triggerWords, {
      imageIds,
      onProgress: async (progress) => { await mutate(job.id, 'captioning', { progress: { stage: 'captioning', ...progress } }); },
    });
    const phase = outcome.failed ? 'caption_failed' : 'captions_ready';
    await mutate(job.id, phase, { status: outcome.failed ? 'failed' : 'ready', error: outcome.failed ? { code: 'CAPTION_FAILED', message: `${outcome.failed} caption(s) failed`, retryable: true } : null });
    return outcome;
  }

  async function runPreflight(jobId) {
    const job = await store.readJob(jobId);
    const report = await preflightService.run(job, job.config);
    await mutate(job.id, report.status === 'fail' ? 'preflight_failed' : 'preflight_ready', {
      status: report.status === 'fail' ? 'failed' : 'ready',
      preflight: report,
      error: report.status === 'fail' ? { code: 'PREFLIGHT_FAILED', message: 'preflight checks failed', retryable: true, details: { checks: report.checks.filter((item) => item.status === 'fail').map((item) => item.id) } } : null,
    });
    return report;
  }

  async function enqueue(jobId, { expectedRevision, preflightToken } = {}) {
    if (!queue?.enqueue) throw new LoraTrainingError('QUEUE_UNAVAILABLE', 'training queue is not configured', { status: 503, details: { retryable: true } });
    let job = await store.readJob(jobId);
    if (expectedRevision !== undefined && job.revision !== normalizeRevision(expectedRevision)) throw new LoraTrainingError(API_ERROR_CODES.REVISION_CONFLICT, 'revision conflict', { status: 409, details: { actualRevision: job.revision } });
    const report = job.config.orchestration?.preflight;
    if (!report || report.status === 'fail' || (preflightToken && report.token !== preflightToken)) throw new LoraTrainingError('PREFLIGHT_REQUIRED', 'a passing preflight result is required', { status: 422, details: { retryable: true } });
    job = await mutate(job.id, 'queued', { status: 'queued', queuedAt: now().toISOString(), error: null });
    try {
      // Delay queue execution until the final queue-position mutation has
      // committed.  Otherwise the background running notification can read
      // the same revision and race this write.
      const position = await queue.enqueue(job.id, { revision: job.revision, config: job.config }, { autoDrain: false });
      await mutate(job.id, 'queued', { queuePosition: position });
      startQueueDrain();
      return get(job.id);
    } catch (error) {
      await mutate(job.id, 'failed', { status: 'failed', error: { code: 'QUEUE_FAILED', message: error.message, retryable: true } });
      throw apiError(error, 'QUEUE_FAILED');
    }
  }

  function startQueueDrain() {
    const starter = typeof queue?.start === 'function' ? queue.start.bind(queue) : typeof queue?.drain === 'function' ? queue.drain.bind(queue) : null;
    if (!starter) return;
    try {
      const pending = starter();
      if (pending && typeof pending.catch === 'function') void pending.catch(() => {});
    } catch {
      // The queue owns background error reporting.  Keep HTTP enqueue success
      // independent from a later drain scheduling failure.
    }
  }

  async function start(jobId, { expectedRevision } = {}) {
    return serialized(normalizeUuid(jobId, 'jobId'), async () => {
      const initial = await store.readJob(jobId);
      if (expectedRevision !== undefined && initial.revision !== normalizeRevision(expectedRevision)) throw new LoraTrainingError(API_ERROR_CODES.REVISION_CONFLICT, 'revision conflict', { status: 409, details: { actualRevision: initial.revision } });
      const outcome = await runCaptioning(initial.id);
      if (outcome.failed) return get(initial.id);
      if (initial.captionReviewMode === 'manual') {
        await mutate(initial.id, 'caption_review', { progress: { stage: 'caption_review' } });
        return get(initial.id);
      }
      const report = await runPreflight(initial.id);
      if (report.status === 'fail') return get(initial.id);
      return enqueue(initial.id, { preflightToken: report.token });
    });
  }

  async function confirmCaptions(jobId, { expectedRevision } = {}) {
    const job = await store.readJob(jobId);
    if (expectedRevision !== undefined && job.revision !== normalizeRevision(expectedRevision)) throw new LoraTrainingError(API_ERROR_CODES.REVISION_CONFLICT, 'revision conflict', { status: 409, details: { actualRevision: job.revision } });
    const manifest = await dataset.readManifest(job.id); const records = (await captions.readCaptions(job.id)).records;
    if (summary(records, manifest.images.length).confirmed !== manifest.images.length) throw new LoraTrainingError('CAPTIONS_INCOMPLETE', 'all images require valid captions', { status: 422 });
    const report = await runPreflight(job.id);
    return report.status === 'fail' ? get(job.id) : enqueue(job.id, { preflightToken: report.token });
  }

  async function editCaption(jobId, imageId, caption, { expectedRevision } = {}) {
    const job = await store.readJob(jobId);
    if (expectedRevision !== undefined && job.revision !== normalizeRevision(expectedRevision)) throw new LoraTrainingError(API_ERROR_CODES.REVISION_CONFLICT, 'revision conflict', { status: 409, details: { actualRevision: job.revision } });
    const record = await captions.edit(job.id, imageId, caption, job.triggerWords);
    await mutate(job.id, 'caption_review', { error: null }); return record;
  }

  async function retryCaption(jobId, imageId) {
    const job = await store.readJob(jobId); const record = await captions.generateOne(job.id, imageId, job.triggerWords);
    await mutate(job.id, 'caption_review', { error: null }); return record;
  }

  async function cancel(jobId) {
    const job = await store.readJob(jobId);
    if (['succeeded', 'canceled'].includes(job.status)) return get(job.id);
    const accepted = await queue?.cancel?.(job.id);
    await mutate(job.id, 'cancelled', { status: 'canceled', cancelAccepted: Boolean(accepted), error: null });
    return get(job.id);
  }

  async function retry(jobId) {
    const source = await store.readJob(jobId);
    const created = await store.createJob({ ...source, id: undefined, revision: undefined, status: 'draft', provenance: { ...source.provenance, retryOf: source.id }, config: { ...source.config, orchestration: { phase: 'draft', retryOf: source.id } } });
    await dataset.cloneDataset(source.id, created.id);
    return get(created.id);
  }

  async function onQueueStateChange(event) {
    const status = event.status === 'running' ? 'running' : event.status === 'succeeded' ? 'succeeded' : event.status === 'canceled' ? 'canceled' : event.status === 'failed' ? 'failed' : 'queued';
    return mutate(event.jobId, event.status, (current) => {
      const existing = current.config.orchestration ?? {};
      const incomingProgress = event.progress ?? { stage: event.status };
      const { artifact: progressArtifact, ...progressFields } = incomingProgress;
      const artifact = event.artifact ?? progressArtifact ?? existing.artifact;
      return {
        status,
        progress: { ...(existing.progress ?? {}), ...progressFields },
        ...(artifact ? { artifact } : {}),
        error: event.error ? { code: 'TRAINING_FAILED', message: event.error, retryable: true } : null,
      };
    });
  }

  return Object.freeze({ create, createAndStart, get, list, start, runCaptioning, editCaption, retryCaption, confirmCaptions, runPreflight, enqueue, cancel, retry, onQueueStateChange });
}

export const loraTrainingController = createLoraTrainingController();
