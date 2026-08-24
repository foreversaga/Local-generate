import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WINDOWS_RENAME_RETRY_DELAYS_MS = Object.freeze([5, 10, 20, 40, 80]);
const WINDOWS_TRANSIENT_RENAME_ERRORS = new Set(["EACCES", "EBUSY", "ENOTEMPTY", "EPERM"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const DEFAULT_MAX_TERMINAL_JOBS = 100;
const writes = new Map();

function defaultRoot() {
  return path.resolve(
    process.env.MINIMAX_H3_SINGLE_VIDEO_DATA_ROOT
      || path.join(PROJECT_ROOT, "data", "jobs", "single-video"),
  );
}

function jsonText(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

function safeId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(id)) {
    const error = new Error("Single Video job id is invalid.");
    error.code = "SINGLE_VIDEO_JOB_ID_INVALID";
    error.status = 400;
    throw error;
  }
  return id;
}

function inside(root, candidate) {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  return absoluteCandidate === absoluteRoot || absoluteCandidate.startsWith(absoluteRoot + path.sep);
}

function safeRelative(value, { allowEmpty = true } = {}) {
  if (value === null || value === undefined || value === "") return allowEmpty ? "" : null;
  const normalized = String(value).replaceAll("\\", "/").trim();
  const segments = normalized.split("/");
  if (
    !normalized
    || normalized.startsWith("/")
    || /^[A-Za-z]:/.test(normalized)
    || normalized.includes("\0")
    || segments.some((segment) => !segment || segment === "." || segment === ".." || /[<>:"|?*]/.test(segment))
    || Array.from(normalized).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) return allowEmpty ? "" : null;
  return normalized;
}

function safeText(value, fallback = "") {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  return text
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/((?:token|secret|password|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s,;]+/g, "[redacted path]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000) || fallback;
}

function safePrompt(value) {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  return text
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/((?:token|secret|password|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s,;]+/g, "[redacted path]")
    .trim()
    .slice(0, 20000);
}

function safeTimestamp(value) {
  const text = typeof value === "string" ? value : "";
  return text && !Number.isNaN(Date.parse(text)) ? text : null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function integerOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  return Number.isInteger(Number(value)) ? Number(value) : null;
}

function safeAssetRef(value) {
  if (typeof value === "string") {
    const name = safeRelative(value, { allowEmpty: false });
    return name ? { root: "input", name } : null;
  }
  if (!value || typeof value !== "object") return null;
  const name = safeRelative(value.name, { allowEmpty: false });
  if (!name) return null;
  const root = ["input", "output"].includes(value.root) ? value.root : "input";
  return { root, name };
}

function safeInputRefs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (Array.isArray(child)) {
      result[key] = child.map((item) => typeof item === "string"
        ? safeRelative(item, { allowEmpty: false })
        : safeAssetRef(item)?.name || "").filter(Boolean);
      continue;
    }
    if (typeof child === "string") {
      const name = safeRelative(child, { allowEmpty: false });
      if (name) result[key] = name;
      continue;
    }
    const ref = safeAssetRef(child);
    if (ref) result[key] = ref;
  }
  return result;
}

function safeOutput(value) {
  const ref = safeAssetRef(value);
  if (ref) return { root: "output", name: ref.name };
  if (value && typeof value === "object") {
    const name = safeRelative(value.name, { allowEmpty: false });
    if (name) return { root: "output", name };
  }
  return null;
}

function safeRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const allowed = [
    "mode", "initialDescription", "prompt", "negativePrompt", "model", "modelProfile", "width", "height", "dimensions",
    "duration", "steps", "seed", "timeoutSeconds", "inputImageName", "lastImageName", "inputVideoName",
    "inputImageRoot", "lastImageRoot", "inputVideoRoot", "referenceImageRoot",
    "referenceImageName", "referenceImageNames", "referenceImageRoots", "referenceImageRoles", "ref2vWorkflow",
    "clothingMode", "clothingDescription", "referenceVideoStart", "referenceVideoEnd", "referenceVideoMaxDimension", "characterLoraName", "characterLoraId",
    "characterLoraStrength", "h3LoraEnabled", "h3LoraPreset", "characterLoraTrigger",
    "outputName", "batchId", "batchIndex", "batchTotal", "inputRefs", "sequenceId", "segmentId", "segmentIndex", "attemptId", "childJobId",
  ];
  const result = {};
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) continue;
    const child = value[key];
    if (key === "inputRefs") {
      result[key] = safeInputRefs(child);
    } else if (key === "referenceImageNames") {
      result[key] = Array.isArray(child)
        ? child.map((item) => safeRelative(item, { allowEmpty: false })).filter(Boolean)
        : [];
    } else if (key === "referenceImageRoots") {
      result[key] = Array.isArray(child)
        ? child.map((item) => item === "output" ? "output" : "input")
        : [];
    } else if (key === "referenceImageRoles") {
      result[key] = Array.isArray(child) ? child.filter((item) => ["character", "face", "clothing"].includes(item)) : [];
    } else if (["inputImageRoot", "lastImageRoot", "inputVideoRoot", "referenceImageRoot"].includes(key)) {
      result[key] = child === "output" ? "output" : "input";
    } else if (["inputImageName", "lastImageName", "inputVideoName", "referenceImageName", "outputName", "characterLoraName"].includes(key)) {
      const text = safeRelative(child, { allowEmpty: false });
      if (text) result[key] = text;
    } else if (key === "initialDescription" || key === "prompt" || key === "negativePrompt") {
      result[key] = safePrompt(child);
    } else if (key === "mode" || key === "model" || key === "modelProfile" || key === "characterLoraId" || key === "batchId" || key === "h3LoraPreset" || key === "characterLoraTrigger" || key === "ref2vWorkflow" || key === "clothingMode" || key === "sequenceId" || key === "segmentId" || key === "attemptId" || key === "childJobId") {
      result[key] = safeText(child);
    } else if (key === "clothingDescription") {
      result[key] = safePrompt(child);
    } else if (key === "h3LoraEnabled") {
      result[key] = child === true;
    } else if (key === "dimensions" && child && typeof child === "object") {
      result[key] = { width: integerOrNull(child.width), height: integerOrNull(child.height) };
    } else if (key === "characterLoraStrength") {
      result[key] = numberOrNull(child);
    } else if (["width", "height", "duration", "steps", "seed", "timeoutSeconds", "batchIndex", "batchTotal", "segmentIndex", "referenceVideoStart", "referenceVideoEnd", "referenceVideoMaxDimension"].includes(key)) {
      result[key] = numberOrNull(child);
    }
  }
  return result;
}

