import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { API_ERROR_CODES, LoraTrainingError, invalid, normalizeUuid } from './schema.mjs';
import { getJobPaths, LORA_PATHS, resolveSafeChild } from './paths.mjs';
import { atomicWriteJson, withStorageLock } from './store.mjs';

const TYPES = Object.freeze({
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
});

function datasetError(code, message, status, details) {
  return new LoraTrainingError(code, message, { status, details });
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
  return { dataset, images: path.join(dataset, 'images'), captions: path.join(dataset, 'captions'), manifest: path.join(dataset, 'manifest.json') };
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
    const sourceManifest = await readManifest(sourceId);
    const sourceLocations = locations(sourceId, paths);
    return importImages(destinationJobId, sourceManifest.images, {
      resolver: async (image) => ({ path: resolveSafeChild(sourceLocations.dataset, image.relativePath), fileName: image.fileName, mimeType: image.mimeType, assetId: image.sourceAssetId }),
    });
  }

  function getLocations(jobId) { return locations(normalizeUuid(jobId, 'jobId'), paths); }
  return Object.freeze({ readManifest, importImages, cloneDataset, getLocations, supportedMimeTypes: Object.freeze([...new Set(Object.values(TYPES))]) });
}

export const datasetService = createDatasetService();
