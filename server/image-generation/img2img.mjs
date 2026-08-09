import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const IMG2IMG_MODELS = Object.freeze([
  "sd_xl_turbo_1.0_fp16.safetensors",
  "v1-5-pruned-emaonly-fp16.safetensors",
]);

export const IMG2IMG_REQUIRED_NODES = Object.freeze([
  "CheckpointLoaderSimple",
  "LoadImage",
  "VAEEncode",
  "CLIPTextEncode",
  "KSampler",
  "VAEDecode",
  "SaveImage",
]);

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const TERMINAL_STAGES = new Set(["completed", "success", "succeeded", "finished", "done"]);
const ERROR_STAGES = new Set(["error", "failed", "failure", "cancelled", "canceled"]);

function isoNow(now = Date.now()) {
  return new Date(now).toISOString();
}

function makeError(message, status = 500, code = "IMG2IMG_ERROR") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function errorMessage(error, fallback = "Image-to-image generation failed.") {
  const value = typeof error === "string" ? error : error?.message;
  return String(value || fallback).replace(/[\r\n]+/g, " ").slice(0, 1200);
}

function inside(root, candidate) {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  return absoluteCandidate === absoluteRoot || absoluteCandidate.startsWith(absoluteRoot + path.sep);
}

export function normalizeImageAssetName(value) {
  if (typeof value !== "string") throw makeError("sourceName must be a relative image asset name.", 400, "SOURCE_NAME_INVALID");
  const raw = value.replaceAll("\\", "/");
  if (!raw || raw.length > 512 || raw.includes("\0") || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) {
    throw makeError("sourceName must be a relative image asset name.", 400, "SOURCE_NAME_INVALID");
  }
  const pieces = raw.split("/");
  if (pieces.some((piece) => !piece || piece === "." || piece === "..")) {
    throw makeError("sourceName must not contain traversal segments.", 400, "SOURCE_NAME_INVALID");
  }
  const normalized = pieces.join("/");
  if (!IMAGE_EXTENSIONS.has(path.posix.extname(normalized).toLowerCase())) {
    throw makeError("Image-to-image accepts PNG, JPG, or WEBP assets only.", 415, "SOURCE_KIND_INVALID");
  }
  return normalized;
}

function sanitizePrefix(value) {
  const result = String(value || "h3_img2img")
    .replaceAll("\\", "_")
    .replaceAll("/", "_")
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 100);
  return result || "h3_img2img";
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function boundedInteger(value, fallback, min, max) {
  return Math.round(boundedNumber(value, fallback, min, max));
}

function link(node, output = 0) {
  return [String(node), output];
}

export function buildImg2ImgPrompt({
  sourceName,
  prompt,
  negativePrompt = "",
  model = IMG2IMG_MODELS[0],
  denoise = 0.65,
  steps = 4,
  cfg = 1,
  seed = 12345,
  filenamePrefix = "img2img/h3_img2img",
} = {}) {
  const image = normalizeImageAssetName(sourceName);
  const positive = String(prompt || "").trim();
  if (!positive) throw makeError("A positive image prompt is required.", 400, "PROMPT_REQUIRED");
  if (positive.length > 4000 || String(negativePrompt || "").length > 4000) {
    throw makeError("Image prompts must be no more than 4000 characters.", 400, "PROMPT_TOO_LONG");
  }
  if (!IMG2IMG_MODELS.includes(model)) throw makeError("Unsupported image checkpoint.", 400, "MODEL_UNSUPPORTED");
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: model } },
    "2": { class_type: "LoadImage", inputs: { image } },
    "3": { class_type: "VAEEncode", inputs: { pixels: link(2), vae: link(1, 2) } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: positive, clip: link(1, 1) } },
    "5": { class_type: "CLIPTextEncode", inputs: { text: String(negativePrompt || "").trim(), clip: link(1, 1) } },
    "6": {
      class_type: "KSampler",
      inputs: {
        model: link(1),
        seed: boundedInteger(seed, 12345, 0, 2_147_483_647),
        steps: boundedInteger(steps, model === IMG2IMG_MODELS[0] ? 4 : 20, 1, 50),
        cfg: boundedNumber(cfg, model === IMG2IMG_MODELS[0] ? 1 : 7, 0, 20),
        sampler_name: "euler_ancestral",
        scheduler: "normal",
        positive: link(4),
        negative: link(5),
        latent_image: link(3),
        denoise: boundedNumber(denoise, 0.65, 0.01, 1),
      },
    },
    "7": { class_type: "VAEDecode", inputs: { samples: link(6), vae: link(1, 2) } },
    "8": { class_type: "SaveImage", inputs: { images: link(7), filename_prefix: String(filenamePrefix || "img2img/h3_img2img") } },
  };
}

