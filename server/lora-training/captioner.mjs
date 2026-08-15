import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { API_ERROR_CODES, LoraTrainingError, invalid, normalizeCaption, normalizeTriggerWords, normalizeUuid } from './schema.mjs';
import { resolveSafeChild } from './paths.mjs';
import { atomicWriteJson, withStorageLock } from './store.mjs';
import { datasetFingerprint, datasetService } from './dataset.mjs';
import { createOllamaCoordinator } from '../ollama-coordinator.mjs';

const DEFAULT_PROMPT = 'Describe this training image as concise comma-separated visual tags. Return only JSON with one string property named caption.';

function captionError(code, message, status, retryable, details) {
  const error = new LoraTrainingError(code, message, { status, details: { retryable, ...details } });
  error.retryable = retryable;
  return error;
}

async function atomicWriteText(filePath, value) {
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(`${value}\n`, 'utf8'); await handle.sync(); await handle.close(); handle = undefined;
    await rename(temp, filePath);
  } catch {
    if (handle) await handle.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw captionError(API_ERROR_CODES.IO_ERROR, 'unable to write caption sidecar', 500, true);
  }
}

function parseModelResponse(value) {
  if (!value || typeof value !== 'object' || typeof value.response !== 'string') throw captionError('OLLAMA_INVALID_RESPONSE', 'Ollama returned an invalid envelope', 502, true);
  let payload;
  try { payload = JSON.parse(value.response); } catch { throw captionError('CAPTION_SCHEMA_INVALID', 'caption model did not return JSON', 422, true); }
  if (!payload || Object.getPrototypeOf(payload) !== Object.prototype || Object.keys(payload).some((key) => key !== 'caption') || typeof payload.caption !== 'string') {
    throw captionError('CAPTION_SCHEMA_INVALID', 'caption JSON must contain only a caption string', 422, true);
  }
  return normalizeCaption(payload.caption);
}

function preserveTriggers(caption, triggerWords) {
  const missing = triggerWords.filter((word) => !caption.toLocaleLowerCase().includes(word.toLocaleLowerCase()));
  return normalizeCaption(missing.length ? `${triggerWords.join(', ')}, ${caption}` : caption);
}

function coordinatorPayload(value) {
  if (value && typeof value === 'object' && value.payload && typeof value.payload === 'object') return value.payload;
  if (value && typeof value === 'object' && typeof value.text === 'string') {
    try { return JSON.parse(value.text); } catch { return null; }
  }
  return value;
}

function captionFailure(error) {
  if (error instanceof LoraTrainingError) return error;
  if (error?.code === 'OLLAMA_UNLOAD_FAILED') {
    return captionError('OLLAMA_UNLOAD_FAILED', error.message || 'Ollama model unload failed', Number.isInteger(error.status) ? error.status : 503, true, {
      ...(error.details && typeof error.details === 'object' ? { coordinator: error.details } : {}),
    });
  }
  return captionError('OLLAMA_UNAVAILABLE', error?.message || 'Ollama caption request failed', 503, true, {
    ...(error?.code ? { upstreamCode: error.code } : {}),
    ...(error?.details && typeof error.details === 'object' ? { upstreamDetails: error.details } : {}),
  });
}

