import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * The two files below are deliberately constants.  The model combo returned by
 * ComfyUI is checked against these names before a job is accepted, so a
 * similarly named checkpoint cannot accidentally be used for an upscale.
 */
export const SEEDVR2_UNET_NAME = "seedvr2_3b_int8_convrot.safetensors";
export const SEEDVR2_VAE_NAME = "seedvr2_ema_vae_fp16.safetensors";

export const SEEDVR2_REQUIRED_NODES = Object.freeze([
  "LoadVideo",
  "GetVideoComponents",
  "ResizeImageMaskNode",
  "SeedVR2Preprocess",
  "VAEEncodeTiled",
  "VAELoader",
  "UNETLoader",
  "SeedVR2Conditioning",
  "SeedVR2TemporalChunk",
  "KSampler",
  "SeedVR2TemporalMerge",
  "VAEDecodeTiled",
  "SeedVR2PostProcessing",
  "CreateVideo",
  "SaveVideo",
]);

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi"]);
const VIDEO_MIME_TYPES = Object.freeze({
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
});
const ARTIFACT_KEYS = ["images", "videos", "files", "gifs"];
const TERMINAL_STAGES = new Set(["completed", "success", "succeeded", "finished", "done"]);
const ERROR_STAGES = new Set(["error", "failed", "failure", "cancelled", "canceled"]);

function isoNow(now = Date.now()) {
  return new Date(now).toISOString();
}

function asErrorMessage(error, fallback = "SeedVR2 upscale failed.") {
  if (typeof error === "string") return error.slice(0, 600);
  const message = error instanceof Error ? error.message : error?.message;
  return String(message || fallback).replace(/[\r\n]+/g, " ").slice(0, 600);
}

function makeError(message, status = 500, code = "SEEDVR2_ERROR") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function isInside(root, candidate) {
  const rootPath = path.resolve(root);
  const candidatePath = path.resolve(candidate);
  return candidatePath === rootPath || candidatePath.startsWith(rootPath + path.sep);
}

/**
 * Normalize an asset name without ever turning traversal into a valid path.
 * Windows drive/UNC names are rejected even when this code runs on POSIX in a
 * test runner; the bridge can be deployed on either platform.
 */
export function normalizeVideoAssetName(value) {
  if (typeof value !== "string") throw makeError("sourceName must be a relative video asset name.", 400, "SOURCE_NAME_INVALID");
  const raw = value.replaceAll("\\", "/");
  if (!raw || raw.length > 512 || raw.includes("\0") || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) {
    throw makeError("sourceName must be a relative video asset name.", 400, "SOURCE_NAME_INVALID");
  }
  const pieces = raw.split("/");
  if (pieces.some((piece) => !piece || piece === "." || piece === "..")) {
    throw makeError("sourceName must not contain traversal segments.", 400, "SOURCE_NAME_INVALID");
  }
  const normalized = pieces.join("/");
  if (!VIDEO_EXTENSIONS.has(path.posix.extname(normalized).toLowerCase())) {
    throw makeError("SeedVR2 accepts video assets only.", 415, "SOURCE_KIND_INVALID");
  }
  return normalized;
}

function comboValues(nodeInfo, key) {
  const spec = nodeInfo?.input?.required?.[key];
  if (!Array.isArray(spec)) return [];
  if (Array.isArray(spec[0])) return spec[0].map((value) => String(value));
  return [];
}

