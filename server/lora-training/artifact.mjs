import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { open, copyFile, link, unlink, stat } from 'node:fs/promises';
import { createReadStream, constants } from 'node:fs';
import { pipeline } from 'node:stream/promises';

const MAX_HEADER_BYTES = 16 * 1024 * 1024;
const COPY_RETRY_DELAYS_MS = Object.freeze([25, 75, 200, 500]);
const WINDOWS_TRANSIENT_COPY_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES']);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function errorCode(error) {
  return error?.code ?? (error?.errno === undefined ? 'UNKNOWN' : String(error.errno));
}

function copyFailure(error, { platform, attempts }) {
  const code = errorCode(error);
  const failure = new Error(error?.message || 'artifact staging copy failed', { cause: error });
  failure.name = 'ArtifactCopyFailure';
  failure.code = code;
  failure.details = {
    retryable: platform === 'win32' && WINDOWS_TRANSIENT_COPY_ERRORS.has(code),
    operation: 'copy',
    phase: 'artifact-staging',
    attempts,
    reason: code,
  };
  failure.retryable = failure.details.retryable;
  return failure;
}

async function copyWithRetry(source, temporary, {
  copy,
  remove,
  platform = process.platform,
  sleep = delay,
} = {}) {
  let attempts = 0;
  while (true) {
    attempts += 1;
    try {
      await copy(source, temporary, constants.COPYFILE_EXCL);
      return;
    } catch (error) {
      const code = errorCode(error);
      const canRetry = platform === 'win32'
        && WINDOWS_TRANSIENT_COPY_ERRORS.has(code)
        && attempts <= COPY_RETRY_DELAYS_MS.length;
      if (!canRetry) throw copyFailure(error, { platform, attempts });
      // A failed Windows copy can leave a partial destination behind.  The
      // temp name is unique to this install, so best-effort cleanup is safe;
      // the outer finally remains responsible for the final cleanup attempt.
      await remove(temporary).catch(() => {});
      await sleep(COPY_RETRY_DELAYS_MS[attempts - 1]);
    }
  }
}

export async function validateSafetensors(filePath, { openFile = open, fileStat = stat } = {}) {
  const details = await fileStat(filePath);
  if (!details.isFile() || details.size <= 12) throw new Error('artifact is empty or too small');
  const handle = await openFile(filePath, 'r');
  try {
    const prefix = Buffer.alloc(8);
    const prefixRead = await handle.read(prefix, 0, 8, 0);
    if (prefixRead.bytesRead !== 8) throw new Error('artifact has a truncated safetensors header');
    const headerLength = Number(prefix.readBigUInt64LE(0));
    if (!Number.isSafeInteger(headerLength) || headerLength < 2 || headerLength > MAX_HEADER_BYTES || 8 + headerLength >= details.size) {
      throw new Error('artifact has an invalid safetensors header length');
    }
    const header = Buffer.alloc(headerLength);
    const headerRead = await handle.read(header, 0, headerLength, 8);
    if (headerRead.bytesRead !== headerLength) throw new Error('artifact has a truncated safetensors header');
    let metadata;
    try { metadata = JSON.parse(header.toString('utf8').trim()); }
    catch { throw new Error('artifact has invalid safetensors metadata'); }
    const tensors = Object.entries(metadata).filter(([name]) => name !== '__metadata__');
    const dataBytes = details.size - 8 - headerLength;
    if (!tensors.length || !tensors.every(([, value]) => {
      if (!value || !Array.isArray(value.shape) || !value.shape.every((item) => Number.isSafeInteger(item) && item >= 0) ||
          !Array.isArray(value.data_offsets) || value.data_offsets.length !== 2) return false;
      const [start, end] = value.data_offsets;
      return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && end <= dataBytes;
    })) {
      throw new Error('artifact contains no valid tensor metadata');
    }
    return { size: details.size, tensorCount: tensors.length };
  } finally {
    await handle.close();
  }
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

export async function installTrainingArtifact({
  job,
  source,
  targetDirectory,
  fileName,
  registerArtifact,
  copy = copyFile,
  publish = link,
  remove = unlink,
  platform = process.platform,
  sleep = delay,
} = {}) {
  if (job?.status !== 'succeeded') throw new Error('only succeeded jobs may install artifacts');
  if (typeof registerArtifact !== 'function') throw new TypeError('registerArtifact callback is required');
  await validateSafetensors(source);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.safetensors$/i.test(fileName ?? '')) throw new TypeError('artifact fileName is invalid');
  const target = path.join(path.resolve(targetDirectory), fileName);
  const temporary = path.join(path.resolve(targetDirectory), `.${fileName}.${randomUUID()}.tmp`);
  let published = false;
  try {
    await copyWithRetry(source, temporary, { copy, remove, platform, sleep });
    const validated = await validateSafetensors(temporary);
    const digest = await sha256(temporary);
    // A same-volume hard-link is an atomic, exclusive publish: it cannot replace an existing target.
    await publish(temporary, target);
    published = true;
    await remove(temporary);
    const record = { jobId: job.id, path: target, fileName, sha256: digest, size: validated.size, tensorCount: validated.tensorCount };
    try { await registerArtifact(cloneRecord(record)); }
    catch (error) {
      await remove(target).catch(() => {});
      throw error;
    }
    return record;
  } finally {
    if (!published) await remove(temporary).catch(() => {});
  }
}

function cloneRecord(record) {
  return structuredClone(record);
}
