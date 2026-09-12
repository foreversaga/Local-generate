import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";

import { createSolH3Readiness } from "./readiness.mjs";
import {
  inferSolH3MediaKind,
  normalizeSolH3MediaLocator,
  normalizeSolH3Request,
  SOL_H3_DURATION_PROFILES,
  SOL_H3_OUTPUT_SPEC,
  solH3OutputSpec,
  solH3Error,
  toInternalSolH3MediaRoot,
} from "./request.mjs";
import { DEFAULT_SOL_H3_RUNTIME_CONFIG } from "./runtime-config.mjs";
import { createSolH3JobStore } from "./job-store.mjs";
import { assertSolH3JobTransition, isSolH3TerminalState } from "./state-machine.mjs";
import {
  assertIdempotentReplay,
  fingerprintSolH3Request,
  normalizeIdempotencyKey,
} from "./idempotency.mjs";
import { writeSolH3SseComment, writeSolH3SseEvent, writeSolH3SseHeaders } from "./sse.mjs";
import { createSolH3MediaValidator } from "./media-validation.mjs";
import { createSolH3OutputValidator } from "./output-validation.mjs";
import { createSolH3RunnerClient } from "./runner-client.mjs";
import { registerSolH3Lifecycle } from "./lifecycle.mjs";
import { parseSolH3RunnerTiming } from "./timing.mjs";

const PIPELINE_STATES = Object.freeze([
  "queued",
  "waiting_gpu",
  "preparing",
  "qwen_running",
  "stage1_running",
  "upscaling",
  "adapting",
  "stage2_running",
  "validating",
  "succeeded",
]);

const STAGE_META = Object.freeze({
  queued: { stage: "已建立，等待 GPU", progress: 0 },
  waiting_gpu: { stage: "等待 GPU 排他資源", progress: 2 },
  preparing: { stage: "準備輸入與官方 runtime", progress: 5 },
  qwen_running: { stage: "Qwen prompt processing", progress: 12 },
  stage1_running: { stage: "H3 Stage 1", progress: 35 },
  upscaling: { stage: "H3 latent upscaler", progress: 58 },
  adapting: { stage: "H3-to-LTX adapter", progress: 68 },
  stage2_running: { stage: "LTX-2.5 Stage 2", progress: 78 },
  validating: { stage: "驗證輸出影片與音訊", progress: 94 },
  succeeded: { stage: "完成（MP4＋AAC 已驗證）", progress: 100 },
});

const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"]);
const SSE_KEEPALIVE_MS = 15_000;

function now() {
  return new Date().toISOString();
}

function safeId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/u.test(id)) {
    throw solH3Error("SOL_H3_JOB_ID_INVALID", "Sol-H3 job id is invalid.", 400);
  }
  return id;
}

function redactAbsolutePaths(value) {
  return String(value)
    .replace(/[A-Za-z]:[\\/]\S+/g, "[redacted path]")
    .replace(/\\\\\S+/g, "[redacted path]")
    .replace(/\/(?:home|tmp|var|opt|usr|mnt|srv|root)\/\S+/g, "[redacted path]");
}

function publicError(error) {
  return redactAbsolutePaths(error?.message || error || "Sol-H3 job failed.")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .slice(-2000);
}

function publicJob(job) {
  if (!job) return null;
  const output = job.status === "succeeded"
    ? {
      id: "final",
      name: "final.mp4",
      url: "/api/sol-h3/jobs/" + encodeURIComponent(job.id) + "/outputs/final",
      kind: "video",
    }
    : null;
  const durationSeconds = Number.isInteger(job.request?.durationSeconds) ? job.request.durationSeconds : 5;
  return {
    id: job.id,
    schemaVersion: job.request?.schemaVersion || 1,
    mode: job.request?.mode || job.mode,
    prompt: job.request?.prompt || "",
    seed: job.request?.seed ?? null,
    durationSeconds,
    refImageMatch: job.request?.refImageMatch || null,
    refStage1Attn: job.request?.refStage1Attn || null,
    status: job.status,
    stage: job.stage,
    progress: Number.isFinite(Number(job.progress)) ? Number(job.progress) : null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    retryOf: job.retryOf || null,
    timing: job.timing || null,
    output,
    outputSpec: solH3OutputSpec(durationSeconds),
    outputMetadata: job.outputMetadata || null,
    error: job.error ? publicError(job.error) : "",
    errorCode: job.errorCode || null,
    cancelRequested: Boolean(job.cancelRequested),
    gpu: job.gpu || null,
    events: Array.isArray(job.events) ? job.events.slice(-40) : [],
  };
}

