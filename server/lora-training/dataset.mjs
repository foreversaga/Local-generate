import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { API_ERROR_CODES, LoraTrainingError, invalid, normalizeUuid } from './schema.mjs';
import { getJobPaths, LORA_PATHS, resolveSafeChild } from './paths.mjs';
import { atomicWriteJson, withStorageLock } from './store.mjs';

const TYPES = Object.freeze({
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
});

// sd-scripts' DreamBooth loader discovers subsets from directories named
// `<repeats>_<class_tokens>`.  Keep this contract in one place instead of
// leaking the Studio split layout into the trainer adapter.
export const DEFAULT_TRAINING_REPEATS = 1;
export const MAX_TRAINING_REPEATS = 1000;
export const TRAINER_CAPTION_EXTENSION = '.txt';

function datasetError(code, message, status, details) {
  return new LoraTrainingError(code, message, { status, details });
}

export function normalizeTrainingRepeats(value = DEFAULT_TRAINING_REPEATS) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TRAINING_REPEATS) {
    throw datasetError('INVALID_TRAINING_REPEATS', `training repeats must be an integer from 1 through ${MAX_TRAINING_REPEATS}`, 422, { minimum: 1, maximum: MAX_TRAINING_REPEATS });
  }
  return value;
}

function safeClassTokens(value) {
  const source = Array.isArray(value) ? value.find((item) => typeof item === 'string' && item.trim()) : value;
  const normalized = String(source ?? 'class').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const slug = normalized.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 64);
  return slug || 'class';
}

function normalizeCaptionExtension(value = TRAINER_CAPTION_EXTENSION) {
  if (typeof value !== 'string' || !/^\.[a-z0-9]{1,8}$/i.test(value)) {
    throw datasetError('INVALID_CAPTION_EXTENSION', 'caption extension is invalid', 422);
  }
  const normalized = value.toLowerCase();
  if (normalized !== TRAINER_CAPTION_EXTENSION) {
    throw datasetError('CAPTION_EXTENSION_UNSUPPORTED', 'DreamBooth materialization requires .txt captions', 422, { captionExtension: TRAINER_CAPTION_EXTENSION });
  }
  return normalized;
}

// The fingerprint deliberately covers only the immutable image identity and
// content fields.  It is shared with caption checkpoints so a caption file
// cannot be reused after the dataset has changed.
export function datasetFingerprint(manifest) {
  const images = Array.isArray(manifest?.images) ? manifest.images.map((image) => ({
    id: image.id,
    fileName: image.fileName,
    relativePath: image.relativePath,
    sha256: image.sha256,
    sizeBytes: image.sizeBytes,
  })) : [];
  return createHash('sha256').update(JSON.stringify(images)).digest('hex');
}

function extensionFor(fileName, mimeType) {
  const extension = path.extname(String(fileName ?? '')).toLowerCase();
  if (!TYPES[extension] || (mimeType && TYPES[extension] !== String(mimeType).toLowerCase())) {
    throw datasetError('UNSUPPORTED_IMAGE', 'image format is unsupported', 415, { fileName, allowed: Object.keys(TYPES) });
  }
  return extension === '.jpeg' ? '.jpg' : extension;
}

async function verifyMagic(filePath, extension) {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    const valid = extension === '.jpg' ? bytes[0] === 0xff && bytes[1] === 0xd8 :
      extension === '.png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) :
      extension === '.webp' ? bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' :
      extension === '.gif' ? ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)) :
      extension === '.bmp' ? bytes.toString('ascii', 0, 2) === 'BM' : false;
    if (!valid) throw datasetError('INVALID_IMAGE', 'image content does not match its extension', 415);
  } finally { await handle.close(); }
}

function locations(jobId, paths) {
  const job = getJobPaths(jobId, paths);
  const dataset = resolveSafeChild(job.directory, 'dataset');
  return {
    dataset,
    images: path.join(dataset, 'images'),
    captions: path.join(dataset, 'captions'),
    manifest: path.join(dataset, 'manifest.json'),
    trainer: resolveSafeChild(job.directory, 'trainer-data'),
  };
}

async function readManifestFile(filePath, jobId) {
  try {
    const value = JSON.parse(await readFile(filePath, 'utf8'));
    if (!value || value.schemaVersion !== 1 || value.jobId !== jobId || !Array.isArray(value.images)) throw new Error('invalid manifest');
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return { schemaVersion: 1, jobId, revision: 0, images: [] };
    throw datasetError(API_ERROR_CODES.IO_ERROR, 'dataset manifest is invalid', 500);
  }
}

