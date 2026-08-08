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
const COMFY_ROOT = path.resolve(
  process.env.COMFYUI_ROOT || path.join(H3_ROOT, "..", "ComfyUI"),
);
const INPUT_ROOT = path.join(COMFY_ROOT, "input");
const OUTPUT_ROOT = path.join(COMFY_ROOT, "output");
const LOG_ROOT = path.resolve(
  process.env.MINIMAX_H3_LOGS_ROOT || path.join(PROJECT_ROOT, "logs"),
);
const TIMING_HISTORY_FILE = path.join(LOG_ROOT, "render-timing-history.json");
const GENERATOR = path.join(H3_ROOT, "src", "generate.py");
const ANIMATE_GENERATOR = path.join(H3_ROOT, "src", "animate_video.py");
const PYTHON = path.join(COMFY_ROOT, "venv", "Scripts", "python.exe");
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
let generatorSupportsLastImage;
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

async function hasLastImageGeneratorFlag() {
  if (typeof generatorSupportsLastImage === "boolean") return generatorSupportsLastImage;
  const source = await fs.readFile(GENERATOR, "utf8").catch(() => "");
  generatorSupportsLastImage = /--last-image\b/.test(source);
  return generatorSupportsLastImage;
}

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
  if (job.status === "running" && Number.isFinite(job.executionStartedMs)) {
    return Math.max(0, Date.now() - job.executionStartedMs);
  }
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
  if (job.status !== "running") return;

  if (estimate.durationMs) {
    job.estimatedProgress = Math.min(95, Math.max(2, (elapsedMs / estimate.durationMs) * 100));
    if (job.progressSource !== "native") {
      job.progress = Math.max(job.progress, job.estimatedProgress);
      job.progressSource = "estimated";
    }
    return;
  }

  // The generator does not emit a progress event while it is starting,
  // loading the workflow, or waiting for ComfyUI's first execution event.
  // Advance through a clearly-labeled warm-up band so a live job does not
  // look frozen at the initial placeholder value of 2%.
  const warmupProgress = Math.min(18, 8 + Math.max(0, elapsedMs - 1000) / 1000);
  job.estimatedProgress = warmupProgress;
  if (job.progressSource !== "native") job.progress = Math.max(job.progress, warmupProgress);
  if (job.progress < 20 && ["正在啟動生成…", "等待 ComfyUI 回報進度…"].includes(job.stage)) {
    job.stage = "等待 ComfyUI 回報進度…";
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
  const fullPath = await resolveMediaPath(rootName, relativeName);
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
  const seen = new Set();
  for (const currentRoot of roots) {
    for (const root of mediaRoots(currentRoot)) {
      const files = await walkMedia(root);
      for (const file of files) {
        const key = currentRoot + ":" + file.relativeName;
        if (seen.has(key)) continue;
        try {
          all.push(await toAsset(currentRoot, file.relativeName));
          seen.add(key);
        } catch {
          // A file can disappear while the directory is being scanned.
        }
      }
    }
  }
  return all.sort((left, right) => right.modified.localeCompare(left.modified)).slice(0, 100);
}

function mediaRoots(rootName) {
  return rootName === "input"
    ? [INPUT_ROOT]
    : [OUTPUT_ROOT];
}

async function resolveMediaPath(rootName, relativeName) {
  const cleanName = String(relativeName || "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!cleanName) throw new Error("缺少媒體檔名。");
  for (const root of mediaRoots(rootName)) {
    const fullPath = safePath(root, cleanName);
    try {
      const stat = await fs.stat(fullPath);
      if (stat.isFile()) return fullPath;
    } catch {
      // Try the next media root.
    }
  }
  throw new Error("找不到媒體檔案：" + cleanName);
}

async function resolveInputMedia(name, expectedKind) {
  const cleanName = String(name || "")
    .replaceAll("\\", "/")
    .replace(/^\/+/, "");
  if (!cleanName) throw new Error("缺少參考媒體檔名。");
  const candidates = [
    { root: INPUT_ROOT, name: cleanName },
    ...mediaRoots("output").map((root) => ({ root, name: cleanName })),
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
      comfyRoot: COMFY_ROOT,
      input: INPUT_ROOT,
      output: OUTPUT_ROOT,
    },
  };
}