function commandBase(url) {
  return String(url || "").trim().replace(/\/+$/u, "");
}

async function checkConflictUrls(urls, fetcher = fetch) {
  const conflicts = [];
  for (const url of urls || []) {
    try {
      const response = await fetcher(commandBase(url) + "/models", { signal: AbortSignal.timeout(1200) });
      if (response.ok) conflicts.push(url);
    } catch {
      // Unavailable configured conflict services do not consume the accelerator.
    }
  }
  return conflicts;
}

async function processAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function pipelineIndex(status) {
  return PIPELINE_STATES.indexOf(status);
}

function nextPipelineState(status) {
  const index = pipelineIndex(status);
  return index >= 0 && index < PIPELINE_STATES.length - 1 ? PIPELINE_STATES[index + 1] : null;
}

export function createSolH3Controller({
  config = DEFAULT_SOL_H3_RUNTIME_CONFIG,
  fsApi = fs,
  spawnApi,
  fetcher = fetch,
  resolveMediaPath,
  gpuCoordinator = null,
  clock = now,
} = {}) {
  if (!config || typeof config !== "object" || typeof resolveMediaPath !== "function") {
    throw new TypeError("Sol-H3 controller dependencies are incomplete.");
  }

  const readiness = createSolH3Readiness({ config, fsApi });
  const store = createSolH3JobStore({ root: config.jobRoot, fsApi, clock });
  const jobs = new Map();
  const admissions = new Map();
  const leases = new Map();
  const idempotency = new Map();
  const mutationTails = new Map();
  const listeners = new Map();
  const managerLockFile = path.join(config.runtimeRoot, "sol-h3-manager.lock");
  let initialized;
  let managerLockOwned = false;
  let unregisterLifecycle = () => {};

  function notify(job, event) {
    const callbacks = listeners.get(job.id);
    if (!callbacks?.size) return;
    for (const callback of [...callbacks]) {
      try { callback(event, publicJob(job)); } catch { callbacks.delete(callback); }
    }
    if (!callbacks.size) listeners.delete(job.id);
  }

  function subscribe(jobId, callback) {
    const cleanId = safeId(jobId);
    const callbacks = listeners.get(cleanId) || new Set();
    callbacks.add(callback);
    listeners.set(cleanId, callbacks);
    return () => {
      callbacks.delete(callback);
      if (!callbacks.size) listeners.delete(cleanId);
    };
  }

  function enqueueMutation(job, operation) {
    const previous = mutationTails.get(job.id) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    const tracked = next.finally(() => {
      if (mutationTails.get(job.id) === tracked) mutationTails.delete(job.id);
    });
    mutationTails.set(job.id, tracked);
    return next;
  }

  async function appendEventUnsafe(job, event) {
    job.eventSeq = (Number(job.eventSeq) || 0) + 1;
    const record = await store.appendEvent(job, { seq: job.eventSeq, ...event });
    notify(job, record);
    return record;
  }

  function transition(job, target, patch = {}, event = {}) {
    return enqueueMutation(job, async () => {
      if (job.status !== target) assertSolH3JobTransition(job.status, target);
      Object.assign(job, patch, { status: target });
      const meta = STAGE_META[target];
      if (meta && patch.stage === undefined) job.stage = meta.stage;
      if (meta && patch.progress === undefined) job.progress = Math.max(Number(job.progress) || 0, meta.progress);
      await appendEventUnsafe(job, {
        status: job.status,
        stage: job.stage,
        progress: job.progress,
        ...event,
      });
      return job;
    });
  }

  function advanceTo(job, target, patch = {}, event = {}) {
    return enqueueMutation(job, async () => {
      if (isSolH3TerminalState(job.status) || job.status === "cancel_requested") return job;
      const targetIndex = pipelineIndex(target);
      let currentIndex = pipelineIndex(job.status);
      if (targetIndex < 0 || currentIndex < 0 || targetIndex < currentIndex) return job;
      while (job.status !== target) {
        const next = nextPipelineState(job.status);
        if (!next) break;
        assertSolH3JobTransition(job.status, next);
        job.status = next;
        const meta = STAGE_META[next];
        if (meta) {
          job.stage = meta.stage;
          job.progress = Math.max(Number(job.progress) || 0, meta.progress);
        }
        if (next === target) Object.assign(job, patch);
        await appendEventUnsafe(job, {
          status: job.status,
          stage: job.stage,
          progress: job.progress,
          ...(next === target ? event : { inferred: true }),
        });
        currentIndex += 1;
        if (currentIndex > targetIndex) break;
      }
      return job;
    });
  }

  const runner = createSolH3RunnerClient({
    config,
    fsApi,
    ...(spawnApi ? { spawnApi } : {}),
    onProgress: (jobId, stage, details = {}) => {
      const job = jobs.get(jobId);
      const target = PIPELINE_STATES.includes(stage) ? stage : null;
      if (job && target) {
        void advanceTo(job, target, {}, {
          source: details.source || "runner",
          ...(details.phase ? { phase: details.phase } : {}),
          ...(details.detail !== undefined ? { detail: details.detail } : {}),
        }).catch(() => {});
      }
    },
  });
  const mediaValidator = createSolH3MediaValidator({ fsApi, probeMedia: runner.probeMedia });
  const outputValidator = createSolH3OutputValidator({
    fsApi,
    probeMedia: runner.probeMedia,
    decodeMedia: runner.decodeMedia,
  });

  async function readLock(filePath) {
    return await fsApi.readFile(filePath, "utf8").then(JSON.parse).catch(() => null);
  }

  async function clearStaleLock(filePath) {
    const lock = await readLock(filePath);
    if (!lock?.pid || await processAlive(lock.pid)) return lock;
    await fsApi.unlink(filePath).catch(() => {});
    return null;
  }

  async function acquireManagerLock() {
    await fsApi.mkdir(config.runtimeRoot, { recursive: true });
    const existing = await clearStaleLock(managerLockFile);
    if (existing?.pid && Number(existing.pid) !== process.pid) {
      throw solH3Error("SOL_H3_MANAGER_LOCKED", "Another H3 Studio process owns the Sol-H3 job manager.", 503);
    }
    if (Number(existing?.pid) === process.pid) {
      managerLockOwned = true;
      return;
    }
    let handle;
    try {
      handle = await fsApi.open(managerLockFile, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: clock() }) + "\n", "utf8");
      managerLockOwned = true;
    } catch (error) {
      throw solH3Error("SOL_H3_MANAGER_LOCKED", "Another H3 Studio process owns the Sol-H3 job manager.", 503, { cause: error?.code || "lock" });
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function ensureInitialized() {
    if (initialized) return initialized;
    initialized = (async () => {
      await acquireManagerLock();
      await clearStaleLock(config.hostLockFile);
      const recovered = [];
      for (const job of await store.loadAll()) {
        jobs.set(job.id, job);
        if (job.idempotencyKey && job.requestFingerprint) {
          idempotency.set(job.idempotencyKey, { jobId: job.id, requestFingerprint: job.requestFingerprint });
        }
        const recovery = await store.recover(job);
        if (recovery.action === "reload") recovered.push(job);
      }
      for (const job of recovered) setImmediate(() => { void run(job); });
      return true;
    })();
    return initialized;
  }

  async function health() {
    await ensureInitialized();
    const conflicts = await checkConflictUrls(config.conflictUrls, fetcher);
    const gpu = gpuCoordinator?.snapshot?.() || { active: null, queue: [], activeCount: 0, queuedCount: 0, totalCount: 0 };
    const result = await readiness.inspect({ gpu, conflicts });
    const lock = await clearStaleLock(config.hostLockFile);
    return {
      ...result,
      hostLock: lock ? { held: true, owner: String(lock.owner || "unknown") } : { held: false },
      managerLock: { held: managerLockOwned },
      conflictPolicy: "reject-only",
    };
  }

  async function preflight(mode) {
    const result = await health();
    const details = result.modes?.[mode];
    if (!details?.ready) {
      throw solH3Error("SOL_H3_NOT_READY", "Sol-H3 " + mode + " is not ready.", 503, {
        mode,
        missing: details?.missing || ["mode_readiness"],
      });
    }
    if (result.conflicts?.length) {
      throw solH3Error("SOL_H3_EXTERNAL_GPU_CONFLICT", "A configured large-model service is using the accelerator.", 409, {
        conflicts: result.conflicts.map((item) => String(item).replace(/\/v1\/?$/u, "")),
      });
    }
    if (result.hostLock?.held) {
      throw solH3Error("SOL_H3_HOST_LOCKED", "Another Sol-H3 worker owns the accelerator lock.", 409);
    }
    return result;
  }

  async function acquireHostLock(job) {
    await fsApi.mkdir(config.runtimeRoot, { recursive: true });
    await clearStaleLock(config.hostLockFile);
    let handle;
    try {
      handle = await fsApi.open(config.hostLockFile, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, owner: job.id, acquiredAt: clock() }) + "\n", "utf8");
    } catch {
      throw solH3Error("SOL_H3_HOST_LOCKED", "Another Sol-H3 worker owns the accelerator lock.", 409);
    } finally {
      await handle?.close().catch(() => {});
    }
    return async () => {
      const lock = await readLock(config.hostLockFile);
      if (lock?.owner === job.id && Number(lock.pid) === process.pid) {
        await fsApi.unlink(config.hostLockFile).catch(() => {});
      }
    };
  }

  async function stageMedia(locator, destination, expectedKinds) {
    const normalized = normalizeSolH3MediaLocator(locator, "input");
    const sourcePath = await resolveMediaPath(toInternalSolH3MediaRoot(normalized.root), normalized.relativePath);
    return await mediaValidator.stage({ sourcePath, destination, locator: normalized, expectedKinds });
  }

  async function stageRequest(job) {
    const request = job.request;
    const inputsRoot = path.join(store.directory(job.id), "inputs");
    const caseFile = path.join(store.directory(job.id), "intermediates", "request.jsonl");
    const record = {
      case_id: "generation",
      prompt: request.prompt,
      seed: request.seed,
      task: request.mode,
      ...(request.durationSeconds === undefined ? {} : { duration_seconds: request.durationSeconds }),
    };

    if (request.mode === "fl2va") {
      const firstExtension = path.extname(request.inputs.firstFrame.relativePath).toLowerCase();
      const lastExtension = path.extname(request.inputs.lastFrame.relativePath).toLowerCase();
      const first = await stageMedia(request.inputs.firstFrame, path.join(inputsRoot, "first-frame" + firstExtension), ["image"]);
      const last = await stageMedia(request.inputs.lastFrame, path.join(inputsRoot, "last-frame" + lastExtension), ["image"]);
      record.first_frame = first.path;
      record.last_frame = last.path;
    }

    if (request.mode === "ref2va") {
      const reference = request.inputs.references[0];
      const extension = path.extname(reference.relativePath).toLowerCase();
      const referenceKind = inferSolH3MediaKind(reference.relativePath, reference.kind);
      if (!referenceKind || (referenceKind === "audio" && !AUDIO_EXTENSIONS.has(extension))) {
        throw solH3Error("SOL_H3_REFERENCE_KIND_UNKNOWN", "ref2va reference must be an image, video, or supported audio file.", 422);
      }
      const staged = await stageMedia(reference, path.join(inputsRoot, "reference" + extension), ["image", "video", "audio"]);
      record.references = [{ type: staged.kind, path: staged.path }];
    }

    await fsApi.writeFile(caseFile, JSON.stringify(record) + "\n", "utf8");
    return caseFile;
  }

  async function writePipelineFingerprint(job, pathsFilePath, currentHealth) {
    const pathsBytes = await fsApi.readFile(pathsFilePath);
    const record = {
      schemaVersion: 1,
      mode: job.request.mode,
      ...(job.request.durationSeconds === undefined ? {} : { durationSeconds: job.request.durationSeconds }),
      ...(job.request.refImageMatch ? { refImageMatch: job.request.refImageMatch } : {}),
      ...(job.request.refStage1Attn ? { refStage1Attn: job.request.refStage1Attn } : {}),
      sanaCommit: currentHealth.code?.sanaCommit || null,
      h3Revision: currentHealth.paths?.h3Revision || config.pinnedH3Revision,
      pathsManifestSha256: sha256(pathsBytes),
      createdAt: clock(),
    };
    const pipelineFingerprint = sha256(JSON.stringify(record));
    await fsApi.writeFile(
      path.join(store.directory(job.id), "checkpoint-fingerprint.json"),
      JSON.stringify({ ...record, pipelineFingerprint }, null, 2) + "\n",
      { encoding: "utf8", flag: "wx" },
    );
    job.pipelineFingerprint = pipelineFingerprint;
    await store.save(job);
    return pipelineFingerprint;
  }

  async function findFormalOutput(outputRoot, outputSpec) {
    const candidates = [];
    async function walk(directory) {
      const entries = await fsApi.readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(candidate);
        else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".mp4") candidates.push(candidate);
      }
    }
    await walk(outputRoot);
    const formal = candidates.filter((candidate) => {
      const relative = path.relative(outputRoot, candidate).split(path.sep);
      return relative[0] === "generation"
        && path.basename(candidate) === `refined_${outputSpec.width}x${outputSpec.height}_${outputSpec.frames}f.mp4`;
    });
    if (formal.length !== 1) {
      throw solH3Error("SOL_H3_OUTPUT_COUNT_INVALID", "Sol-H3 job did not produce exactly one formal MP4 output.", 502, {
        count: formal.length,
        totalMp4: candidates.length,
      });
    }
    return formal[0];
  }

  async function run(job) {
    let lease;
    let releaseHostLock;
    let heartbeat;
    try {
      if (isSolH3TerminalState(job.status)) return;
      if (job.cancelRequested || job.status === "cancel_requested") {
        await transition(job, "cancelled", { stage: "已取消", finishedAt: clock() });
        return;
      }

      const admission = gpuCoordinator?.request?.({
        requestId: "sol-h3:" + job.id,
        jobId: "sol-h3:" + job.id,
        workloadType: "sol-h3",
        runtime: "local",
        metadata: { mode: job.request.mode, resource: "accelerator-global", leaseMode: "exclusive" },
      });
      if (admission) admissions.set(job.id, admission);
      await transition(job, "waiting_gpu");
      lease = admission ? await admission.granted : null;
      if (lease) leases.set(job.id, lease);
      if (lease?.heartbeat) heartbeat = setInterval(() => lease.heartbeat(), 60_000);
      heartbeat?.unref?.();
      if (job.cancelRequested) throw solH3Error("SOL_H3_CANCELLED", "Sol-H3 job was cancelled.", 499);

      const currentHealth = await preflight(job.request.mode);
      releaseHostLock = await acquireHostLock(job);
      await transition(job, "preparing", {
        startedAt: job.startedAt || clock(),
        gpu: currentHealth.gpu,
      });

      const caseFile = await stageRequest(job);
      const pathsFilePath = await runner.pathsFile(job.request.mode);
      const pipelineFingerprint = await writePipelineFingerprint(job, pathsFilePath, currentHealth);
      // The job store owns the stable outputs/ directory, while the official
      // Pipeline requires its output root itself to be new (exist_ok=False).
      // Give each invocation a private child root and keep final.mp4 at the
      // job-scoped outputs/ level after validation below.
      const outputRoot = path.join(store.directory(job.id), "outputs", "run");
      const exit = await runner.run({
        jobId: job.id,
        mode: job.request.mode,
        caseFile,
        outputRoot,
        logFile: path.join(store.directory(job.id), "logs", "runner.log"),
        pathsFilePath,
        durationSeconds: job.request.durationSeconds || 5,
        refImageMatch: job.request.refImageMatch || null,
        refStage1Attn: job.request.refStage1Attn || null,
      });
      if (job.cancelRequested) throw solH3Error("SOL_H3_CANCELLED", "Sol-H3 job was cancelled.", 499);
      if (exit.code !== 0) {
        throw solH3Error("SOL_H3_RUNNER_FAILED", "Official Sol-H3 runner failed.", 502, {
          exitCode: exit.code,
          signal: exit.signal,
          logTail: publicError(exit.logTail),
        });
      }

      const runnerReport = await fsApi.readFile(path.join(outputRoot, "results.json"), "utf8")
        .then((value) => JSON.parse(value))
        .catch(() => null);
      const timing = parseSolH3RunnerTiming(runnerReport);
      if (timing) {
        job.timing = timing;
        await store.save(job);
      }

      await advanceTo(job, "validating");
      const outputSpec = solH3OutputSpec(job.request.durationSeconds || 5);
      const sourceOutput = await findFormalOutput(outputRoot, outputSpec);
      const finalOutput = path.join(store.directory(job.id), "outputs", "final.mp4");
      if (sourceOutput !== finalOutput) await fsApi.rename(sourceOutput, finalOutput);
      const outputMetadata = await outputValidator.validate(finalOutput, {
        pipelineFingerprint, outputSpec,
      });
      await fsApi.writeFile(
        path.join(outputRoot, "manifest.json"),
        JSON.stringify({ schemaVersion: 1, outputId: "final", ...outputMetadata }, null, 2) + "\n",
        "utf8",
      );
      await transition(job, "succeeded", {
        finishedAt: clock(),
        outputMetadata,
        error: "",
        errorCode: null,
      });
    } catch (error) {
      const cancelled = error?.code === "SOL_H3_CANCELLED" || error?.code === "GPU_LEASE_CANCELLED" || job.cancelRequested;
      if (!isSolH3TerminalState(job.status)) {
        if (cancelled && job.status !== "cancel_requested") {
          await transition(job, "cancel_requested", { cancelRequested: true, stage: "正在取消 Sol-H3 worker" }).catch(() => {});
        }
        const target = cancelled ? "cancelled" : "failed";
        await transition(job, target, {
          stage: cancelled ? "已取消" : "失敗",
          progress: cancelled ? job.progress : null,
          finishedAt: clock(),
          error: cancelled ? "" : publicError(error),
          errorCode: cancelled ? null : (error?.code || "SOL_H3_JOB_FAILED"),
        }).catch(async () => {
          job.status = target;
          job.stage = cancelled ? "已取消" : "失敗";
          job.finishedAt = clock();
          job.error = cancelled ? "" : publicError(error);
          job.errorCode = cancelled ? null : (error?.code || "SOL_H3_JOB_FAILED");
          await store.save(job).catch(() => {});
        });
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      admissions.delete(job.id);
      leases.delete(job.id);
      await releaseHostLock?.().catch(() => {});
      lease?.release?.();
    }
  }

  async function create(payload, { idempotencyKey: rawIdempotencyKey = null, retryOf = null } = {}) {
    await ensureInitialized();
    const request = normalizeSolH3Request(payload);
    const idempotencyKey = normalizeIdempotencyKey(rawIdempotencyKey);
    const requestFingerprint = fingerprintSolH3Request(request);
    if (idempotencyKey) {
      const replayId = assertIdempotentReplay(idempotency.get(idempotencyKey), requestFingerprint);
      if (replayId) {
        const replay = jobs.get(replayId);
        if (replay) return publicJob(replay);
      }
    }

    await preflight(request.mode);
    const id = "sol-" + Date.now().toString(36) + "-" + randomUUID().replaceAll("-", "").slice(0, 10);
    const job = {
      id,
      request,
      requestFingerprint,
      idempotencyKey,
      status: "queued",
      stage: STAGE_META.queued.stage,
      progress: 0,
      createdAt: clock(),
      updatedAt: clock(),
      startedAt: null,
      finishedAt: null,
      retryOf: retryOf || null,
      cancelRequested: false,
      eventSeq: 0,
      events: [],
      error: "",
      errorCode: null,
      outputMetadata: null,
      pipelineFingerprint: null,
      timing: null,
    };
    await store.create(job);
    jobs.set(id, job);
    if (idempotencyKey) idempotency.set(idempotencyKey, { jobId: id, requestFingerprint });
    await enqueueMutation(job, () => appendEventUnsafe(job, {
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      created: true,
    }));
    setImmediate(() => { void run(job); });
    return publicJob(job);
  }

  async function list() {
    await ensureInitialized();
    return [...jobs.values()]
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .slice(0, 100)
      .map(publicJob);
  }

  async function get(id) {
    await ensureInitialized();
    return publicJob(jobs.get(safeId(id)) || null);
  }

  async function cancel(id) {
    await ensureInitialized();
    const cleanId = safeId(id);
    const job = jobs.get(cleanId);
    if (!job) throw solH3Error("SOL_H3_JOB_NOT_FOUND", "Sol-H3 job not found.", 404);
    if (isSolH3TerminalState(job.status)) return publicJob(job);
    if (job.status !== "cancel_requested") {
      await transition(job, "cancel_requested", { cancelRequested: true, stage: "正在取消 Sol-H3 worker" });
    }
    admissions.get(cleanId)?.cancel?.("Sol-H3 cancellation requested.");
    runner.cancel(cleanId);
    if (!admissions.has(cleanId) && !leases.has(cleanId)) {
      await transition(job, "cancelled", { stage: "已取消", finishedAt: clock(), error: "", errorCode: null });
    }
    return publicJob(job);
  }

  async function retry(id) {
    await ensureInitialized();
    const cleanId = safeId(id);
    const source = jobs.get(cleanId);
    if (!source) throw solH3Error("SOL_H3_JOB_NOT_FOUND", "Sol-H3 job not found.", 404);
    if (!["failed", "interrupted"].includes(source.status)) {
      throw solH3Error("SOL_H3_RETRY_NOT_ALLOWED", "Only failed or interrupted Sol-H3 jobs can be retried.", 409, { status: source.status });
    }
    return await create(source.request, { retryOf: source.id });
  }

  async function output(id, outputId, req, res) {
    await ensureInitialized();
    const job = jobs.get(safeId(id));
    if (!job || job.status !== "succeeded" || outputId !== "final") {
      throw solH3Error("SOL_H3_OUTPUT_NOT_FOUND", "Sol-H3 output not found.", 404);
    }
    const filePath = path.join(store.directory(job.id), "outputs", "final.mp4");
    const stat = await fsApi.lstat(filePath).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) throw solH3Error("SOL_H3_OUTPUT_NOT_FOUND", "Sol-H3 output not found.", 404);
    const baseHeaders = {
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=0, must-revalidate",
      "X-Content-Type-Options": "nosniff",
    };
    const range = String(req.headers.range || "").match(/^bytes=(\d*)-(\d*)$/u);
    if (!range) {
      res.writeHead(200, { ...baseHeaders, "Content-Length": stat.size });
      createReadStream(filePath).pipe(res);
      return true;
    }
    if (!range[1] && !range[2]) {
      res.writeHead(416, { "Content-Range": "bytes */" + stat.size });
      res.end();
      return true;
    }
    const suffix = !range[1] ? Number(range[2]) : null;
    const start = suffix !== null ? Math.max(0, stat.size - suffix) : Number(range[1]);
    const end = suffix !== null ? stat.size - 1 : (range[2] ? Math.min(stat.size - 1, Number(range[2])) : stat.size - 1);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= stat.size) {
      res.writeHead(416, { "Content-Range": "bytes */" + stat.size });
      res.end();
      return true;
    }
    res.writeHead(206, {
      ...baseHeaders,
      "Content-Length": end - start + 1,
      "Content-Range": "bytes " + start + "-" + end + "/" + stat.size,
    });
    createReadStream(filePath, { start, end }).pipe(res);
    return true;
  }

  async function streamEvents(id, req, res) {
    await ensureInitialized();
    const cleanId = safeId(id);
    const job = jobs.get(cleanId);
    if (!job) throw solH3Error("SOL_H3_JOB_NOT_FOUND", "Sol-H3 job not found.", 404);
    writeSolH3SseHeaders(res);
    res.flushHeaders?.();
    for (const event of job.events || []) {
      writeSolH3SseEvent(res, event, { eventName: "job", id: event.seq });
    }
    writeSolH3SseEvent(res, publicJob(job), { eventName: "snapshot", id: job.eventSeq || 0 });
    if (isSolH3TerminalState(job.status)) {
      writeSolH3SseEvent(res, publicJob(job), { eventName: "done", id: job.eventSeq || 0 });
      res.end();
      return true;
    }

    let cleaned = false;
    let unsubscribe = () => {};
    const keepalive = setInterval(() => writeSolH3SseComment(res), SSE_KEEPALIVE_MS);
    keepalive.unref?.();
    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      clearInterval(keepalive);
      unsubscribe();
    }
    unsubscribe = subscribe(cleanId, (event, snapshot) => {
      writeSolH3SseEvent(res, { event, job: snapshot }, { eventName: "job", id: event.seq });
      if (isSolH3TerminalState(snapshot.status)) {
        writeSolH3SseEvent(res, snapshot, { eventName: "done", id: event.seq });
        cleanup();
        res.end();
      }
    });
    req.once("close", cleanup);
    res.once?.("close", cleanup);
    return true;
  }

  async function close() {
    for (const admission of admissions.values()) admission.cancel?.("Sol-H3 controller shutdown.");
    await runner.close();
    for (const lease of leases.values()) lease.release?.();
    leases.clear();
    admissions.clear();
    await Promise.allSettled([...mutationTails.values()]);
    const hostLock = await readLock(config.hostLockFile);
    if (Number(hostLock?.pid) === process.pid) await fsApi.unlink(config.hostLockFile).catch(() => {});
    if (managerLockOwned) {
      const managerLock = await readLock(managerLockFile);
      if (Number(managerLock?.pid) === process.pid) await fsApi.unlink(managerLockFile).catch(() => {});
      managerLockOwned = false;
    }
    unregisterLifecycle();
  }

  function capabilities() {
    return {
      enabled: config.enabled,
      schemaVersion: config.schemaVersion,
      mediaRoots: ["comfyui-input", "comfyui-output"],
      durationProfiles: Object.values(SOL_H3_DURATION_PROFILES).map((profile) => ({ ...profile })),
      controls: {
        durationSeconds: { type: "enum", values: [5, 10], default: 5 },
        seed: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 42 },
        refImageMatch: { type: "enum", values: ["stage1", "stage2"], modes: ["ref2va"] },
        refStage1Attn: { type: "enum", values: ["dense", "sol"], modes: ["ref2va"] },
      },
      fixedRecipe: { stage1Updates: 4, stage2Updates: 3, width: 1344, height: 768, fps: 24,
        audio: "native H3 PCM → AAC stereo", resolutionEditable: false, fpsEditable: false,
        stepsEditable: false },
      modes: {
        t2va: { label: "文字 → 影片＋音訊", inputs: "none", output: { ...SOL_H3_OUTPUT_SPEC } },
        fl2va: { label: "首幀＋尾幀 → 影片＋音訊", inputs: "firstFrame+lastFrame", output: { ...SOL_H3_OUTPUT_SPEC } },
        ref2va: { label: "參考素材 → 影片＋音訊", inputs: "exactly one image/video/audio locator; WebUI exposes image/video in MVP", output: { ...SOL_H3_OUTPUT_SPEC } },
      },
    };
  }

  async function handleRoute(req, res, { pathname, readJson, sendJson, sendError }) {
    try {
      if (pathname === "/api/sol-h3/capabilities") {
        if (req.method !== "GET") return sendError(res, 405, "Capabilities endpoint only supports GET.", "METHOD_NOT_ALLOWED");
        sendJson(res, 200, capabilities());
        return true;
      }
      if (pathname === "/api/sol-h3/health" || pathname === "/api/sol-h3/readiness") {
        if (req.method !== "GET") return sendError(res, 405, "Readiness endpoint only supports GET.", "METHOD_NOT_ALLOWED");
        sendJson(res, 200, await health());
        return true;
      }
      if (pathname === "/api/sol-h3/jobs") {
        if (req.method === "GET") {
          sendJson(res, 200, { jobs: await list() });
          return true;
        }
        if (req.method === "POST") {
          const job = await create(await readJson(req), { idempotencyKey: req.headers["idempotency-key"] });
          sendJson(res, 202, { job });
          return true;
        }
        return sendError(res, 405, "Sol-H3 jobs endpoint only supports GET and POST.", "METHOD_NOT_ALLOWED");
      }

      const outputMatch = pathname.match(/^\/api\/sol-h3\/jobs\/([^/]+)\/outputs\/([^/]+)$/u);
      if (outputMatch && req.method === "GET") return await output(outputMatch[1], outputMatch[2], req, res);
      const actionMatch = pathname.match(/^\/api\/sol-h3\/jobs\/([^/]+)(?:\/(cancel|retry|events))?$/u);
      if (!actionMatch) return false;
      const id = actionMatch[1];

      if (!actionMatch[2] && req.method === "GET") {
        const job = await get(id);
        if (!job) return sendError(res, 404, "Sol-H3 job not found.", "SOL_H3_JOB_NOT_FOUND");
        sendJson(res, 200, { job });
        return true;
      }
      if (actionMatch[2] === "cancel" && req.method === "POST") {
        sendJson(res, 202, { job: await cancel(id) });
        return true;
      }
      if (actionMatch[2] === "retry" && req.method === "POST") {
        sendJson(res, 202, { job: await retry(id) });
        return true;
      }
      if (actionMatch[2] === "events" && req.method === "GET") {
        const requestUrl = new URL(req.url || pathname, "http://localhost");
        if (requestUrl.searchParams.get("poll") === "1") {
          const job = await get(id);
          if (!job) return sendError(res, 404, "Sol-H3 job not found.", "SOL_H3_JOB_NOT_FOUND");
          sendJson(res, 200, { events: job.events || [], job });
          return true;
        }
        return await streamEvents(id, req, res);
      }
      return sendError(res, 405, "Unsupported Sol-H3 job operation.", "METHOD_NOT_ALLOWED");
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      sendJson(res, status, {
        error: publicError(error),
        code: error?.code || "SOL_H3_REQUEST_FAILED",
        ...(error?.details && typeof error.details === "object" ? { details: error.details } : {}),
      });
      return true;
    }
  }

  unregisterLifecycle = registerSolH3Lifecycle(close);
  return Object.freeze({ handleRoute, capabilities, health, create, get, list, cancel, retry, close });
}
