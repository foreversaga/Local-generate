import { createReadStream } from "node:fs";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const H3_ROOT = path.resolve(
  process.env.MINIMAX_H3_ROOT || path.join(PROJECT_ROOT, "..", "minimax-h3-local"),
);
const INPUT_ROOT = path.join(H3_ROOT, "input");
const OUTPUT_ROOT = path.join(H3_ROOT, "output");
const LOG_ROOT = path.resolve(
  process.env.MINIMAX_H3_LOGS_ROOT || path.join(PROJECT_ROOT, "logs"),
);
const TIMING_HISTORY_FILE = path.join(LOG_ROOT, "render-timing-history.json");
const GENERATOR = path.join(H3_ROOT, "src", "generate.py");
const ANIMATE_GENERATOR = path.join(H3_ROOT, "src", "animate_video.py");
const PYTHON = path.join(H3_ROOT, "..", "ComfyUI", "venv", "Scripts", "python.exe");
const COMFY_URL = (process.env.COMFY_URL || "http://127.0.0.1:8188").replace(/\/$/, "");
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const MAX_BODY_BYTES = 260 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi"]);
const jobs = new Map();
const jobProcesses = new Map();
const generationQueue = [];
const reservedOutputPaths = new Set();
let activeGenerationId = null;
const timingSampleWindow = 5;
let timingSamples = [];
let timingHistoryWrite = Promise.resolve();
const timingHistoryReady = fs
  .readFile(TIMING_HISTORY_FILE, "utf8")
  .then((text) => {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      timingSamples = parsed.filter((sample) =>
        Number.isFinite(Number(sample?.width)) &&
        Number.isFinite(Number(sample?.height)) &&
        Number.isFinite(Number(sample?.duration)) &&
        Number.isFinite(Number(sample?.elapsedMs)) &&
        Number(sample.elapsedMs) > 0,
      );
    }
  })
  .catch(() => {});

function now() {
  return new Date().toISOString();
}

function jsonHeaders() {
  return {
    "Cache-Control": "no-store",
  };
}

function withinTenPercent(value, target) {
  const tolerance = Math.max(Math.abs(target) * 0.1, 1);
  return Math.abs(value - target) <= tolerance;
}

function matchingTimingSamples(job) {
  return timingSamples
    .filter((sample) =>
      withinTenPercent(Number(sample.width), job.width) &&
      withinTenPercent(Number(sample.height), job.height) &&
      withinTenPercent(Number(sample.duration), job.duration),
    )
    .slice(-timingSampleWindow);
}

function timingEstimate(job) {
  const samples = matchingTimingSamples(job);
  if (!samples.length) return { durationMs: null, sampleCount: 0 };
  const total = samples.reduce((sum, sample) => sum + Number(sample.elapsedMs), 0);
  return {
    durationMs: Math.round(total / samples.length),
    sampleCount: samples.length,
  };
}

function elapsedMilliseconds(job) {
  if (Number.isFinite(job.elapsedMs)) return Math.max(0, job.elapsedMs);
  if (!Number.isFinite(job.executionStartedMs)) return 0;
  return Math.max(0, Date.now() - job.executionStartedMs);
}

function updateJobTiming(job) {
  const elapsedMs = elapsedMilliseconds(job);
  const estimate = timingEstimate(job);
  job.elapsedMs = elapsedMs;
  job.estimatedDurationMs = estimate.durationMs;
  job.timingSampleCount = estimate.sampleCount;
  job.etaMs = estimate.durationMs === null
    ? null
    : Math.max(0, estimate.durationMs - elapsedMs);
  if (job.status === "running" && estimate.durationMs) {
    job.progress = Math.min(95, Math.max(2, (elapsedMs / estimate.durationMs) * 100));
  }
}

function recordTimingSample(job, elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return;
  timingSamples.push({
    width: job.width,
    height: job.height,
    duration: job.duration,
    elapsedMs: Math.round(elapsedMs),
    completedAt: now(),
  });
  if (timingSamples.length > 500) timingSamples = timingSamples.slice(-500);
  timingHistoryWrite = timingHistoryWrite
    .catch(() => {})
    .then(() => timingHistoryReady)
    .then(async () => {
      await fs.mkdir(LOG_ROOT, { recursive: true });
      await fs.writeFile(TIMING_HISTORY_FILE, JSON.stringify(timingSamples, null, 2), "utf8");
    })
    .catch(() => {});
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...jsonHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

async function readBody(req) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("檔案太大，請先壓縮後再上傳。"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw new Error("請求內容不是有效的 JSON。");
  }
}

