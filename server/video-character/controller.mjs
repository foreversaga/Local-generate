import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const ACTIVE = new Set(["queued", "running"]);
const MODES = new Set(["replace", "dwpose"]);
const DEFAULT_NEGATIVE = "blurry, flicker, identity drift, face distortion, deformed hands, extra limbs, duplicate person, warped background, cropped head, cropped limbs";
const STAGING_ROOT = ".video-character-staging";

function now() { return new Date().toISOString(); }

function safeId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(id)) throw Object.assign(new Error("Invalid video-character job id."), { status: 400, code: "VIDEO_CHARACTER_JOB_ID_INVALID" });
  return id;
}

export async function cleanupVideoCharacterStaging({ inputRoot, outputRoot, id, fsApi = fs }) {
  const cleanId = safeId(id);
  for (const rootValue of [inputRoot, outputRoot]) {
    if (!rootValue) continue;
    const root = path.resolve(rootValue);
    const stagingRoot = path.join(root, STAGING_ROOT);
    const target = path.join(stagingRoot, cleanId);
    if (!target.startsWith(`${stagingRoot}${path.sep}`)) throw new Error("Invalid video-character staging path.");
    await fsApi.rm(target, { recursive: true, force: true });
    if (typeof fsApi.rmdir === "function") {
      await fsApi.rmdir(stagingRoot).catch((error) => {
        if (!error || !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
      });
    }
  }
}

function safeRelative(value) {
  const normalized = String(value || "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0")) return "";
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[<>:"|?*]/.test(part))) return "";
  return normalized;
}

function safeAsset(value) {
  if (!value || typeof value !== "object") return null;
  const name = safeRelative(value.name);
  const root = value.root === "output" ? "output" : value.root === "input" ? "input" : "";
  return name && root ? { root, name } : null;
}

function finiteNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
}

function integer(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    mode: job.mode,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    progressSource: job.progressSource || "unknown",
    phase: job.phase || "prepare",
    nativeCurrent: Number.isFinite(Number(job.nativeCurrent)) ? Number(job.nativeCurrent) : null,
    nativeMaximum: Number.isFinite(Number(job.nativeMaximum)) ? Number(job.nativeMaximum) : null,
    chunkIndex: Number.isInteger(job.chunkIndex) ? job.chunkIndex : null,
    chunkCount: Number.isInteger(job.chunkCount) ? job.chunkCount : null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt || null,
    source: job.source,
    references: job.references,
    settings: job.settings,
    output: job.output || null,
    error: job.error || "",
    workspace: {
      path: job.workspaceRelative,
      exists: Boolean(job.workspaceExists),
      clearedAt: job.workspaceClearedAt || null,
    },
    memory: Array.isArray(job.memory) ? job.memory.slice(-120) : [],
  };
}

