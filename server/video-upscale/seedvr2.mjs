import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createSeedVR2JobStore } from "./seedvr2-store.mjs";

/**
 * The two files below are deliberately constants.  The model combo returned by
 * ComfyUI is checked against these names before a job is accepted, so a
 * similarly named checkpoint cannot accidentally be used for an upscale.
 */
export const SEEDVR2_UNET_NAME = "seedvr2_3b_int8_convrot.safetensors";
export const SEEDVR2_VAE_NAME = "seedvr2_ema_vae_fp16.safetensors";
export const SEEDVR2_PROFILE = "seedvr2_3b_int8";
export const SEEDVR2_PROFILE_LABEL = "SeedVR2 3B Int8";

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

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(makeError("SeedVR2 cancellation requested.", 499, "SEEDVR2_CANCELLED"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      reject(makeError("SeedVR2 cancellation requested.", 499, "SEEDVR2_CANCELLED"));
    };
    function done() {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

async function fileExists(filePath, fsApi = fs) {
  const stat = await fsApi.stat(filePath).catch(() => null);
  return Boolean(stat?.isFile());
}

async function realPathOrResolved(filePath, fsApi = fs) {
  return fsApi.realpath(filePath).catch(() => path.resolve(filePath));
}

function cloneValue(value) {
  if (value === undefined) return undefined;
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

function publicGpuLease(gpuCoordinator, workloadType, job) {
  const state = gpuCoordinator?.get?.(`${workloadType}:${job.id}`);
  if (!state) return undefined;
  return {
    status: state.status,
    workloadType: state.workloadType,
    queuePosition: state.queuePosition,
    runtimeMode: state.runtimeMode,
  };
}

function publicJob(job, gpuCoordinator = null, gpuWorkloadType = "seedvr2-upscale") {
  const gpu = publicGpuLease(gpuCoordinator, gpuWorkloadType, job);
  const output = job.output ? cloneValue(job.output) : undefined;
  const source = job.source && typeof job.source === "object"
    ? cloneValue(job.source)
    : { name: job.sourceName, root: job.sourceRoot };
  return {
    id: job.id,
    status: job.status,
    ...(gpu ? { gpu } : {}),
    progress: job.progress,
    stage: job.stage,
    source,
    sourceName: job.sourceName,
    sourceRoot: job.sourceRoot,
    scale: job.scale,
    profile: job.profile,
    seed: job.seed,
    prompt: cloneValue(job.prompt),
    ...(job.promptId ? { promptId: job.promptId } : {}),
    output: output || null,
    error: job.error || "",
    ...(job.cancelReason ? { cancelReason: job.cancelReason } : {}),
    ...(job.recoverable ? { recoverable: true } : {}),
    ...(job.recovery ? { recovery: cloneValue(job.recovery) } : {}),
    ...(Number.isInteger(job.attempt) ? { attempt: job.attempt } : {}),
    ...(job.retryOf ? { retryOf: job.retryOf } : {}),
    ...(job.provenance ? { provenance: cloneValue(job.provenance) } : {}),
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    ...(job.cancelledAt ? { cancelledAt: job.cancelledAt } : {}),
    ...(job.updatedAt ? { updatedAt: job.updatedAt } : {}),
    ...(job.timestamps ? { timestamps: cloneValue(job.timestamps) } : {}),
  };
}

function uniqueId() {
  return randomUUID();
}

function cancellationError() {
  return makeError("SeedVR2 cancellation requested.", 499, "SEEDVR2_CANCELLED");
}

function assertNotCancelled(job) {
  if (job?.cancelRequested) throw cancellationError();
}

function boundedSeed(value, fallback = null) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > 2_147_483_647) return fallback;
  return numeric;
}

function normalizeProfile(value) {
  const profile = String(value || SEEDVR2_PROFILE).trim();
  if (![SEEDVR2_PROFILE, SEEDVR2_PROFILE_LABEL].includes(profile)) {
    throw makeError("SeedVR2 profile is invalid.", 400, "PROFILE_INVALID");
  }
  return SEEDVR2_PROFILE;
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
  jobStore = createSeedVR2JobStore(),
  requestTimeoutMs = 15_000,
  pollIntervalMs = 1_000,
  maxPollMs = 0,
  clientId = "h3-seedvr2",
  gpuCoordinator = null,
  gpuWorkloadType = "seedvr2-upscale",
  gpuRuntime = remote ? "remote" : "local",
} = {}) {
  if (!inputRoot || !outputRoot) throw new Error("SeedVR2 controller requires inputRoot and outputRoot.");
  const comfyRootPath = path.resolve(comfyRoot || path.dirname(inputRoot));
  const modelPaths = {
    unet: path.join(comfyRootPath, "models", "diffusion_models", SEEDVR2_UNET_NAME),
    vae: path.join(comfyRootPath, "models", "vae", SEEDVR2_VAE_NAME),
  };
  const jobs = new Map();
  const queue = [];
  const runtimes = new Map();
  const gpuAdmissions = new Map();
  const pendingPersistence = new Map();
  const toPublicJob = (job) => publicJob(job, gpuCoordinator, gpuWorkloadType);
  let active = null;
  let storeLoaded = false;
  let storeLoading = null;

  function ensureGpuAdmission(job) {
    if (!gpuCoordinator) return null;
    const existing = gpuAdmissions.get(String(job.id));
    if (existing) return existing;
    const admission = gpuCoordinator.request({
      requestId: `${gpuWorkloadType}:${job.id}`,
      jobId: `${gpuWorkloadType}:${job.id}`,
      workloadType: gpuWorkloadType,
      runtime: gpuRuntime,
      metadata: { profile: job.profile, sourceRoot: job.sourceRoot },
    });
    gpuAdmissions.set(String(job.id), admission);
    return admission;
  }

  function cancelGpuAdmission(jobId, reason) {
    const admission = gpuAdmissions.get(String(jobId));
    if (!admission) return false;
    const cancelled = admission.cancel(reason);
    if (cancelled) gpuAdmissions.delete(String(jobId));
    return cancelled;
  }

  async function ensureStoreLoaded() {
    if (storeLoaded) return;
    if (!storeLoading) {
      storeLoading = Promise.resolve().then(async () => {
        const recovered = typeof jobStore.recover === "function"
          ? await jobStore.recover({ ownerId: `seedvr2-bridge-${process.pid}`, recoveredAt: isoNow(now()) })
          : { jobs: await jobStore.list(), requeued: [] };
        for (const job of recovered.jobs || []) {
          if (job?.id) jobs.set(String(job.id), job);
        }
        for (const job of (recovered.requeued || []).sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
          const queuedJob = job?.id ? jobs.get(String(job.id)) || job : null;
          if (queuedJob && !queue.some((queued) => queued.id === queuedJob.id)) {
            ensureGpuAdmission(queuedJob);
            queue.push(queuedJob);
          }
        }
        storeLoaded = true;
        pump();
        if (typeof jobStore.prune === "function") {
          await jobStore.prune({ maxTerminalJobs: 100 }).catch((error) => {
            console.warn("[seedvr2] retention warning", error?.message || error);
          });
        }
        return recovered;
      }).finally(() => {
        storeLoading = null;
      });
    }
    await storeLoading;
  }

  async function persistJob(job, { required = false } = {}) {
    const key = String(job.id);
    const updatedAt = isoNow(now());
    const snapshot = cloneValue({ ...job, updatedAt });
    const previous = pendingPersistence.get(key) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      try {
        const saved = await jobStore.save(snapshot);
        if (jobs.get(key) === job) Object.assign(job, saved);
        return saved;
      } catch (error) {
        if (required) throw makeError(`Unable to persist SeedVR2 job: ${asErrorMessage(error)}`, 503, "SEEDVR2_PERSISTENCE_FAILED");
        console.warn(`[seedvr2] job persistence warning ${key}:`, error?.message || error);
        return null;
      }
    });
    const tracked = operation.finally(() => {
      if (pendingPersistence.get(key) === tracked) pendingPersistence.delete(key);
    }).catch(() => {});
    pendingPersistence.set(key, tracked);
    return await operation;
  }

  async function waitForPersistence(id) {
    await pendingPersistence.get(String(id));
  }

  async function flushPersistence() {
    await Promise.all([...pendingPersistence.values()].map((pending) => pending.catch(() => null)));
  }

  async function updateJob(job, patch, options) {
    Object.assign(job, patch);
    return await persistJob(job, options);
  }

  async function request(endpoint, init = {}, timeoutMs = requestTimeoutMs, signal) {
    if (typeof fetchImpl !== "function") throw makeError("ComfyUI transport is unavailable.", 503, "COMFY_UNAVAILABLE");
    if (signal?.aborted) throw cancellationError();
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
    const onAbort = signal && controller ? () => controller.abort() : null;
    signal?.addEventListener?.("abort", onAbort, { once: true });
    let response;
    try {
      response = await fetchImpl(comfyUrl + endpoint, { ...init, ...(controller ? { signal: controller.signal } : {}) });
    } catch (error) {
      if (signal?.aborted) throw cancellationError();
      throw makeError(`ComfyUI request failed: ${asErrorMessage(error)}`, 503, "COMFY_UNAVAILABLE");
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    }
    return response;
  }

  async function requestJson(endpoint, init = {}, timeoutMs = requestTimeoutMs, signal) {
    const response = await request(endpoint, init, timeoutMs, signal);
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
      if (error?.code !== "EEXIST") await fsApi.copyFile(source.path, candidate);
    }
    const createdPath = await fsApi.realpath(candidate).catch(() => null);
    if (!createdPath || !isInside(inputReal, createdPath)) throw makeError("Temporary input path is unsafe.", 500, "TEMP_PATH_INVALID");
    return { loadName: relativeName, path: createdPath, created: true };
  }

  async function uploadRemoteInput(job, source, signal) {
    if (typeof FormData !== "function" || typeof Blob !== "function") {
      throw makeError("Remote video upload is unavailable in this Node runtime.", 500, "UPLOAD_UNAVAILABLE");
    }
    assertNotCancelled(job);
    const extension = path.posix.extname(source.cleanName).toLowerCase() || ".mp4";
    const uploadName = `seedvr2_temp_${sanitizeFilenamePrefix(job.id)}${extension}`;
    let bytes;
    try {
      bytes = await fsApi.readFile(source.path);
    } catch (error) {
      throw makeError(`Unable to read source video for remote upload: ${asErrorMessage(error)}`, 502, "SOURCE_READ_FAILED");
    }
    assertNotCancelled(job);
    const form = new FormData();
    form.append("image", new Blob([bytes], { type: VIDEO_MIME_TYPES[extension] || "application/octet-stream" }), uploadName);
    form.append("subfolder", "h3-studio-seedvr2");
    form.append("type", "input");
    form.append("overwrite", "true");
    const payload = await requestJson("/upload/image", { method: "POST", body: form }, 60_000, signal);
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

  async function downloadRemoteArtifact(job, artifact, signal) {
    const metadata = artifact && typeof artifact === "object"
      ? artifact
      : { filename: artifact, subfolder: "", type: "output" };
    const relativeName = artifactRelativeName(metadata);
    if (!relativeName) throw makeError("ComfyUI returned an unsafe output artifact.", 502, "OUTPUT_ARTIFACT_INVALID");
    if (metadata.type && metadata.type !== "output") throw makeError("ComfyUI returned a non-output artifact.", 502, "OUTPUT_ARTIFACT_INVALID");
    const filename = String(metadata.filename).replaceAll("\\", "/");
    const subfolder = String(metadata.subfolder || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
    const query = new URLSearchParams({ filename, subfolder, type: "output" });
    const response = await request(`/view?${query.toString()}`, {}, 60_000, signal);
    if (!response?.ok) throw makeError(`Unable to download generated video: HTTP ${response?.status || 0}.`, 502, "OUTPUT_DOWNLOAD_FAILED");
    if (typeof response.arrayBuffer !== "function") throw makeError("ComfyUI returned an unreadable video artifact.", 502, "OUTPUT_DOWNLOAD_FAILED");
    assertNotCancelled(job);
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
    assertNotCancelled(job);
    if (typeof toAsset === "function") return await toAsset("output", localName);
    return { name: localName, root: "output", kind: "video" };
  }

  async function waitForHistory(job, promptId, signal) {
    const started = Date.now();
    while (true) {
      assertNotCancelled(job);
      const payload = await requestJson(`/history/${encodeURIComponent(promptId)}`, {}, requestTimeoutMs, signal);
      assertNotCancelled(job);
      const parsed = parseSeedVR2History(payload, promptId);
      if (parsed.state === "failed") throw makeError(parsed.error || "ComfyUI reported an execution error.", 502, "COMFY_EXECUTION_FAILED");
      const artifact = parsed.state === "completed" ? historyArtifact(payload, promptId) : null;
      if (artifact) return artifact;
      if (parsed.state === "completed") throw makeError("ComfyUI completed without a SaveVideo artifact.", 502, "OUTPUT_ARTIFACT_MISSING");
      const elapsed = Date.now() - started;
      if (maxPollMs > 0 && elapsed >= maxPollMs) throw makeError("Timed out while waiting for ComfyUI output.", 504, "COMFY_POLL_TIMEOUT");
      job.progress = Math.min(90, Math.max(25, 25 + Math.floor(Math.min(65, elapsed / 4000))));
      job.stage = "Processing SeedVR2";
      await persistJob(job);
      await sleep(pollIntervalMs, signal);
    }
  }

  async function runJob(job) {
    let staged = null;
    let succeeded = false;
    let failure = null;
    const abortController = typeof AbortController === "function" ? new AbortController() : null;
    const runtime = { abortController, promptId: "" };
    const gpuAdmission = ensureGpuAdmission(job);
    let gpuLease = null;
    runtimes.set(job.id, runtime);
    try {
      if (gpuAdmission) {
        await updateJob(job, { status: "queued", stage: "Waiting for GPU" });
        gpuLease = await gpuAdmission.granted;
        if (!gpuLease) throw cancellationError();
        assertNotCancelled(job);
      }
      assertNotCancelled(job);
      await updateJob(job, {
        status: "running",
        startedAt: isoNow(now()),
        completedAt: null,
        cancelledAt: null,
        error: "",
        progress: 5,
        stage: "Checking SeedVR2 readiness",
      });
      const readiness = await checkReadiness();
      assertNotCancelled(job);
      if (!readiness.ready) throw makeError("SeedVR2 is unavailable: required ComfyUI nodes or model files are missing.", 503, "SEEDVR2_NOT_READY");

      await updateJob(job, { progress: 12, stage: "Validating source video" });
      const source = await resolveAsset(job.sourceRoot, job.sourceName);
      assertNotCancelled(job);
      let loadName = source.cleanName;
      if (remote) {
        await updateJob(job, { progress: 16, stage: "Uploading source video" });
        staged = await uploadRemoteInput(job, source, abortController?.signal);
        loadName = staged.loadName;
      } else if (job.sourceRoot === "output") {
        await updateJob(job, { progress: 16, stage: "Staging source video" });
        staged = await stageOutputSource(job, source);
        loadName = staged.loadName;
      }
      assertNotCancelled(job);

      const prompt = buildSeedVR2Prompt({
        sourceName: loadName,
        filenamePrefix: outputPrefix(job),
        unetName: SEEDVR2_UNET_NAME,
        vaeName: SEEDVR2_VAE_NAME,
        seed: job.seed,
      });
      await updateJob(job, { prompt, progress: 20, stage: "Submitting ComfyUI workflow" });
      assertNotCancelled(job);
      const submitted = await requestJson("/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, client_id: clientId }),
      }, requestTimeoutMs, abortController?.signal);
      const promptId = submitted?.prompt_id || submitted?.promptId;
      if (!promptId) {
        const rejection = submitted?.error || submitted?.node_errors;
        throw makeError(rejection ? `ComfyUI rejected the workflow: ${asErrorMessage(rejection)}` : "ComfyUI did not return a prompt id.", 502, "COMFY_PROMPT_REJECTED");
      }
      runtime.promptId = String(promptId);
      await updateJob(job, { promptId: runtime.promptId, progress: 25, stage: "Processing SeedVR2", provenance: { ...job.provenance, submittedAt: isoNow(now()) } });
      const artifact = await waitForHistory(job, runtime.promptId, abortController?.signal);
      assertNotCancelled(job);
      await updateJob(job, { progress: 92, stage: remote ? "Downloading output video" : "Registering output video" });
      const output = remote
        ? await downloadRemoteArtifact(job, artifact, abortController?.signal)
        : await artifactAsset(artifact.relativeName || artifact);
      assertNotCancelled(job);
      await updateJob(job, { output, progress: 100 });
      succeeded = true;
    } catch (error) {
      failure = error;
      if (!job.cancelRequested && error?.code !== "SEEDVR2_CANCELLED" && error?.code !== "GPU_LEASE_CANCELLED") {
        job.error = asErrorMessage(error);
        job.progress = Math.min(100, Math.max(job.progress, 1));
        await persistJob(job);
      }
    } finally {
      gpuLease?.release?.();
      gpuAdmissions.delete(String(job.id));
      await cleanupStagedTemp(staged, job);
      runtimes.delete(job.id);
      const cancelled = Boolean(job.cancelRequested) || failure?.code === "SEEDVR2_CANCELLED" || failure?.code === "GPU_LEASE_CANCELLED";
      if (cancelled) {
        const cancelledAt = isoNow(now());
        await updateJob(job, {
          status: "cancelled",
          stage: "Cancelled",
          completedAt: cancelledAt,
          cancelledAt,
          cancelRequested: false,
          output: null,
          error: "",
          cancelReason: job.cancelReason || "Cancelled by user.",
        });
      } else if (succeeded) {
        await updateJob(job, { status: "completed", stage: "Completed", progress: 100, completedAt: isoNow(now()), cancelRequested: false });
      } else {
        await updateJob(job, {
          status: "failed",
          stage: "Failed",
          completedAt: isoNow(now()),
          cancelRequested: false,
          error: job.error || asErrorMessage(failure),
        });
      }
    }
  }

  function pump() {
    if (active || !queue.length) return;
    const next = queue.shift();
    if (!next || next.status === "cancelled" || next.cancelRequested) {
      pump();
      return;
    }
    active = next;
    setTimeout(() => {
      void runJob(next).finally(() => {
        if (active === next) active = null;
        pump();
      });
    }, 0);
  }

  function createJob({ sourceName, sourceRoot, scale = 2, profile = SEEDVR2_PROFILE, seed, attempt = 1, retryOf = "", provenance = null } = {}) {
    const id = String(idFactory());
    const createdAt = isoNow(now());
    const request = {
      sourceName,
      sourceRoot,
      scale: 2,
      profile,
      seed,
    };
    return {
      id,
      status: "queued",
      progress: 0,
      stage: "Queued",
      source: { name: sourceName, root: sourceRoot },
      sourceName,
      sourceRoot,
      scale,
      profile,
      seed,
      prompt: null,
      output: null,
      error: "",
      createdAt,
      startedAt: null,
      completedAt: null,
      updatedAt: createdAt,
      cancelledAt: null,
      cancelReason: "",
      cancelRequested: false,
      attempt,
      ...(retryOf ? { retryOf } : {}),
      recoverable: false,
      recovery: null,
      promptId: "",
      provenance: provenance || {
        request,
        attempt,
        ...(retryOf ? { retryOf, originalId: retryOf } : { originalId: id }),
        submittedAt: createdAt,
      },
    };
  }

  async function enqueue(input = {}) {
    await ensureStoreLoaded();
    const sourceRoot = String(input.sourceRoot || "input");
    if (!["input", "output"].includes(sourceRoot)) throw makeError("sourceRoot must be input or output.", 400, "SOURCE_ROOT_INVALID");
    if (Number(input.scale) !== 2) throw makeError("SeedVR2 upscale currently supports scale=2 only.", 400, "SCALE_INVALID");
    const profile = normalizeProfile(input.profile);
    const cleanName = normalizeVideoAssetName(input.sourceName);
    const seed = boundedSeed(input.seed, Math.floor(Math.random() * 2_147_483_648));
    await resolveAsset(sourceRoot, cleanName);
    const job = createJob({ sourceName: cleanName, sourceRoot, scale: 2, profile, seed });
    await persistJob(job, { required: true });
    jobs.set(job.id, job);
    ensureGpuAdmission(job);
    queue.push(job);
    pump();
    return toPublicJob(job);
  }

  async function readJob(id) {
    const key = String(id);
    await waitForPersistence(key);
    const inMemory = jobs.get(key);
    if (inMemory) return inMemory;
    const persisted = await jobStore.read?.(key);
    if (persisted) jobs.set(key, persisted);
    return persisted || null;
  }

  async function getJob(id) {
    await ensureStoreLoaded();
    const job = await readJob(id);
    return job ? toPublicJob(job) : null;
  }

  async function listJobs() {
    await ensureStoreLoaded();
    await flushPersistence();
    const records = typeof jobStore.list === "function" ? await jobStore.list() : [];
    const merged = new Map(records.map((job) => [String(job.id), job]));
    for (const job of jobs.values()) merged.set(String(job.id), job);
    return [...merged.values()]
      .sort((left, right) => String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt)))
      .slice(0, 100)
      .map(toPublicJob);
  }

  async function cancelJob(id, reason = "Cancelled by user.") {
    await ensureStoreLoaded();
    const job = await readJob(id);
    if (!job) throw makeError("SeedVR2 job not found.", 404, "SEEDVR2_JOB_NOT_FOUND");
    if (["completed", "failed", "cancelled", "interrupted"].includes(job.status)) {
      throw makeError(`SeedVR2 job cannot be cancelled from ${job.status}.`, 409, "SEEDVR2_CANCEL_NOT_ALLOWED");
    }
    if (job.status === "cancelling") return toPublicJob(job);
    const cancelReason = asErrorMessage(reason, "Cancelled by user.");
    job.cancelReason = cancelReason;
    job.cancelRequested = true;
    const isQueued = job.status === "queued";
    const runtime = runtimes.get(job.id);
    if (isQueued) {
      cancelGpuAdmission(job.id, cancelReason);
      const index = queue.findIndex((queued) => queued.id === job.id);
      if (index >= 0) queue.splice(index, 1);
      if (active !== job) {
        const cancelledAt = isoNow(now());
        await updateJob(job, {
          status: "cancelled",
          stage: "Cancelled",
          completedAt: cancelledAt,
          cancelledAt,
          cancelRequested: false,
        });
        return toPublicJob(job);
      }
    }
    job.status = "cancelling";
    job.stage = "Cancelling SeedVR2";
    await persistJob(job, { required: true });
    cancelGpuAdmission(job.id, cancelReason);
    runtime?.abortController?.abort();
    if (runtime?.promptId) {
      await request("/interrupt", { method: "POST" }, requestTimeoutMs).catch(() => null);
    }
    return toPublicJob(job);
  }

  async function retryJob(id) {
    await ensureStoreLoaded();
    const source = await readJob(id);
    if (!source) throw makeError("SeedVR2 job not found.", 404, "SEEDVR2_JOB_NOT_FOUND");
    if (["queued", "running", "cancelling"].includes(source.status)) {
      throw makeError("Active SeedVR2 jobs cannot be retried.", 409, "SEEDVR2_JOB_ACTIVE");
    }
    if (!["failed", "cancelled", "interrupted"].includes(source.status)) {
      throw makeError("Only failed, cancelled, or interrupted SeedVR2 jobs can be retried.", 409, "SEEDVR2_JOB_NOT_RETRYABLE");
    }
    await resolveAsset(source.sourceRoot, source.sourceName);
    const attempt = Math.max(1, Number(source.attempt || source.provenance?.attempt || 1) + 1);
    const retryOf = source.id;
    const request = source.provenance?.request || {
      sourceName: source.sourceName,
      sourceRoot: source.sourceRoot,
      scale: source.scale,
      profile: source.profile,
      seed: source.seed,
    };
    const job = createJob({
      sourceName: source.sourceName,
      sourceRoot: source.sourceRoot,
      scale: 2,
      profile: source.profile || SEEDVR2_PROFILE,
      seed: boundedSeed(source.seed, 0),
      attempt,
      retryOf,
      provenance: {
        request: {
          sourceName: request.sourceName || source.sourceName,
          sourceRoot: request.sourceRoot || source.sourceRoot,
          scale: 2,
          profile: request.profile || source.profile || SEEDVR2_PROFILE,
          seed: boundedSeed(request.seed, boundedSeed(source.seed, 0)),
        },
        attempt,
        retryOf,
        originalId: source.provenance?.originalId || source.id,
        ...(source.provenance?.reason ? { reason: source.provenance.reason } : {}),
        submittedAt: isoNow(now()),
      },
    });
    await persistJob(job, { required: true });
    jobs.set(job.id, job);
    ensureGpuAdmission(job);
    queue.push(job);
    pump();
    return toPublicJob(job);
  }

  async function handleRoute(req, res, { pathname = new URL(req.url || "/", "http://localhost").pathname, readJson, sendJson, sendError } = {}) {
    const respond = sendJson || ((response, status, payload) => {
      const body = JSON.stringify(payload);
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(body);
    });
    const fail = sendError || ((response, status, message, code) => respond(response, status, { error: message, ...(code ? { code } : {}) }));
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
        fail(res, status, asErrorMessage(error, "Unable to queue SeedVR2 upscale."), error?.code);
      }
      return true;
    }
    const actionMatch = pathname.match(/^\/api\/upscale\/jobs\/([^/]+)\/(cancel|retry)$/);
    if (req.method === "POST" && actionMatch) {
      const id = decodeURIComponent(actionMatch[1]);
      try {
        const body = typeof readJson === "function" ? await readJson(req) : {};
        const job = actionMatch[2] === "cancel"
          ? await cancelJob(id, body?.reason || body?.cancelReason || "Cancelled by user.")
          : await retryJob(id);
        respond(res, actionMatch[2] === "retry" ? 201 : 200, { job });
      } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : 400;
        fail(res, status, asErrorMessage(error, `Unable to ${actionMatch[2]} SeedVR2 job.`), error?.code);
      }
      return true;
    }
    if (req.method === "GET" && pathname === "/api/upscale/jobs") {
      try {
        respond(res, 200, { jobs: await listJobs() });
      } catch (error) {
        fail(res, 503, asErrorMessage(error, "Unable to load SeedVR2 job history."), error?.code || "SEEDVR2_PERSISTENCE_FAILED");
      }
      return true;
    }
    if (req.method === "GET" && pathname.startsWith("/api/upscale/jobs/")) {
      const id = decodeURIComponent(pathname.slice("/api/upscale/jobs/".length));
      try {
        const job = await getJob(id);
        if (!job) fail(res, 404, "SeedVR2 job not found.", "SEEDVR2_JOB_NOT_FOUND");
        else respond(res, 200, { job });
      } catch (error) {
        fail(res, Number.isInteger(error?.status) ? error.status : 503, asErrorMessage(error, "Unable to load SeedVR2 job history."), error?.code);
      }
      return true;
    }
    return false;
  }

  const ready = ensureStoreLoaded();
  ready.catch((error) => console.error("[seedvr2] startup recovery failed", error?.message || error));

  return {
    buildPrompt: buildSeedVR2Prompt,
    checkReadiness,
    enqueue,
    getJob,
    getJobs: () => [...jobs.values()].map(toPublicJob),
    listJobs,
    cancel: cancelJob,
    retry: retryJob,
    ready: () => ready,
    handleRoute,
    publicJob,
    parseHistory: parseSeedVR2History,
    active: () => active ? toPublicJob(active) : null,
  };
}

export { artifactRelativeName, publicJob };