function safePath(root, relativeName) {
  const rootPath = path.resolve(root);
  const candidate = path.resolve(rootPath, String(relativeName || ""));
  if (candidate !== rootPath && !candidate.startsWith(rootPath + path.sep)) {
    throw new Error("不允許存取這個檔案路徑。");
  }
  return candidate;
}

function classifyFile(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  return null;
}

function mimeFor(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  const values = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
  };
  return values[extension] || "application/octet-stream";
}

async function walkMedia(root, prefix = "") {
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const relativeName = prefix ? prefix + "/" + entry.name : entry.name;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkMedia(fullPath, relativeName)));
      continue;
    }
    if (classifyFile(entry.name)) files.push({ relativeName, fullPath });
  }
  return files;
}

async function toAsset(rootName, relativeName) {
  const root = rootName === "input" ? INPUT_ROOT : OUTPUT_ROOT;
  const fullPath = safePath(root, relativeName);
  const stat = await fs.stat(fullPath);
  const kind = classifyFile(relativeName);
  if (!kind) throw new Error("這不是支援的圖片或影片檔案。");
  return {
    name: relativeName.replaceAll("\\", "/"),
    root: rootName,
    kind,
    mime: mimeFor(relativeName),
    size: stat.size,
    modified: stat.mtime.toISOString(),
    url: "/media?root=" + rootName + "&name=" + encodeURIComponent(relativeName),
  };
}

async function listAssets(rootName) {
  const roots = rootName === "all" ? ["input", "output"] : [rootName];
  const all = [];
  for (const currentRoot of roots) {
    const root = currentRoot === "input" ? INPUT_ROOT : OUTPUT_ROOT;
    const files = await walkMedia(root);
    for (const file of files) {
      try {
        all.push(await toAsset(currentRoot, file.relativeName));
      } catch {
        // A file can disappear while the directory is being scanned.
      }
    }
  }
  return all.sort((left, right) => right.modified.localeCompare(left.modified)).slice(0, 100);
}

async function resolveInputMedia(name, expectedKind) {
  const cleanName = path.basename(String(name || ""));
  if (!cleanName) throw new Error("缺少參考媒體檔名。");
  const candidates = [
    { root: INPUT_ROOT, name: cleanName },
    { root: OUTPUT_ROOT, name: cleanName },
  ];
  for (const candidate of candidates) {
    const fullPath = safePath(candidate.root, candidate.name);
    try {
      const stat = await fs.stat(fullPath);
      const kind = classifyFile(candidate.name);
      if (stat.isFile() && kind === expectedKind) return fullPath;
    } catch {
      // Try the next media root.
    }
  }
  throw new Error("找不到參考檔案：" + cleanName);
}

async function fetchJson(url, init = {}, timeoutMs = 1800) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = JSON.parse(text || "{}");
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    throw new Error((payload && (payload.error || payload.message)) || response.statusText);
  }
  return payload;
}

async function health() {
  const [ollama, comfy] = await Promise.all([
    fetchJson(OLLAMA_URL + "/api/tags").catch(() => null),
    fetchJson(COMFY_URL + "/system_stats").catch(() => null),
  ]);
  const models = Array.isArray(ollama?.models)
    ? ollama.models.map((item) => String(item.name || item.model || "")).filter(Boolean)
    : [];
  const devices = Array.isArray(comfy?.devices)
    ? comfy.devices.map((device) => ({
        name: device.name,
        vram_total: device.vram_total,
        vram_free: device.vram_free,
      }))
    : [];
  return {
    bridge: true,
    h3Root: await fs
      .stat(H3_ROOT)
      .then((value) => value.isDirectory())
      .catch(() => false),
    ollama: { online: Boolean(ollama), models },
    comfy: { online: Boolean(comfy), url: COMFY_URL, devices },
    paths: {
      h3Root: H3_ROOT,
      input: INPUT_ROOT,
      output: OUTPUT_ROOT,
    },
  };
}