export function createVideoCharacterController({
  dataRoot,
  inputRoot,
  outputRoot,
  runtimeRoot,
  comfyUrl = "http://127.0.0.1:8188",
  resolveMediaPath,
  toAsset,
  getPython,
  runWithGpu = async (_id, operation) => operation(),
  fsApi = fs,
  spawnApi = spawn,
  clock = now,
} = {}) {
  if (!dataRoot || !inputRoot || !outputRoot || !resolveMediaPath || !toAsset || !getPython) throw new TypeError("video-character controller dependencies are incomplete");
  const root = path.resolve(dataRoot);
  const jobsRoot = path.join(root, "jobs");
  const workspacesRoot = path.join(root, "workspaces");
  const finalRoot = path.resolve(outputRoot, "video-character");
  const jobs = new Map();
  const children = new Map();
  const cancellations = new Set();
  let readyPromise;

  function jobPath(id) { return path.join(jobsRoot, `${safeId(id)}.json`); }
  function workspacePath(id) { return path.join(workspacesRoot, safeId(id)); }
  function finalPath(id) { return path.join(finalRoot, safeId(id), "final.mp4"); }

  async function persist(job) {
    job.updatedAt = clock();
    await fsApi.mkdir(jobsRoot, { recursive: true });
    const temporary = `${jobPath(job.id)}.${process.pid}.${randomUUID()}.tmp`;
    await fsApi.writeFile(temporary, JSON.stringify(job, null, 2) + "\n", "utf8");
    await fsApi.rename(temporary, jobPath(job.id));
  }

  async function ensureReady() {
    if (!readyPromise) readyPromise = (async () => {
      await fsApi.mkdir(jobsRoot, { recursive: true });
      await fsApi.mkdir(workspacesRoot, { recursive: true });
      const entries = await fsApi.readdir(jobsRoot, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const job = await fsApi.readFile(path.join(jobsRoot, entry.name), "utf8").then((text) => JSON.parse(text)).catch(() => null);
        if (!job?.id) continue;
        if (ACTIVE.has(job.status)) {
          job.status = "interrupted";
          job.stage = "服務重啟，中斷未完成工作";
          job.error = "The server restarted before this job completed.";
          job.finishedAt = clock();
          await persist(job).catch(() => {});
          await cleanupVideoCharacterStaging({ inputRoot, outputRoot, id: job.id, fsApi }).catch(() => {});
        }
        jobs.set(job.id, job);
      }
    })();
    return readyPromise;
  }

  function normalizeRequest(payload) {
    if (!payload || typeof payload !== "object") throw Object.assign(new Error("Video-character request must be an object."), { status: 400, code: "VIDEO_CHARACTER_REQUEST_INVALID" });
    const mode = String(payload.mode || "").trim().toLowerCase();
    if (!MODES.has(mode)) throw Object.assign(new Error("mode must be replace or dwpose."), { status: 400, code: "VIDEO_CHARACTER_MODE_INVALID" });
    const source = safeAsset(payload.source);
    if (!source) throw Object.assign(new Error("A source video asset is required."), { status: 400, code: "VIDEO_CHARACTER_SOURCE_INVALID" });
    const references = Array.isArray(payload.references) ? payload.references.map(safeAsset).filter(Boolean) : [];
    if (!references.length || references.length > 4) throw Object.assign(new Error("Provide one to four reference images."), { status: 400, code: "VIDEO_CHARACTER_REFERENCES_INVALID" });
    const width = integer(payload.width, 512, 256, 1536);
    const height = integer(payload.height, 896, 256, 1536);
    if (width % 32 || height % 32) throw Object.assign(new Error("Width and height must be multiples of 32."), { status: 400, code: "VIDEO_CHARACTER_DIMENSIONS_INVALID" });
    return {
      mode,
      source,
      references,
      prompt: String(payload.prompt || "A person performs the same movement as the source video with natural hands, clothing, lighting and stable full-body framing.").trim().slice(0, 20000),
      negativePrompt: String(payload.negativePrompt || DEFAULT_NEGATIVE).trim().slice(0, 10000),
      width,
      height,
      fps: finiteNumber(payload.fps, 24, 1, 120),
      steps: integer(payload.steps, mode === "replace" ? 40 : 6, 1, 80),
      seed: integer(payload.seed, 12345, 0, 2147483647),
      targetPrompt: String(payload.targetPrompt || "person").trim().slice(0, 200),
      targetIndex: integer(payload.targetIndex, 0, 0, 31),
      targetOrder: ["left_to_right", "area", "none"].includes(payload.targetOrder) ? payload.targetOrder : "left_to_right",
      timeoutSeconds: finiteNumber(payload.timeoutSeconds, 3600, 60, 86400),
    };
  }

  async function copyAsset(asset, destination) {
    const sourcePath = await resolveMediaPath(asset.root, asset.name);
    await fsApi.mkdir(path.dirname(destination), { recursive: true });
    await fsApi.copyFile(sourcePath, destination);
  }

  async function setState(job, patch) {
    Object.assign(job, patch);
    await persist(job).catch(() => {});
  }

  function parseRunnerLine(job, line) {
    const text = String(line || "").trim();
    if (!text) return;
    let event;
    try { event = JSON.parse(text); } catch { return; }
    if (event.event === "progress" || event.event === "memory") {
      const memory = event.memory && typeof event.memory === "object" ? {
        at: clock(),
        rssBytes: Number.isFinite(Number(event.memory.rssBytes)) ? Number(event.memory.rssBytes) : null,
        vramUsedBytes: Number.isFinite(Number(event.memory.vramUsedBytes)) ? Number(event.memory.vramUsedBytes) : null,
        vramTotalBytes: Number.isFinite(Number(event.memory.vramTotalBytes)) ? Number(event.memory.vramTotalBytes) : null,
      } : null;
      if (event.event === "progress") {
        if (event.progress !== null && event.progress !== undefined && Number.isFinite(Number(event.progress))) job.progress = finiteNumber(event.progress, job.progress, 0, 100);
        job.progressSource = "runner";
        job.phase = String(event.phase || job.phase || "prepare").slice(0, 80);
        job.stage = String(event.stage || job.stage).slice(0, 240);
        if (event.current !== null && event.current !== undefined && Number.isFinite(Number(event.current))) job.nativeCurrent = Math.max(0, Math.floor(Number(event.current)));
        if (event.total !== null && event.total !== undefined && Number.isFinite(Number(event.total))) job.nativeMaximum = Math.max(0, Math.floor(Number(event.total)));
        const chunkIndex = event.chunkIndex ?? event.chunk_index;
        const chunkCount = event.chunkCount ?? event.chunk_count;
        if (chunkIndex !== null && chunkIndex !== undefined && Number.isInteger(Number(chunkIndex))) job.chunkIndex = Math.max(0, Math.floor(Number(chunkIndex)));
        if (chunkCount !== null && chunkCount !== undefined && Number.isInteger(Number(chunkCount))) job.chunkCount = Math.max(0, Math.floor(Number(chunkCount)));
      }
      if (memory) job.memory.push(memory);
      void persist(job).catch(() => {});
    }
    if (event.event === "output" && event.path) job.runnerOutput = String(event.path);
  }

  async function run(job) {
    const workspace = workspacePath(job.id);
    await runWithGpu(job.id, async () => {
      await setState(job, { status: "running", stage: "啟動影片工作流程", progress: 1 });
      const runner = process.env.MINIMAX_H3_VIDEO_CHARACTER_RUNNER
        ? path.resolve(process.env.MINIMAX_H3_VIDEO_CHARACTER_RUNNER)
        : path.join(path.resolve(runtimeRoot || path.join(root, "..", "..", "minimax-workflow")), "src", "video_character.py");
      const python = await getPython();
      if (!python?.executable) throw Object.assign(new Error("Python runtime is unavailable."), { code: "VIDEO_CHARACTER_PYTHON_UNAVAILABLE", status: 503 });
      const stat = await fsApi.stat(runner).catch(() => null);
      if (!stat?.isFile()) throw Object.assign(new Error(`Video-character runner is missing: ${runner}`), { code: "VIDEO_CHARACTER_RUNNER_MISSING", status: 503 });
      const requestPath = path.join(workspace, "request.json");
      const request = { ...job.settings, sourcePath: path.join(workspace, "source", "driving.mp4"), referencePaths: job.references.map((reference, index) => path.join(workspace, "references", `reference-${String(index + 1).padStart(2, "0")}${path.extname(reference.name).toLowerCase() || ".png"}`)), workspace, outputPath: path.join(workspace, "final.mp4"), fps: job.settings.fps };
      await fsApi.writeFile(requestPath, JSON.stringify(request, null, 2) + "\n", "utf8");
      const child = spawnApi(python.executable, [runner, "--request", requestPath], {
        cwd: path.dirname(path.dirname(runner)),
        env: { ...process.env, H3_VIDEO_CHARACTER_WORKSPACE: workspace },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      children.set(job.id, child);
      const logStream = await fsApi.open(path.join(workspace, "runner.log"), "a");
      const handle = (chunk) => {
        const text = String(chunk);
        void logStream.write(text).catch(() => {});
        for (const line of text.split(/\r?\n/)) parseRunnerLine(job, line);
      };
      child.stdout?.on("data", handle);
      child.stderr?.on("data", handle);
      const exit = await new Promise((resolve, reject) => {
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, job.settings.timeoutSeconds * 1000);
        child.once("error", reject);
        child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut }); });
      }).finally(() => { children.delete(job.id); void logStream.close().catch(() => {}); });
      if (cancellations.has(job.id)) {
        cancellations.delete(job.id);
        throw Object.assign(new Error("Video-character generation was cancelled."), { code: "VIDEO_CHARACTER_CANCELLED", status: 499 });
      }
      if (exit.timedOut) throw Object.assign(new Error("Video-character generation timed out."), { code: "VIDEO_CHARACTER_TIMEOUT", status: 504 });
      if (exit.code !== 0) throw Object.assign(new Error(`Video-character runner exited with code ${exit.code ?? "unknown"}.`), { code: "VIDEO_CHARACTER_RUNNER_FAILED", status: 502 });
      const candidate = job.runnerOutput ? path.resolve(job.runnerOutput) : path.join(workspace, "final.mp4");
      if (!candidate.startsWith(workspace + path.sep) || !(await fsApi.stat(candidate).catch(() => null))?.isFile()) throw Object.assign(new Error("Video-character runner completed without final.mp4."), { code: "VIDEO_CHARACTER_OUTPUT_MISSING", status: 502 });
      const destination = finalPath(job.id);
      await fsApi.mkdir(path.dirname(destination), { recursive: true });
      await fsApi.copyFile(candidate, destination);
      const relative = path.relative(path.resolve(outputRoot), destination).replaceAll("\\", "/");
      const output = await toAsset("output", relative);
      await setState(job, { status: "completed", stage: "完成", progress: 100, progressSource: "completed", phase: "complete", finishedAt: clock(), output, workspaceExists: true });
    }).catch(async (error) => {
      const cancelled = error?.code === "VIDEO_CHARACTER_CANCELLED";
      await setState(job, { status: cancelled ? "cancelled" : "failed", stage: cancelled ? "已取消" : "失敗", finishedAt: clock(), error: error instanceof Error ? error.message : String(error), errorCode: error?.code || "VIDEO_CHARACTER_FAILED" });
    }).finally(async () => {
      try {
        await cleanupVideoCharacterStaging({ inputRoot, outputRoot, id: job.id, fsApi });
      } catch (error) {
        await setState(job, {
          status: "failed",
          stage: "暫存清理失敗",
          finishedAt: clock(),
          error: `Video-character staging cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          errorCode: "VIDEO_CHARACTER_STAGING_CLEANUP_FAILED",
        });
      }
    });
  }

  async function create(payload) {
    await ensureReady();
    const settings = normalizeRequest(payload);
    const id = `vc-${Date.now().toString(36)}-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const workspace = workspacePath(id);
    const job = {
      id, mode: settings.mode, status: "queued", stage: "準備中", progress: 0, progressSource: "unknown", phase: "prepare", createdAt: clock(), updatedAt: clock(),
      source: settings.source, references: settings.references, settings, workspaceRelative: path.relative(root, workspace).replaceAll("\\", "/"), workspaceExists: true, memory: [], runnerOutput: "",
    };
    await fsApi.mkdir(path.join(workspace, "source"), { recursive: true });
    await fsApi.mkdir(path.join(workspace, "references"), { recursive: true });
    await copyAsset(settings.source, path.join(workspace, "source", "driving.mp4"));
    for (const [index, asset] of settings.references.entries()) await copyAsset(asset, path.join(workspace, "references", `reference-${String(index + 1).padStart(2, "0")}${path.extname(asset.name).toLowerCase() || ".png"}`));
    jobs.set(id, job);
    await persist(job);
    void run(job);
    return publicJob(job);
  }

  async function get(id) { await ensureReady(); return publicJob(jobs.get(safeId(id)) || null); }
  async function list() { await ensureReady(); return [...jobs.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(publicJob); }

  async function clear(id) {
    await ensureReady();
    const job = jobs.get(safeId(id));
    if (!job) throw Object.assign(new Error("Video-character job not found."), { status: 404, code: "VIDEO_CHARACTER_JOB_NOT_FOUND" });
    if (ACTIVE.has(job.status) || children.has(job.id)) throw Object.assign(new Error("Cannot clear an active video-character workspace."), { status: 409, code: "VIDEO_CHARACTER_WORKSPACE_ACTIVE" });
    await fsApi.rm(workspacePath(job.id), { recursive: true, force: true });
    await setState(job, { workspaceExists: false, workspaceClearedAt: clock() });
    return publicJob(job);
  }

  async function health() {
    const runner = process.env.MINIMAX_H3_VIDEO_CHARACTER_RUNNER
      ? path.resolve(process.env.MINIMAX_H3_VIDEO_CHARACTER_RUNNER)
      : path.join(path.resolve(runtimeRoot || path.join(root, "..", "..", "minimax-workflow")), "src", "video_character.py");
    const [runnerStat, comfy] = await Promise.all([
      fsApi.stat(runner).catch(() => null),
      fetch(`${String(comfyUrl).replace(/\/$/, "")}/system_stats`, { signal: AbortSignal.timeout(5000) }).then((response) => response.ok).catch(() => false),
    ]);
    return { ready: Boolean(runnerStat?.isFile() && comfy), runner: Boolean(runnerStat?.isFile()), comfy, modes: { replace: Boolean(runnerStat?.isFile() && comfy), dwpose: Boolean(runnerStat?.isFile() && comfy) }, workspaceRoot: path.relative(root, workspacesRoot).replaceAll("\\", "/") };
  }

  function cancel(id) {
    const cleanId = safeId(id);
    const child = children.get(cleanId);
    if (!child) return false;
    cancellations.add(cleanId);
    child.kill("SIGTERM");
    return true;
  }

  async function handleRoute(req, res, { pathname, readJson, sendJson, sendError }) {
    if (pathname === "/api/video-character/health") {
      if (req.method !== "GET") return sendError(res, 405, "Health endpoint only supports GET.", "METHOD_NOT_ALLOWED");
      sendJson(res, 200, await health());
      return true;
    }
    if (pathname === "/api/video-character/jobs") {
      if (req.method === "GET") { sendJson(res, 200, { jobs: await list() }); return true; }
      if (req.method === "POST") { try { sendJson(res, 202, { job: await create(await readJson(req)) }); } catch (error) { sendError(res, error?.status || 500, error?.message || String(error), error?.code || "VIDEO_CHARACTER_CREATE_FAILED"); } return true; }
      return sendError(res, 405, "Jobs endpoint only supports GET and POST.", "METHOD_NOT_ALLOWED");
    }
    const match = pathname.match(/^\/api\/video-character\/jobs\/([^/]+)(?:\/(clear|cancel))?$/);
    if (!match) return false;
    const id = match[1];
    try {
      if (match[2] === "clear" && req.method === "POST") sendJson(res, 200, { job: await clear(id) });
      else if (match[2] === "cancel" && req.method === "POST") { cancel(id); sendJson(res, 200, { job: await get(id) }); }
      else if (!match[2] && req.method === "GET") { const job = await get(id); if (!job?.id) return sendError(res, 404, "Video-character job not found.", "VIDEO_CHARACTER_JOB_NOT_FOUND"); sendJson(res, 200, { job }); }
      else sendError(res, 405, "Unsupported video-character job operation.", "METHOD_NOT_ALLOWED");
    } catch (error) { sendError(res, error?.status || 500, error?.message || String(error), error?.code || "VIDEO_CHARACTER_JOB_FAILED"); }
    return true;
  }

  return { handleRoute, health, create, get, list, clear };
}
