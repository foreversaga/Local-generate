import { API_ERROR_CODES, LoraTrainingError, invalid, normalizeRevision, normalizeTrainingFamily, normalizeUuid } from './schema.mjs';
import { jobStore } from './store.mjs';
import { datasetService } from './dataset.mjs';
import { captionService } from './captioner.mjs';
import { createPreflightService } from './preflight.mjs';

function apiError(error, fallbackCode = 'ORCHESTRATION_FAILED') {
  if (error instanceof LoraTrainingError) return error;
  return new LoraTrainingError(fallbackCode, error?.message || 'LoRA training operation failed', { status: 500, details: { retryable: false } });
}

function revisionConflict(actualRevision) {
  return new LoraTrainingError(API_ERROR_CODES.REVISION_CONFLICT, 'revision conflict', {
    status: 409,
    details: { actualRevision },
  });
}

function summary(records, total) {
  return { total, confirmed: records.filter((item) => ['ready', 'edited'].includes(item.status)).length, failed: records.filter((item) => item.status === 'failed').length };
}

const TOP_LEVEL_STATUSES = new Set(['draft', 'ready', 'queued', 'running', 'succeeded', 'failed', 'canceled']);
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'canceled']);
const ACTIVE_RETRY_STATUSES = new Set(['draft', 'ready', 'queued', 'running']);

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
    // A caller may intentionally observe the original rejection while the
    // tracker promise remains attached to the per-job queue.  Consume the
    // tracker rejection so Vinext's unhandled-rejection backstop cannot take
    // down the process when two requests race on one revision.
    void current.catch(() => {});
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

  async function markInterrupted(jobId, error) {
    if (error?.code !== API_ERROR_CODES.IO_ERROR) return;
    try {
      const current = await store.readJob(jobId);
      if (TERMINAL_STATUSES.has(current.status)) return;
      await mutate(jobId, 'failed', {
        status: 'failed',
        error: {
          code: 'TRAINING_INTERRUPTED',
          message: 'training state could not be persisted; retry is available',
          retryable: true,
          details: { cause: API_ERROR_CODES.IO_ERROR },
        },
      });
    } catch (persistError) {
      // The original IO error remains the request failure.  A second write
      // failure must never become an unhandled rejection or mask its cause.
      console.warn('[lora-training] unable to persist interrupted state', persistError?.message || persistError);
    }
  }

  async function create(request) {
    if (!request || typeof request !== 'object') throw invalid('job request must be an object');
    const family = normalizeTrainingFamily(request.family);
    const job = await store.createJob({
      slug: request.slug, displayName: request.displayName, family,
      captionReviewMode: request.captionReviewMode ?? 'auto', triggerWords: request.triggerWords,
      assetIds: request.assetIds ?? request.sourceAssetIds ?? [], config: { ...(request.config ?? {}), family },
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

  async function list(filters = {}) {
    const normalizedFilters = { ...filters };
    if (filters.family) normalizedFilters.family = normalizeTrainingFamily(filters.family);
    return store.listJobs(normalizedFilters);
  }

  async function createAndStart(request) {
    const created = await create(request);
    return start(created.job.id, { expectedRevision: created.job.revision });
  }

  async function runCaptioningInternal(jobId, { imageIds } = {}) {
    const checkpoint = typeof captions.checkpoint === 'function' ? await captions.checkpoint(jobId) : null;
    if (checkpoint?.complete) {
      const total = Number.isSafeInteger(checkpoint.total) ? checkpoint.total : (Array.isArray(checkpoint.records) ? checkpoint.records.length : 0);
      const outcome = { records: checkpoint.records ?? [], failed: 0, resumed: true };
      await mutate(jobId, 'captions_ready', {
        status: 'ready',
        progress: { stage: 'captioning', completed: total, total, failed: 0, resumed: true },
        error: null,
      });
      return outcome;
    }
    await mutate(jobId, 'captioning', { progress: { stage: 'captioning', completed: 0, ...(checkpoint?.total ? { total: checkpoint.total } : {}) } });
    const job = await store.readJob(jobId);
    const outcome = await captions.generate(job.id, job.triggerWords, {
      imageIds,
      onProgress: async (progress) => { await mutate(job.id, 'captioning', { progress: { stage: 'captioning', ...progress } }); },
    });
    const phase = outcome.failed ? 'caption_failed' : 'captions_ready';
    await mutate(job.id, phase, { status: outcome.failed ? 'failed' : 'ready', error: outcome.failed ? { code: 'CAPTION_FAILED', message: `${outcome.failed} caption(s) failed`, retryable: true } : null });
    return outcome;
  }

  async function runCaptioning(jobId, options = {}) {
    return serialized(normalizeUuid(jobId, 'jobId'), async () => {
      try {
        return await runCaptioningInternal(jobId, options);
      } catch (error) {
        await markInterrupted(jobId, error);
        throw apiError(error);
      }
    });
  }

  async function runPreflightInternal(jobId, { expectedRevision } = {}) {
    const job = await store.readJob(jobId);
    const expected = expectedRevision === undefined ? undefined : normalizeRevision(expectedRevision, 'expectedRevision');
    if (expected !== undefined && job.revision !== expected) throw revisionConflict(job.revision);
    if (['queued', 'running'].includes(job.status)) {
      throw new LoraTrainingError('ALREADY_QUEUED', 'job is already queued or running', { status: 409, details: { retryable: false, status: job.status, actualRevision: job.revision } });
    }
    const report = await preflightService.run(job, job.config);
    const next = await mutate(job.id, report.status === 'fail' ? 'preflight_failed' : 'preflight_ready', {
      status: report.status === 'fail' ? 'failed' : 'ready',
      preflight: report,
      error: report.status === 'fail' ? { code: 'PREFLIGHT_FAILED', message: 'preflight checks failed', retryable: true, details: { checks: report.checks.filter((item) => item.status === 'fail').map((item) => item.id) } } : null,
    });
    // Keep the legacy report shape while exposing the revision committed by
    // this preflight mutation.  HTTP callers can use it for the subsequent
    // enqueue instead of replaying the preflight request's stale revision.
    return { ...report, revision: next.revision };
  }

  async function runPreflight(jobId, options = {}) {
    return serialized(normalizeUuid(jobId, 'jobId'), async () => {
      try {
        return await runPreflightInternal(jobId, options);
      } catch (error) {
        await markInterrupted(jobId, error);
        throw apiError(error);
      }
    });
  }

  async function enqueueInternal(jobId, { expectedRevision, preflightToken } = {}) {
    if (!queue?.enqueue) throw new LoraTrainingError('QUEUE_UNAVAILABLE', 'training queue is not configured', { status: 503, details: { retryable: true } });
    let job = await store.readJob(jobId);
    if (expectedRevision !== undefined && job.revision !== normalizeRevision(expectedRevision)) throw revisionConflict(job.revision);
    if (['queued', 'running'].includes(job.status)) {
      throw new LoraTrainingError('ALREADY_QUEUED', 'job is already queued or running', { status: 409, details: { retryable: false, status: job.status, actualRevision: job.revision } });
    }
    if (['succeeded', 'canceled'].includes(job.status)) {
      throw new LoraTrainingError('QUEUE_NOT_ALLOWED', 'terminal jobs cannot be queued again', { status: 409, details: { retryable: false, status: job.status, actualRevision: job.revision } });
    }
    // Validate the current config again at the queue boundary.  This catches
    // edits made after a previously passing preflight instead of deferring an
    // unknown/unsupported parameter failure until trainer process startup.
    if (typeof preflightService.validateConfig === 'function') {
      await preflightService.validateConfig(job, job.config);
    }
    const report = job.config.orchestration?.preflight;
    if (!report || report.status === 'fail' || (preflightToken && report.token !== preflightToken)
      || (Number.isSafeInteger(report.jobRevision) && report.jobRevision + 1 !== job.revision)) {
      throw new LoraTrainingError('PREFLIGHT_REQUIRED', 'a passing preflight result is required for the current configuration', { status: 422, details: { retryable: true } });
    }
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
      try {
        await mutate(job.id, 'failed', { status: 'failed', error: { code: 'QUEUE_FAILED', message: error.message, retryable: true } });
      } catch (persistError) {
        console.warn('[lora-training] unable to persist queue failure', persistError?.message || persistError);
      }
      throw apiError(error, 'QUEUE_FAILED');
    }
  }

  async function enqueue(jobId, options = {}) {
    return serialized(normalizeUuid(jobId, 'jobId'), async () => {
      try {
        return await enqueueInternal(jobId, options);
      } catch (error) {
        await markInterrupted(jobId, error);
        throw apiError(error, 'QUEUE_FAILED');
      }
    });
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
      try {
        const initial = await store.readJob(jobId);
        if (expectedRevision !== undefined && initial.revision !== normalizeRevision(expectedRevision)) throw revisionConflict(initial.revision);
        if (['queued', 'running'].includes(initial.status)) {
          throw new LoraTrainingError('ALREADY_QUEUED', 'job is already queued or running', { status: 409, details: { retryable: false, status: initial.status, actualRevision: initial.revision } });
        }
        // `start` owns the per-job lock, so use internal stages here.  Calling
        // the public serialized wrappers would wait on this same lock.
        const outcome = await runCaptioningInternal(initial.id);
        if (outcome.failed) return get(initial.id);
        if (initial.captionReviewMode === 'manual') {
          await mutate(initial.id, 'caption_review', { progress: { stage: 'caption_review' } });
          return get(initial.id);
        }
        const report = await runPreflightInternal(initial.id);
        if (report.status === 'fail') return get(initial.id);
        return enqueueInternal(initial.id, { preflightToken: report.token });
      } catch (error) {
        await markInterrupted(jobId, error);
        throw apiError(error);
      }
    });
  }

  async function confirmCaptionsInternal(jobId, { expectedRevision } = {}) {
    const job = await store.readJob(jobId);
    if (expectedRevision !== undefined && job.revision !== normalizeRevision(expectedRevision)) throw revisionConflict(job.revision);
    if (['queued', 'running'].includes(job.status)) {
      throw new LoraTrainingError('ALREADY_QUEUED', 'job is already queued or running', { status: 409, details: { retryable: false, status: job.status, actualRevision: job.revision } });
    }
    const manifest = await dataset.readManifest(job.id); const records = (await captions.readCaptions(job.id)).records;
    if (summary(records, manifest.images.length).confirmed !== manifest.images.length) throw new LoraTrainingError('CAPTIONS_INCOMPLETE', 'all images require valid captions', { status: 422 });
    const report = await runPreflightInternal(job.id);
    return report.status === 'fail' ? get(job.id) : enqueueInternal(job.id, { preflightToken: report.token });
  }

  async function confirmCaptions(jobId, options = {}) {
    return serialized(normalizeUuid(jobId, 'jobId'), async () => {
      try {
        return await confirmCaptionsInternal(jobId, options);
      } catch (error) {
        await markInterrupted(jobId, error);
        throw apiError(error);
      }
    });
  }

  async function editCaptionInternal(jobId, imageId, caption, { expectedRevision } = {}) {
    const job = await store.readJob(jobId);
    if (expectedRevision !== undefined && job.revision !== normalizeRevision(expectedRevision)) throw revisionConflict(job.revision);
    if (['queued', 'running'].includes(job.status)) {
      throw new LoraTrainingError('ALREADY_QUEUED', 'job is already queued or running', { status: 409, details: { retryable: false, status: job.status, actualRevision: job.revision } });
    }
    const record = await captions.edit(job.id, imageId, caption, job.triggerWords);
    await mutate(job.id, 'caption_review', { error: null }); return record;
  }

  async function editCaption(jobId, imageId, caption, options = {}) {
    return serialized(normalizeUuid(jobId, 'jobId'), async () => {
      try {
        return await editCaptionInternal(jobId, imageId, caption, options);
      } catch (error) {
        await markInterrupted(jobId, error);
        throw apiError(error);
      }
    });
  }

  async function retryCaptionInternal(jobId, imageId, { expectedRevision } = {}) {
    const job = await store.readJob(jobId);
    if (expectedRevision !== undefined && job.revision !== normalizeRevision(expectedRevision, 'expectedRevision')) throw revisionConflict(job.revision);
    if (['queued', 'running'].includes(job.status)) {
      throw new LoraTrainingError('ALREADY_QUEUED', 'job is already queued or running', { status: 409, details: { retryable: false, status: job.status, actualRevision: job.revision } });
    }
    const record = await captions.generateOne(job.id, imageId, job.triggerWords);
    await mutate(job.id, 'caption_review', { error: null }); return record;
  }

  async function retryCaption(jobId, imageId, options = {}) {
    return serialized(normalizeUuid(jobId, 'jobId'), async () => {
      try {
        return await retryCaptionInternal(jobId, imageId, options);
      } catch (error) {
        await markInterrupted(jobId, error);
        throw apiError(error);
      }
    });
  }

  async function cancelInternal(jobId) {
    const job = await store.readJob(jobId);
    if (['succeeded', 'canceled'].includes(job.status)) return get(job.id);
    const accepted = await queue?.cancel?.(job.id);
    await mutate(job.id, 'cancelled', { status: 'canceled', cancelAccepted: Boolean(accepted), error: null });
    return get(job.id);
  }

  async function cancel(jobId) {
    return serialized(normalizeUuid(jobId, 'jobId'), async () => {
      try {
        return await cancelInternal(jobId);
      } catch (error) {
        await markInterrupted(jobId, error);
        throw apiError(error, 'QUEUE_FAILED');
      }
    });
  }

  async function retry(jobId) {
    return serialized(normalizeUuid(jobId, 'jobId'), async () => {
      const source = await store.readJob(jobId);
      const activePosition = typeof queue?.position === 'function' ? queue.position(source.id) : null;
      if (!['failed', 'canceled'].includes(source.status) || activePosition !== null && activePosition !== undefined) {
        throw new LoraTrainingError('RETRY_NOT_ALLOWED', 'only failed or canceled jobs that are no longer queued can be retried', {
          status: 409,
          details: { retryable: false, status: source.status },
        });
      }

      if (typeof store.listJobs === 'function') {
        const existing = (await store.listJobs()).filter((job) =>
          job?.provenance?.retryOf === source.id && ACTIVE_RETRY_STATUSES.has(job.status),
        ).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0];
        if (existing) {
          if (existing.status === 'draft' || existing.status === 'ready') {
            const existingPosition = typeof queue?.position === 'function' ? queue.position(existing.id) : null;
            if (existingPosition !== null && existingPosition !== undefined) return get(existing.id);
            return start(existing.id, { expectedRevision: existing.revision });
          }
          return get(existing.id);
        }
      }

      const previousAttempt = Number(source.provenance?.attempt ?? source.config?.orchestration?.attempt ?? 0);
      const attempt = Number.isSafeInteger(previousAttempt) && previousAttempt >= 0 ? previousAttempt + 1 : 1;
      // Keep stable dataset/caption revision metadata and other config
      // provenance, but never carry a stale execution checkpoint into the
      // new attempt.  `start()` will create a fresh preflight token for the
      // cloned dataset.
      const retryOrchestration = { ...(source.config?.orchestration ?? {}) };
      for (const key of ['phase', 'preflight', 'progress', 'error', 'artifact', 'queuePosition', 'startedAt', 'finishedAt']) delete retryOrchestration[key];
      const created = await store.createJob({
        ...source,
        id: undefined,
        revision: undefined,
        status: 'draft',
        provenance: { ...source.provenance, retryOf: source.id, attempt },
        config: {
          ...source.config,
          orchestration: { ...retryOrchestration, phase: 'draft', retryOf: source.id, attempt },
        },
      });
      try {
        await dataset.cloneDataset(source.id, created.id);

        // A retry must follow the same caption/preflight/queue path as a new
        // job.  In particular, do not reuse the source preflight token: its
        // fingerprint is bound to the source job id and revision.
        return await start(created.id, { expectedRevision: created.revision });
      } catch (error) {
        await markInterrupted(created.id, error);
        throw error;
      }
    });
  }

  async function onQueueStateChange(event) {
    const jobId = normalizeUuid(event.jobId, 'jobId');
    const operation = () => {
      const status = event.status === 'running' ? 'running' : event.status === 'succeeded' ? 'succeeded' : event.status === 'canceled' ? 'canceled' : event.status === 'failed' ? 'failed' : 'queued';
      return mutate(jobId, event.status, (current) => {
        const existing = current.config.orchestration ?? {};
        const incomingProgress = event.progress ?? { stage: event.status };
        const { artifact: progressArtifact, ...progressFields } = incomingProgress;
        const artifact = event.artifact ?? progressArtifact ?? existing.artifact;
        const failure = event.error
          ? (typeof event.error === 'object' ? event.error : { message: event.error })
          : null;
        return {
          status,
          progress: { ...(existing.progress ?? {}), ...progressFields },
          ...(artifact ? { artifact } : {}),
          error: failure ? {
            code: failure.code ?? 'TRAINING_FAILED',
            message: String(failure.message ?? 'training failed'),
            retryable: failure.retryable !== undefined ? Boolean(failure.retryable) : true,
            ...(failure.details && typeof failure.details === 'object' ? { details: failure.details } : {}),
          } : null,
        };
      });
    };
    // Queue notifications can be awaited from inside enqueue/cancel. If the
    // same job is already under an API lock, enqueue non-terminal updates
    // behind that operation without awaiting the lock recursively (which
    // deadlocks). Terminal updates are awaited by the queue so drain() cannot
    // resolve before the final job status is persisted.
    if (locks.has(jobId)) {
      const pending = serialized(jobId, operation);
      if (TERMINAL_STATUSES.has(event.status) && !event.queueCancel) return pending;
      void pending.catch((error) => {
        console.warn('[lora-training] queue state update failed', error?.message || error);
      });
      return undefined;
    }
    return serialized(jobId, operation);
  }

  return Object.freeze({ create, createAndStart, get, list, start, runCaptioning, editCaption, retryCaption, confirmCaptions, runPreflight, enqueue, cancel, retry, onQueueStateChange });
}

export const loraTrainingController = createLoraTrainingController();