export function createCaptionService({ dataset = datasetService, fetchImpl = globalThis.fetch, ollamaCoordinator = null, commandRunner = null, ollamaUrl = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434', comfyUrl = '', remoteComfy = false, model = process.env.OLLAMA_CAPTION_MODEL ?? 'gemma4', prompt = DEFAULT_PROMPT, promptVersion = 'gemma4-v1', clock = () => new Date(), maxAttempts = 2, requestTimeoutMs = 120_000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  const coordinator = ollamaCoordinator ?? createOllamaCoordinator({ fetchImpl, ...(commandRunner ? { commandRunner } : {}) });
  if (typeof coordinator?.generate !== 'function') throw new TypeError('Ollama coordinator with generate() is required');
  const endpoint = new URL('/api/generate', ollamaUrl).toString();

  async function readCaptions(jobId) {
    const id = normalizeUuid(jobId, 'jobId');
    const filePath = path.join(dataset.getLocations(id).captions, 'manifest.json');
    try {
      const value = JSON.parse(await readFile(filePath, 'utf8'));
      if (!value || value.schemaVersion !== 1 || value.jobId !== id || !Array.isArray(value.records)) throw new Error('invalid');
      return value;
    } catch (error) {
      if (error?.code === 'ENOENT') return { schemaVersion: 1, jobId: id, revision: 0, records: [] };
      throw captionError(API_ERROR_CODES.IO_ERROR, 'caption manifest is invalid', 500, false);
    }
  }

  async function persistRecord(jobId, image, record) {
    const locations = dataset.getLocations(jobId);
    const manifestPath = path.join(locations.captions, 'manifest.json');
    return withStorageLock(manifestPath, async () => {
      const current = await readCaptions(jobId);
      const datasetManifest = await dataset.readManifest(jobId);
      const records = current.records.filter((item) => item.imageId !== image.id);
      records.push(record);
      await atomicWriteJson(manifestPath, {
        ...current,
        revision: current.revision + 1,
        datasetRevision: datasetManifest.revision,
        datasetFingerprint: datasetFingerprint(datasetManifest),
        updatedAt: clock().toISOString(),
        records,
      });
      return record;
    });
  }

  async function checkpoint(jobId) {
    const id = normalizeUuid(jobId, 'jobId');
    const [manifest, captions] = await Promise.all([dataset.readManifest(id), readCaptions(id)]);
    const images = manifest.images;
    const expected = new Map(images.map((image) => [image.id, image]));
    const seen = new Set();
    const records = captions.records;
    const completeRecords = records.length === images.length && records.every((record) => {
      const image = expected.get(record.imageId);
      if (!image || seen.has(record.imageId) || !['ready', 'edited'].includes(record.status)) return false;
      if (record.imageFile && record.imageFile !== image.fileName) return false;
      if (typeof record.caption !== 'string' || !record.caption.trim()) return false;
      seen.add(record.imageId);
      return true;
    }) && seen.size === images.length;
    const fingerprint = datasetFingerprint(manifest);
    const metadataMatches =
      (captions.datasetRevision === undefined || captions.datasetRevision === manifest.revision) &&
      (captions.datasetFingerprint === undefined || captions.datasetFingerprint === fingerprint);
    const failed = records.filter((record) => record.status === 'failed').length;
    return {
      complete: images.length > 0 && completeRecords && metadataMatches,
      records: structuredClone(records),
      total: images.length,
      failed,
      datasetRevision: manifest.revision,
      datasetFingerprint: fingerprint,
      legacy: captions.datasetRevision === undefined || captions.datasetFingerprint === undefined,
    };
  }

  async function generateOne(jobId, imageId, triggerWords, { attempts = maxAttempts, session = null } = {}) {
    const id = normalizeUuid(jobId, 'jobId');
    const triggers = normalizeTriggerWords(triggerWords);
    const manifest = await dataset.readManifest(id);
    const image = manifest.images.find((item) => item.id === normalizeUuid(imageId, 'imageId'));
    if (!image) throw captionError(API_ERROR_CODES.NOT_FOUND, 'dataset image not found', 404, false);
    let failure;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const bytes = await readFile(resolveSafeChild(dataset.getLocations(id).dataset, image.relativePath));
        const request = {
          body: {
            model,
            prompt: `${prompt}\nRequired trigger words: ${triggers.join(', ')}`,
            images: [bytes.toString('base64')],
            format: 'json',
            stream: false,
          },
          timeoutMs: requestTimeoutMs,
          requestFetch: fetchImpl,
        };
        const response = session
          ? await session.generate(request)
          : await coordinator.generate({ ollamaUrl, comfyUrl, remoteComfy, model, ...request });
        const caption = preserveTriggers(parseModelResponse(coordinatorPayload(response)), triggers);
        const record = { imageId: image.id, imageFile: image.fileName, status: 'ready', caption, model, promptVersion, attempts: attempt, updatedAt: clock().toISOString() };
        await atomicWriteText(resolveSafeChild(dataset.getLocations(id).captions, `${image.id}.txt`), caption);
        return persistRecord(id, image, record);
      } catch (error) {
        failure = captionFailure(error);
        if (failure.code === 'OLLAMA_UNLOAD_FAILED') break;
      }
    }
    const record = { imageId: image.id, imageFile: image.fileName, status: 'failed', caption: '', model, promptVersion, attempts, updatedAt: clock().toISOString(), error: { code: failure.code, message: failure.message, retryable: failure.retryable !== false } };
    await persistRecord(id, image, record);
    throw failure;
  }

  async function generate(jobId, triggerWords, { imageIds, onProgress = async () => {} } = {}) {
    const manifest = await dataset.readManifest(jobId);
    const selected = imageIds ? new Set(imageIds.map((id) => normalizeUuid(id, 'imageId'))) : null;
    const images = selected ? manifest.images.filter((image) => selected.has(image.id)) : manifest.images;
    if (!images.length) throw invalid('no dataset images selected for captioning');
    const results = [];
    let session = null;
    let primaryError = null;
    try {
      if (typeof coordinator.openModelSession === 'function') {
        session = await coordinator.openModelSession({ ollamaUrl, comfyUrl, remoteComfy, model, requestFetch: fetchImpl });
      }
      for (let index = 0; index < images.length; index += 1) {
        try { results.push(await generateOne(jobId, images[index].id, triggerWords, { session })); }
        catch (error) { results.push({ imageId: images[index].id, status: 'failed', error: { code: error.code ?? 'CAPTION_FAILED', message: error.message, retryable: error.retryable !== false } }); }
        await onProgress({ completed: index + 1, total: images.length, failed: results.filter((item) => item.status === 'failed').length });
      }
    } catch (error) {
      primaryError = captionFailure(error);
    }
    let cleanupError = null;
    if (session) {
      try { await session.close(); }
      catch (error) { cleanupError = captionFailure(error); }
    }
    if (primaryError) {
      if (cleanupError) {
        primaryError.details = {
          ...(primaryError.details && typeof primaryError.details === 'object' ? primaryError.details : {}),
          unloadError: { code: cleanupError.code, message: cleanupError.message },
        };
        primaryError.cause = cleanupError;
      }
      throw primaryError;
    }
    if (cleanupError) throw cleanupError;
    return { records: results, failed: results.filter((item) => item.status === 'failed').length };
  }

  async function edit(jobId, imageId, caption, triggerWords) {
    const id = normalizeUuid(jobId, 'jobId');
    const imageKey = normalizeUuid(imageId, 'imageId');
    const image = (await dataset.readManifest(id)).images.find((item) => item.id === imageKey);
    if (!image) throw captionError(API_ERROR_CODES.NOT_FOUND, 'dataset image not found', 404, false);
    const value = preserveTriggers(normalizeCaption(caption), normalizeTriggerWords(triggerWords));
    const current = (await readCaptions(id)).records.find((record) => record.imageId === imageKey);
    const record = { imageId: image.id, imageFile: image.fileName, status: 'edited', caption: value, model: current?.model ?? model, promptVersion: current?.promptVersion ?? promptVersion, attempts: current?.attempts ?? 0, updatedAt: clock().toISOString() };
    await atomicWriteText(resolveSafeChild(dataset.getLocations(id).captions, `${image.id}.txt`), value);
    return persistRecord(id, image, record);
  }

  return Object.freeze({ generate, generateOne, edit, readCaptions, checkpoint, endpoint, model });
}

export const captionService = createCaptionService();