async function readCaptionManifest(filePath, jobId) {
  try {
    const value = JSON.parse(await readFile(filePath, 'utf8'));
    if (!value || value.schemaVersion !== 1 || value.jobId !== jobId || !Array.isArray(value.records)) throw new Error('invalid caption manifest');
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return { schemaVersion: 1, jobId, revision: 0, records: [] };
    throw datasetError(API_ERROR_CODES.IO_ERROR, 'caption manifest is invalid', 500);
  }
}

async function regularFile(filePath, label) {
  try {
    const stat = await lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw datasetError('UNSAFE_DATASET_FILE', `${label} must be a regular file`, 422);
    return stat;
  } catch (error) {
    if (error instanceof LoraTrainingError) throw error;
    if (error?.code === 'ENOENT') throw datasetError('DATASET_FILE_MISSING', `${label} is missing`, 422);
    throw datasetError(API_ERROR_CODES.IO_ERROR, `unable to inspect ${label}`, 500, { reason: error?.code });
  }
}

async function readTrainerEntries(target, jobId) {
  const manifest = await readManifestFile(target.manifest, jobId);
  if (!manifest.images.length) throw datasetError('DATASET_EMPTY', 'dataset is empty', 422);
  const captions = await readCaptionManifest(path.join(target.captions, 'manifest.json'), jobId);
  const records = new Map(captions.records.map((record) => [record.imageId, record]));
  const entries = [];
  for (const image of manifest.images) {
    if (!image || typeof image.id !== 'string' || typeof image.relativePath !== 'string') {
      throw datasetError('DATASET_MANIFEST_INVALID', 'dataset image metadata is invalid', 422);
    }
    const source = resolveSafeChild(target.dataset, image.relativePath);
    await regularFile(source, 'dataset image');
    const extension = extensionFor(image.fileName ?? source, image.mimeType);
    const record = records.get(image.id);
    if (!record || !['ready', 'edited'].includes(record.status) || typeof record.caption !== 'string' || !record.caption.trim()) {
      throw datasetError('CAPTIONS_INCOMPLETE', 'all dataset images require a non-empty caption before training', 422, { imageId: image.id });
    }
    entries.push({ image, source, extension, caption: record.caption.trim() });
  }
  return { manifest, entries };
}

function trainerLayoutOptions({ triggerWords, classTokens, repeats = DEFAULT_TRAINING_REPEATS, captionExtension = TRAINER_CAPTION_EXTENSION } = {}) {
  const normalizedRepeats = normalizeTrainingRepeats(repeats);
  const normalizedClassTokens = safeClassTokens(classTokens ?? triggerWords);
  const normalizedCaptionExtension = normalizeCaptionExtension(captionExtension);
  return {
    repeats: normalizedRepeats,
    classTokens: normalizedClassTokens,
    captionExtension: normalizedCaptionExtension,
    subset: `${normalizedRepeats}_${normalizedClassTokens}`,
  };
}