function comboValues(nodeInfo, key) {
  const spec = nodeInfo?.input?.required?.[key];
  return Array.isArray(spec?.[0]) ? spec[0].map(String) : [];
}

export function evaluateImg2ImgReadiness(objectInfo, { comfyUi = true } = {}) {
  const nodes = Object.fromEntries(IMG2IMG_REQUIRED_NODES.map((name) => [name, Boolean(objectInfo?.[name])]));
  const listed = comboValues(objectInfo?.CheckpointLoaderSimple, "ckpt_name");
  const models = Object.fromEntries(IMG2IMG_MODELS.map((name) => [name, listed.includes(name)]));
  return {
    ready: Boolean(comfyUi) && Object.values(nodes).every(Boolean) && Object.values(models).some(Boolean),
    comfyUi: Boolean(comfyUi),
    nodes,
    models,
  };
}

function safeArtifact(value) {
  if (!value || typeof value !== "object") return null;
  const filename = String(value.filename || value.name || "").replaceAll("\\", "/");
  const subfolder = String(value.subfolder || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  const type = String(value.type || "output");
  const parts = [...(subfolder ? subfolder.split("/") : []), ...filename.split("/")];
  if (!filename || !["input", "output", "temp"].includes(type) || parts.some((part) => !part || part === "." || part === "..")) return null;
  const relativeName = parts.join("/");
  if (!IMAGE_EXTENSIONS.has(path.posix.extname(relativeName).toLowerCase())) return null;
  return { filename, subfolder, type, relativeName };
}

export function parseImg2ImgHistory(payload, promptId = "") {
  const record = payload?.[promptId] && typeof payload[promptId] === "object" ? payload[promptId] : payload;
  if (!record || typeof record !== "object") return { state: "pending" };
  const status = record.status && typeof record.status === "object" ? record.status : {};
  const statusText = String(status.status_str || status.status || "").toLowerCase();
  const messages = Array.isArray(status.messages) ? status.messages : [];
  const executionError = messages
    .filter((item) => Array.isArray(item) && /error|exception|failed/i.test(String(item[0] || "")))
    .map((item) => item[1]?.exception_message || item[1]?.message || item[1])
    .find(Boolean);
  const nodeErrors = record.node_errors;
  const hasNodeErrors = Array.isArray(nodeErrors) ? nodeErrors.length > 0 : Boolean(nodeErrors && Object.keys(nodeErrors).length);
  if (ERROR_STAGES.has(statusText) || status.completed === false || hasNodeErrors || executionError) {
    return { state: "failed", error: errorMessage(executionError || record.error || "ComfyUI reported an image execution error.") };
  }
  const outputs = record.outputs && typeof record.outputs === "object" ? record.outputs : {};
  for (const nodeId of ["8", ...Object.keys(outputs).filter((key) => key !== "8")]) {
    const images = Array.isArray(outputs[nodeId]?.images) ? outputs[nodeId].images : [];
    for (const image of images) {
      const artifact = safeArtifact(image);
      if (artifact) return { state: "completed", artifact };
    }
  }
  if (status.completed === true || TERMINAL_STAGES.has(statusText)) return { state: "completed" };
  return { state: "running" };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    sourceName: job.sourceName,
    sourceRoot: job.sourceRoot,
    prompt: job.prompt,
    negativePrompt: job.negativePrompt,
    model: job.model,
    denoise: job.denoise,
    steps: job.steps,
    cfg: job.cfg,
    seed: job.seed,
    ...(job.output ? { output: { ...job.output } } : {}),
    ...(job.error ? { error: job.error } : {}),
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  };
}

