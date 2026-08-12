import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const PERSISTED_STATUSES = new Set(["queued", "running", "cancelling", "completed", "failed", "cancelled", "interrupted"]);
const DEFAULT_PROFILE = "seedvr2_3b_int8";
const TRANSIENT_RENAME_ERRORS = new Set(["EACCES", "EBUSY", "ENOTEMPTY", "EPERM"]);
const RENAME_DELAYS_MS = Object.freeze([5, 10, 20, 40, 80]);
const writes = new Map();

function defaultRoot() {
  return path.resolve(
    process.env.MINIMAX_H3_SEEDVR2_DATA_ROOT
      || path.join(PROJECT_ROOT, "data", "jobs", "seedvr2"),
  );
}

function inside(root, candidate) {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  return absoluteCandidate === absoluteRoot || absoluteCandidate.startsWith(absoluteRoot + path.sep);
}

function safeId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(id)) {
    const error = new Error("SeedVR2 job id is invalid.");
    error.code = "SEEDVR2_JOB_ID_INVALID";
    error.status = 400;
    throw error;
  }
  return id;
}

function safeRelative(value) {
  const normalized = String(value || "").replaceAll("\\", "/").trim();
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.includes("\0")) return "";
  const pieces = normalized.split("/");
  if (pieces.some((piece) => !piece || piece === "." || piece === ".." || /[<>:"|?*]/.test(piece))) return "";
  if (Array.from(normalized).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return "";
  return normalized;
}

function safeText(value, fallback = "", limit = 2000) {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  return text.replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/((?:token|secret|password|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit) || fallback;
}

function safeTimestamp(value) {
  const text = typeof value === "string" ? value : "";
  return text && !Number.isNaN(Date.parse(text)) ? text : null;
}

function safeNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function safeInteger(value, fallback = null) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : fallback;
}

function safePrompt(value, depth = 0) {
  if (depth > 8 || value === undefined || typeof value === "function" || typeof value === "symbol") return null;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return safeText(value, "", 20_000);
  if (Array.isArray(value)) return value.slice(0, 300).map((child) => safePrompt(child, depth + 1));
  if (typeof value !== "object") return null;
  const result = {};
  for (const [key, child] of Object.entries(value).slice(0, 500)) {
    const cleanKey = safeText(key, "", 160);
    if (!cleanKey) continue;
    result[cleanKey] = safePrompt(child, depth + 1);
  }
  return result;
}

function safeOutput(value) {
  if (!value || typeof value !== "object") return null;
  const name = safeRelative(value.name);
  if (!name) return null;
  const output = {
    name,
    root: value.root === "output" ? "output" : "output",
    kind: safeText(value.kind, "video", 32),
  };
  for (const key of ["url", "downloadUrl"]) {
    if (typeof value[key] === "string" && value[key].startsWith("/")) output[key] = value[key].slice(0, 1000);
  }
  return output;
}

function safeProvenance(value, job) {
  const source = value && typeof value === "object" ? value : {};
  const request = source.request && typeof source.request === "object" ? source.request : {};
  const requestSeed = safeInteger(request.seed ?? job.seed, 0);
  return {
    request: {
      sourceName: safeRelative(request.sourceName || job.sourceName),
      sourceRoot: request.sourceRoot === "output" ? "output" : "input",
      scale: safeNumber(request.scale ?? job.scale, 2) === 2 ? 2 : 2,
      profile: safeText(request.profile || job.profile, DEFAULT_PROFILE, 80),
      seed: requestSeed === null ? 0 : Math.max(0, Math.min(2_147_483_647, requestSeed)),
    },
    attempt: Math.max(1, Math.floor(safeNumber(source.attempt ?? job.attempt, 1))),
    ...(safeIdOptional(source.retryOf || job.retryOf) ? { retryOf: safeIdOptional(source.retryOf || job.retryOf) } : {}),
    ...(safeIdOptional(source.originalId || source.sourceJobId) ? { originalId: safeIdOptional(source.originalId || source.sourceJobId) } : {}),
    ...(safeText(source.reason) ? { reason: safeText(source.reason, "", 200) } : {}),
    ...(safeTimestamp(source.submittedAt) ? { submittedAt: safeTimestamp(source.submittedAt) } : {}),
  };
}

function safeIdOptional(value) {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(id) ? id : "";
}

export function canonicalSeedVR2Job(input = {}) {
  const id = safeId(input.id);
  const source = input.source && typeof input.source === "object" ? input.source : {};
  const sourceName = safeRelative(input.sourceName || source.name);
  if (!sourceName) {
    const error = new Error("SeedVR2 sourceName is invalid.");
    error.code = "SEEDVR2_SOURCE_NAME_INVALID";
    error.status = 400;
    throw error;
  }
  const sourceRoot = (input.sourceRoot || source.root) === "output" ? "output" : "input";
  const attempt = Math.max(1, Math.floor(safeNumber(input.attempt, 1)));
  const createdAt = safeTimestamp(input.createdAt || input.timestamps?.createdAt) || new Date().toISOString();
  const startedAt = safeTimestamp(input.startedAt || input.timestamps?.startedAt);
  const completedAt = safeTimestamp(input.completedAt || input.timestamps?.completedAt);
  const cancelledAt = safeTimestamp(input.cancelledAt || input.timestamps?.cancelledAt);
  const updatedAt = safeTimestamp(input.updatedAt || input.timestamps?.updatedAt) || createdAt;
  const seed = safeInteger(input.seed ?? input.provenance?.request?.seed, 0);
  const job = {
    id,
    status: PERSISTED_STATUSES.has(String(input.status || "")) ? String(input.status) : "queued",
    progress: Math.max(0, Math.min(100, safeNumber(input.progress, 0))),
    stage: safeText(input.stage, "Queued", 120),
    sourceName,
    sourceRoot,
    source: { name: sourceName, root: sourceRoot },
    scale: 2,
    profile: safeText(input.profile, DEFAULT_PROFILE, 80),
    seed: seed === null ? 0 : Math.max(0, Math.min(2_147_483_647, seed)),
    prompt: safePrompt(input.prompt),
    output: safeOutput(input.output),
    error: safeText(input.error, "", 1200),
    createdAt,
    startedAt,
    completedAt,
    updatedAt,
    cancelledAt,
    cancelReason: safeText(input.cancelReason, "", 400),
    cancelRequested: Boolean(input.cancelRequested),
    attempt,
    retryOf: safeIdOptional(input.retryOf),
    recoverable: Boolean(input.recoverable),
    recovery: input.recovery && typeof input.recovery === "object" ? {
      reason: safeText(input.recovery.reason, "", 120),
      previousStatus: safeText(input.recovery.previousStatus, "", 40),
      recoveredBy: safeText(input.recovery.recoveredBy, "", 120),
      recoveredAt: safeTimestamp(input.recovery.recoveredAt),
    } : null,
    promptId: safeText(input.promptId, "", 200),
  };
  job.provenance = safeProvenance(input.provenance, job);
  job.timestamps = { createdAt, startedAt, completedAt, updatedAt, cancelledAt };
  return job;
}

function isTerminal(job) {
  return TERMINAL_STATUSES.has(String(job?.status || "")) && !job?.recoverable;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renameWithRetry(source, destination, fsApi, platform) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsApi.rename(source, destination);
      return;
    } catch (error) {
      if (platform !== "win32" || !TRANSIENT_RENAME_ERRORS.has(error?.code) || attempt >= RENAME_DELAYS_MS.length) throw error;
      await delay(RENAME_DELAYS_MS[attempt]);
    }
  }
}

async function atomicWrite(filePath, value, { fsApi, platform }) {
  await fsApi.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fsApi.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await renameWithRetry(temporary, filePath, fsApi, platform);
  } catch (error) {
    await fsApi.unlink(temporary).catch(() => {});
    throw error;
  }
}