function cleanOllamaPrompt(value) {
  return String(value || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
}

async function createPrompt(payload) {
  const brief = String(payload.brief || "").trim();
  const model = String(payload.model || "gemma4:12b");
  const negativePrompt = String(payload.negativePrompt || "").trim();
  if (!brief) throw new Error("請先輸入一段畫面想法。");
  const system =
    "You are a professional MiniMax H3 local video prompt engineer. " +
    "Turn the user's idea into one production-ready English prompt. " +
    "Include subject, action, camera movement, framing, environment, lighting, " +
    "texture, pacing, and natural audio when useful. Preserve the intended story. " +
    "Use clear cinematic language, no headings, no explanations, no markdown, and do not invent readable text.";
  const result = await fetchJson(
    OLLAMA_URL + "/api/generate",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        system,
        prompt: "User idea:\n" + brief,
        stream: false,
        options: { temperature: 0.7, top_p: 0.9 },
      }),
    },
    120000,
  );
  const prompt = cleanOllamaPrompt(result.response || result.message?.content);
  if (!prompt) throw new Error("Ollama 回傳了空的提示詞。");
  return {
    prompt,
    negativePrompt:
      negativePrompt ||
      "blurry, low quality, flicker, jitter, deformed face, extra limbs, warped hands, text, logo, watermark",
  };
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function outputFileName(value) {
  const raw = path.basename(String(value || "h3-render"));
  const withoutExtension = raw.replace(/\.[^.]+$/, "");
  const clean = withoutExtension.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return (clean || "h3-render") + ".mp4";
}

async function allocateOutputPath(requestedName) {
  const parsed = path.parse(requestedName);
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? "" : "-" + index;
    const candidateName = parsed.name + suffix + parsed.ext;
    const candidatePath = safePath(OUTPUT_ROOT, candidateName);
    if (reservedOutputPaths.has(candidatePath)) continue;
    if (await fs.stat(candidatePath).catch(() => null)) continue;
    reservedOutputPaths.add(candidatePath);
    return { name: candidateName, path: candidatePath };
  }
  throw new Error("找不到可用的輸出檔名，請清理或關閉已存在的同名影片。");
}

function publicJob(job) {
  updateJobTiming(job);
  return {
    id: job.id,
    status: job.status,
    mode: job.mode,
    progress: job.progress,
    stage: job.stage,
    prompt: job.prompt,
    seed: job.seed,
    batchId: job.batchId,
    batchIndex: job.batchIndex,
    batchTotal: job.batchTotal,
    width: job.width,
    height: job.height,
    duration: job.duration,
    modelProfile: job.modelProfile,
    output: job.output,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    elapsedMs: job.elapsedMs,
    estimatedDurationMs: job.estimatedDurationMs,
    etaMs: job.etaMs,
    timingSampleCount: job.timingSampleCount,
  };
}

function updateJobFromLine(job, line) {
  const progress = line.match(/progress=(\d+)\/(\d+)/i);
  if (progress) {
    const current = Number(progress[1]);
    const maximum = Math.max(1, Number(progress[2]));
    job.progress = Math.min(94, 5 + (current / maximum) * 86);
    job.stage = job.mode === "replace" ? "逐段生成影片…" : "生成影格…";
  }
  const node = line.match(/node=([^\s]+)/i);
  if (node) job.stage = "ComfyUI / " + node[1];
  const chunk = line.match(/chunk=(\d+)/i);
  if (chunk) {
    job.stage = "處理影片段落 " + chunk[1] + "…";
    job.progress = Math.min(94, Math.max(job.progress, 12 + Number(chunk[1]) * 7));
  }
  if (/upload/i.test(line)) job.stage = "上傳參考媒體…";
  if (/queued|prompt_id/i.test(line)) job.stage = "已送入 ComfyUI 佇列";
}

function attachProcessOutput(job, stream, isError = false) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r\n|\n|\r/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.trim()) {
        updateJobFromLine(job, line);
        if (isError && /error|exception|traceback|failed/i.test(line)) job.error = line.trim().slice(-600);
      }
    }
  });
  stream.on("end", () => {
    if (buffer.trim()) updateJobFromLine(job, buffer.trim());
  });
}

