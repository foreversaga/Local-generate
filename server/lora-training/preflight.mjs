import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { MODEL_FAMILIES, invalid, normalizeSlug, normalizeUuid } from './schema.mjs';
import { LORA_PATHS } from './paths.mjs';
import { datasetService } from './dataset.mjs';

function result(id, status, message, details) { return { id, status, message, ...(details ? { details } : {}) }; }

export function createPreflightService({
  dataset = datasetService,
  readCaptions,
  fetchImpl = globalThis.fetch,
  ollamaUrl = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434',
  ollamaModel = process.env.OLLAMA_CAPTION_MODEL ?? 'gemma4',
  checkTrainer = async () => ({ ok: false, message: 'trainer runtime adapter is not configured' }),
  resolveBaseModel = async () => null,
  paths = LORA_PATHS,
  clock = () => new Date(),
} = {}) {
  async function run(job, config = job?.config ?? {}) {
    if (!job) throw invalid('job is required');
    const jobId = normalizeUuid(job.id, 'jobId');
    const family = config.family ?? job.family;
    if (!MODEL_FAMILIES.includes(family)) throw invalid('family is unsupported', { allowed: MODEL_FAMILIES });
    const checks = [];
    let manifest;
    try {
      manifest = await dataset.readManifest(jobId);
      checks.push(result('dataset', manifest.images.length ? 'pass' : 'fail', manifest.images.length ? `${manifest.images.length} image(s) ready` : 'dataset is empty', { imageCount: manifest.images.length }));
    } catch (error) { checks.push(result('dataset', 'fail', error.message)); }

    try {
      const captions = typeof readCaptions === 'function' ? await readCaptions(jobId) : null;
      if (!captions) checks.push(result('captions', 'warning', 'caption reader adapter is not configured'));
      else {
        const ready = captions.records.filter((item) => ['ready', 'edited'].includes(item.status)).length;
        checks.push(result('captions', manifest && ready === manifest.images.length ? 'pass' : 'fail', `${ready}/${manifest?.images.length ?? 0} captions ready`, { ready }));
      }
    } catch (error) { checks.push(result('captions', 'fail', error.message)); }

    try {
      const response = await fetchImpl(new URL('/api/tags', ollamaUrl), { signal: AbortSignal.timeout(5000) });
      const payload = response.ok ? await response.json() : null;
      const models = Array.isArray(payload?.models) ? payload.models.map((item) => item.name ?? item.model) : [];
      const present = models.some((name) => name === ollamaModel || name?.startsWith(`${ollamaModel}:`));
      checks.push(result('ollama', response.ok && present ? 'pass' : 'fail', response.ok ? (present ? `model ${ollamaModel} is available` : `model ${ollamaModel} is missing`) : 'Ollama is unavailable', { endpoint: new URL(ollamaUrl).origin, model: ollamaModel }));
    } catch { checks.push(result('ollama', 'fail', 'Ollama is unavailable', { endpoint: new URL(ollamaUrl).origin, model: ollamaModel })); }

    try {
      const trainer = await checkTrainer({ job, config, family });
      checks.push(result('trainer', trainer?.ok ? 'pass' : 'fail', trainer?.message ?? (trainer?.ok ? 'trainer runtime ready' : 'trainer runtime unavailable'), trainer?.details));
    } catch (error) { checks.push(result('trainer', 'fail', error.message)); }

    try {
      const baseProfile = normalizeSlug(config.baseProfile, 'baseProfile');
      const baseModel = await resolveBaseModel({ family, baseProfile, job });
      checks.push(result('baseModel', baseModel ? 'pass' : 'fail', baseModel ? 'base model resolved' : 'base model could not be resolved', baseModel ? { baseProfile, ...baseModel } : { baseProfile }));
    } catch (error) { checks.push(result('baseModel', 'fail', error.message)); }

    try {
      await mkdir(paths.jobs, { recursive: true }); await access(paths.jobs, constants.R_OK | constants.W_OK);
      checks.push(result('output', 'pass', 'job output root is writable'));
    } catch { checks.push(result('output', 'fail', 'job output root is not writable')); }
    checks.push(result('family', MODEL_FAMILIES.includes(family) ? 'pass' : 'fail', `family ${family}`, { supported: MODEL_FAMILIES }));

    const status = checks.some((item) => item.status === 'fail') ? 'fail' : checks.some((item) => item.status === 'warning') ? 'warning' : 'pass';
    const fingerprint = createHash('sha256').update(JSON.stringify({ jobId, revision: job.revision, family, config, datasetRevision: manifest?.revision, checks: checks.map(({ id, status: checkStatus }) => [id, checkStatus]) })).digest('hex');
    return { status, checks, token: fingerprint, jobId, jobRevision: job.revision, checkedAt: clock().toISOString() };
  }
  return Object.freeze({ run });
}

export const preflightService = createPreflightService();
