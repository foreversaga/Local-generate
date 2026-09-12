import { promises as fs, createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";

import { createSolH3Readiness } from "./readiness.mjs";
import {
  inferSolH3MediaKind,
  normalizeSolH3MediaLocator,
  normalizeSolH3Request,
  SOL_H3_OUTPUT_SPEC,
  solH3Error,
} from "./request.mjs";
import { DEFAULT_SOL_H3_RUNTIME_CONFIG } from "./runtime-config.mjs";

const ACTIVE = new Set(["queued", "waiting_gpu", "preparing", "qwen_running", "stage1_running", "upscaling", "adapting", "stage2_running", "validating", "cancel_requested"]);
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"]);

function now() {
  return new Date().toISOString();
}

function safeId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(id)) {
    throw solH3Error("SOL_H3_JOB_ID_INVALID", "Sol-H3 job id is invalid.", 400);
  }
  return id;
}

function safeOutputPath(root, id) {
  const jobPath = path.resolve(root, safeId(id));
  const resolvedRoot = path.resolve(root);
  if (jobPath !== resolvedRoot && !jobPath.startsWith(resolvedRoot + path.sep)) {
    throw solH3Error("SOL_H3_JOB_PATH_INVALID", "Sol-H3 job path is invalid.", 400);
  }
  return jobPath;
}

function publicError(error) {
  return String(error?.message || error || "Sol-H3 job failed.")
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s,;]+/g, "[redacted path]")
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
  return {
    id: job.id,
    schemaVersion: job.request?.schemaVersion || 1,
    mode: job.request?.mode || job.mode,
    prompt: job.request?.prompt || "",
    seed: job.request?.seed ?? null,
    status: job.status,
    stage: job.stage,
    progress: Number.isFinite(Number(job.progress)) ? Number(job.progress) : null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    output,
    outputSpec: { ...SOL_H3_OUTPUT_SPEC },
    error: job.error ? publicError(job.error) : "",
    cancelRequested: Boolean(job.cancelRequested),
    gpu: job.gpu || null,
    events: Array.isArray(job.events) ? job.events.slice(-40) : [],
  };
}

async function atomicWriteJson(filePath, value, fsApi) {
  const temporary = filePath + "." + process.pid + "." + randomUUID() + ".tmp";
  await fsApi.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  try {
    await fsApi.rename(temporary, filePath);
  } catch (error) {
    await fsApi.unlink(temporary).catch(() => {});
    throw error;
  }
}