function safeProvenance(value, fallbackRequest = {}) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const result = {
    request: safeRequest(input.request || fallbackRequest),
    attempt: Math.max(1, integerOrNull(input.attempt) || 1),
  };
  for (const key of ["retryOf", "originalId", "reason"]) {
    const text = safeIdOptional(input[key]);
    if (text) result[key] = text;
  }
  if (input.submittedAt) result.submittedAt = safeTimestamp(input.submittedAt);
  const binding = input.binding || input.sequenceBinding || input.request?.sequenceBinding;
  if (binding && typeof binding === "object") {
    result.binding = {
      sequenceId: safeIdOptional(binding.sequenceId) || null,
      segmentId: safeIdOptional(binding.segmentId) || null,
      segmentIndex: integerOrNull(binding.segmentIndex),
      attempt: integerOrNull(binding.attempt),
      attemptId: safeIdOptional(binding.attemptId) || null,
      childJobId: safeIdOptional(binding.childJobId) || null,
    };
  }
  return result;
}

function safeIdOptional(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && /^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(text) ? text : "";
}

function safePromptId(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text) ? text : "";
}

function canonicalJob(input = {}) {
  const id = safeId(input.id);
  const request = safeRequest(input.provenance?.request || input.request || input);
  const width = integerOrNull(input.width ?? input.dimensions?.width ?? request.width);
  const height = integerOrNull(input.height ?? input.dimensions?.height ?? request.height);
  const attempt = Math.max(1, integerOrNull(input.attempt ?? input.provenance?.attempt) || 1);
  const timestamps = {};
  for (const key of ["createdAt", "updatedAt", "queuedAt", "processStartedAt", "executionStartedAt", "startedAt", "finishedAt", "interruptedAt"]) {
    const value = safeTimestamp(input[key]);
    if (value) timestamps[key] = value;
  }
  // outputRelativeName is reserved before generation starts. It must never be
  // promoted to an actual artifact until ComfyUI has produced the file.
  const output = safeOutput(input.output);
  const provenance = safeProvenance(input.provenance, request);
  provenance.attempt = attempt;
  const runtimeMode = input.runtimeMode === "remote" ? "remote" : "local";
  return {
    id,
    mode: safeText(input.mode || request.mode, "t2v"),
    initialDescription: safePrompt(input.initialDescription ?? request.initialDescription),
    prompt: safePrompt(input.prompt || request.prompt),
    negativePrompt: safePrompt(input.negativePrompt || request.negativePrompt),
    model: safeText(input.model || input.modelProfile || request.model || request.modelProfile),
    modelProfile: safeText(input.modelProfile || input.model || request.modelProfile || request.model),
    dimensions: { width, height },
    width,
    height,
    duration: numberOrNull(input.duration ?? request.duration),
    steps: integerOrNull(input.steps ?? request.steps),
    seed: integerOrNull(input.seed ?? request.seed),
    timeoutSeconds: numberOrNull(input.timeoutSeconds ?? request.timeoutSeconds),
    inputRefs: safeInputRefs(input.inputRefs || request.inputRefs),
    promptId: safePromptId(input.promptId),
    runtimeMode,
    status: safeText(input.status, "queued"),
    stage: safeText(input.stage, "queued"),
    progress: numberOrNull(input.progress) ?? 0,
    output,
    outputName: safeRelative(input.outputName || output?.name, { allowEmpty: false }) || null,
    error: safeText(input.error),
    exitCode: integerOrNull(input.exitCode),
    elapsedMs: numberOrNull(input.elapsedMs),
    queueElapsedMs: numberOrNull(input.queueElapsedMs),
    ...timestamps,
    attempt,
    recoverable: Boolean(input.recoverable),
    recovery: input.recovery && typeof input.recovery === "object" ? {
      reason: safeText(input.recovery.reason),
      previousStatus: safeText(input.recovery.previousStatus),
      recoveredBy: safeIdOptional(input.recovery.recoveredBy) || null,
      recoveredAt: safeTimestamp(input.recovery.recoveredAt),
    } : null,
    provenance,
    batchId: safeText(input.batchId || request.batchId),
    batchIndex: integerOrNull(input.batchIndex ?? request.batchIndex),
    batchTotal: integerOrNull(input.batchTotal ?? request.batchTotal),
    retryOf: safeIdOptional(input.retryOf || provenance.retryOf) || null,
  };
}