export function createSeedVR2JobStore({
  root = defaultRoot(),
  fsApi = fs,
  platform = process.platform,
  clock = () => new Date(),
  idFactory = () => randomUUID(),
  maxTerminalJobs = 100,
} = {}) {
  const jobsRoot = path.resolve(root);

  function timestamp(value = clock()) {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }

  function jobFile(id) {
    const safe = safeId(id);
    const candidate = path.resolve(jobsRoot, `${safe}.json`);
    if (!inside(jobsRoot, candidate)) throw new Error("SeedVR2 job path is unsafe.");
    return candidate;
  }

  async function ensure() {
    await fsApi.mkdir(jobsRoot, { recursive: true });
  }

  async function readRaw(id) {
    try {
      return canonicalSeedVR2Job(JSON.parse(await fsApi.readFile(jobFile(id), "utf8")));
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

  async function save(job) {
    const canonical = canonicalSeedVR2Job({ ...job, updatedAt: job.updatedAt || timestamp() });
    const filePath = jobFile(canonical.id);
    const previous = writes.get(filePath) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      await ensure();
      await atomicWrite(filePath, canonical, { fsApi, platform });
      return canonical;
    });
    const tracked = next.finally(() => {
      if (writes.get(filePath) === tracked) writes.delete(filePath);
    });
    writes.set(filePath, tracked);
    return await next;
  }

  async function create(input, options = {}) {
    const id = options.id || input?.id || idFactory();
    return await save({ ...input, id, createdAt: input?.createdAt || options.createdAt || timestamp() });
  }

  async function update(id, patchOrUpdater) {
    const filePath = jobFile(id);
    const previous = writes.get(filePath) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const current = await readRaw(id);
      if (!current) {
        const error = new Error(`SeedVR2 job not found: ${id}`);
        error.code = "SEEDVR2_JOB_NOT_FOUND";
        error.status = 404;
        throw error;
      }
      const patch = typeof patchOrUpdater === "function" ? await patchOrUpdater(current) : patchOrUpdater;
      const updated = canonicalSeedVR2Job({ ...current, ...(patch || {}), id, updatedAt: timestamp() });
      await atomicWrite(filePath, updated, { fsApi, platform });
      return updated;
    });
    const tracked = next.finally(() => {
      if (writes.get(filePath) === tracked) writes.delete(filePath);
    });
    writes.set(filePath, tracked);
    return await next;
  }

  async function list() {
    await ensure();
    const entries = await fsApi.readdir(jobsRoot, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -5);
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(id)) continue;
      const job = await read(id);
      if (job) result.push(job);
    }
    return result.sort((left, right) => String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt)));
  }

  async function recover({ ownerId = `bridge-${process.pid}`, recoveredAt = timestamp() } = {}) {
    const all = await list();
    const requeued = [];
    const interrupted = [];
    const cancelled = [];
    for (const job of all) {
      if (job.status === "cancelling" || job.cancelRequested) {
        const next = await update(job.id, {
          status: "cancelled",
          stage: "Cancelled",
          cancelRequested: false,
          cancelReason: job.cancelReason || "SeedVR2 cancellation was persisted before the bridge restarted.",
          cancelledAt: recoveredAt,
          completedAt: recoveredAt,
          recoverable: false,
          recovery: { reason: "bridge_restart_cancelled", previousStatus: job.status, recoveredBy: ownerId, recoveredAt },
        });
        cancelled.push(next);
      } else if (job.status === "running") {
        const next = await update(job.id, {
          status: "interrupted",
          stage: "Interrupted",
          recoverable: true,
          error: job.error || "SeedVR2 was interrupted by a bridge restart; retry is available.",
          completedAt: recoveredAt,
          cancelRequested: false,
          recovery: { reason: "bridge_restart", previousStatus: job.status, recoveredBy: ownerId, recoveredAt },
        });
        interrupted.push(next);
      } else if (job.status === "queued") {
        const next = await update(job.id, {
          stage: "Queued",
          recovery: { reason: "bridge_restart", previousStatus: "queued", recoveredBy: ownerId, recoveredAt },
        });
        requeued.push(next);
      }
    }
    return { jobs: await list(), requeued, interrupted, cancelled };
  }

  async function prune({ maxTerminalJobs: requested = maxTerminalJobs, maxAgeMs = null, now = clock() } = {}) {
    const all = await list();
    const terminal = all.filter(isTerminal).sort((left, right) => String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt)));
    const cutoff = maxAgeMs === null ? null : new Date(now).getTime() - Math.max(0, Number(maxAgeMs));
    const ids = new Set(terminal.slice(Math.max(0, Number(requested))).map((job) => job.id));
    if (cutoff !== null) {
      for (const job of terminal) if (Date.parse(job.updatedAt || job.completedAt || job.createdAt) < cutoff) ids.add(job.id);
    }
    for (const id of ids) await fsApi.unlink(jobFile(id)).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    return { removed: [...ids], retained: (await list()).filter((job) => !ids.has(job.id)) };
  }

  return Object.freeze({ root: jobsRoot, ensure, read, list, create, save, update, recover, prune, isTerminal, jobFile });
}

export const SEEDVR2_DATA_ROOT = defaultRoot;