export function createImg2ImgController({
  comfyUrl = (process.env.COMFY_URL || "http://127.0.0.1:8188").replace(/\/$/, ""),
  remote = false,
  inputRoot,
  outputRoot,
  toAsset,
  beforeRun,
  fetchImpl = globalThis.fetch,
  fsApi = fs,
  now = () => new Date(),
  idFactory = randomUUID,
  pollIntervalMs = 1000,
  maxPollMs = 10 * 60 * 1000,
  requestTimeoutMs = 30_000,
  clientId = "h3-img2img",
} = {}) {
  if (!inputRoot || !outputRoot) throw new Error("Image-to-image controller requires inputRoot and outputRoot.");
  const jobs = new Map();
  const queue = [];
  let active = null;

  async function request(endpoint, init = {}, timeoutMs = requestTimeoutMs) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let response;
    try {
      response = await fetchImpl(comfyUrl + endpoint, { ...init, ...(controller ? { signal: controller.signal } : {}) });
    } catch (error) {
      throw makeError(`ComfyUI request failed: ${errorMessage(error)}`, 503, "COMFY_UNAVAILABLE");
    } finally {
      if (timer) clearTimeout(timer);
    }
    return response;
  }

  async function requestJson(endpoint, init = {}, timeoutMs = requestTimeoutMs) {
    const response = await request(endpoint, init, timeoutMs);
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text || "{}"); } catch { payload = { raw: text }; }
    if (!response.ok) throw makeError(errorMessage(payload?.error || payload?.message || payload?.raw || response.statusText), response.status === 404 ? 404 : 502, "COMFY_REQUEST_FAILED");
    return payload;
  }

  async function checkReadiness() {
    const [stats, objectInfo] = await Promise.all([
      requestJson("/system_stats").then(() => true).catch(() => false),
      requestJson("/object_info").catch(() => null),
    ]);
    return evaluateImg2ImgReadiness(objectInfo, { comfyUi: stats });
  }

  async function resolveAsset(rootName, sourceName) {
    if (!['input', 'output'].includes(rootName)) throw makeError("sourceRoot must be input or output.", 400, "SOURCE_ROOT_INVALID");
    const cleanName = normalizeImageAssetName(sourceName);
    const root = rootName === "output" ? outputRoot : inputRoot;
    const rootReal = await fsApi.realpath(root).catch(() => path.resolve(root));
    const candidate = path.resolve(root, cleanName);
    if (!inside(root, candidate)) throw makeError("Source image path is unsafe.", 400, "SOURCE_PATH_INVALID");
    const candidateReal = await fsApi.realpath(candidate).catch(() => null);
    if (!candidateReal || !inside(rootReal, candidateReal)) throw makeError("Source image is missing or unsafe.", 404, "SOURCE_NOT_FOUND");
    const stat = await fsApi.stat(candidateReal).catch(() => null);
    if (!stat?.isFile()) throw makeError("Source image is missing.", 404, "SOURCE_NOT_FOUND");
    return { cleanName, path: candidateReal };
  }

  async function copyOutputToLocalInput(job, source) {
    const extension = path.posix.extname(source.cleanName).toLowerCase();
    const loadName = `img2img_temp_${job.id}${extension}`;
    const target = path.resolve(inputRoot, loadName);
    if (!inside(inputRoot, target)) throw makeError("Temporary image path is unsafe.", 500, "TEMP_PATH_INVALID");
    await fsApi.mkdir(inputRoot, { recursive: true });
    await fsApi.copyFile(source.path, target);
    return { loadName, path: target, created: true };
  }

  async function uploadRemoteInput(job, source) {
    if (typeof FormData !== "function" || typeof Blob !== "function") throw makeError("Remote image upload is unavailable in this Node runtime.", 500, "UPLOAD_UNAVAILABLE");
    const extension = path.posix.extname(source.cleanName).toLowerCase();
    const uploadName = `${job.id}${extension}`;
    const form = new FormData();
    form.append("image", new Blob([await fsApi.readFile(source.path)], { type: extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg" }), uploadName);
    form.append("subfolder", "h3-studio-img2img");
    form.append("type", "input");
    form.append("overwrite", "true");
    const payload = await requestJson("/upload/image", { method: "POST", body: form }, 60_000);
    const uploaded = safeArtifact({ filename: payload.name || uploadName, subfolder: payload.subfolder || "h3-studio-img2img", type: payload.type || "input" });
    if (!uploaded) throw makeError("ComfyUI returned an invalid uploaded image path.", 502, "UPLOAD_RESPONSE_INVALID");
    return { loadName: uploaded.relativeName, created: false };
  }

  async function cleanupLocalTemp(staged) {
    if (!staged?.created) return;
    const candidate = path.resolve(staged.path);
    if (!inside(inputRoot, candidate)) return;
    const stat = await fsApi.stat(candidate).catch(() => null);
    if (stat?.isFile()) await fsApi.unlink(candidate).catch(() => {});
  }

  async function waitForHistory(job, promptId) {
    const started = Date.now();
    while (true) {
      const parsed = parseImg2ImgHistory(await requestJson(`/history/${encodeURIComponent(promptId)}`), promptId);
      if (parsed.state === "failed") throw makeError(parsed.error, 502, "COMFY_EXECUTION_FAILED");
      if (parsed.state === "completed" && parsed.artifact) return parsed.artifact;
      if (parsed.state === "completed") throw makeError("ComfyUI completed without a SaveImage artifact.", 502, "OUTPUT_ARTIFACT_MISSING");
      const elapsed = Date.now() - started;
      if (maxPollMs > 0 && elapsed >= maxPollMs) throw makeError("Timed out waiting for the generated image.", 504, "COMFY_POLL_TIMEOUT");
      job.progress = Math.min(90, 28 + Math.floor(Math.min(62, elapsed / 3000)));
      job.stage = "Generating image";
      await sleep(pollIntervalMs);
    }
  }

  async function registerLocalArtifact(artifact) {
    const relativeName = normalizeImageAssetName(artifact.relativeName);
    const outputReal = await fsApi.realpath(outputRoot).catch(() => path.resolve(outputRoot));
    const candidate = path.resolve(outputRoot, relativeName);
    const candidateReal = await fsApi.realpath(candidate).catch(() => null);
    if (!candidateReal || !inside(outputReal, candidateReal)) throw makeError("ComfyUI image output is missing or unsafe.", 502, "OUTPUT_ARTIFACT_MISSING");
    return typeof toAsset === "function" ? toAsset("output", relativeName) : { root: "output", name: relativeName, kind: "image" };
  }

  async function downloadRemoteArtifact(job, artifact) {
    const query = new URLSearchParams({ filename: artifact.filename, subfolder: artifact.subfolder, type: artifact.type });
    const response = await request(`/view?${query.toString()}`, {}, 60_000);
    if (!response.ok) throw makeError(`Unable to download generated image: HTTP ${response.status}.`, 502, "OUTPUT_DOWNLOAD_FAILED");
    const extension = path.posix.extname(artifact.filename).toLowerCase();
    const localName = `img2img/${sanitizePrefix(path.posix.basename(job.sourceName, path.posix.extname(job.sourceName)))}-${job.id.slice(0, 8)}${extension}`;
    const candidate = path.resolve(outputRoot, localName);
    if (!inside(outputRoot, candidate)) throw makeError("Downloaded image path is unsafe.", 500, "OUTPUT_PATH_INVALID");
    await fsApi.mkdir(path.dirname(candidate), { recursive: true });
    await fsApi.writeFile(candidate, Buffer.from(await response.arrayBuffer()));
    return typeof toAsset === "function" ? toAsset("output", localName) : { root: "output", name: localName, kind: "image" };
  }

  async function runJob(job) {
    let staged = null;
    try {
      job.status = "running";
      job.startedAt = isoNow(now());
      job.progress = 4;
      job.stage = "Preparing GPU";
      if (typeof beforeRun === "function") await beforeRun(job);
      const readiness = await checkReadiness();
      if (!readiness.ready || !readiness.models[job.model]) throw makeError("Selected image checkpoint or required ComfyUI nodes are unavailable.", 503, "IMG2IMG_NOT_READY");
      job.progress = 12;
      job.stage = "Preparing source image";
      const source = await resolveAsset(job.sourceRoot, job.sourceName);
      if (remote) staged = await uploadRemoteInput(job, source);
      else if (job.sourceRoot === "output") staged = await copyOutputToLocalInput(job, source);
      else staged = { loadName: source.cleanName, created: false };
      const graph = buildImg2ImgPrompt({ ...job, sourceName: staged.loadName, filenamePrefix: `img2img/h3_img2img_${job.id.slice(0, 8)}` });
      job.progress = 22;
      job.stage = "Submitting ComfyUI workflow";
      const submitted = await requestJson("/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: graph, client_id: clientId }),
      });
      const promptId = submitted.prompt_id || submitted.promptId;
      if (!promptId) throw makeError("ComfyUI rejected the image workflow.", 502, "COMFY_PROMPT_REJECTED");
      job.progress = 28;
      const artifact = await waitForHistory(job, String(promptId));
      job.progress = 94;
      job.stage = remote ? "Downloading image" : "Registering image";
      job.output = remote ? await downloadRemoteArtifact(job, artifact) : await registerLocalArtifact(artifact);
      job.progress = 100;
      job.status = "completed";
      job.stage = "Completed";
    } catch (error) {
      job.status = "failed";
      job.stage = "Failed";
      job.error = errorMessage(error);
    } finally {
      await cleanupLocalTemp(staged);
      job.completedAt = isoNow(now());
    }
  }

  function pump() {
    if (active || !queue.length) return;
    const next = queue.shift();
    active = next;
    setTimeout(() => {
      void runJob(next).finally(() => {
        if (active === next) active = null;
        pump();
      });
    }, 0);
  }

  async function enqueue(input = {}) {
    const model = String(input.model || IMG2IMG_MODELS[0]);
    if (!IMG2IMG_MODELS.includes(model)) throw makeError("Unsupported image checkpoint.", 400, "MODEL_UNSUPPORTED");
    const sourceRoot = String(input.sourceRoot || "input");
    const sourceName = normalizeImageAssetName(input.sourceName);
    await resolveAsset(sourceRoot, sourceName);
    const prompt = String(input.prompt || "").trim();
    if (!prompt) throw makeError("A positive image prompt is required.", 400, "PROMPT_REQUIRED");
    const job = {
      id: String(idFactory()),
      status: "queued",
      progress: 0,
      stage: "Queued",
      sourceName,
      sourceRoot,
      prompt,
      negativePrompt: String(input.negativePrompt || "").trim(),
      model,
      denoise: boundedNumber(input.denoise, 0.65, 0.01, 1),
      steps: boundedInteger(input.steps, model === IMG2IMG_MODELS[0] ? 4 : 20, 1, 50),
      cfg: boundedNumber(input.cfg, model === IMG2IMG_MODELS[0] ? 1 : 7, 0, 20),
      seed: boundedInteger(input.seed, Math.floor(Math.random() * 2_147_483_647), 0, 2_147_483_647),
      createdAt: isoNow(now()),
      startedAt: null,
      completedAt: null,
    };
    // Validate the full graph contract before admitting the job.
    buildImg2ImgPrompt(job);
    jobs.set(job.id, job);
    queue.push(job);
    pump();
    return publicJob(job);
  }

  async function handleRoute(req, res, { pathname = new URL(req.url || "/", "http://localhost").pathname, readJson, sendJson, sendError } = {}) {
    if (req.method === "GET" && pathname === "/api/img2img/health") {
      sendJson(res, 200, await checkReadiness());
      return true;
    }
    if (req.method === "POST" && pathname === "/api/img2img") {
      try {
        const body = await readJson(req);
        const readiness = await checkReadiness();
        if (!readiness.ready) {
          sendJson(res, 503, { error: "Image-to-image is not ready.", health: readiness });
          return true;
        }
        sendJson(res, 202, { job: await enqueue(body) });
      } catch (error) {
        sendError(res, Number.isInteger(error?.status) ? error.status : 400, errorMessage(error), error?.code);
      }
      return true;
    }
    if (req.method === "GET" && pathname === "/api/img2img/jobs") {
      sendJson(res, 200, { jobs: [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicJob) });
      return true;
    }
    if (req.method === "GET" && pathname.startsWith("/api/img2img/jobs/")) {
      const id = decodeURIComponent(pathname.slice("/api/img2img/jobs/".length));
      const job = jobs.get(id);
      if (!job) sendError(res, 404, "Image-to-image job not found.");
      else sendJson(res, 200, { job: publicJob(job) });
      return true;
    }
    return false;
  }

  return {
    checkReadiness,
    enqueue,
    getJob: async (id) => jobs.has(String(id)) ? publicJob(jobs.get(String(id))) : null,
    getJobs: () => [...jobs.values()].map(publicJob),
    handleRoute,
    active: () => active ? publicJob(active) : null,
  };
}