function queueSpawn(command, args, options, job) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.started = false;
  child.cancelled = false;
  child.actualChild = null;

  const entry = { command, args, options, job, child };
  child.kill = () => {
    if (child.cancelled) return;
    child.cancelled = true;
    job.cancelRequested = true;
    if (child.actualChild) {
      child.actualChild.kill();
      return;
    }
    const index = generationQueue.indexOf(entry);
    if (index >= 0) generationQueue.splice(index, 1);
    queueMicrotask(() => child.emit("close", null));
  };

  generationQueue.push(entry);
  queueMicrotask(pumpGenerationQueue);
  return child;
}

function pumpGenerationQueue() {
  if (activeGenerationId || !generationQueue.length) return;
  const entry = generationQueue.shift();
  if (!entry) return;
  if (entry.child.cancelled) {
    queueMicrotask(() => entry.child.emit("close", null));
    return;
  }

  activeGenerationId = entry.job.id;
  entry.child.started = true;
  entry.job.status = "running";
  entry.job.executionStartedAt = now();
  entry.job.executionStartedMs = Date.now();
  entry.job.stage = "正在啟動生成…";
  try {
    const actualChild = spawn(entry.command, entry.args, entry.options);
    entry.child.actualChild = actualChild;
    actualChild.stdout.pipe(entry.child.stdout);
    actualChild.stderr.pipe(entry.child.stderr);
    actualChild.on("error", (error) => entry.child.emit("error", error));
    actualChild.on("close", (code) => {
      activeGenerationId = null;
      entry.child.emit("close", code);
    });
  } catch (error) {
    activeGenerationId = null;
    entry.child.emit("error", error);
    entry.child.emit("close", null);
  }
}