function commandBase(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

async function checkConflictUrls(urls, fetcher = fetch) {
  const conflicts = [];
  for (const url of urls || []) {
    try {
      const response = await fetcher(commandBase(url) + "/models", { signal: AbortSignal.timeout(1200) });
      if (response.ok) conflicts.push(url);
    } catch {
      // An unavailable configured conflict service is not a conflict.
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

export function createSolH3Controller({
  config = DEFAULT_SOL_H3_RUNTIME_CONFIG,
  fsApi = fs,
  spawnApi = spawn,
  fetcher = fetch,
  resolveMediaPath,
  gpuCoordinator = null,
  clock = now,
} = {}) {
  if (!config || typeof config !== "object" || typeof resolveMediaPath !== "function") {
    throw new TypeError("Sol-H3 controller dependencies are incomplete.");
  }
  const readiness = createSolH3Readiness({ config, fsApi });
  const jobs = new Map();
  const children = new Map();
  const admissions = new Map();
  const saveTails = new Map();
  let initialized;

  function jobDirectory(id) {
    return safeOutputPath(config.jobRoot, id);
  }

  function statePath(id) {
    return path.join(jobDirectory(id), "state.json");
  }

  function eventPath(id) {
    return path.join(jobDirectory(id), "events.jsonl");
  }

  async function persist(job) {
    job.updatedAt = clock();
    await fsApi.mkdir(jobDirectory(job.id), { recursive: true });
    const previous = saveTails.get(job.id) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => atomicWriteJson(statePath(job.id), job, fsApi));
    const tracked = next.finally(() => {
      if (saveTails.get(job.id) === tracked) saveTails.delete(job.id);
    });
    saveTails.set(job.id, tracked);
    await next;
  }

  async function appendEvent(job, event) {
    const record = { at: clock(), ...event };
    job.events = [...(Array.isArray(job.events) ? job.events : []), record].slice(-200);
    await fsApi.mkdir(jobDirectory(job.id), { recursive: true });
    await fsApi.appendFile(eventPath(job.id), JSON.stringify(record) + "\n", "utf8").catch(() => {});
    await persist(job);
  }

  async function update(job, patch, event = {}) {
    Object.assign(job, patch);
    await appendEvent(job, { status: job.status, stage: job.stage, progress: job.progress, ...event });
  }

  async function clearStaleLock() {
    const lock = await fsApi.readFile(config.hostLockFile, "utf8")
      .then((text) => JSON.parse(text))
      .catch(() => null);
    if (!lock || !lock.pid || await processAlive(lock.pid)) return lock;
    await fsApi.unlink(config.hostLockFile).catch(() => {});
    return null;
  }

  async function ensureInitialized() {
    if (initialized) return initialized;
    initialized = (async () => {
      await fsApi.mkdir(config.jobRoot, { recursive: true });
      await clearStaleLock();
      const entries = await fsApi.readdir(config.jobRoot, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const id = entry.name;
        const state = await fsApi.readFile(path.join(config.jobRoot, id, "state.json"), "utf8")
          .then((text) => JSON.parse(text))
          .catch(() => null);
        if (!state?.id) continue;
        if (ACTIVE.has(state.status)) {
          state.status = "interrupted";
          state.stage = "服務重啟，工作已中斷";
          state.error = "The WebUI restarted before this Sol-H3 job completed.";
          state.finishedAt = clock();
          state.cancelRequested = false;
          await persist(state).catch(() => {});
        }
        jobs.set(state.id, state);
      }
      return true;
    })();
    return initialized;
  }

  async function inspectConflicts() {
    return await checkConflictUrls(config.conflictUrls, fetcher);
  }

  async function health() {
    await ensureInitialized();
    const conflicts = await inspectConflicts();
    const gpu = gpuCoordinator?.snapshot?.() || { active: null, queue: [], activeCount: 0, queuedCount: 0, totalCount: 0 };
    const result = await readiness.inspect({ gpu, conflicts });
    const lock = await fsApi.readFile(config.hostLockFile, "utf8")
      .then((text) => JSON.parse(text))
      .catch(() => null);
    return {
      ...result,
      hostLock: lock ? { held: true, owner: String(lock.owner || "unknown") } : { held: false },
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
        conflicts: result.conflicts.map((item) => String(item).replace(/\/v1\/?$/, "")),
      });
    }
    if (result.hostLock?.held) {
      throw solH3Error("SOL_H3_HOST_LOCKED", "Another Sol-H3 worker owns the accelerator lock.", 409);
    }
    return result;
  }

  async function copyInput(locator, destination, expectedKinds) {
    const normalized = normalizeSolH3MediaLocator(locator, "input");
    const sourcePath = await resolveMediaPath(normalized.root, normalized.relativePath);
    const sourceStat = await fsApi.lstat(sourcePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw solH3Error("SOL_H3_MEDIA_NOT_REGULAR", "Input media must be a regular file.", 422);
    }
    const kind = inferSolH3MediaKind(normalized.relativePath, normalized.kind);
    if (!expectedKinds.includes(kind)) {
      throw solH3Error("SOL_H3_MEDIA_KIND_INVALID", "The selected media type is not valid for this mode.", 422, {
        expected: expectedKinds,
        actual: kind,
      });
    }
    if (normalized.fingerprint?.size !== undefined && normalized.fingerprint.size !== sourceStat.size) {
      throw solH3Error("SOL_H3_MEDIA_CHANGED", "The selected media changed before staging.", 409);
    }
    if (normalized.fingerprint?.mtimeMs !== undefined && Math.abs(normalized.fingerprint.mtimeMs - sourceStat.mtimeMs) > 1) {
      throw solH3Error("SOL_H3_MEDIA_CHANGED", "The selected media changed before staging.", 409);
    }
    await fsApi.mkdir(path.dirname(destination), { recursive: true });
    await fsApi.copyFile(sourcePath, destination);
    const stagedStat = await fsApi.stat(destination);
    if (stagedStat.size !== sourceStat.size) throw solH3Error("SOL_H3_MEDIA_STAGE_FAILED", "Staged media size did not match the source.", 409);
    return { path: destination, kind, size: sourceStat.size, mtimeMs: sourceStat.mtimeMs };
  }

  async function stageRequest(job, request) {
    const inputsRoot = path.join(jobDirectory(job.id), "inputs");
    const casesRoot = path.join(jobDirectory(job.id), "intermediates");
    const caseFile = path.join(casesRoot, "request.jsonl");
    await fsApi.mkdir(casesRoot, { recursive: true });
    const caseRecord = {
      case_id: "generation",
      prompt: request.prompt,
      seed: request.seed,
      task: request.mode,
    };
    if (request.mode === "fl2va") {
      const first = await copyInput(
        request.inputs.firstFrame,
        path.join(inputsRoot, "first-frame" + path.extname(request.inputs.firstFrame.relativePath).toLowerCase()),
        ["image"],
      );
      const last = await copyInput(
        request.inputs.lastFrame,
        path.join(inputsRoot, "last-frame" + path.extname(request.inputs.lastFrame.relativePath).toLowerCase()),
        ["image"],
      );
      caseRecord.first_frame = first.path;
      caseRecord.last_frame = last.path;
    }
    if (request.mode === "ref2va") {
      const reference = request.inputs.references[0];
      const extension = path.extname(reference.relativePath).toLowerCase();
      const referenceKind = inferSolH3MediaKind(reference.relativePath, reference.kind);
      if (!referenceKind || (referenceKind === "audio" && !AUDIO_EXTENSIONS.has(extension))) {
        throw solH3Error("SOL_H3_REFERENCE_KIND_UNKNOWN", "ref2va reference must be an image, video, or supported audio file.", 422);
      }
      const staged = await copyInput(reference, path.join(inputsRoot, "reference" + extension), ["image", "video", "audio"]);
      caseRecord.references = [{ type: staged.kind, path: staged.path }];
    }
    await fsApi.writeFile(caseFile, JSON.stringify(caseRecord) + "\n", "utf8");
    return { caseFile, inputsRoot };
  }

  async function runnerPathsFile(task) {
    const requiredKey = task === "ref2va" ? "ref2va_lora" : "vsa_lora";
    const candidates = [config.taskPaths?.[task], config.pathsFile, config.fallbackCheckpointPathsFile].filter(Boolean);
    for (const candidate of candidates) {
      const manifest = await fsApi.readFile(candidate, "utf8")
        .then((text) => JSON.parse(text))
        .catch(() => null);
      if (manifest && typeof manifest[requiredKey] === "string" && manifest[requiredKey].trim()) return candidate;
    }
    throw solH3Error("SOL_H3_PATHS_NOT_READY", "No task-compatible Sol-H3 path manifest is prepared.", 503, { task });
  }

  async function runnerPython(pathsFile) {
    if (config.inferPython) return config.inferPython;
    const manifest = await fsApi.readFile(pathsFile, "utf8")
      .then((text) => JSON.parse(text))
      .catch(() => null);
    return String(manifest?.stage2_python || manifest?.qwen_python || "python3").trim() || "python3";
  }

  function updateFromLine(job, line) {
    const text = String(line || "").trim();
    if (!text) return;
    const lower = text.toLowerCase();
    const stages = [
      ["qwen", "qwen_running", 20, "Qwen prompt processing"],
      ["stage1", "stage1_running", 40, "H3 Stage 1"],
      ["upscal", "upscaling", 60, "H3 latent upscaler"],
      ["adapter", "adapting", 68, "H3-to-LTX adapter"],
      ["stage2", "stage2_running", 80, "LTX-2.5 Stage 2"],
      ["mux", "validating", 92, "封裝影片與音訊"],
    ];
    const selected = stages.find(([needle]) => lower.includes(needle));
    if (!selected || TERMINAL.has(job.status)) return;
    job.status = selected[1];
    job.stage = selected[3];
    job.progress = Math.max(Number(job.progress) || 0, selected[2]);
    job.updatedAt = clock();
    void persist(job).catch(() => {});
  }

  function runCommand(command, args, options) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnApi(command, args, options);
      } catch (error) {
        reject(error);
        return;
      }
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, 24 * 60 * 60 * 1000);
      const append = (value, chunk) => (value + String(chunk)).slice(-64 * 1024);
      child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
      child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
      child.stdout?.on("data", (chunk) => String(chunk).split(/\r?\n/).forEach((line) => updateFromLine(options.job, line)));
      child.stderr?.on("data", (chunk) => String(chunk).split(/\r?\n/).forEach((line) => updateFromLine(options.job, line)));
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, stdout, stderr, timedOut, child });
      });
    });
  }

  async function acquireHostLock(job) {
    await fsApi.mkdir(config.runtimeRoot, { recursive: true });
    let handle;
    try {
      handle = await fsApi.open(config.hostLockFile, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, owner: job.id, acquiredAt: clock() }) + "\n", "utf8");
    } catch {
      await handle?.close().catch(() => {});
      throw solH3Error("SOL_H3_HOST_LOCKED", "Another Sol-H3 worker owns the accelerator lock.", 409);
    }
    await handle.close();
    return async () => { await fsApi.unlink(config.hostLockFile).catch(() => {}); };
  }

  async function findMp4(outputRoot) {
    const result = [];
    async function walk(directory) {
      const entries = await fsApi.readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".mp4") result.push(file);
      }
    }
    await walk(outputRoot);
    return result;
  }

  async function findFormalMp4(outputRoot) {
    const candidates = await findMp4(outputRoot);
    const formal = candidates.filter((file) => {
      const relative = path.relative(outputRoot, file).split(path.sep);
      return relative[0] === "generation" && path.basename(file) === "refined_1344x768_121f.mp4";
    });
    if (formal.length !== 1) {
      throw solH3Error("SOL_H3_OUTPUT_COUNT_INVALID", "Sol-H3 job did not produce exactly one formal MP4 output.", 502, {
        count: formal.length,
        totalMp4: candidates.length,
      });
    }
    return formal[0];
  }

  async function probeOutput(filePath) {
    const ffprobe = String(process.env.FFPROBE_PATH || "ffprobe");
    const result = await runCommand(ffprobe, [
      "-v", "error",
      "-count_frames",
      "-show_entries", "stream=index,codec_type,codec_name,width,height,nb_read_frames,r_frame_rate",
      "-show_entries", "format=format_name",
      "-of", "json",
      filePath,
    ], { job: { status: "validating", progress: 96, stage: "驗證 MP4/AAC 輸出" } }).catch((error) => {
      throw solH3Error("SOL_H3_FFPROBE_UNAVAILABLE", "ffprobe is required to validate the Sol-H3 output.", 503, { cause: publicError(error) });
    });
    if (result.code !== 0) throw solH3Error("SOL_H3_OUTPUT_INVALID", "ffprobe could not decode the Sol-H3 output.", 502);
    let metadata;
    try { metadata = JSON.parse(result.stdout); } catch { throw solH3Error("SOL_H3_OUTPUT_INVALID", "ffprobe returned invalid output metadata.", 502); }
    const streams = Array.isArray(metadata.streams) ? metadata.streams : [];
    const video = streams.find((stream) => stream.codec_type === "video");
    const audio = streams.find((stream) => stream.codec_type === "audio");
    const fps = String(video?.r_frame_rate || "");
    const frames = Number(video?.nb_read_frames);
    const fpsValue = fps.includes("/") ? Number(fps.split("/")[0]) / Number(fps.split("/")[1]) : Number(fps);
    const format = String(metadata.format?.format_name || "").split(",").includes("mov") || String(metadata.format?.format_name || "").split(",").includes("mp4");
    if (!video || !audio || audio.codec_name !== SOL_H3_OUTPUT_SPEC.audioCodec
      || video.width !== SOL_H3_OUTPUT_SPEC.width || video.height !== SOL_H3_OUTPUT_SPEC.height
      || frames !== SOL_H3_OUTPUT_SPEC.frames || Math.abs(fpsValue - SOL_H3_OUTPUT_SPEC.fps) > 0.01 || !format) {
      throw solH3Error("SOL_H3_OUTPUT_CONTRACT_FAILED", "Sol-H3 output did not meet the MP4/AAC/frames/FPS contract.", 502, {
        video: video ? { width: video.width, height: video.height, frames, fps: fpsValue } : null,
        audio: audio ? { codec: audio.codec_name } : null,
      });
    }
    return { format: metadata.format?.format_name || "mp4", video: { width: video.width, height: video.height, frames, fps: fpsValue }, audio: { codec: audio.codec_name } };
  }

  async function run(job) {
    let lease;
    let releaseLock;
    try {
      const admission = gpuCoordinator?.request?.({
        requestId: "sol-h3:" + job.id,
        jobId: "sol-h3:" + job.id,
        workloadType: "sol-h3",
        runtime: "local",
        metadata: { mode: job.request.mode },
      });
      if (admission) admissions.set(job.id, admission);
      await update(job, { status: "waiting_gpu", stage: "等待 GPU 排他資源", progress: 2 });
      lease = admission ? await admission.granted : null;
      if (job.cancelRequested) throw solH3Error("SOL_H3_CANCELLED", "Sol-H3 job was cancelled.", 499);
      const currentHealth = await preflight(job.request.mode);
      job.gpu = currentHealth.gpu;
      releaseLock = await acquireHostLock(job);
      await update(job, { status: "preparing", stage: "準備輸入與官方 runtime", progress: 5 });
      const staged = await stageRequest(job, job.request);
      const outputRoot = path.join(jobDirectory(job.id), "outputs");
      await fsApi.mkdir(outputRoot, { recursive: true });
      await update(job, { status: "qwen_running", stage: "啟動官方 Sol-H3 pipeline", progress: 10 });
      const pathsFile = await runnerPathsFile(job.request.mode);
      const args = [
        config.inferPath,
        "--paths", pathsFile,
        "--prompts", staged.caseFile,
        "--task", job.request.mode,
        "--output-dir", outputRoot,
      ];
      const child = spawnApi(await runnerPython(pathsFile), args, {
        cwd: config.sanaPackageRoot,
        env: {
          ...process.env,
          HF_HUB_OFFLINE: "1",
          TRANSFORMERS_OFFLINE: "1",
          HF_HUB_DISABLE_IMPLICIT_TOKEN: "1",
          PYTHONUNBUFFERED: "1",
          PYTHONPATH: [config.sanaPackageRoot, process.env.PYTHONPATH || ""].filter(Boolean).join(path.delimiter),
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      children.set(job.id, child);
      let logTail = "";
      const handleOutput = (chunk) => {
        logTail = (logTail + String(chunk)).slice(-64 * 1024);
        String(chunk).split(/\r?\n/).forEach((line) => updateFromLine(job, line));
        void fsApi.appendFile(path.join(jobDirectory(job.id), "logs.txt"), String(chunk), "utf8").catch(() => {});
      };
      child.stdout?.on("data", handleOutput);
      child.stderr?.on("data", handleOutput);
      const exit = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => child.kill("SIGTERM"), 24 * 60 * 60 * 1000);
        child.once("error", reject);
        child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
      });
      children.delete(job.id);
      if (job.cancelRequested) throw solH3Error("SOL_H3_CANCELLED", "Sol-H3 job was cancelled.", 499);
      if (exit.code !== 0) throw solH3Error("SOL_H3_RUNNER_FAILED", "Official Sol-H3 runner failed.", 502, { exitCode: exit.code, signal: exit.signal, logTail: publicError(logTail) });
      await update(job, { status: "validating", stage: "驗證輸出影片與音訊", progress: 94 });
      const sourceOutput = await findFormalMp4(outputRoot);
      const finalOutput = path.join(outputRoot, "final.mp4");
      if (sourceOutput !== finalOutput) await fsApi.rename(sourceOutput, finalOutput);
      const metadata = await probeOutput(finalOutput);
      await update(job, { status: "succeeded", stage: "完成（MP4＋AAC 已驗證）", progress: 100, finishedAt: clock(), outputMetadata: metadata, error: "" });
    } catch (error) {
      const cancelled = error?.code === "SOL_H3_CANCELLED" || job.cancelRequested;
      await update(job, {
        status: cancelled ? "cancelled" : "failed",
        stage: cancelled ? "已取消" : "失敗",
        progress: cancelled ? job.progress : null,
        finishedAt: clock(),
        error: publicError(error),
        errorCode: error?.code || "SOL_H3_JOB_FAILED",
      }).catch(() => {});
    } finally {
      children.delete(job.id);
      admissions.delete(job.id);
      releaseLock?.();
      lease?.release?.();
    }
  }

  async function create(payload) {
    await ensureInitialized();
    const request = normalizeSolH3Request(payload);
    await preflight(request.mode);
    const id = "sol-" + Date.now().toString(36) + "-" + randomUUID().replaceAll("-", "").slice(0, 10);
    const job = {
      id,
      request,
      status: "queued",
      stage: "已建立，等待 GPU",
      progress: 0,
      createdAt: clock(),
      updatedAt: clock(),
      finishedAt: null,
      startedAt: null,
      cancelRequested: false,
      events: [],
      error: "",
      outputMetadata: null,
    };
    jobs.set(id, job);
    await persist(job);
    void run(job);
    return publicJob(job);
  }

  async function list() {
    await ensureInitialized();
    return [...jobs.values()]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
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
    if (TERMINAL.has(job.status)) return publicJob(job);
    job.cancelRequested = true;
    job.status = "cancel_requested";
    job.stage = "正在取消 Sol-H3 worker";
    const admission = admissions.get(cleanId);
    admission?.cancel?.("Sol-H3 cancellation requested.");
    const child = children.get(cleanId);
    if (child) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    }
    await persist(job);
    return publicJob(job);
  }

  async function output(id, outputId, req, res) {
    await ensureInitialized();
    const job = jobs.get(safeId(id));
    if (!job || job.status !== "succeeded" || outputId !== "final") {
      throw solH3Error("SOL_H3_OUTPUT_NOT_FOUND", "Sol-H3 output not found.", 404);
    }
    const filePath = path.join(jobDirectory(job.id), "outputs", "final.mp4");
    const stat = await fsApi.stat(filePath).catch(() => null);
    if (!stat?.isFile()) throw solH3Error("SOL_H3_OUTPUT_NOT_FOUND", "Sol-H3 output not found.", 404);
    const headers = {
      "Content-Type": "video/mp4",
      "Content-Length": stat.size,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=0, must-revalidate",
      "X-Content-Type-Options": "nosniff",
    };
    const range = String(req.headers.range || "").match(/^bytes=(\d*)-(\d*)$/);
    if (range) {
      const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2] || 0));
      const end = range[2] ? Math.min(stat.size - 1, Number(range[2])) : stat.size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= stat.size) {
        res.writeHead(416, { "Content-Range": "bytes */" + stat.size });
        res.end();
        return true;
      }
      res.writeHead(206, { ...headers, "Content-Length": end - start + 1, "Content-Range": "bytes " + start + "-" + end + "/" + stat.size });
      createReadStream(filePath, { start, end }).pipe(res);
      return true;
    }
    res.writeHead(200, headers);
    createReadStream(filePath).pipe(res);
    return true;
  }

  async function handleRoute(req, res, { pathname, readJson, sendJson, sendError }) {
    try {
      if (pathname === "/api/sol-h3/capabilities") {
        if (req.method !== "GET") return sendError(res, 405, "Capabilities endpoint only supports GET.", "METHOD_NOT_ALLOWED");
        sendJson(res, 200, {
          enabled: config.enabled,
          schemaVersion: config.schemaVersion,
          modes: {
            t2va: { label: "文字 → 影片＋音訊", inputs: "none", output: { ...SOL_H3_OUTPUT_SPEC } },
            fl2va: { label: "首幀＋尾幀 → 影片＋音訊", inputs: "firstFrame+lastFrame", output: { ...SOL_H3_OUTPUT_SPEC } },
            ref2va: { label: "參考素材 → 影片＋音訊", inputs: "one image/video reference in MVP", output: { ...SOL_H3_OUTPUT_SPEC } },
          },
        });
        return true;
      }
      if (pathname === "/api/sol-h3/health" || pathname === "/api/sol-h3/readiness") {
        if (req.method !== "GET") return sendError(res, 405, "Readiness endpoint only supports GET.", "METHOD_NOT_ALLOWED");
        sendJson(res, 200, await health());
        return true;
      }
      if (pathname === "/api/sol-h3/jobs") {
        if (req.method === "GET") { sendJson(res, 200, { jobs: await list() }); return true; }
        if (req.method === "POST") { sendJson(res, 202, { job: await create(await readJson(req)) }); return true; }
        return sendError(res, 405, "Sol-H3 jobs endpoint only supports GET and POST.", "METHOD_NOT_ALLOWED");
      }
      const outputMatch = pathname.match(/^\/api\/sol-h3\/jobs\/([^/]+)\/outputs\/([^/]+)$/);
      if (outputMatch && req.method === "GET") return await output(outputMatch[1], outputMatch[2], req, res);
      const actionMatch = pathname.match(/^\/api\/sol-h3\/jobs\/([^/]+)(?:\/(cancel|events))?$/);
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
      if (actionMatch[2] === "events" && req.method === "GET") {
        const job = await get(id);
        if (!job) return sendError(res, 404, "Sol-H3 job not found.", "SOL_H3_JOB_NOT_FOUND");
        sendJson(res, 200, { events: job.events || [] });
        return true;
      }
      return sendError(res, 405, "Unsupported Sol-H3 job operation.", "METHOD_NOT_ALLOWED");
    } catch (error) {
      sendError(res, Number.isInteger(error?.status) ? error.status : 500, publicError(error), error?.code || "SOL_H3_REQUEST_FAILED");
      return true;
    }
  }

  return Object.freeze({ handleRoute, health, create, get, list, cancel });
}