export function createDatasetService({ paths = LORA_PATHS, resolveSource, maxImages = 10_000, maxImageBytes = 100 * 1024 * 1024, clock = () => new Date() } = {}) {
  async function readManifest(jobId) {
    const id = normalizeUuid(jobId, 'jobId');
    return structuredClone(await readManifestFile(locations(id, paths).manifest, id));
  }

  async function importImages(jobId, inputs, { resolver = resolveSource } = {}) {
    const id = normalizeUuid(jobId, 'jobId');
    if (!Array.isArray(inputs) || inputs.length < 1) throw invalid('images must be a non-empty array');
    if (typeof resolver !== 'function') throw new TypeError('resolveSource callback is required');
    const target = locations(id, paths);
    return withStorageLock(target.manifest, async () => {
      await mkdir(target.images, { recursive: true });
      await mkdir(target.captions, { recursive: true });
      const current = await readManifestFile(target.manifest, id);
      if (current.images.length + inputs.length > maxImages) throw datasetError('DATASET_TOO_LARGE', 'dataset image limit exceeded', 413, { maxImages });
      const additions = [];
      const created = [];
      try {
        for (const input of inputs) {
          const source = await resolver(input);
          if (!source || typeof source.path !== 'string') throw invalid('image resolver returned an invalid source');
          const stat = await lstat(source.path);
          if (!stat.isFile() || stat.isSymbolicLink()) throw invalid('image source must be a regular file');
          if (stat.size < 1 || stat.size > maxImageBytes) throw datasetError('IMAGE_TOO_LARGE', 'image size is invalid', 413, { maxImageBytes });
          const extension = extensionFor(source.fileName ?? input?.fileName ?? source.path, source.mimeType);
          await verifyMagic(source.path, extension);
          const imageId = randomUUID();
          const relativePath = `images/${imageId}${extension}`;
          const destination = resolveSafeChild(target.dataset, relativePath);
          await copyFile(source.path, destination);
          created.push(destination);
          const bytes = await readFile(destination);
          additions.push({
            id: imageId, fileName: path.basename(destination), relativePath,
            sourceAssetId: source.assetId ?? input?.assetId ?? null,
            sourceName: path.basename(String(source.fileName ?? input?.fileName ?? source.path)),
            mimeType: TYPES[extension], sizeBytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'), importedAt: clock().toISOString(),
          });
        }
        const next = { ...current, revision: current.revision + 1, updatedAt: clock().toISOString(), images: [...current.images, ...additions] };
        await atomicWriteJson(target.manifest, next);
        return structuredClone(next);
      } catch (error) {
        await Promise.all(created.map((file) => unlink(file).catch(() => {})));
        throw error;
      }
    });
  }

  async function cloneDataset(sourceJobId, destinationJobId) {
    const sourceId = normalizeUuid(sourceJobId, 'sourceJobId');
    const destinationId = normalizeUuid(destinationJobId, 'destinationJobId');
    const sourceManifest = await readManifest(sourceId);
    const sourceLocations = locations(sourceId, paths);
    const destinationManifest = await importImages(destinationId, sourceManifest.images, {
      resolver: async (image) => ({ path: resolveSafeChild(sourceLocations.dataset, image.relativePath), fileName: image.fileName, mimeType: image.mimeType, assetId: image.sourceAssetId }),
    });

    // A retry should be able to resume a completed caption checkpoint.  Image
    // ids are regenerated by importImages, so remap caption records and their
    // optional sidecars by source-image order.  Missing/invalid source
    // captions are intentionally ignored; the normal caption path will fill
    // them in and the clone remains usable.
    const sourceCaptionPath = path.join(sourceLocations.captions, 'manifest.json');
    let sourceCaptions = null;
    try {
      const value = JSON.parse(await readFile(sourceCaptionPath, 'utf8'));
      if (value?.schemaVersion === 1 && value.jobId === sourceId && Array.isArray(value.records)) sourceCaptions = value;
    } catch (error) {
      if (error?.code !== 'ENOENT') sourceCaptions = null;
    }
    if (!sourceCaptions) return destinationManifest;

    const sourceToDestination = new Map(sourceManifest.images.map((image, index) => [image.id, destinationManifest.images[index]]));
    const records = sourceCaptions.records.flatMap((record) => {
      const image = sourceToDestination.get(record.imageId);
      if (!image) return [];
      return [{ ...record, imageId: image.id, imageFile: image.fileName }];
    });
    const destinationLocations = locations(destinationId, paths);
    await mkdir(destinationLocations.captions, { recursive: true });
    const destinationCaptionPath = path.join(destinationLocations.captions, 'manifest.json');
    await withStorageLock(destinationCaptionPath, async () => {
      await atomicWriteJson(destinationCaptionPath, {
        schemaVersion: 1,
        jobId: destinationId,
        revision: Number.isSafeInteger(sourceCaptions.revision) ? sourceCaptions.revision : records.length,
        datasetRevision: destinationManifest.revision,
        datasetFingerprint: datasetFingerprint(destinationManifest),
        updatedAt: clock().toISOString(),
        records,
      });
    });
    await Promise.all(records.map(async (record) => {
      // Records above have already been remapped, so look up the original
      // image id by destination id before copying its sidecar.
      const sourceImage = sourceManifest.images.find((image) => sourceToDestination.get(image.id)?.id === record.imageId);
      if (!sourceImage) return;
      const originalSidecar = resolveSafeChild(sourceLocations.captions, `${sourceImage.id}.txt`);
      const destinationSidecar = resolveSafeChild(destinationLocations.captions, `${record.imageId}.txt`);
      await copyFile(originalSidecar, destinationSidecar).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
    }));
    return destinationManifest;
  }

  /**
   * Check the canonical split layout without creating trainer files.  This is
   * intentionally separate from materialization so preflight cannot leave a
   * partially refreshed staging tree behind.
   */
  async function inspectTrainerLayout(jobId, options = {}) {
    const id = normalizeUuid(jobId, 'jobId');
    try {
      const layout = trainerLayoutOptions(options);
      const { manifest, entries } = await readTrainerEntries(locations(id, paths), id);
      return {
        ok: true,
        imageCount: entries.length,
        captionCount: entries.length,
        datasetRevision: manifest.revision,
        repeats: layout.repeats,
        classTokens: layout.classTokens,
        subset: layout.subset,
        captionExtension: layout.captionExtension,
      };
    } catch (error) {
      if (error instanceof LoraTrainingError) return { ok: false, code: error.code, message: error.message, details: error.details };
      return { ok: false, code: API_ERROR_CODES.IO_ERROR, message: 'unable to inspect trainer dataset layout' };
    }
  }

  /**
   * Materialize the Studio split dataset into the immediate DreamBooth
   * directory structure expected by sd-scripts.  The canonical images and
   * captions are read-only here; a completed staging tree replaces the old
   * generated tree as one directory rename, so retries are idempotent and
   * stale files cannot leak into a later attempt.
   */
  async function materializeTrainerDataset(jobId, options = {}) {
    const id = normalizeUuid(jobId, 'jobId');
    const target = locations(id, paths);
    const job = getJobPaths(id, paths);
    return withStorageLock(target.trainer, async () => {
      const layout = trainerLayoutOptions(options);
      const { manifest, entries } = await readTrainerEntries(target, id);
      const stage = resolveSafeChild(job.directory, `.trainer-data-stage-${randomUUID()}`);
      const subset = resolveSafeChild(stage, layout.subset);
      const backup = resolveSafeChild(job.directory, `.trainer-data-backup-${randomUUID()}`);
      let movedOld = false;
      let installed = false;
      try {
      await mkdir(subset, { recursive: true });
      for (const { image, source, extension, caption } of entries) {
        // Image ids are generated UUIDs, so using them as names avoids source
        // filename collisions while retaining the original extension.
        const imageName = `${image.id}${extension}`;
        const imageTarget = resolveSafeChild(subset, imageName);
        const captionTarget = resolveSafeChild(subset, `${image.id}${layout.captionExtension}`);
        await copyFile(source, imageTarget);
        await writeFile(captionTarget, `${caption}\n`, { encoding: 'utf8', mode: 0o600 });
      }

      // A generated tree must never be a symlink/junction supplied by a
      // caller.  Refuse it before moving anything, preserving the old tree.
      try {
        const existing = await lstat(target.trainer);
        if (existing.isSymbolicLink() || !existing.isDirectory()) throw datasetError('UNSAFE_TRAINER_DATASET', 'trainer dataset root is not a regular directory', 422);
        await rename(target.trainer, backup);
        movedOld = true;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      await rename(stage, target.trainer);
      installed = true;
      if (movedOld) await rm(backup, { recursive: true, force: true }).catch(() => {});
        return {
          root: target.trainer,
          subset: layout.subset,
          imageCount: entries.length,
          captionCount: entries.length,
          datasetRevision: manifest.revision,
          repeats: layout.repeats,
          classTokens: layout.classTokens,
          captionExtension: layout.captionExtension,
        };
      } catch (error) {
        if (movedOld && !installed) {
          await rename(backup, target.trainer).catch(() => {});
        }
        if (error instanceof LoraTrainingError) throw error;
        throw datasetError('TRAINER_DATASET_MATERIALIZE_FAILED', 'unable to materialize trainer dataset', 500, { reason: error?.code });
      } finally {
        // These paths are generated inside the job directory and never point at
        // canonical dataset files.  Cleanup failures must not mask the original
        // materialization error.
        await rm(stage, { recursive: true, force: true }).catch(() => {});
        if (installed || movedOld) await rm(backup, { recursive: true, force: true }).catch(() => {});
      }
    });
  }

  function getLocations(jobId) { return locations(normalizeUuid(jobId, 'jobId'), paths); }
  return Object.freeze({
    readManifest, importImages, cloneDataset, getLocations,
    inspectTrainerLayout, materializeTrainerDataset,
    supportedMimeTypes: Object.freeze([...new Set(Object.values(TYPES))]),
  });
}

export const datasetService = createDatasetService();