function cleanOllamaPrompt(value) {
  return String(value || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```(?:text|markdown)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function promptMode(value) {
  return ["t2v", "i2v", "fl2v", "l2v", "ref2v", "replace"].includes(value) ? value : "t2v";
}

function promptSystem(mode, durationSeconds, hasVisualReference) {
  if (mode === "i2v") {
    return (
      "You are a professional MiniMax H3 I2VA video prompt engineer following the h3-prompt-writing guide. " +
      "Write the final prompt in English and preserve dialogue, lyrics, and visible scene text in their original language. " +
      "The first line must be exactly: For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced. " +
      "Then add one blank line and exactly these three fields in this order: " +
      "integrated_multimodal_description, overall_soundscape, non_diegetic_music. " +
      (hasVisualReference
        ? "Inspect the attached first-frame reference and start [Shot 1] from it; preserve its subject identity, clothing, colors, composition, key objects, and spatial relationships, "
        : "Start [Shot 1] from the supplied first-frame reference, preserve its subject identity, clothing, colors, composition, key objects, and spatial relationships, ") +
      "then describe continuous forward development. Use later shot timestamps only for real cuts, keep all timing within " +
      durationSeconds.toFixed(2) +
      " seconds, and describe composition, subjects, environment, actions, camera, and sound. " +
      "Use 1–4 English sentences for overall_soundscape and 1–3 English sentences or N/A for non_diegetic_music. " +
      "Do not add headings beyond the required field names, explanations, markdown, plot summaries, or invented readable text."
    );
  }

  if (mode === "fl2v") {
    return (
      "You are a professional MiniMax H3 FL2VA video prompt engineer following the h3-prompt-writing guide. " +
      "Write the final prompt in English and preserve dialogue, lyrics, and visible scene text in their original language. " +
      "The first line must be exactly: How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the " +
      durationSeconds.toFixed(2) +
      "-second mark of the target video. " +
      "Then add one blank line and exactly these three fields in this order: " +
      "integrated_multimodal_description, overall_soundscape, non_diegetic_music. " +
      "Treat Picture 1 as the opening frame and Picture 2 as the ending frame. Describe a continuous path between them, preserve identity and scene anchors, and make the final [Shot N] reach Picture 2. " +
      "Prefer one shot unless the user explicitly requests cuts. Keep all timing within " +
      durationSeconds.toFixed(2) +
      " seconds, and describe composition, subjects, environment, actions, camera, and sound. " +
      "Use 1–4 English sentences for overall_soundscape and 1–3 English sentences or N/A for non_diegetic_music. " +
      "Do not add headings beyond the required field names, explanations, markdown, plot summaries, or invented readable text."
    );
  }

  if (mode === "l2v") {
    return (
      "You are a professional MiniMax H3 L2VA video prompt engineer following the h3-prompt-writing guide. " +
      "Write the final prompt in English and preserve dialogue, lyrics, and visible scene text in their original language. " +
      "The first line must be exactly: How the reference pictures align with the target video — <Picture 1> (from [Shot N]) aligns with the " +
      durationSeconds.toFixed(2) +
      "-second mark of the target video. " +
      "Then add one blank line and exactly these three fields in this order: " +
      "integrated_multimodal_description, overall_soundscape, non_diegetic_music. " +
      "Treat Picture 1 as the final frame only. Infer a plausible preceding state, describe the transition and gradual convergence, and land on Picture 1 in the final [Shot N]. " +
      "Keep all timing within " +
      durationSeconds.toFixed(2) +
      " seconds, and describe composition, subjects, environment, actions, camera, and sound. " +
      "Use 1–4 English sentences for overall_soundscape and 1–3 English sentences or N/A for non_diegetic_music. " +
      "Do not add headings beyond the required field names, explanations, markdown, plot summaries, or invented readable text."
    );
  }

  if (mode === "ref2v") {
    return (
      "You are a professional MiniMax H3 Ref2VA full-reference prompt engineer following the h3-prompt-writing guide. " +
      "Write all six sections in English and preserve dialogue, lyrics, and visible scene text in their original language. " +
      "Return exactly these sections in this order, each as a field with a colon: subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music. " +
      "Use stable labels <Subject N>, <Picture N>, <Video N>, and <Audio N> for referenced content. Define every label before using it later. " +
      "The summary must begin with a square-bracketed task-type prefix such as [reference generation], [keyframe completion], or [video editing + reference generation]. " +
      "In retention_analysis use the fixed visible relationship markers fully_preserved, partially_preserved, attribute_transfer, weak_reference and the fixed audio markers fully_copy, partially_copy, reference, weak_reference. " +
      "The detailed_description must be a playback-order shot timeline with composition, subject appearance and position, environment, lighting, actions, state changes, camera, sound, and reference labels at the points where they apply. " +
      "Use 1–4 English sentences for overall_soundscape and 1–3 English sentences or N/A for non_diegetic_music. " +
      "Do not add markdown fences, explanations, extra headings, or labels that are not part of the six required sections."
    );
  }

  if (mode === "replace") {
    return (
      "You are a professional Wan2.2 Animate video replacement prompt engineer. " +
      "Write one production-ready English positive prompt for replacing the selected subject while preserving the source video's motion, camera path, framing, environment, lighting, timing, and scene continuity. " +
      (hasVisualReference
        ? "Inspect the attached reference image and source-video preview frame. Transfer the reference subject's identity, face, hair, clothing, colors, body proportions, and material details into the source video's moving subject while keeping the source motion and pose timing. "
        : "Use the named reference media as the source of subject identity and motion context. ") +
      "Describe the final subject appearance, actions, expression, composition, lighting, material details, occlusion, and motion continuity in one cohesive prompt. Do not redesign the background, camera, or choreography unless the user explicitly requests it. " +
      "Return only the prompt, with no headings, explanations, markdown, or invented readable text."
    );
  }

  return (
    "You are a professional MiniMax H3 T2VA video prompt engineer following the h3-prompt-writing guide. " +
    "Turn the user's idea into a complete audiovisual timeline in English while preserving dialogue, lyrics, and visible scene text in their original language. " +
    "Return exactly these three fields in this order: integrated_multimodal_description, overall_soundscape, non_diegetic_music. " +
    "The integrated_multimodal_description must begin with [Shot 1], describe composition, subjects, environment, actions, camera, dialogue, and diegetic sound, " +
    "and use strictly increasing timestamps only for later cuts. Keep all timing within " +
    durationSeconds.toFixed(2) +
    " seconds. Use 1–4 English sentences for overall_soundscape and 1–3 English sentences or N/A for non_diegetic_music. " +
    "Do not add explanations, markdown, plot summaries, or invented readable text."
  );
}

async function createPrompt(payload) {
  const brief = String(payload.brief || "").trim();
  const model = String(payload.model || "gemma4:12b");
  const mode = promptMode(payload.mode);
  const durationSeconds = clampNumber(payload.duration, 5, 0.5, 60);
  const referenceImageName = String(payload.referenceImageName || "").trim();
  const firstFrameName = String(payload.firstFrameName || "").trim();
  const lastFrameName = String(payload.lastFrameName || "").trim();
  const sourceVideoName = String(payload.sourceVideoName || "").trim();
  const visualInputs = Array.isArray(payload.images)
    ? payload.images
      .filter((item) => item && typeof item.data === "string" && item.data.trim())
      .map((item) => ({
        role: String(item.role || "reference_image"),
        data: String(item.data).replace(/^data:[^;]+;base64,/, "").trim(),
      }))
    : [];
  const negativePrompt = String(payload.negativePrompt || "").trim();
  if (!brief) throw new Error("請先輸入一段畫面想法。");
  const modeLabel = {
    t2v: "T2VA text-to-video",
    i2v: "I2VA image-to-video",
    fl2v: "FL2VA first-and-last-frame video",
    l2v: "L2VA last-frame video",
    ref2v: "Ref2VA full-reference video",
    replace: "Wan2.2 Animate video replacement",
  }[mode];
  const context = [
    `Input mode: ${modeLabel}.`,
    `Target duration: ${durationSeconds.toFixed(2)} seconds.`,
    mode === "i2v"
      ? `A reference image is supplied and must be treated as <Picture 1> at the first frame${referenceImageName ? ` (asset: ${referenceImageName})` : ""}.`
      : "",
    mode === "ref2v" && referenceImageName
      ? `<Picture 1> is the supplied reference image (asset: ${referenceImageName}); define its visual subjects and concrete frame role before reusing the label.`
      : "",
    mode === "ref2v" && sourceVideoName
      ? `<Video 1> is the supplied reference video (asset: ${sourceVideoName}); define its structural or visual reference role and do not invent an audio track unless one is actually supplied.`
      : "",
    mode === "replace" && referenceImageName
      ? `The replacement subject reference image is ${referenceImageName}; preserve its identity and visible attributes in the source video.`
      : "",
    mode === "fl2v"
      ? `Picture 1 is the first frame${firstFrameName ? ` (asset: ${firstFrameName})` : ""}; Picture 2 is the last frame${lastFrameName ? ` (asset: ${lastFrameName})` : ""}. The generated path must connect them continuously.`
      : "",
    mode === "l2v"
      ? `Picture 1 is the final frame${lastFrameName ? ` (asset: ${lastFrameName})` : ""}; infer the preceding state and land on it at the end.`
      : "",
    mode === "replace" && sourceVideoName
      ? `The source video asset is ${sourceVideoName}; preserve its motion and scene continuity.`
      : "",
    visualInputs.length
      ? `Attached visual references: ${visualInputs.map((item) => item.role).join(", ")}. Inspect them and keep their visible identities and composition consistent.`
      : "",
    negativePrompt ? `User-provided negative constraints: ${negativePrompt}` : "",
  ].filter(Boolean).join("\n");
  const result = await fetchJson(
    OLLAMA_URL + "/api/generate",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        system: promptSystem(mode, durationSeconds, visualInputs.length > 0),
        prompt: context + "\n\nUser idea:\n" + brief,
        stream: false,
        options: { temperature: 0.7, top_p: 0.9 },
        ...(visualInputs.length ? { images: visualInputs.map((item) => item.data) } : {}),
      }),
    },
    120000,
  );
  const prompt = cleanOllamaPrompt(result.response || result.message?.content);
  if (!prompt) throw new Error("Ollama 回傳了空的提示詞。");
  const defaultNegativePrompt = mode === "replace"
    ? "identity drift, face drift, costume drift, body-shape drift, altered background, changed camera path, pose mismatch, motion mismatch, flicker, jitter, warping, extra limbs, deformed hands, text, logo, watermark"
    : "blurry, low quality, flicker, jitter, deformed face, extra limbs, warped hands, text, logo, watermark";
  return {
    prompt,
    negativePrompt: negativePrompt || defaultNegativePrompt,
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
    progressSource: job.progressSource,
    estimatedProgress: job.estimatedProgress,
    nativeCurrent: job.nativeCurrent,
    nativeMaximum: job.nativeMaximum,
    comfyNode: job.comfyNode,
    connectionState: job.connectionState,
    updatedAt: job.updatedAt,
    lastNativeProgressAt: job.lastNativeProgressAt,
  };
}

function touchJob(job) {
  job.updatedAt = now();
}

function stageProgress(classType) {
  return {
    CLIPLoader: 20,
    UNETLoader: 24,
    VAELoader: 27,
    MiniMaxH3ImageToVideo: 30,
    SamplerCustomAdvanced: 32,
    VAEDecode: 93,
    VAEDecodeAudio: 95,
    CreateVideo: 97,
    SaveVideo: 98,
  }[classType] || 20;
}

function updateJobFromStructuredEvent(job, event) {
  touchJob(job);
  const type = String(event?.type || "");
  if (type === "queued") {
    job.stage = "已送入 ComfyUI 佇列";
    job.progress = Math.max(job.progress, 19);
    job.connectionState = "queued";
    return;
  }
  if (type === "websocket_connected") {
    job.connectionState = "connected";
    return;
  }
  if (type === "websocket_reconnecting") {
    job.connectionState = "reconnecting";
    job.stage = "ComfyUI 進度連線重連中…";
    return;
  }
  if (type === "heartbeat") {
    job.connectionState = event.transport === "polling" ? "polling" : "connected";
    return;
  }
  if (type === "executing") {
    job.connectionState = "connected";
    if (event.node == null) {
      job.stage = "ComfyUI 執行完成，讀取輸出…";
      job.progress = Math.max(job.progress, 98);
      return;
    }
    job.comfyNode = String(event.class_type || event.node);
    job.stage = String(event.stage || `ComfyUI / ${job.comfyNode}`);
    if (job.progressSource !== "native") job.progress = Math.max(job.progress, stageProgress(event.class_type));
    return;
  }
  if (type === "progress") {
    const current = Math.max(0, Number(event.value) || 0);
    const maximum = Math.max(1, Number(event.max) || 1);
    job.nativeCurrent = current;
    job.nativeMaximum = maximum;
    job.progressSource = "native";
    job.lastNativeProgressAt = job.updatedAt;
    job.connectionState = "connected";
    job.progress = Math.min(94, 20 + (current / maximum) * 72);
    job.stage = String(event.stage || (job.mode === "replace" ? "逐段生成影片…" : "採樣生成影格…"));
    return;
  }
  if (type === "artifact") {
    const relativeName = String(event.relative_name || "").replaceAll("\\", "/").replace(/^\/+/, "");
    if (!relativeName || event.folder_type !== "output") return;
    // Validate now; resolveMediaPath performs the final on-disk check after
    // the child exits and ComfyUI has closed the output file.
    safePath(OUTPUT_ROOT, relativeName);
    job.outputRelativeName = relativeName;
    job.outputName = relativeName;
    job.stage = "ComfyUI 已寫入原生成品";
    job.progress = Math.max(job.progress, 99);
  }
}

function updateJobFromLine(job, line) {
  const marker = "H3_PROGRESS ";
  const markerIndex = line.indexOf(marker);
  if (markerIndex >= 0) {
    try {
      updateJobFromStructuredEvent(job, JSON.parse(line.slice(markerIndex + marker.length)));
      return;
    } catch {
      // Fall through to the legacy text parser for compatibility.
    }
  }
  const progress = line.match(/progress=(\d+)\/(\d+)/i);
  if (progress) {
    const current = Number(progress[1]);
    const maximum = Math.max(1, Number(progress[2]));
    // Reserve the first 20% for input preparation and ComfyUI queueing;
    // map the actual node progress into the remaining generation band.
    job.progress = Math.min(94, Math.max(job.progress, 20 + (current / maximum) * 72));
    job.progressSource = "native";
    job.nativeCurrent = current;
    job.nativeMaximum = maximum;
    job.lastNativeProgressAt = now();
    touchJob(job);
    job.stage = job.mode === "replace" ? "逐段生成影片…" : "生成影格…";
  }
  const node = line.match(/node=([^\s]+)/i);
  if (node) {
    job.stage = "ComfyUI / " + node[1];
    job.progress = Math.min(94, Math.max(job.progress, 20));
    touchJob(job);
  }
  const chunk = line.match(/chunk=(\d+)/i);
  if (chunk) {
    job.stage = "處理影片段落 " + chunk[1] + "…";
    job.progress = Math.min(94, Math.max(job.progress, 20 + Number(chunk[1]) * 7));
  }
  if (/upload/i.test(line)) {
    job.stage = "上傳參考媒體…";
    job.progress = Math.max(job.progress, 12);
  }
  if (/queued|prompt_id/i.test(line)) {
    job.stage = "已送入 ComfyUI 佇列";
    job.progress = Math.max(job.progress, 19);
    touchJob(job);
  }
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
  entry.job.progress = Math.max(entry.job.progress, 8);
  entry.job.stage = "正在啟動生成…";
  entry.job.connectionState = "starting";
  touchJob(entry.job);
  try {
    const actualChild = spawn(entry.command, entry.args, entry.options);
    entry.child.actualChild = actualChild;
    entry.job.progress = Math.max(entry.job.progress, 9);
    entry.job.stage = "等待 ComfyUI 回報進度…";
    touchJob(entry.job);
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
  if (payload.mode === "ref2v") {
    throw new Error("目前本機生成器尚未接入原生 Ref2VA；請先使用 Ref2VA 提示詞，或切換到可生成的 H3 模式。");
  }
  const mode = ["t2v", "i2v", "fl2v", "l2v", "replace"].includes(payload.mode) ? payload.mode : "t2v";
  const prompt = String(payload.prompt || "").trim();
  if (!prompt) throw new Error("提示詞不能是空白。");
  if (!(await fs.stat(H3_ROOT).catch(() => null))) {
    throw new Error("找不到 minimax-h3-local，請確認本機路徑。");
  }
  if (!(await fs.stat(PYTHON).catch(() => null))) {
    throw new Error("找不到 ComfyUI 虛擬環境的 Python。");
  }
  if ((mode === "fl2v" || mode === "l2v") && !(await hasLastImageGeneratorFlag())) {
    throw new Error("目前本機 generate.py 尚未公開 --last-image；FL2VA/L2VA 提示詞已可產出，但影片生成需先更新本機 CLI。");
  }
  const requestedOutputName = outputFileName(payload.outputName);
  await fs.mkdir(INPUT_ROOT, { recursive: true });
  await fs.mkdir(OUTPUT_ROOT, { recursive: true });
  await fs.mkdir(LOG_ROOT, { recursive: true });

  let inputImagePath = null;
  let lastImagePath = null;
  let inputVideoPath = null;
  if (mode === "i2v" || mode === "fl2v") {
    inputImagePath = await resolveInputMedia(payload.inputImageName, "image");
  }
  if (mode === "fl2v" || mode === "l2v") {
    lastImagePath = await resolveInputMedia(payload.lastImageName, "image");
  }
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
    progressSource: "estimated",
    estimatedProgress: 2,
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
    updatedAt: now(),
    connectionState: "starting",
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
    if (lastImagePath) args.push("--last-image", lastImagePath);
  }

  const childEnv = {
    ...process.env,
    PYTHONUNBUFFERED: "1",
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
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
    const outputRelativeName = job.outputRelativeName || outputName;
    const nativeOutputPath = await resolveMediaPath("output", outputRelativeName).catch(() => null);
    const outputExists = Boolean(nativeOutputPath);
    if (job.cancelRequested) {
      job.status = "cancelled";
      job.stage = "已停止";
    } else if (code === 0 && outputExists) {
      job.status = "completed";
      job.progress = 100;
      job.stage = "完成，影片已寫入 ComfyUI output";
      try {
        job.output = await toAsset("output", outputRelativeName);
      } catch {
        job.error = "生成完成，但找不到輸出影片。";
        job.status = "failed";
      }
    } else {
      job.status = "failed";
      job.stage = "生成失敗";
      if (!job.error) job.error = "生成程序結束，代碼：" + String(code);
    }
    job.elapsedMs = Number.isFinite(job.executionStartedMs)
      ? Math.max(0, Date.now() - job.executionStartedMs)
      : elapsedMilliseconds(job);
    if (job.status === "completed") {
      recordTimingSample(job, job.elapsedMs);
      job.etaMs = 0;
    }
    job.finishedAt = now();
    touchJob(job);
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

async function deleteOutputVideo(relativeName) {
  const cleanName = String(relativeName || "")
    .replaceAll("\\", "/")
    .replace(/^\/+/, "");
  if (!cleanName || classifyFile(cleanName) !== "video") {
    throw new Error("只能刪除 output 內的影片。");
  }

  const candidates = mediaRoots("output").map((root) => safePath(root, cleanName));
  const existingPaths = [];
  for (const candidate of candidates) {
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isFile()) existingPaths.push(candidate);
  }
  if (!existingPaths.length) {
    throw new Error("找不到要刪除的影片：" + cleanName);
  }

  for (const candidate of existingPaths) {
    await fs.unlink(candidate);
  }
  return {
    name: cleanName,
    root: "output",
    kind: "video",
    deletedCount: existingPaths.length,
  };
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
  if (req.method === "DELETE" && pathname === "/api/assets") {
    const root = requestUrl.searchParams.get("root");
    const relativeName = requestUrl.searchParams.get("name");
    if (root !== "output" || !relativeName) {
      sendError(res, 400, "只能刪除 output 內的影片。");
      return;
    }
    sendJson(res, 200, { asset: await deleteOutputVideo(relativeName) });
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
    const fullPath = await resolveMediaPath(rootName, relativeName);
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