async function startGeneration(payload) {
  await timingHistoryReady;
  const mode = ["t2v", "i2v", "replace"].includes(payload.mode) ? payload.mode : "t2v";
  const prompt = String(payload.prompt || "").trim();
  if (!prompt) throw new Error("提示詞不能是空白。");
  if (!(await fs.stat(H3_ROOT).catch(() => null))) {
    throw new Error("找不到 minimax-h3-local，請確認本機路徑。");
  }
  if (!(await fs.stat(PYTHON).catch(() => null))) {
    throw new Error("找不到 ComfyUI 虛擬環境的 Python。");
  }
  const requestedOutputName = outputFileName(payload.outputName);
  await fs.mkdir(INPUT_ROOT, { recursive: true });
  await fs.mkdir(OUTPUT_ROOT, { recursive: true });
  await fs.mkdir(LOG_ROOT, { recursive: true });

  let inputImagePath = null;
  let inputVideoPath = null;
  if (mode === "i2v") inputImagePath = await resolveInputMedia(payload.inputImageName, "image");
  if (mode === "replace") {
    inputVideoPath = await resolveInputMedia(payload.inputVideoName, "video");
    inputImagePath = await resolveInputMedia(payload.referenceImageName, "image");
  }

  const output = await allocateOutputPath(requestedOutputName);
  const outputName = output.name;
  const outputPath = output.path;

  const width = Math.round(clampNumber(payload.width, mode === "replace" ? 832 : 736, 32, 2048));
  const height = Math.round(clampNumber(payload.height, mode === "replace" ? 480 : 416, 32, 2048));
  const duration = clampNumber(payload.duration, 5, 0.5, 60);
  const steps = Math.round(clampNumber(payload.steps, mode === "replace" ? 6 : 20, 1, 80));
  const seed = Math.round(clampNumber(payload.seed, 12345, 0, 2147483647));
  const modelProfile = mode === "replace" ? "wan22_animate_fp8" : String(payload.modelProfile || "nvfp4_blackwell");
  const negativePrompt = String(payload.negativePrompt || "").trim();
  const batchId = String(payload.batchId || "");
  const batchIndex = Math.round(clampNumber(payload.batchIndex, 1, 1, 20));
  const batchTotal = Math.round(clampNumber(payload.batchTotal, 1, 1, 20));
  const job = {
    id: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
    status: "queued",
    mode,
    progress: 2,
    stage: "準備本機輸入…",
    prompt,
    seed,
    batchId,
    batchIndex,
    batchTotal,
    width,
    height,
    duration,
    modelProfile,
    startedAt: now(),
    outputName,
    outputPath,
    cancelRequested: false,
  };
  jobs.set(job.id, job);

  let args = [];
  if (mode === "replace") {
    args = [
      ANIMATE_GENERATOR,
      "--input-video",
      inputVideoPath,
      "--reference-image",
      inputImagePath,
      "--prompt",
      prompt,
      "--negative-prompt",
      negativePrompt,
      "--width",
      String(width),
      "--height",
      String(height),
      "--steps",
      String(steps),
      "--seed",
      String(seed),
      "--output",
      outputPath,
      "--model-profile",
      modelProfile,
      "--comfy-url",
      COMFY_URL,
    ];
  } else {
    args = [
      GENERATOR,
      "--prompt",
      prompt,
      "--negative-prompt",
      negativePrompt,
      "--duration",
      String(duration),
      "--width",
      String(width),
      "--height",
      String(height),
      "--steps",
      String(steps),
      "--seed",
      String(seed),
      "--output",
      outputPath,
      "--model-profile",
      modelProfile,
      "--comfy-url",
      COMFY_URL,
    ];
    if (inputImagePath) args.push("--input-image", inputImagePath);
  }

  const childEnv = {
    ...process.env,
    PYTHONUNBUFFERED: "1",
    MINIMAX_H3_LOGS_ROOT: LOG_ROOT,
  };
  if (childEnv.Path && childEnv.PATH) delete childEnv.PATH;
  const child = queueSpawn(PYTHON, args, {
    cwd: H3_ROOT,
    windowsHide: true,
    env: childEnv,
  }, job);
  job.status = child.started ? "running" : "queued";
  if (!child.started) job.stage = "等待前一個影片完成…";
  jobProcesses.set(job.id, child);
  attachProcessOutput(job, child.stdout);
  attachProcessOutput(job, child.stderr, true);
  child.on("error", (error) => {
    job.error = error.message;
  });
  child.on("close", async (code) => {
    jobProcesses.delete(job.id);
    const outputExists = await fs.stat(outputPath).then(() => true).catch(() => false);
    if (job.cancelRequested) {
      job.status = "cancelled";
      job.stage = "已停止";
    } else if (code === 0 && outputExists) {
      job.status = "completed";
      job.progress = 100;
      job.stage = "完成，影片已寫入 output";
      try {
        job.output = await toAsset("output", outputName);
      } catch {
        job.error = "生成完成，但找不到輸出影片。";
        job.status = "failed";
      }
    } else {
      job.status = "failed";
      job.stage = "生成失敗";
      if (!job.error) job.error = "生成程序結束，代碼：" + String(code);
    }
    if (job.status === "completed") {
      job.elapsedMs = Number.isFinite(job.executionStartedMs)
        ? Math.max(0, Date.now() - job.executionStartedMs)
        : elapsedMilliseconds(job);
      recordTimingSample(job, job.elapsedMs);
      job.etaMs = 0;
    }
    job.finishedAt = now();
    reservedOutputPaths.delete(outputPath);
    trimJobs();
    queueMicrotask(pumpGenerationQueue);
  });
  return publicJob(job);
}

