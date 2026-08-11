import path from 'node:path';
import { mkdir, open, readFile, readdir, rename, unlink, rmdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  API_ERROR_CODES,
  LoraTrainingError,
  normalizeJobCreate,
  normalizeJobPatch,
  normalizeJobRecord,
  normalizeRevision,
  normalizeUuid,
} from './schema.mjs';
import { ensureLoraTrainingLayout, getJobPaths, LORA_PATHS } from './paths.mjs';

const writeQueues = new Map();
const RENAME_RETRY_DELAYS_MS = Object.freeze([25, 75, 200, 500]);
const TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY']);

function storageError(message, cause, details = {}) {
  const mergedDetails = {
    ...details,
    ...(cause?.code && details.reason === undefined ? { reason: cause.code } : {}),
  };
  return new LoraTrainingError(API_ERROR_CODES.IO_ERROR, message, {
    status: 500,
    details: Object.keys(mergedDetails).length ? mergedDetails : undefined,
  });
}

function notFound(kind) {
  return new LoraTrainingError(API_ERROR_CODES.NOT_FOUND, `${kind} not found`, { status: 404 });
}

function conflict(actualRevision) {
  return new LoraTrainingError(API_ERROR_CODES.REVISION_CONFLICT, 'revision conflict', {
    status: 409,
    details: { actualRevision },
  });
}

export function withStorageLock(key, operation) {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(operation);
  const tracked = result.finally(() => {
    if (writeQueues.get(key) === tracked) writeQueues.delete(key);
  });
  writeQueues.set(key, tracked);
  // `finally()` creates a second promise.  If the operation rejects, that
  // tracker rejects too; consume it so callers can handle the original
  // result without Vinext's unhandled-rejection backstop terminating Node.
  void tracked.catch(() => {});
  return result;
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function renameWithRetry(tempPath, filePath, { renameImpl = rename, sleep = delay } = {}) {
  let attempts = 0;
  while (true) {
    attempts += 1;
    try {
      await renameImpl(tempPath, filePath);
      return attempts;
    } catch (error) {
      const canRetry = TRANSIENT_RENAME_ERRORS.has(error?.code) && attempts <= RENAME_RETRY_DELAYS_MS.length;
      if (!canRetry) {
        // Keep the original errno for API diagnostics, but do not mutate an
        // error supplied by a test double (or a frozen native error).
        let failure;
        try {
          failure = Object.assign(error, { _atomicRenameAttempts: attempts });
        } catch {
          failure = new Error(error?.message || 'rename failed', { cause: error });
          failure.code = error?.code;
          failure._atomicRenameAttempts = attempts;
        }
        throw failure;
      }
      await sleep(RENAME_RETRY_DELAYS_MS[attempts - 1]);
    }
  }
}

export async function atomicWriteJson(filePath, value, options = {}) {
  const directory = path.dirname(filePath);
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  let operation = 'open';
  let attempts = 0;
  try {
    handle = await open(tempPath, 'wx', 0o600);
    operation = 'write';
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    operation = 'sync';
    await handle.sync();
    operation = 'close';
    await handle.close();
    handle = undefined;
    operation = 'rename';
    attempts = await renameWithRetry(tempPath, filePath, options);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    throw storageError('Unable to persist LoRA training data', error, {
      retryable: true,
      operation,
      attempts: attempts || Number(error?._atomicRenameAttempts) || 1,
      target: path.basename(filePath),
    });
  }
}

async function readJson(filePath, kind) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') throw notFound(kind);
    throw storageError(`Unable to read ${kind}`, error);
  }
}

export function createJobStore({ paths = LORA_PATHS, clock = () => new Date(), idFactory = randomUUID } = {}) {
  const readJob = async (jobId) => {
    const id = normalizeUuid(jobId, 'jobId');
    let job;
    try {
      job = normalizeJobRecord(await readJson(getJobPaths(id, paths).state, 'job'));
    } catch (error) {
      if (error instanceof LoraTrainingError && error.code === API_ERROR_CODES.NOT_FOUND) throw error;
      if (error instanceof LoraTrainingError && error.code === API_ERROR_CODES.IO_ERROR) throw error;
      throw storageError('Stored job state is invalid');
    }
    if (job.id !== id) throw storageError('Stored job identity is invalid');
    return job;
  };

  const createJob = async (request) => {
    const job = normalizeJobCreate(request, { id: idFactory(), now: clock().toISOString() });
    const jobPaths = getJobPaths(job.id, paths);
    return withStorageLock(jobPaths.state, async () => {
      await ensureLoraTrainingLayout(paths);
      try {
        await readFile(jobPaths.state, 'utf8');
        throw new LoraTrainingError(API_ERROR_CODES.ALREADY_EXISTS, 'job already exists', { status: 409 });
      } catch (error) {
        if (error instanceof LoraTrainingError) throw error;
        if (error?.code !== 'ENOENT') throw storageError('Unable to check job state', error);
      }
      await mkdir(jobPaths.directory, { recursive: false }).catch((error) => {
        if (error?.code !== 'EEXIST') throw storageError('Unable to create job storage', error);
      });
      await atomicWriteJson(jobPaths.state, job);
      return structuredClone(job);
    });
  };

  const updateJob = async (jobId, patch, { expectedRevision } = {}) => {
    const id = normalizeUuid(jobId, 'jobId');
    const normalizedPatch = normalizeJobPatch(patch);
    const expected = normalizeRevision(expectedRevision, 'expectedRevision');
    const statePath = getJobPaths(id, paths).state;
    return withStorageLock(statePath, async () => {
      const current = await readJob(id);
      if (current.revision !== expected) throw conflict(current.revision);
      const next = normalizeJobRecord({
        ...current,
        ...normalizedPatch,
        id,
        revision: current.revision + 1,
        createdAt: current.createdAt,
        updatedAt: clock().toISOString(),
      });
      await atomicWriteJson(statePath, next);
      return structuredClone(next);
    });
  };

  const deleteJob = async (jobId, { expectedRevision } = {}) => {
    const id = normalizeUuid(jobId, 'jobId');
    const expected = normalizeRevision(expectedRevision, 'expectedRevision');
    const jobPaths = getJobPaths(id, paths);
    return withStorageLock(jobPaths.state, async () => {
      const current = await readJob(id);
      if (current.revision !== expected) throw conflict(current.revision);
      const tombstone = path.join(jobPaths.directory, `.job.json.deleted.${randomUUID()}`);
      try {
        await rename(jobPaths.state, tombstone);
        await unlink(tombstone);
        await rmdir(jobPaths.directory).catch((error) => {
          if (!['ENOTEMPTY', 'ENOENT'].includes(error?.code)) throw error;
        });
      } catch (error) {
        throw storageError('Unable to delete job', error);
      }
      return { id, revision: current.revision };
    });
  };

  const listJobs = async ({ status, family } = {}) => {
    await ensureLoraTrainingLayout(paths);
    let entries;
    try {
      entries = await readdir(paths.jobs, { withFileTypes: true });
    } catch (error) {
      throw storageError('Unable to list jobs', error);
    }
    const jobs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const job = await readJob(entry.name);
        if ((!status || job.status === status) && (!family || job.family === family)) jobs.push(job);
      } catch (error) {
        if (error instanceof LoraTrainingError && error.code === API_ERROR_CODES.INVALID_IDENTIFIER) continue;
        throw error;
      }
    }
    return jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map((job) => structuredClone(job));
  };

  return Object.freeze({ createJob, readJob, updateJob, deleteJob, listJobs });
}

export const jobStore = createJobStore();
