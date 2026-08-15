import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ensureDataDirs,
  jobsRoot,
  sequenceAssemblyDir,
  sequenceEventsFile,
  sequenceJobDir,
  sequenceJobFile,
  sequenceSegmentDir,
  sequenceSegmentFile,
  sequenceSegmentsDir,
  sequenceAttemptFile,
  sequenceAttemptsDir,
} from "./paths.mjs";
import { createSequenceRecord, LongVideoError, newId, sanitizeAssetRef } from "./schema.mjs";

const writes = new Map();
const RENAME_RETRY_DELAYS_MS = Object.freeze([25, 75, 200, 500]);
const TRANSIENT_RENAME_ERRORS = new Set(["EPERM", "EBUSY", "ENOTEMPTY"]);

function jsonText(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

function sanitizeForStorage(value, key = "") {
  if (Array.isArray(value)) return value.map((item) => sanitizeForStorage(item, key));
  if (!value || typeof value !== "object") return value;
  if (key === "inputAsset" || key === "outputAsset" || key === "finalAsset" || key === "rawAsset" || key === "normalizedAsset" || key === "tailAsset") return sanitizeAssetRef(value);
  const result = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (["outputPath", "finalPath", "rawPath", "normalizedPath", "tailPath", "fullPath", "path", "url", "filename", "stack", "token", "base64"].includes(childKey)) continue;
    result[childKey] = sanitizeForStorage(childValue, childKey);
  }
  return result;
}