export function evaluateSeedVR2Readiness(objectInfo, {
  unetName = SEEDVR2_UNET_NAME,
  vaeName = SEEDVR2_VAE_NAME,
  modelFiles = {},
  comfyUi = true,
} = {}) {
  const nodes = Object.fromEntries(SEEDVR2_REQUIRED_NODES.map((name) => [name, Boolean(objectInfo?.[name])]));
  const unetListed = comboValues(objectInfo?.UNETLoader, "unet_name").includes(unetName);
  const vaeListed = comboValues(objectInfo?.VAELoader, "vae_name").includes(vaeName);
  const unetFile = modelFiles.unet === undefined ? true : Boolean(modelFiles.unet);
  const vaeFile = modelFiles.vae === undefined ? true : Boolean(modelFiles.vae);
  const models = {
    unet: { name: unetName, available: unetListed && unetFile },
    vae: { name: vaeName, available: vaeListed && vaeFile },
  };
  const ready = Boolean(comfyUi) && Object.values(nodes).every(Boolean) && models.unet.available && models.vae.available;
  return { ready, comfyUi: Boolean(comfyUi), models, nodes };
}

function link(node, output = 0) {
  return [String(node), output];
}

/**
 * Build the native ComfyUI 0.30.0 graph.  TemporalChunk's list output is
 * intentionally fanned out to both Conditioning and KSampler; Comfy's list
 * execution maps those nodes per chunk and TemporalMerge joins the samples.
 */
export function buildSeedVR2Prompt({
  sourceName,
  filenamePrefix = "seedvr2_upscaled",
  unetName = SEEDVR2_UNET_NAME,
  vaeName = SEEDVR2_VAE_NAME,
  seed,
} = {}) {
  const file = normalizeVideoAssetName(sourceName);
  const safePrefix = sanitizeFilenamePrefix(filenamePrefix);
  const samplerSeed = Number.isSafeInteger(seed) && seed >= 0 ? seed : Math.floor(Math.random() * 2_147_483_647);
  return {
    "1": { class_type: "LoadVideo", inputs: { file } },
    "2": { class_type: "GetVideoComponents", inputs: { video: link(1) } },
    "3": {
      class_type: "ResizeImageMaskNode",
      inputs: {
        input: link(2),
        resize_type: "scale by multiplier",
        "resize_type.multiplier": 2,
        scale_method: "lanczos",
      },
    },
    "4": { class_type: "SeedVR2Preprocess", inputs: { resized_images: link(3) } },
    "5": { class_type: "VAELoader", inputs: { vae_name: vaeName } },
    "6": {
      class_type: "VAEEncodeTiled",
      inputs: {
        pixels: link(4),
        vae: link(5),
        tile_size: 512,
        overlap: 64,
        temporal_size: 16,
        temporal_overlap: 4,
      },
    },
    "7": { class_type: "UNETLoader", inputs: { unet_name: unetName, weight_dtype: "default" } },
    "8": { class_type: "SeedVR2Conditioning", inputs: { model: link(7), vae_conditioning: link(9) } },
    "9": { class_type: "SeedVR2TemporalChunk", inputs: { latent: link(6), temporal_overlap: 0, chunking_mode: "auto" } },
    "10": {
      class_type: "KSampler",
      inputs: {
        model: link(7),
        seed: samplerSeed,
        steps: 1,
        cfg: 1,
        sampler_name: "euler",
        scheduler: "simple",
        positive: link(8, 0),
        negative: link(8, 1),
        latent_image: link(9),
        denoise: 1,
      },
    },
    "11": { class_type: "SeedVR2TemporalMerge", inputs: { latents: link(10), temporal_overlap: link(9, 1) } },
    "12": {
      class_type: "VAEDecodeTiled",
      inputs: {
        samples: link(11),
        vae: link(5),
        tile_size: 512,
        overlap: 64,
        temporal_size: 16,
        temporal_overlap: 4,
      },
    },
    "13": { class_type: "SeedVR2PostProcessing", inputs: { images: link(12), original_resized_images: link(3), color_correction_method: "none" } },
    "14": { class_type: "CreateVideo", inputs: { images: link(13), fps: link(2, 2), audio: link(2, 1) } },
    "15": {
      class_type: "SaveVideo",
      inputs: {
        video: link(14),
        filename_prefix: safePrefix,
        format: "mp4",
        codec: "h264",
        "codec.encoding": "re-encode",
        "codec.encoding.crf": 18,
      },
    },
  };
}