function isTerminal(job) {
  return TERMINAL_STATUSES.has(String(job?.status || "")) && !job?.recoverable;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function renameWithRetry(source, destination, fsApi, platform = process.platform) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsApi.rename(source, destination);
      return;
    } catch (error) {
      const retryable = platform === "win32" && WINDOWS_TRANSIENT_RENAME_ERRORS.has(error?.code);
      if (!retryable || attempt >= WINDOWS_RENAME_RETRY_DELAYS_MS.length) throw error;
      await delay(WINDOWS_RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

export async function atomicWriteJson(filePath, value, fsApi = fs, platform = process.platform) {
  const directory = path.dirname(filePath);
  await fsApi.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fsApi.writeFile(temporary, jsonText(value), "utf8");
    await renameWithRetry(temporary, filePath, fsApi, platform);
  } catch (error) {
    await fsApi.unlink(temporary).catch(() => {});
    throw error;
  }
}

export function createSingleVideoJobStore({
  root = defaultRoot(),
  fsApi = fs,
  platform = process.platform,
  clock = () => new Date(),
  idFactory = () => `sv-${Date.now().toString(36)}-${randomUUID().replaceAll("-", "").slice(0, 10)}`,
  maxTerminalJobs = DEFAULT_MAX_TERMINAL_JOBS,
} = {}) {
  const jobsRoot = path.resolve(root);

  function jobFile(id) {
    const safe = safeId(id);
    const candidate = path.resolve(jobsRoot, `${safe}.json`);
    if (!inside(jobsRoot, candidate)) {
      const error = new Error("Single Video job path is unsafe.");
      error.code = "SINGLE_VIDEO_JOB_PATH_INVALID";
      error.status = 400;
      throw error;
    }
    return candidate;
  }

  function timestamp(value = clock()) {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }

  async function readRaw(id) {
    try {
      return JSON.parse(await fsApi.readFile(jobFile(id), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async function read(id) {
    const filePath = jobFile(id);
    const pending = writes.get(filePath);
    if (pending) await pending;
    return await readRaw(id);
  }

  async function ensure() {
    await fsApi.mkdir(jobsRoot, { recursive: true });
  }

  async function save(job) {
    const canonical = canonicalJob({ ...job, updatedAt: job.updatedAt || timestamp() });
    const filePath = jobFile(canonical.id);
    const previous = writes.get(filePath) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      await ensure();
      await atomicWriteJson(filePath, canonical, fsApi, platform);
      return canonical;
    });
    const tracked = next.finally(() => {
      if (writes.get(filePath) === tracked) writes.delete(filePath);
    });
    writes.set(filePath, tracked);
    return next;
  }

  async function create(input, options = {}) {
    const id = options.id || input?.id || idFactory();
    const createdAt = options.createdAt || timestamp();
    const initialCreatedAt = input?.createdAt || createdAt;
    const job = canonicalJob({ ...input, id, createdAt: initialCreatedAt, updatedAt: input?.updatedAt || initialCreatedAt });
    return await save(job);
  }

  async function update(id, patchOrUpdater) {
    const filePath = jobFile(id);
    const previous = writes.get(filePath) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const current = await readRaw(id);
      if (!current) {
        const error = new Error(`Single Video job not found: ${id}`);
        error.code = "SINGLE_VIDEO_JOB_NOT_FOUND";
        error.status = 404;
        throw error;
      }
      const patch = typeof patchOrUpdater === "function" ? await patchOrUpdater(current) : patchOrUpdater;
      const updated = canonicalJob({ ...current, ...(patch || {}), id, updatedAt: timestamp() });
      await atomicWriteJson(filePath, updated, fsApi, platform);
      return updated;
    });
    const tracked = next.finally(() => {
      if (writes.get(filePath) === tracked) writes.delete(filePath);
    });
    writes.set(filePath, tracked);
    return next;
  }

  async function list() {
    await ensure();
    const entries = await fsApi.readdir(jobsRoot, { withFileTypes: true });
    const jobs = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -5);
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(id)) continue;
      const job = await read(id);
      if (job?.id) jobs.push(job);
    }
    return jobs.sort((left, right) => String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")));
  }

  async function recover({ ownerId = `bridge-${process.pid}`, recoveredAt = timestamp() } = {}) {
    const all = await list();
    const requeued = [];
    const interrupted = [];
    for (const job of all) {
      if (["running", "cancelling"].includes(job.status)) {
        const boundToSequence = Boolean(job.provenance?.binding?.sequenceId);
        const next = await update(job.id, {
          status: boundToSequence ? "recovering" : "interrupted",
          stage: boundToSequence ? "recovering" : "interrupted",
          recoverable: true,
          error: boundToSequence ? null : (job.error || "Generation was interrupted by a bridge restart; retry is available."),
          interruptedAt: recoveredAt,
          finishedAt: recoveredAt,
          recovery: {
            reason: boundToSequence ? "bridge_restart_bound_sequence" : "bridge_restart",
            previousStatus: job.status,
            recoveredBy: ownerId,
            recoveredAt,
          },
          execution: null,
        });
        interrupted.push(next);
        continue;
      }
      if (job.status === "queued") {
        const next = await update(job.id, {
          stage: "queued",
          recoverable: false,
          recovery: {
            reason: "bridge_restart",
            previousStatus: job.status,
            recoveredBy: ownerId,
            recoveredAt,
          },
          execution: null,
        });
        requeued.push(next);
      }
    }
    return { jobs: await list(), requeued, interrupted };
  }

  async function remove(id) {
    const filePath = jobFile(id);
    const previous = writes.get(filePath) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      await fsApi.unlink(filePath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
      return id;
    });
    const tracked = next.finally(() => {
      if (writes.get(filePath) === tracked) writes.delete(filePath);
    });
    writes.set(filePath, tracked);
    return next;
  }

  async function prune({ maxTerminalJobs: requestedMaxTerminalJobs = maxTerminalJobs, maxAgeMs = null, now = clock() } = {}) {
    const all = await list();
    const terminal = all.filter(isTerminal).sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
    const cutoff = maxAgeMs === null ? null : new Date(now).getTime() - Math.max(0, Number(maxAgeMs));
    const removeByAge = cutoff === null ? new Set() : new Set(terminal.filter((job) => Date.parse(job.updatedAt || job.finishedAt || job.createdAt || "") < cutoff).map((job) => job.id));
    const keepCount = Math.max(0, Number(requestedMaxTerminalJobs));
    const removeByCount = new Set(terminal.slice(keepCount).map((job) => job.id));
    const ids = [...new Set([...removeByAge, ...removeByCount])];
    for (const id of ids) await remove(id);
    return { removed: ids, retained: (await list()).filter((job) => !ids.includes(job.id)) };
  }

  return Object.freeze({
    root: jobsRoot,
    jobFile,
    ensure,
    read,
    list,
    create,
    save,
    update,
    recover,
    remove,
    prune,
    isTerminal,
  });
}

export const SINGLE_VIDEO_DATA_ROOT = defaultRoot;
export { TERMINAL_STATUSES };