function redactEventValue(value, key = "") {
  const normalizedKey = key.toLowerCase();
  if (normalizedKey.includes("token") || normalizedKey.includes("base64") || normalizedKey === "prompt") return undefined;
  if (Array.isArray(value)) return value.map((item) => redactEventValue(item, key));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const redacted = redactEventValue(childValue, childKey);
    if (redacted !== undefined) result[childKey] = redacted;
  }
  return result;
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function renameWithRetry(tempPath, filePath, { renameImpl = fs.rename, sleep = delay } = {}) {
  let attempts = 0;
  while (true) {
    attempts += 1;
    try {
      await renameImpl(tempPath, filePath);
      return attempts;
    } catch (error) {
      const canRetry = TRANSIENT_RENAME_ERRORS.has(error?.code) && attempts <= RENAME_RETRY_DELAYS_MS.length;
      if (!canRetry) {
        // Preserve the native errno while exposing the bounded-attempt count
        // to the caller's diagnostics.  Test doubles may provide frozen
        // errors, so fall back to a wrapper when mutation is unavailable.
        let failure;
        try {
          failure = Object.assign(error, { _atomicRenameAttempts: attempts });
        } catch {
          failure = new Error(error?.message || "rename failed", { cause: error });
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
  await fs.mkdir(directory, { recursive: true });
  const temp = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}.tmp`);
  await fs.writeFile(temp, jsonText(value), "utf8");
  try {
    await renameWithRetry(temp, filePath, options);
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

async function serial(filePath, operation) {
  const previous = writes.get(filePath) || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  const tracked = next.finally(() => {
    if (writes.get(filePath) === tracked) writes.delete(filePath);
  });
  writes.set(filePath, tracked);
  // Callers intentionally observe `next` (for example to preserve a 409
  // revision-conflict response).  The tracker created by finally() mirrors
  // that rejection; consume it so Vinext's unhandled-rejection backstop does
  // not terminate the process after the caller handles the original error.
  void tracked.catch(() => {});
  return next;
}

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function readJob(id) {
  return readJson(sequenceJobFile(id), null);
}

export async function getJob(id) {
  const job = await readJob(id);
  if (!job) throw new LongVideoError("SEQUENCE_NOT_FOUND", `Sequence not found: ${id}`, 404);
  return sanitizeForStorage(job);
}

export async function listJobs() {
  await ensureDataDirs();
  const entries = await fs.readdir(jobsRoot(), { withFileTypes: true }).catch(() => []);
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const job = await readJob(entry.name).catch(() => null);
    if (job) jobs.push(job);
  }
  return jobs.sort((left, right) => String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt)));
}

export async function createJob(input, { id = newId("seq"), now = new Date().toISOString() } = {}) {
  const job = createSequenceRecord(input, { id, now });
  await fs.mkdir(sequenceSegmentsDir(id), { recursive: true });
  await fs.mkdir(sequenceAssemblyDir(id), { recursive: true });
  await atomicWriteJson(sequenceJobFile(id), sanitizeForStorage(job));
  for (let index = 0; index < job.segments.length; index += 1) {
    await atomicWriteJson(sequenceSegmentFile(id, index), sanitizeForStorage(job.segments[index]));
  }
  await appendEvent(id, {
    level: "info",
    event: "sequence.created",
    sequenceId: id,
    stage: job.status,
  });
  return job;
}

export async function saveJob(job, { expectedRevision } = {}) {
  if (!job?.id) throw new LongVideoError("SEQUENCE_INVALID", "Sequence id is required.");
  return serial(sequenceJobFile(job.id), async () => {
    const current = await readJob(job.id);
    if (expectedRevision !== undefined && current && current.revision !== expectedRevision) {
      throw new LongVideoError("REVISION_CONFLICT", "Sequence was changed by another request.", 409, { expectedRevision, actualRevision: current.revision });
    }
    const next = {
      ...job,
      revision: Math.max(1, Number(current?.revision || job.revision || 0) + (current ? 1 : 0)),
      updatedAt: new Date().toISOString(),
    };
    const persisted = sanitizeForStorage(next);
    await atomicWriteJson(sequenceJobFile(job.id), persisted);
    if (Array.isArray(next.segments)) {
      await fs.mkdir(sequenceSegmentsDir(job.id), { recursive: true });
      for (let index = 0; index < next.segments.length; index += 1) await atomicWriteJson(sequenceSegmentFile(job.id, index), sanitizeForStorage(next.segments[index]));
    }
    return persisted;
  });
}

export async function updateJob(id, patchOrUpdater, { expectedRevision } = {}) {
  return saveJob(
    await (async () => {
      const current = await getJob(id);
      const patch = typeof patchOrUpdater === "function" ? await patchOrUpdater(current) : patchOrUpdater;
      return { ...current, ...(patch || {}) };
    })(),
    { expectedRevision },
  );
}

export async function updateSegment(id, index, patchOrUpdater, options = {}) {
  return updateJob(id, async (job) => {
    if (!job.segments?.[index]) throw new LongVideoError("SEGMENT_NOT_FOUND", `Segment not found: ${index}`, 404);
    const current = job.segments[index];
    const patch = typeof patchOrUpdater === "function" ? await patchOrUpdater(current, job) : patchOrUpdater;
    const segments = job.segments.map((segment, currentIndex) => currentIndex === Number(index) ? { ...segment, ...(patch || {}) } : segment);
    return { ...job, segments, timeline: segments };
  }, options);
}

export async function appendEvent(id, event) {
  const entry = redactEventValue({
    timestamp: new Date().toISOString(),
    level: event.level || "info",
    event: event.event || "sequence.event",
    sequenceId: id,
    ...event,
  });
  const line = JSON.stringify(entry) + "\n";
  await serial(sequenceEventsFile(id), async () => {
    await fs.mkdir(sequenceJobDir(id), { recursive: true });
    await fs.appendFile(sequenceEventsFile(id), line, "utf8");
  });
  // A concise copy in the project log makes startup/API failures diagnosable
  // without reading every job directory. The per-job JSONL remains canonical.
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const logFile = path.join(path.dirname(jobsRoot()), "..", "logs", `long-video-${date}.jsonl`);
  await fs.mkdir(path.dirname(logFile), { recursive: true }).catch(() => {});
  await fs.appendFile(logFile, line, "utf8").catch(() => {});
  if (process.env.H3_LONG_VIDEO_LOG_STDOUT !== "0") console.info("[long-video]", entry.event, entry.sequenceId, entry.segmentIndex ?? "");
  return entry;
}

export async function writeAssemblyJson(id, value) {
  const filePath = path.join(sequenceAssemblyDir(id), "assembly.json");
  await atomicWriteJson(filePath, sanitizeForStorage(value));
  return filePath;
}

export async function writeAttempt(id, index, attempt, value) {
  const filePath = sequenceAttemptFile(id, index, attempt);
  await fs.mkdir(sequenceAttemptsDir(id, index), { recursive: true });
  await atomicWriteJson(filePath, sanitizeForStorage(value));
  return filePath;
}

export async function writeSequenceManifest(outputFolder, sequence) {
  const filePath = path.join(outputFolder, ".h3-sequence.json");
  await atomicWriteJson(filePath, sanitizeForStorage(sequence));
  return filePath;
}

export async function readEvents(id) {
  const contents = await fs.readFile(sequenceEventsFile(id), "utf8").catch(() => "");
  return contents.split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return { level: "error", event: "log.invalid_json", raw: line }; }
  });
}

export { sequenceJobDir, sequenceSegmentDir };

export const writeJsonAtomic = atomicWriteJson;
export const createSequence = createJob;
export const getSequence = getJob;
export const listSequences = listJobs;
export const updateSequence = updateJob;