export function sanitizeFilenamePrefix(value) {
  const raw = String(value || "seedvr2_upscaled")
    .replaceAll("\\", "_")
    .replaceAll("/", "_")
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return raw || "seedvr2_upscaled";
}

function historyRecord(payload, promptId) {
  if (!payload || typeof payload !== "object") return null;
  return payload[promptId] && typeof payload[promptId] === "object" ? payload[promptId] : payload;
}

function artifactFromValue(value) {
  if (typeof value === "string") return { filename: value, subfolder: "", type: "output" };
  if (!value || typeof value !== "object") return null;
  const filename = value.filename || value.name || value.file;
  if (typeof filename !== "string" || !filename) return null;
  return {
    filename,
    subfolder: typeof value.subfolder === "string" ? value.subfolder : "",
    type: typeof value.type === "string" ? value.type : "output",
  };
}

function artifactRelativeName(candidate) {
  if (!candidate) return null;
  const rawSubfolder = String(candidate.subfolder || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  const rawFilename = String(candidate.filename || "").replaceAll("\\", "/");
  if (!rawFilename || rawFilename.startsWith("/") || /^[A-Za-z]:\//.test(rawFilename)) return null;
  const pieces = [...(rawSubfolder ? rawSubfolder.split("/") : []), ...rawFilename.split("/")];
  if (pieces.some((part) => !part || part === "." || part === "..")) return null;
  const relativeName = pieces.join("/");
  return VIDEO_EXTENSIONS.has(path.posix.extname(relativeName).toLowerCase()) ? relativeName : null;
}

function historyArtifact(payload, promptId) {
  const record = historyRecord(payload, promptId);
  if (!record) return null;
  const outputs = record.outputs && typeof record.outputs === "object" ? record.outputs : {};
  const orderedNodes = ["15", ...Object.keys(outputs).filter((key) => key !== "15")];
  for (const nodeId of orderedNodes) {
    const output = outputs[nodeId];
    if (!output || typeof output !== "object") continue;
    for (const key of ARTIFACT_KEYS) {
      const values = Array.isArray(output[key]) ? output[key] : [];
      for (const value of values) {
        const parsed = artifactFromValue(value);
        const relativeName = artifactRelativeName(parsed);
        if (relativeName) return { ...parsed, relativeName };
      }
    }
  }
  return null;
}

export function parseSeedVR2History(payload, promptId = "") {
  const record = historyRecord(payload, promptId);
  if (!record) return { state: "pending" };
  const status = record.status && typeof record.status === "object" ? record.status : {};
  const statusText = String(status.status_str || status.status || record.status || "").toLowerCase();
  const messages = Array.isArray(status.messages) ? status.messages : [];
  const errorMessage = messages
    .filter((message) => Array.isArray(message) && /error|exception|failed/i.test(String(message[0] || "")))
    .map((message) => message[1]?.exception_message || message[1]?.message || message[1])
    .find(Boolean);
  const nodeErrors = record.node_errors;
  const hasNodeErrors = Array.isArray(nodeErrors) ? nodeErrors.length > 0 : Boolean(nodeErrors && typeof nodeErrors === "object" && Object.keys(nodeErrors).length);
  if (ERROR_STAGES.has(statusText) || status.completed === false || hasNodeErrors || errorMessage) {
    return { state: "failed", error: asErrorMessage(errorMessage || record.error || statusText || "ComfyUI reported an execution error.") };
  }

  const artifact = historyArtifact(payload, promptId);
  if (artifact) return { state: "completed", artifact: artifact.relativeName };

  if (status.completed === true || TERMINAL_STAGES.has(statusText)) return { state: "completed" };
  return { state: "running" };
}

function responsePayload(response, text) {
  if (text === undefined) return response?.json ? response.json() : {};
  try {
    return JSON.parse(text || "{}");
  } catch {
    return { raw: text };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileExists(filePath, fsApi = fs) {
  const stat = await fsApi.stat(filePath).catch(() => null);
  return Boolean(stat?.isFile());
}

async function realPathOrResolved(filePath, fsApi = fs) {
  return fsApi.realpath(filePath).catch(() => path.resolve(filePath));
}

function publicJob(job) {
  const output = job.output ? { ...job.output } : undefined;
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    sourceName: job.sourceName,
    sourceRoot: job.sourceRoot,
    scale: job.scale,
    ...(output ? { output } : {}),
    ...(job.error ? { error: job.error } : {}),
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  };
}

function uniqueId() {
  return randomUUID();
}

export function createSeedVR2Controller({
  comfyUrl = (process.env.COMFY_URL || "http://127.0.0.1:8188").replace(/\/$/, ""),
  remote = false,
  comfyRoot,
  inputRoot,
  outputRoot,
  toAsset,
  fetchImpl = globalThis.fetch,
  fsApi = fs,
  now = () => new Date(),
  idFactory = uniqueId,
  requestTimeoutMs = 15_000,
  pollIntervalMs = 1_000,
  maxPollMs = 0,
  clientId = "h3-seedvr2",
} = {}) {
  if (!inputRoot || !outputRoot) throw new Error("SeedVR2 controller requires inputRoot and outputRoot.");
  const comfyRootPath = path.resolve(comfyRoot || path.dirname(inputRoot));
  const modelPaths = {
    unet: path.join(comfyRootPath, "models", "diffusion_models", SEEDVR2_UNET_NAME),
    vae: path.join(comfyRootPath, "models", "vae", SEEDVR2_VAE_NAME),
  };
  const jobs = new Map();
  const queue = [];
  let active = null;

  async function request(endpoint, init = {}, timeoutMs = requestTimeoutMs) {
    if (typeof fetchImpl !== "function") throw makeError("ComfyUI transport is unavailable.", 503, "COMFY_UNAVAILABLE");
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let response;
    try {
      response = await fetchImpl(comfyUrl + endpoint, { ...init, ...(controller ? { signal: controller.signal } : {}) });
    } catch (error) {
      throw makeError(`ComfyUI request failed: ${asErrorMessage(error)}`, 503, "COMFY_UNAVAILABLE");
    } finally {
      if (timer) clearTimeout(timer);
    }
    return response;
  }

  async function requestJson(endpoint, init = {}, timeoutMs = requestTimeoutMs) {
    const response = await request(endpoint, init, timeoutMs);
    const text = typeof response?.text === "function" ? await response.text() : undefined;
    const payload = await responsePayload(response, text);
    if (!response?.ok) {
      const message = payload?.error || payload?.message || payload?.raw || response?.statusText || "ComfyUI request failed.";
      throw makeError(asErrorMessage(message), response?.status === 404 ? 404 : 502, "COMFY_REQUEST_FAILED");
    }
    return payload;
  }

  async function checkReadiness() {
    const [statsResult, objectResult, modelFiles] = await Promise.all([
      requestJson("/system_stats").then(() => true).catch(() => false),
      requestJson("/object_info").catch(() => null),
      Promise.all([
        fileExists(modelPaths.unet, fsApi),
        fileExists(modelPaths.vae, fsApi),
      ]).then(([unet, vae]) => ({ unet, vae })),
    ]);
    return evaluateSeedVR2Readiness(objectResult, { modelFiles, comfyUi: statsResult });
  }

  async function resolveAsset(rootName, sourceName) {
    const cleanName = normalizeVideoAssetName(sourceName);
    const root = rootName === "output" ? outputRoot : inputRoot;
    const rootReal = await realPathOrResolved(root, fsApi);
    const candidate = path.resolve(root, cleanName);
    if (!isInside(root, candidate)) throw makeError("Asset path escapes its media root.", 400, "SOURCE_PATH_INVALID");
    const candidateReal = await fsApi.realpath(candidate).catch(() => null);
    if (!candidateReal || !isInside(rootReal, candidateReal)) throw makeError("Source asset is missing or unsafe.", 404, "SOURCE_NOT_FOUND");
    const stat = await fsApi.stat(candidateReal).catch(() => null);
    if (!stat?.isFile()) throw makeError("Source asset is missing.", 404, "SOURCE_NOT_FOUND");
    return { cleanName, path: candidateReal };
  }

  async function stageOutputSource(job, source) {
    const extension = path.posix.extname(source.cleanName).toLowerCase() || ".mp4";
    // Keep the temporary file visible to LoadVideo's input combo (and make it
    // unambiguous in diagnostics) while retaining UUID-derived uniqueness.
    const relativeName = `seedvr2_temp_${job.id}${extension}`;
    const candidate = path.resolve(inputRoot, relativeName);
    const inputReal = await realPathOrResolved(inputRoot, fsApi);
    if (!isInside(inputRoot, candidate) || !isInside(inputReal, await realPathOrResolved(path.dirname(candidate), fsApi))) {
      throw makeError("Temporary input path is unsafe.", 500, "TEMP_PATH_INVALID");
    }
    await fsApi.mkdir(inputRoot, { recursive: true });
    try {
      await fsApi.copyFile(source.path, candidate, fsApi.constants?.COPYFILE_EXCL);
    } catch (error) {
      // Some test doubles do not expose constants or copyFile flags.  The name
      // is UUID-derived, so a second attempt without the optional flag is safe.
      if (error?.code !== "EEXIST") await fsApi.copyFile(source.path, candidate);
    }
    const createdPath = await fsApi.realpath(candidate).catch(() => null);
    if (!createdPath || !isInside(inputReal, createdPath)) throw makeError("Temporary input path is unsafe.", 500, "TEMP_PATH_INVALID");
    return { loadName: relativeName, path: createdPath, created: true };
  }

  async function uploadRemoteInput(job, source) {
    if (typeof FormData !== "function" || typeof Blob !== "function") {
      throw makeError("Remote video upload is unavailable in this Node runtime.", 500, "UPLOAD_UNAVAILABLE");
    }
    const extension = path.posix.extname(source.cleanName).toLowerCase() || ".mp4";
    const uploadName = `seedvr2_temp_${sanitizeFilenamePrefix(job.id)}${extension}`;
    let bytes;
    try {
      bytes = await fsApi.readFile(source.path);
    } catch (error) {
      throw makeError(`Unable to read source video for remote upload: ${asErrorMessage(error)}`, 502, "SOURCE_READ_FAILED");
    }
    const form = new FormData();
    form.append("image", new Blob([bytes], { type: VIDEO_MIME_TYPES[extension] || "application/octet-stream" }), uploadName);
    form.append("subfolder", "h3-studio-seedvr2");
    form.append("type", "input");
    form.append("overwrite", "true");
    const payload = await requestJson("/upload/image", { method: "POST", body: form }, 60_000);
    const uploaded = artifactRelativeName({
      filename: payload?.name || uploadName,
      subfolder: typeof payload?.subfolder === "string" ? payload.subfolder : "h3-studio-seedvr2",
    });
    if (!uploaded) throw makeError("ComfyUI returned an invalid uploaded video path.", 502, "UPLOAD_RESPONSE_INVALID");
    return { loadName: uploaded, created: false };
  }

  async function cleanupStagedTemp(staged, job) {
    if (!staged?.created) return;
    try {
      const inputReal = await realPathOrResolved(inputRoot, fsApi);
      const candidate = path.resolve(inputRoot, staged.loadName);
      if (!isInside(inputRoot, candidate)) throw new Error("temporary path escaped input root");
      const candidateReal = await fsApi.realpath(candidate).catch(() => candidate);
      if (!isInside(inputReal, candidateReal)) throw new Error("temporary path realpath escaped input root");
      const stat = await fsApi.stat(candidateReal).catch(() => null);
      if (stat?.isFile()) await fsApi.unlink(candidateReal);
    } catch {
      // A cleanup safety failure must never replace a successful output.  Keep
      // a bounded internal warning for diagnostics; public job shape is stable.
      job.cleanupWarning = "temporary input cleanup skipped";
      console.warn("[seedvr2] temporary input cleanup skipped");
    }
  }

  function outputPrefix(job) {
    const stem = path.posix.basename(job.sourceName, path.posix.extname(job.sourceName));
    return sanitizeFilenamePrefix(`seedvr2_${stem}_${job.id.slice(0, 8)}`);
  }

  async function artifactAsset(relativeName) {
    const clean = artifactRelativeName({ filename: relativeName });
    if (!clean) throw makeError("ComfyUI returned an unsafe output artifact.", 502, "OUTPUT_ARTIFACT_INVALID");
    const outputReal = await realPathOrResolved(outputRoot, fsApi);
    const candidate = path.resolve(outputRoot, clean);
    if (!isInside(outputRoot, candidate)) throw makeError("ComfyUI output escaped its output root.", 502, "OUTPUT_ARTIFACT_INVALID");
    const candidateReal = await fsApi.realpath(candidate).catch(() => null);
    if (!candidateReal || !isInside(outputReal, candidateReal)) throw makeError("ComfyUI output is missing or unsafe.", 502, "OUTPUT_ARTIFACT_INVALID");
    const stat = await fsApi.stat(candidateReal).catch(() => null);
    if (!stat?.isFile()) throw makeError("ComfyUI output is missing.", 502, "OUTPUT_ARTIFACT_MISSING");
    if (typeof toAsset === "function") return await toAsset("output", clean);
    return { name: clean, root: "output", kind: "video" };
  }

  async function downloadRemoteArtifact(job, artifact) {
    const metadata = artifact && typeof artifact === "object"
      ? artifact
      : { filename: artifact, subfolder: "", type: "output" };
    const relativeName = artifactRelativeName(metadata);
    if (!relativeName) throw makeError("ComfyUI returned an unsafe output artifact.", 502, "OUTPUT_ARTIFACT_INVALID");
    if (metadata.type && metadata.type !== "output") throw makeError("ComfyUI returned a non-output artifact.", 502, "OUTPUT_ARTIFACT_INVALID");
    const filename = String(metadata.filename).replaceAll("\\", "/");
    const subfolder = String(metadata.subfolder || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
    const query = new URLSearchParams({
      filename,
      subfolder,
      type: "output",
    });
    const response = await request(`/view?${query.toString()}`, {}, 60_000);
    if (!response?.ok) throw makeError(`Unable to download generated video: HTTP ${response?.status || 0}.`, 502, "OUTPUT_DOWNLOAD_FAILED");
    if (typeof response.arrayBuffer !== "function") throw makeError("ComfyUI returned an unreadable video artifact.", 502, "OUTPUT_DOWNLOAD_FAILED");

    const extension = path.posix.extname(relativeName).toLowerCase();
    const localName = `seedvr2/${outputPrefix(job)}${extension}`;
    const candidate = path.resolve(outputRoot, localName);
    if (!isInside(outputRoot, candidate)) throw makeError("Downloaded video path is unsafe.", 500, "OUTPUT_PATH_INVALID");
    const outputReal = await realPathOrResolved(outputRoot, fsApi);
    await fsApi.mkdir(path.dirname(candidate), { recursive: true });
    const parentReal = await realPathOrResolved(path.dirname(candidate), fsApi);
    if (!isInside(outputReal, parentReal)) throw makeError("Downloaded video path escaped its output root.", 500, "OUTPUT_PATH_INVALID");
    const existingReal = await fsApi.realpath(candidate).catch(() => null);
    if (existingReal && !isInside(outputReal, existingReal)) throw makeError("Downloaded video path escaped its output root.", 500, "OUTPUT_PATH_INVALID");
    await fsApi.writeFile(candidate, Buffer.from(await response.arrayBuffer()));
    const createdReal = await fsApi.realpath(candidate).catch(() => null);
    if (!createdReal || !isInside(outputReal, createdReal)) throw makeError("Downloaded video path escaped its output root.", 500, "OUTPUT_PATH_INVALID");
    if (typeof toAsset === "function") return await toAsset("output", localName);
    return { name: localName, root: "output", kind: "video" };
  }

  async function waitForHistory(job, promptId) {
    const started = Date.now();
    while (true) {
      const payload = await requestJson(`/history/${encodeURIComponent(promptId)}`);
      const parsed = parseSeedVR2History(payload, promptId);
      if (parsed.state === "failed") throw makeError(parsed.error || "ComfyUI reported an execution error.", 502, "COMFY_EXECUTION_FAILED");
      const artifact = parsed.state === "completed" ? historyArtifact(payload, promptId) : null;
      if (artifact) return artifact;
      if (parsed.state === "completed") throw makeError("ComfyUI completed without a SaveVideo artifact.", 502, "OUTPUT_ARTIFACT_MISSING");
      const elapsed = Date.now() - started;
      if (maxPollMs > 0 && elapsed >= maxPollMs) throw makeError("Timed out while waiting for ComfyUI output.", 504, "COMFY_POLL_TIMEOUT");
      job.progress = Math.min(90, Math.max(25, 25 + Math.floor(Math.min(65, elapsed / 4000))));
      job.stage = "Processing SeedVR2";
      await sleep(pollIntervalMs);
    }
  }

  async function runJob(job) {
    let staged = null;
    let succeeded = false;
    try {
      job.status = "running";
      job.startedAt = isoNow(now());
      job.progress = 5;
      job.stage = "Checking SeedVR2 readiness";
      const readiness = await checkReadiness();
      if (!readiness.ready) throw makeError("SeedVR2 is unavailable: required ComfyUI nodes or model files are missing.", 503, "SEEDVR2_NOT_READY");

      job.progress = 12;
      job.stage = "Validating source video";
      const source = await resolveAsset(job.sourceRoot, job.sourceName);
      let loadName = source.cleanName;
      if (remote) {
        job.progress = 16;
        job.stage = "Uploading source video";
        staged = await uploadRemoteInput(job, source);
        loadName = staged.loadName;
      } else if (job.sourceRoot === "output") {
        job.progress = 16;
        job.stage = "Staging source video";
        staged = await stageOutputSource(job, source);
        loadName = staged.loadName;
      }

      const prompt = buildSeedVR2Prompt({ sourceName: loadName, filenamePrefix: outputPrefix(job), unetName: SEEDVR2_UNET_NAME, vaeName: SEEDVR2_VAE_NAME });
      job.progress = 20;
      job.stage = "Submitting ComfyUI workflow";
      const submitted = await requestJson("/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, client_id: clientId }),
      });
      const promptId = submitted?.prompt_id || submitted?.promptId;
      if (!promptId) {
        const rejection = submitted?.error || submitted?.node_errors;
        throw makeError(rejection ? `ComfyUI rejected the workflow: ${asErrorMessage(rejection)}` : "ComfyUI did not return a prompt id.", 502, "COMFY_PROMPT_REJECTED");
      }
      job.progress = 25;
      job.stage = "Processing SeedVR2";
      const artifact = await waitForHistory(job, String(promptId));
      job.progress = 92;
      job.stage = remote ? "Downloading output video" : "Registering output video";
      job.output = remote ? await downloadRemoteArtifact(job, artifact) : await artifactAsset(artifact.relativeName || artifact);
      job.progress = 100;
      succeeded = true;
    } catch (error) {
      job.progress = Math.min(100, Math.max(job.progress, 1));
      job.error = asErrorMessage(error);
    } finally {
      await cleanupStagedTemp(staged, job);
      job.completedAt = isoNow(now());
      if (succeeded) {
        job.stage = "Completed";
        job.status = "completed";
      } else {
        job.stage = "Failed";
        job.status = "failed";
      }
    }
  }

  function pump() {
    if (active || !queue.length) return;
    const next = queue.shift();
    active = next;
    // Keep the 202 response observably `queued`; execution starts on the next
    // turn while the queue remains single-active.
    setTimeout(() => {
      void runJob(next).finally(() => {
        if (active === next) active = null;
        pump();
      });
    }, 0);
  }

  async function enqueue({ sourceName, sourceRoot = "input", scale = 2 } = {}) {
    if (!["input", "output"].includes(sourceRoot)) throw makeError("sourceRoot must be input or output.", 400, "SOURCE_ROOT_INVALID");
    if (scale !== 2) throw makeError("SeedVR2 upscale currently supports scale=2 only.", 400, "SCALE_INVALID");
    const cleanName = normalizeVideoAssetName(sourceName);
    // Reject missing assets at admission time; the worker revalidates again in
    // case a user deletes/replaces the file while it waits in the queue.
    await resolveAsset(sourceRoot, cleanName);
    const job = {
      id: String(idFactory()),
      status: "queued",
      progress: 0,
      stage: "Queued",
      sourceName: cleanName,
      sourceRoot,
      scale: 2,
      createdAt: isoNow(now()),
      startedAt: null,
      completedAt: null,
    };
    jobs.set(job.id, job);
    queue.push(job);
    pump();
    return publicJob(job);
  }

  async function getJob(id) {
    const job = jobs.get(String(id));
    return job ? publicJob(job) : null;
  }

  async function handleRoute(req, res, { pathname = new URL(req.url || "/", "http://localhost").pathname, readJson, sendJson, sendError } = {}) {
    const respond = sendJson || ((response, status, payload) => {
      const body = JSON.stringify(payload);
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(body);
    });
    const fail = sendError || ((response, status, message) => respond(response, status, { error: message }));
    if (req.method === "GET" && pathname === "/api/upscale/health") {
      respond(res, 200, await checkReadiness());
      return true;
    }
    if (req.method === "POST" && pathname === "/api/upscale") {
      try {
        const body = typeof readJson === "function" ? await readJson(req) : {};
        const readiness = await checkReadiness();
        if (!readiness.ready) {
          respond(res, 503, { error: "SeedVR2 is not ready.", health: readiness });
          return true;
        }
        respond(res, 202, { job: await enqueue(body) });
      } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : 400;
        fail(res, status, asErrorMessage(error, "Unable to queue SeedVR2 upscale."));
      }
      return true;
    }
    if (req.method === "GET" && pathname === "/api/upscale/jobs") {
      const list = [...jobs.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 100).map(publicJob);
      respond(res, 200, { jobs: list });
      return true;
    }
    if (req.method === "GET" && pathname.startsWith("/api/upscale/jobs/")) {
      const id = decodeURIComponent(pathname.slice("/api/upscale/jobs/".length));
      const job = await getJob(id);
      if (!job) {
        fail(res, 404, "SeedVR2 job not found.");
        return true;
      }
      respond(res, 200, { job });
      return true;
    }
    return false;
  }

  return {
    buildPrompt: buildSeedVR2Prompt,
    checkReadiness,
    enqueue,
    getJob,
    getJobs: () => [...jobs.values()].map(publicJob),
    handleRoute,
    publicJob,
    parseHistory: parseSeedVR2History,
    active: () => active ? publicJob(active) : null,
  };
}

export { artifactRelativeName, publicJob };
