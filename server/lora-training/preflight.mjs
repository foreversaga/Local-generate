import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { API_ERROR_CODES, LoraTrainingError, MODEL_FAMILIES, invalid, normalizeSlug, normalizeUuid } from './schema.mjs';
import { LORA_PATHS } from './paths.mjs';
import { datasetService } from './dataset.mjs';
import { TRAINING_PARAMETER_ALIASES, TRAINING_PARAMETER_KEYS, resolveTrainingParameters } from './presets.mjs';
import { Z_IMAGE_BASE_PROFILE, Z_IMAGE_PARAMETER_ALIASES, Z_IMAGE_PARAMETER_KEYS } from './backends/z-image-ai-toolkit.mjs';

function result(id, status, message, details) { return { id, status, message, ...(details ? { details } : {}) }; }

export function createPreflightService({
  dataset = datasetService,
  readCaptions,
  fetchImpl = globalThis.fetch,
  ollamaUrl = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434',
  ollamaModel = process.env.OLLAMA_CAPTION_MODEL ?? 'gemma4',
  checkTrainer = async () => ({ ok: false, message: 'trainer runtime adapter is not configured' }),
  checkArtifactTarget = async () => ({ ok: true, status: 'warning', message: 'artifact target checker is not configured' }),
  checkTrainingData,
  resolveBaseModel = async () => null,
  paths = LORA_PATHS,
  presetOptions = {},
  clock = () => new Date(),
} = {}) {
  function configError(error) {
    const rawMessage = typeof error?.message === 'string' && error.message
      ? error.message
      : 'training configuration is invalid';
    const message = error?.code && ['ENOENT', 'EACCES', 'EPERM'].includes(error.code)
      || /(?:ENOENT|EACCES|no such file|cannot read|unexpected token)/i.test(rawMessage)
      ? 'selected training preset could not be loaded'
      : rawMessage.replace(/(?:[A-Za-z]:\\|\/)[^\s,;]+/g, '[redacted path]').slice(0, 240);
    const parameterMatch = rawMessage.match(/parameter is not allowed:\s*([A-Za-z][A-Za-z0-9]*)/i)
      ?? rawMessage.match(/training parameter conflict:\s*([A-Za-z][A-Za-z0-9]*)/i)
      ?? rawMessage.match(/^([A-Za-z][A-Za-z0-9]*)\s+(?:must|is)\b/i);
    const field = parameterMatch?.[1];
    const suggestion = field
      ? `Update ${field} to a supported value or remove it.`
      : 'Choose a supported preset and training parameter values.';
    return new LoraTrainingError(API_ERROR_CODES.INVALID_REQUEST, `training configuration is invalid: ${message} ${suggestion}`, {
      status: 422,
      details: {
        retryable: true,
        ...(field ? { field } : {}),
        suggestion,
        allowedParameters: TRAINING_PARAMETER_KEYS,
        aliases: TRAINING_PARAMETER_ALIASES,
      },
    });
  }

  async function validateConfig(job, config = job?.config ?? {}) {
    if (!job) throw invalid('job is required');
    const family = config.family ?? job.family;
    if (!MODEL_FAMILIES.includes(family)) throw invalid('family is unsupported', { allowed: MODEL_FAMILIES });
    const preset = config.presetId ?? config.preset ?? family;
    try {
      const zImage = family === 'z-image';
      const zImageConfig = {
        ...config,
        ...(config.aiToolkit ?? {}),
        ...(config.zImage ?? {}),
        ...(config.zImageConfig ?? {}),
      };
      if (zImage && config.baseProfile !== Z_IMAGE_BASE_PROFILE) {
        throw new TypeError('baseProfile must be z-image-turbo for z-image training');
      }
      if (zImage && Object.hasOwn(zImageConfig, 'epochs')) {
        throw new TypeError('epochs is not supported by AI Toolkit Z-Image; use steps');
      }
      const zDirectParameters = Object.fromEntries(Object.keys(zImageConfig)
        .filter((key) => Z_IMAGE_PARAMETER_KEYS.includes(key) || Object.hasOwn(Z_IMAGE_PARAMETER_ALIASES, key))
        .map((key) => [key, zImageConfig[key]]));
      const resolved = await resolveTrainingParameters({
        preset,
        family,
        parameters: zImage
          ? { ...zImageConfig.parameters, ...zImageConfig.overrides, ...zDirectParameters, ...config.overrides, ...config.parameters }
          : (config.overrides ?? config.parameters ?? {}),
      }, presetOptions);
      return Object.freeze({
        presetId: resolved.preset,
        selectedPreset: resolved.selectedPreset,
        parameters: resolved.parameters,
        values: resolved.values,
      });
    } catch (error) {
      throw configError(error);
    }
  }

  async function run(job, config = job?.config ?? {}) {
    if (!job) throw invalid('job is required');
    const jobId = normalizeUuid(job.id, 'jobId');
    const family = config.family ?? job.family;
    if (!MODEL_FAMILIES.includes(family)) throw invalid('family is unsupported', { allowed: MODEL_FAMILIES });
    const resolvedConfig = await validateConfig(job, config);
    const checks = [];
    let manifest;
    let datasetLayoutFingerprint;
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

    const zImage = family === 'z-image';
    if (zImage && typeof checkTrainingData === 'function') {
      try {
        const layout = await checkTrainingData({ job, config, family });
        if (layout) {
          datasetLayoutFingerprint = layout.datasetFingerprint;
          checks.push(result('datasetLayout', layout.ok ? 'pass' : 'fail', layout.ok
            ? `${layout.imageCount} image/caption pair(s) ready for AI Toolkit`
            : (layout.message ?? 'AI Toolkit training data directory is unavailable'),
          layout.ok ? {
            imageCount: layout.imageCount, captionCount: layout.captionCount,
            captionExtension: layout.captionExtension ?? '.txt', folderPath: layout.folderPath,
            ...(layout.datasetFingerprint === undefined ? {} : { datasetFingerprint: layout.datasetFingerprint }),
          } : { code: layout.code }));
        }
      } catch (error) { checks.push(result('datasetLayout', 'fail', error.message)); }
    } else if (!zImage && typeof dataset.inspectTrainerLayout === 'function') {
      // The Studio stores images and captions in separate canonical splits,
      // while sd-scripts discovers DreamBooth data only from immediate
      // `<repeats>_<class_tokens>` subdirectories.  Validate the pair contract
      // before queueing so a passing 39/39 split cannot reach a trainer with an
      // empty subset.  Materialization itself remains in the dispatch path.
      try {
        const layout = await dataset.inspectTrainerLayout(jobId, {
          triggerWords: job.triggerWords,
          classTokens: config.classTokens ?? config.classToken,
          repeats: config.trainingRepeats ?? config.repeats,
          captionExtension: resolvedConfig.values.captionExtension ?? '.txt',
        });
        checks.push(result('datasetLayout', layout.ok ? 'pass' : 'fail', layout.ok ? `${layout.imageCount} image/caption pair(s) ready for DreamBooth` : (layout.message ?? 'trainer dataset layout is unavailable'), layout.ok ? {
          imageCount: layout.imageCount, captionCount: layout.captionCount, repeats: layout.repeats,
          classTokens: layout.classTokens, subset: layout.subset, captionExtension: layout.captionExtension,
        } : { code: layout.code }));
      } catch (error) { checks.push(result('datasetLayout', 'fail', error.message)); }
    }

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
      const artifactTarget = await checkArtifactTarget({ job, config, family, resolvedConfig });
      const targetStatus = artifactTarget?.status === 'warning'
        ? 'warning'
        : artifactTarget?.ok
          ? 'pass'
          : 'fail';
      checks.push(result('artifactTarget', targetStatus, artifactTarget?.message ?? (artifactTarget?.ok ? 'artifact target is ready' : 'artifact target is unavailable'), artifactTarget?.details));
    } catch (error) { checks.push(result('artifactTarget', 'fail', error.message)); }

    try {
      await mkdir(paths.jobs, { recursive: true }); await access(paths.jobs, constants.R_OK | constants.W_OK);
      checks.push(result('output', 'pass', 'job output root is writable'));
    } catch { checks.push(result('output', 'fail', 'job output root is not writable')); }
    checks.push(result('family', MODEL_FAMILIES.includes(family) ? 'pass' : 'fail', `family ${family}`, { supported: MODEL_FAMILIES }));

    const status = checks.some((item) => item.status === 'fail') ? 'fail' : checks.some((item) => item.status === 'warning') ? 'warning' : 'pass';
    const fingerprint = createHash('sha256').update(JSON.stringify({
      jobId, revision: job.revision, family, config, datasetRevision: manifest?.revision,
      datasetLayoutFingerprint,
      checks: checks.map(({ id, status: checkStatus }) => [id, checkStatus]),
    })).digest('hex');
    return {
      status,
      checks,
      token: fingerprint,
      jobId,
      jobRevision: job.revision,
      checkedAt: clock().toISOString(),
      resolvedConfig,
    };
  }
  return Object.freeze({ run, validateConfig });
}

export const preflightService = createPreflightService();