function trimJobs() {
  const items = [...jobs.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  for (const item of items.slice(30)) {
    if (!jobProcesses.has(item.id)) jobs.delete(item.id);
  }
}

async function uploadAsset(payload) {
  const inputName = path.basename(String(payload.name || "upload"));
  const mimeType = String(payload.mimeType || "");
  let extension = path.extname(inputName).toLowerCase();
  if (!extension) {
    const extensionByMime = {
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/webp": ".webp",
      "video/mp4": ".mp4",
      "video/quicktime": ".mov",
      "video/webm": ".webm",
    };
    extension = extensionByMime[mimeType] || "";
  }
  if (!IMAGE_EXTENSIONS.has(extension) && !VIDEO_EXTENSIONS.has(extension)) {
    throw new Error("只支援 PNG、JPG、WEBP、MP4、MOV 或 WEBM。");
  }
  const cleanStem = path
    .basename(inputName, path.extname(inputName))
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "upload";
  let outputName = cleanStem + extension;
  let outputPath = safePath(INPUT_ROOT, outputName);
  let counter = 1;
  while (await fs.stat(outputPath).catch(() => null)) {
    outputName = cleanStem + "-" + counter + extension;
    outputPath = safePath(INPUT_ROOT, outputName);
    counter += 1;
  }
  const data = String(payload.data || "").replace(/^data:[^;]+;base64,/, "");
  if (!data) throw new Error("上傳內容是空的。");
  await fs.mkdir(INPUT_ROOT, { recursive: true });
  await fs.writeFile(outputPath, Buffer.from(data, "base64"));
  return await toAsset("input", outputName);
}

async function route(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, jsonHeaders());
    res.end();
    return;
  }
  const requestUrl = new URL(req.url || "/", "http://localhost");
  const pathname = requestUrl.pathname;

  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, await health());
    return;
  }
  if (req.method === "GET" && pathname === "/api/assets") {
    const root = requestUrl.searchParams.get("root") || "all";
    if (!["all", "input", "output"].includes(root)) {
      sendError(res, 400, "不支援的資源資料夾。");
      return;
    }
    sendJson(res, 200, { assets: await listAssets(root) });
    return;
  }
  if (req.method === "GET" && pathname === "/api/jobs") {
    const values = [...jobs.values()]
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .slice(0, 20)
      .map(publicJob);
    sendJson(res, 200, { jobs: values });
    return;
  }
  if (req.method === "GET" && pathname.startsWith("/api/jobs/")) {
    const id = pathname.split("/").pop();
    const job = jobs.get(id);
    if (!job) {
      sendError(res, 404, "找不到這個生成工作。");
      return;
    }
    sendJson(res, 200, publicJob(job));
    return;
  }
  if (req.method === "POST" && pathname === "/api/assets/upload") {
    sendJson(res, 200, { asset: await uploadAsset(await readJson(req)) });
    return;
  }
  if (req.method === "POST" && pathname === "/api/ollama/prompt") {
    sendJson(res, 200, await createPrompt(await readJson(req)));
    return;
  }
  if (req.method === "POST" && pathname === "/api/generate") {
    sendJson(res, 202, { job: await startGeneration(await readJson(req)) });
    return;
  }
  if (req.method === "POST" && pathname.startsWith("/api/jobs/") && pathname.endsWith("/cancel")) {
    const id = pathname.split("/")[3];
    const job = jobs.get(id);
    const child = jobProcesses.get(id);
    if (!job || !child) {
      sendError(res, 404, "這個工作目前不在執行中。");
      return;
    }
    job.cancelRequested = true;
    job.status = "cancelling";
    job.stage = "正在停止…";
    child.kill();
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "GET" && pathname === "/media") {
    const rootName = requestUrl.searchParams.get("root");
    const relativeName = requestUrl.searchParams.get("name");
    if (!["input", "output"].includes(rootName) || !relativeName) {
      sendError(res, 400, "缺少媒體路徑。");
      return;
    }
    const root = rootName === "input" ? INPUT_ROOT : OUTPUT_ROOT;
    const fullPath = safePath(root, relativeName);
    const kind = classifyFile(relativeName);
    if (!kind) {
      sendError(res, 415, "不支援的媒體格式。");
      return;
    }
    const stat = await fs.stat(fullPath).catch(() => null);
    if (!stat?.isFile()) {
      sendError(res, 404, "找不到媒體檔案。");
      return;
    }
    res.writeHead(200, {
      ...jsonHeaders(),
      "Content-Type": mimeFor(relativeName),
      "Content-Length": stat.size,
      "Content-Disposition": (requestUrl.searchParams.get("download") === "1" ? "attachment" : "inline") + "; filename=\"" + path.basename(relativeName).replace(/"/g, "") + "\"",
    });
    createReadStream(fullPath).pipe(res);
    return;
  }
  sendError(res, 404, "H3 Studio bridge endpoint not found.");
}

/*
const server = createServer((req, res) => {
  route(req, res).catch((error) => {
    console.error("[bridge]", error);
    if (!res.headersSent) sendError(res, 500, error instanceof Error ? error.message : "本機服務發生錯誤。");
    else res.end();
  });
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, BRIDGE_HOST, () => {
  // Standalone launcher removed; this module is mounted by the web server.
  console.log("MiniMax project: " + H3_ROOT);
  console.log("ComfyUI: " + COMFY_URL);
  console.log("Ollama: " + OLLAMA_URL);
  });
}

*/

export { route };
