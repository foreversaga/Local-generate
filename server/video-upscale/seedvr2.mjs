import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createSeedVR2JobStore } from "./seedvr2-store.mjs";
import {
  MMH3_ULTIMATE_PROFILE,
  MMH3_ULTIMATE_PROFILE_LABEL,
  MMH3_ULTIMATE_SCALE,
  buildMMH3UltimatePrompt,
  evaluateMMH3UltimateReadiness,
} from "./mmh3-ultimate.mjs";
import { jobListLimit, summarizeJobRecord, wantsJobSummary } from "../../app/lib/job-list-query.mjs";

/**
 * The two files below are deliberately constants.  The model combo returned by
 * ComfyUI is checked against these names before a job is accepted, so a
 * similarly named checkpoint cannot accidentally be used for an upscale.
 */
export const SEEDVR2_UNET_NAME = "seedvr2_7b_sharp_nvfp4.safetensors";
export const SEEDVR2_FP16_UNET_NAME = "seedvr2_7b_sharp_fp16.safetensors";
export const SEEDVR2_VAE_NAME = "seedvr2_ema_vae_fp16.safetensors";
export const SEEDVR2_PROFILE = "seedvr2_7b_sharp_nvfp4";
export const SEEDVR2_PROFILE_LABEL = "SeedVR2 7B Sharp NVFP4";
export const SEEDVR2_FP16_PROFILE = "seedvr2_7b_sharp_fp16";
export const SEEDVR2_FP16_PROFILE_LABEL = "SeedVR2 7B Sharp FP16";
export const SEEDVR2_MIN_SCALE = 1;
export const SEEDVR2_MAX_SCALE = 4;
export const SEEDVR2_DEFAULT_SCALE = 2;
export const SEEDVR2_RESIZE_METHODS = Object.freeze(["lanczos", "bicubic", "bilinear", "area", "nearest-exact"]);
export const SEEDVR2_COLOR_CORRECTION_METHODS = Object.freeze(["wavelet", "lab", "adain", "none"]);
export const SEEDVR2_DEFAULT_RESIZE_METHOD = "lanczos";
export const SEEDVR2_DEFAULT_COLOR_CORRECTION = "wavelet";
export const SEEDVR2_MIN_STEPS = 1;
export const SEEDVR2_MAX_STEPS = 20;
export const SEEDVR2_MIN_CFG = 0;
export const SEEDVR2_MAX_CFG = 20;
export const SEEDVR2_MIN_DENOISE = 0;
export const SEEDVR2_MAX_DENOISE = 1;
export const SEEDVR2_DEFAULT_STEPS = 1;
export const SEEDVR2_DEFAULT_CFG = 1;
export const SEEDVR2_DEFAULT_SAMPLER_NAME = "euler";
export const SEEDVR2_DEFAULT_SCHEDULER = "simple";
export const SEEDVR2_DEFAULT_DENOISE = 1;
export const SEEDVR2_DETAIL_NODE = "SeedVR2TilingUpscaler";
export const SEEDVR2_DETAIL_DIT_LOADER_NODE = "SeedVR2LoadDiTModel";
export const SEEDVR2_DETAIL_VAE_LOADER_NODE = "SeedVR2LoadVAEModel";
export const SEEDVR2_DETAIL_FP16_UNET_NAME = SEEDVR2_FP16_UNET_NAME;
export const SEEDVR2_DETAIL_VAE_NAME = "ema_vae_fp16.safetensors";
export const SEEDVR2_DEFAULT_DETAIL = Object.freeze({
  detailPreset: "default",
  inputNoiseScale: 0,
  latentNoiseScale: 0,
  tileWidth: 1024,
  tileHeight: 1024,
  tilePadding: 64,
  tileUpscaleResolution: 2048,
  blendingMethod: "multiband",
  antiAliasingStrength: 0,
  maskBlur: 0,
  tilingStrategy: "chess",
});
export const SEEDVR2_SKIN_DETAIL_SETTINGS = Object.freeze({
  scale: 2,
  resizeMethod: "lanczos",
  colorCorrection: "wavelet",
  steps: 1,
  cfg: 1,
  samplerName: "euler",
  scheduler: "simple",
  denoise: 1,
  ...SEEDVR2_DEFAULT_DETAIL,
  detailPreset: "skin_detail",
  inputNoiseScale: 0.035,
});
export const SEEDVR2_BLENDING_METHODS = Object.freeze(["multiband", "linear", "gaussian"]);
export const SEEDVR2_TILING_STRATEGIES = Object.freeze(["chess", "grid"]);
export const SEEDVR2_DETAIL_PRESETS = Object.freeze(["default", "skin_detail"]);
export const SEEDVR2_DETAIL_NODE_INPUT_TYPES = Object.freeze({
  image: "IMAGE",
  dit: "SEEDVR2_DIT",
  vae: "SEEDVR2_VAE",
  seed: "INT",
  new_resolution: "INT",
  upscale_factor: "FLOAT",
  color_correction: "COMBO",
  input_noise_scale: "FLOAT",
  latent_noise_scale: "FLOAT",
  tile_width: "INT",
  tile_height: "INT",
  tile_padding: "INT",
  tile_upscale_resolution: "INT",
  blending_method: "COMBO",
  anti_aliasing_strength: "FLOAT",
  mask_blur: "FLOAT",
  tiling_strategy: "COMBO",
});
export const SEEDVR2_DETAIL_NODE_INPUTS = Object.freeze(Object.keys(SEEDVR2_DETAIL_NODE_INPUT_TYPES));
export const SEEDVR2_SAMPLER_NAMES = Object.freeze([
  "euler",
  "euler_cfg_pp",
  "euler_ancestral",
  "euler_ancestral_cfg_pp",
  "heun",
  "heunpp2",
  "dpm_2",
  "dpm_2_ancestral",
  "lms",
  "dpm_fast",
  "dpm_adaptive",
  "dpmpp_2s_ancestral",
  "dpmpp_2s_ancestral_cfg_pp",
  "dpmpp_sde",
  "dpmpp_sde_gpu",
  "dpmpp_2m",
  "dpmpp_2m_cfg_pp",
  "dpmpp_2m_sde",
  "dpmpp_2m_sde_gpu",
  "dpmpp_3m_sde",
  "dpmpp_3m_sde_gpu",
  "ddpm",
  "lcm",
  "ipndm",
  "ipndm_v",
  "deis",
  "res_multistep",
  "res_multistep_cfg_pp",
  "gradient_estimation",
  "gradient_estimation_cfg_pp",
  "er_sde",
  "sa_solver",
  "sa_solver_pece",
]);
export const SEEDVR2_SCHEDULERS = Object.freeze([
  "normal",
  "karras",
  "exponential",
  "sgm_uniform",
  "simple",
  "ddim_uniform",
  "beta",
  "linear_quadratic",
  "kl_optimal",
]);

export const H3_LATENT_UPSCALER_NAME = "h3_clean_latent_upscaler_v1_mamad8.safetensors";
export const H3_LATENT_VAE_NAME = "minimax_h3_video_vae_fp16.safetensors";
export const H3_LATENT_AUDIO_VAE_NAME = "minimax_h3_audio_vae_fp32.safetensors";
export const H3_LATENT_ENCODER_NAME = "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors";
export const H3_LATENT_DIFFUSION_NAMES = Object.freeze([
  "minimax_h3_ref2va_pruned_nvfp4.safetensors",
]);
export const H3_LATENT_PROFILE = "h3_latent_2x";
export const H3_LATENT_PROFILE_LABEL = "MiniMax H3 Latent 2x · 社群雙採樣";
export const H3_LATENT_SCALE = 2;
export const H3_LATENT_UPSCALE_METHOD = "bilinear";
export const H3_LATENT_PASS1_STEPS = 25;
export const H3_LATENT_PASS2_STEPS = 15;
export const H3_LATENT_PASS2_DENOISE = 0.4;
export const H3_LATENT_PASS2_SIGMAS = "0.9864, 0.9740, 0.9587, 0.9400, 0.9158, 0.8845, 0.8406, 0.7774, 0.6744, 0.4856, 0.0000";
export const H3_LATENT_PROMPT = "Use <Video 1> as the exact source for the subjects, motion, camera movement, composition, lighting, and pacing. Preserve <Audio 1> exactly. Reconstruct clean, natural fine detail at the larger canvas without changing the scene.";

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

export const SEEDVR2_IMAGE_REQUIRED_NODES = Object.freeze([
  "LoadImage",
  "ResizeImageMaskNode",
  "SeedVR2Preprocess",
  "VAEEncodeTiled",
  "VAELoader",
  "UNETLoader",
  "SeedVR2Conditioning",
  "KSampler",
  "VAEDecodeTiled",
  "SeedVR2PostProcessing",
  "SaveImage",
]);

export const SEEDVR2_DETAIL_REQUIRED_NODES = Object.freeze([
  "LoadVideo",
  "GetVideoComponents",
  SEEDVR2_DETAIL_DIT_LOADER_NODE,
  SEEDVR2_DETAIL_VAE_LOADER_NODE,
  SEEDVR2_DETAIL_NODE,
  "CreateVideo",
  "SaveVideo",
]);

export const SEEDVR2_DETAIL_IMAGE_REQUIRED_NODES = Object.freeze([
  "LoadImage",
  SEEDVR2_DETAIL_DIT_LOADER_NODE,
  SEEDVR2_DETAIL_VAE_LOADER_NODE,
  SEEDVR2_DETAIL_NODE,
  "SaveImage",
]);

export const H3_LATENT_REQUIRED_NODES = Object.freeze([
  "LoadVideo",
  "GetVideoComponents",
  "GetImageSize",
  "UNETLoader",
  "CLIPLoader",
  "VAELoader",
  "MiniMaxH3ReferenceToVideo",
  "RandomNoise",
  "KSamplerSelect",
  "BasicScheduler",
  "BasicGuider",
  "SamplerCustomAdvanced",
  "LTXVSeparateAVLatent",
  "MiniMaxH3LatentUpscale",
  "LTXVConcatAVLatent",
  "MiniMaxH3AddNoise",
  "MiniMaxH3ShiftSigmas",
  "MiniMaxH3ConditioningUpscale",
  "ManualSigmas",
  "DisableNoise",
  "VAEDecode",
  "VAEDecodeAudio",
  "CreateVideo",
  "SaveVideo",
]);

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const VIDEO_MIME_TYPES = Object.freeze({
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
});
const IMAGE_MIME_TYPES = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
});
const ARTIFACT_KEYS = ["images", "videos", "files", "gifs"];
const TERMINAL_STAGES = new Set(["completed", "success", "succeeded", "finished", "done"]);
const ERROR_STAGES = new Set(["error", "failed", "failure", "cancelled", "canceled"]);
const COMFY_WS_BUFFER_MAX = 64;
const SEEDVR2_NODE_PROGRESS = Object.freeze({
  LoadImage: 25,
  LoadVideo: 25,
  GetVideoComponents: 27,
  ResizeImageMaskNode: 30,
  SeedVR2Preprocess: 34,
  VAELoader: 36,
  VAEEncodeTiled: 42,
  UNETLoader: 38,
  SeedVR2Conditioning: 46,
  SeedVR2TemporalChunk: 50,
  KSampler: 58,
  SeedVR2TemporalMerge: 72,
  VAEDecodeTiled: 84,
  SeedVR2PostProcessing: 88,
  SeedVR2LoadDiTModel: 36,
  SeedVR2LoadVAEModel: 38,
  SeedVR2TilingUpscaler: 58,
  CreateVideo: 90,
  SaveVideo: 90,
  SaveImage: 90,
});
const UPSCALE_NODE_PROGRESS = Object.freeze({
  ...SEEDVR2_NODE_PROGRESS,
  MiniMaxH3ReferenceToVideo: 40,
  BasicScheduler: 42,
  LTXVSeparateAVLatent: 48,
  MiniMaxH3LatentUpscale: 52,
  MiniMaxH3AddNoise: 58,
  SamplerCustomAdvanced: 76,
  VAEDecode: 86,
});

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

export function comfyWebSocketUrl(comfyUrl, clientId) {
  try {
    const url = new URL(String(comfyUrl || ""));
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return "";
    url.protocol = ["https:", "wss:"].includes(url.protocol) ? "wss:" : "ws:";
    const basePath = url.pathname.replace(/\/+$/, "");
    url.pathname = basePath ? `${basePath}/ws` : "/ws";
    url.searchParams.set("clientId", String(clientId || ""));
    return url.toString();
  } catch {
    return "";
  }
}

export function parseSeedVR2WebSocketMessage(value) {
  let text = value;
  if (typeof text !== "string") {
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(text)) text = text.toString("utf8");
    else if (typeof ArrayBuffer !== "undefined" && text instanceof ArrayBuffer) text = Buffer.from(text).toString("utf8");
    else return null;
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || typeof payload.type !== "string") return null;
  const data = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
    ? payload.data
    : {};
  return { ...data, type: payload.type };
}

function createSeedVR2ProgressSession({ comfyUrl, clientId, WebSocketImpl = globalThis.WebSocket, onEvent } = {}) {
  const wsUrl = comfyWebSocketUrl(comfyUrl, clientId);
  const emit = (event) => {
    if (typeof onEvent === "function") onEvent(event);
  };
  if (!wsUrl || typeof WebSocketImpl !== "function") {
    emit({ type: "websocket_unavailable", connectionState: "unavailable" });
    return {
      available: false,
      setPromptId() {},
      close() {},
      get state() { return "unavailable"; },
    };
  }

  let socket = null;
  let promptId = "";
  let state = "connecting";
  let closed = false;
  const buffered = [];

  const deliver = (event) => {
    if (!event) return;
    const eventPromptId = String(event.prompt_id || event.promptId || "");
    if (event.type === "status" || !eventPromptId) {
      emit(event);
      return;
    }
    if (promptId) {
      if (eventPromptId === promptId) emit(event);
      return;
    }
    if (buffered.length < COMFY_WS_BUFFER_MAX) buffered.push(event);
  };

  const handleMessage = (message) => {
    if (closed) return;
    const event = parseSeedVR2WebSocketMessage(message?.data ?? message);
    if (event) deliver(event);
  };
  const handleOpen = () => {
    if (closed) return;
    state = "connected";
    emit({ type: "websocket_connected", connectionState: state });
  };
  const handleError = () => {
    if (closed) return;
    state = "error";
    emit({ type: "websocket_error", connectionState: state, error: "ComfyUI WebSocket is unavailable; using history polling." });
  };
  const handleClose = () => {
    if (closed) return;
    state = "closed";
    emit({ type: "websocket_closed", connectionState: state });
  };

  try {
    socket = new WebSocketImpl(wsUrl);
    if (typeof socket.addEventListener === "function") {
      socket.addEventListener("message", handleMessage);
      socket.addEventListener("open", handleOpen);
      socket.addEventListener("error", handleError);
      socket.addEventListener("close", handleClose);
    } else {
      socket.onmessage = handleMessage;
      socket.onopen = handleOpen;
      socket.onerror = handleError;
      socket.onclose = handleClose;
    }
  } catch {
    state = "error";
    emit({ type: "websocket_error", connectionState: state, error: "ComfyUI WebSocket could not be opened; using history polling." });
  }

  return {
    available: true,
    setPromptId(value) {
      promptId = String(value || "");
      if (!promptId) return;
      const pending = buffered.splice(0, buffered.length);
      for (const event of pending) deliver(event);
    },
    close() {
      if (closed) return;
      closed = true;
      state = "closed";
      try { socket?.close?.(); } catch { /* best effort */ }
    },
    get state() { return state; },
  };
}

function seedvr2NodeInfo(graph, event = {}) {
  const rawNodeId = event.node ?? event.display_node ?? event.node_id ?? event.display_node_id;
  const nodeId = rawNodeId === undefined || rawNodeId === null || rawNodeId === "" ? "" : String(rawNodeId);
  const node = nodeId ? graph?.[nodeId] : null;
  const classType = String(node?.class_type || event.class_type || nodeId || "ComfyUI");
  const title = String(node?._meta?.title || node?.title || event.node_title || "").trim();
  const label = title && title !== classType ? `${title} (${classType})` : classType;
  return { nodeId, classType, label };
}

function seedvr2NodeBaseline(classType) {
  return Number(UPSCALE_NODE_PROGRESS[classType]) || 28;
}

function profileLabel(profile) {
  if (profile === MMH3_ULTIMATE_PROFILE) return MMH3_ULTIMATE_PROFILE_LABEL;
  if (profile === H3_LATENT_PROFILE) return H3_LATENT_PROFILE_LABEL;
  return profile === SEEDVR2_FP16_PROFILE ? SEEDVR2_FP16_PROFILE_LABEL : SEEDVR2_PROFILE_LABEL;
}

function isSeedVR2Profile(profile) {
  return profile === SEEDVR2_PROFILE || profile === SEEDVR2_FP16_PROFILE;
}

function isH3VideoProfile(profile) {
  return profile === H3_LATENT_PROFILE || profile === MMH3_ULTIMATE_PROFILE;
}

function seedVR2UnetName(profile) {
  return profile === SEEDVR2_FP16_PROFILE ? SEEDVR2_FP16_UNET_NAME : SEEDVR2_UNET_NAME;
}

function seedVR2DetailUnetName(unetName) {
  return unetName === SEEDVR2_FP16_UNET_NAME ? SEEDVR2_DETAIL_FP16_UNET_NAME : "";
}

function profileShortName(profile) {
  if (profile === MMH3_ULTIMATE_PROFILE) return "h3ultimate";
  return profile === H3_LATENT_PROFILE ? "h3latent" : "seedvr2";
}

function applySeedVR2ProgressEvent(job, graph, event, runtime) {
  if (!event?.type) return;
  const node = seedvr2NodeInfo(graph, event);
  const setProgressFloor = (value) => {
    job.progress = Math.min(90, Math.max(Number(job.progress) || 0, value));
  };

  if (event.type === "websocket_connected") {
    runtime.wsState = "connected";
    return;
  }
  if (event.type === "websocket_unavailable" || event.type === "websocket_error") {
    runtime.wsState = event.connectionState || "error";
    if (job.status === "running" && job.progress >= 25) job.stage = `Processing ${profileLabel(job.profile)} (history fallback)`;
    return;
  }
  if (event.type === "websocket_closed") {
    runtime.wsState = "closed";
    return;
  }
  if (event.type === "status") {
    runtime.wsState = "connected";
    if (job.status === "running" && job.progress < 25) job.stage = "Waiting for ComfyUI";
    return;
  }
  if (event.type === "execution_start") {
    runtime.wsState = "connected";
    if (job.status === "running") job.stage = "ComfyUI / starting execution";
    return;
  }
  if (event.type === "execution_cached") {
    runtime.wsState = "connected";
    if (job.status === "running") job.stage = "ComfyUI / loading workflow";
    return;
  }
  if (event.type === "executing") {
    runtime.wsState = "connected";
    runtime.wsProgressSeen = true;
    if (event.node === null || event.node === undefined || event.node === "") {
      runtime.wsTerminal = "executing";
      if (job.status === "running") job.stage = "ComfyUI / finalizing output";
      return;
    }
    setProgressFloor(seedvr2NodeBaseline(node.classType));
    if (job.status === "running") job.stage = `ComfyUI / ${node.label}`;
    return;
  }
  if (event.type === "progress") {
    const current = Number(event.value);
    const maximum = Number(event.max);
    if (!Number.isFinite(current) || !Number.isFinite(maximum) || maximum <= 0) return;
    runtime.wsState = "connected";
    runtime.wsProgressSeen = true;
    const fraction = Math.min(1, Math.max(0, current / maximum));
    setProgressFloor(seedvr2NodeBaseline(node.classType) + Math.round(fraction * 8));
    if (job.status === "running") job.stage = `ComfyUI / ${node.label} (${Math.max(0, current)}/${Math.max(1, maximum)})`;
    return;
  }
  if (event.type === "progress_state") {
    const active = Object.entries(event.nodes || {}).find(([, value]) => value?.state === "running");
    if (!active) return;
    const [nodeId, value] = active;
    applySeedVR2ProgressEvent(job, graph, {
      type: "progress",
      node: nodeId,
      display_node: value?.display_node_id,
      value: value?.value,
      max: value?.max,
    }, runtime);
    return;
  }
  if (event.type === "execution_error" || event.type === "execution_interrupted") {
    const message = asErrorMessage(event.exception_message || event.message || event.error || `ComfyUI reported a ${profileLabel(job.profile)} execution error.`);
    runtime.wsState = "error";
    runtime.wsTerminal = "error";
    runtime.comfyError = { message, code: "COMFY_EXECUTION_FAILED" };
    if (job.status === "running") job.stage = `ComfyUI error / ${node.label}`;
    return;
  }
  if (event.type === "execution_success") {
    runtime.wsState = "connected";
    runtime.wsTerminal = "success";
    if (job.status === "running") job.stage = "ComfyUI / completed, reading output";
  }
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

export function normalizeUpscaleAssetName(value) {
  if (typeof value !== "string") throw makeError("sourceName must be a relative image or video asset name.", 400, "SOURCE_NAME_INVALID");
  const raw = value.replaceAll("\\", "/");
  if (!raw || raw.length > 512 || raw.includes("\0") || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) {
    throw makeError("sourceName must be a relative image or video asset name.", 400, "SOURCE_NAME_INVALID");
  }
  const pieces = raw.split("/");
  if (pieces.some((piece) => !piece || piece === "." || piece === "..")) {
    throw makeError("sourceName must not contain traversal segments.", 400, "SOURCE_NAME_INVALID");
  }
  const normalized = pieces.join("/");
  const extension = path.posix.extname(normalized).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(extension) && !IMAGE_EXTENSIONS.has(extension)) {
    throw makeError("SeedVR2 accepts PNG, JPEG, WebP, and supported video assets only.", 415, "SOURCE_KIND_INVALID");
  }
  return normalized;
}

function sourceKindFromName(value) {
  return IMAGE_EXTENSIONS.has(path.posix.extname(String(value || "")).toLowerCase()) ? "image" : "video";
}

function nodeInputSpec(nodeInfo, key) {
  return nodeInfo?.input?.required?.[key] ?? nodeInfo?.input?.optional?.[key];
}

function comboValues(nodeInfo, key) {
  const spec = nodeInputSpec(nodeInfo, key);
  if (!Array.isArray(spec)) return [];
  if (Array.isArray(spec[0])) return spec[0].map((value) => String(value));
  // ComfyUI V3 schemas expose a combo as ["COMBO", { options: [...] }].
  // Keep accepting the legacy [options, config] shape above because native
  // nodes from older ComfyUI versions still use it.
  if (spec[0] === "COMBO" && Array.isArray(spec[1]?.options)) {
    return spec[1].options.map((value) => String(value));
  }
  return [];
}

function nodeInputType(nodeInfo, key) {
  const spec = nodeInputSpec(nodeInfo, key);
  if (!Array.isArray(spec)) return "";
  if (Array.isArray(spec[0]) || spec[0] === "COMBO") return "COMBO";
  return String(spec[0] || "").toUpperCase();
}

export function evaluateSeedVR2Readiness(objectInfo, {
  unetName = SEEDVR2_UNET_NAME,
  vaeName = SEEDVR2_VAE_NAME,
  modelFiles = {},
  comfyUi = true,
  sourceKind = "video",
  detailMode = false,
  detailSettings = SEEDVR2_DEFAULT_DETAIL,
} = {}) {
  const requiredNodes = detailMode
    ? sourceKind === "image" ? SEEDVR2_DETAIL_IMAGE_REQUIRED_NODES : SEEDVR2_DETAIL_REQUIRED_NODES
    : sourceKind === "image" ? SEEDVR2_IMAGE_REQUIRED_NODES : SEEDVR2_REQUIRED_NODES;
  const nodes = Object.fromEntries(requiredNodes.map((name) => [name, Boolean(objectInfo?.[name])]));
  const modelNode = detailMode ? objectInfo?.[SEEDVR2_DETAIL_DIT_LOADER_NODE] : objectInfo?.UNETLoader;
  const vaeNode = detailMode ? objectInfo?.[SEEDVR2_DETAIL_VAE_LOADER_NODE] : objectInfo?.VAELoader;
  const detailUnetName = seedVR2DetailUnetName(unetName);
  const unetListed = detailMode
    ? Boolean(detailUnetName) && comboValues(modelNode, "model").includes(detailUnetName)
    : comboValues(modelNode, "unet_name").includes(unetName);
  const vaeListed = detailMode
    ? comboValues(vaeNode, "model").includes(SEEDVR2_DETAIL_VAE_NAME)
    : comboValues(vaeNode, "vae_name").includes(vaeName);
  const unetFile = modelFiles.unet === undefined ? true : Boolean(modelFiles.unet);
  const vaeFile = modelFiles.vae === undefined ? true : Boolean(modelFiles.vae);
  const models = {
    unet: { name: detailMode ? detailUnetName || unetName : unetName, available: unetListed && unetFile },
    vae: { name: detailMode ? SEEDVR2_DETAIL_VAE_NAME : vaeName, available: vaeListed && vaeFile },
  };
  let detail;
  if (detailMode) {
    const nodeInfo = objectInfo?.[SEEDVR2_DETAIL_NODE];
    const missingInputs = SEEDVR2_DETAIL_NODE_INPUTS.filter((key) => !nodeInputSpec(nodeInfo, key));
    const invalidInputs = SEEDVR2_DETAIL_NODE_INPUTS.filter((key) => (
      nodeInputSpec(nodeInfo, key) && nodeInputType(nodeInfo, key) !== SEEDVR2_DETAIL_NODE_INPUT_TYPES[key]
    ));
    const mappedTilingStrategy = detailSettings.tilingStrategy === "chess" ? "Chess" : "Linear";
    const unsupported = {
      resizeMethod: detailSettings.resizeMethod === "lanczos" ? [] : [detailSettings.resizeMethod],
      colorCorrection: comboValues(nodeInfo, "color_correction").includes(detailSettings.colorCorrection) ? [] : [detailSettings.colorCorrection],
      steps: detailSettings.steps === 1 ? [] : [detailSettings.steps],
      cfg: detailSettings.cfg === 1 ? [] : [detailSettings.cfg],
      samplerName: detailSettings.samplerName === "euler" ? [] : [detailSettings.samplerName],
      scheduler: detailSettings.scheduler === "simple" ? [] : [detailSettings.scheduler],
      denoise: detailSettings.denoise === 1 ? [] : [detailSettings.denoise],
      blendingMethod: comboValues(nodeInfo, "blending_method").includes(detailSettings.blendingMethod) ? [] : [detailSettings.blendingMethod],
      tilingStrategy: comboValues(nodeInfo, "tiling_strategy").includes(mappedTilingStrategy) ? [] : [detailSettings.tilingStrategy],
      detailPreset: SEEDVR2_DETAIL_PRESETS.includes(detailSettings.detailPreset) ? [] : [detailSettings.detailPreset],
    };
    const schemaReady = missingInputs.length === 0 && invalidInputs.length === 0 && Object.values(unsupported).every((values) => values.length === 0);
    detail = {
      requested: true,
      node: SEEDVR2_DETAIL_NODE,
      available: Boolean(nodeInfo) && schemaReady,
      missingInputs,
      invalidInputs,
      unsupported,
    };
  }
  const ready = Boolean(comfyUi)
    && Object.values(nodes).every(Boolean)
    && models.unet.available
    && models.vae.available
    && (!detailMode || detail?.available);
  return { ready, comfyUi: Boolean(comfyUi), models, nodes, ...(detail ? { detail } : {}) };
}

export function evaluateH3LatentReadiness(objectInfo, {
  diffusionNames = H3_LATENT_DIFFUSION_NAMES,
  encoderName = H3_LATENT_ENCODER_NAME,
  vaeName = H3_LATENT_VAE_NAME,
  audioVaeName = H3_LATENT_AUDIO_VAE_NAME,
  modelFiles = {},
  comfyUi = true,
} = {}) {
  const nodes = Object.fromEntries(H3_LATENT_REQUIRED_NODES.map((name) => [name, Boolean(objectInfo?.[name])]));
  const diffusionOptions = comboValues(objectInfo?.UNETLoader, "unet_name");
  const encoderListed = comboValues(objectInfo?.CLIPLoader, "clip_name").includes(encoderName);
  const vaeOptions = comboValues(objectInfo?.VAELoader, "vae_name");
  const diffusionFileMap = modelFiles.diffusion && typeof modelFiles.diffusion === "object"
    ? modelFiles.diffusion
    : {};
  const diffusionName = diffusionNames.find((name) => diffusionOptions.includes(name) && diffusionFileMap[name] !== false)
    || diffusionNames.find((name) => diffusionOptions.includes(name))
    || diffusionNames[0];
  const diffusionFile = modelFiles.diffusion === undefined
    ? true
    : Boolean(diffusionFileMap[diffusionName]);
  const encoderFile = modelFiles.encoder === undefined ? true : Boolean(modelFiles.encoder);
  const videoVaeFile = modelFiles.videoVae === undefined ? true : Boolean(modelFiles.videoVae);
  const audioVaeFile = modelFiles.audioVae === undefined ? true : Boolean(modelFiles.audioVae);
  const models = {
    diffusion: { name: diffusionName, available: diffusionOptions.includes(diffusionName) && diffusionFile },
    encoder: { name: encoderName, available: encoderListed && encoderFile },
    videoVae: { name: vaeName, available: vaeOptions.includes(vaeName) && videoVaeFile },
    audioVae: { name: audioVaeName, available: vaeOptions.includes(audioVaeName) && audioVaeFile },
  };
  const modelReady = models.diffusion.available && models.encoder.available
    && models.videoVae.available && models.audioVae.available;
  return {
    ready: Boolean(comfyUi) && Object.values(nodes).every(Boolean) && modelReady,
    comfyUi: Boolean(comfyUi),
    models,
    nodes,
  };
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
  scale = SEEDVR2_DEFAULT_SCALE,
  resizeMethod = SEEDVR2_DEFAULT_RESIZE_METHOD,
  colorCorrection = SEEDVR2_DEFAULT_COLOR_CORRECTION,
  steps = SEEDVR2_DEFAULT_STEPS,
  cfg = SEEDVR2_DEFAULT_CFG,
  samplerName = SEEDVR2_DEFAULT_SAMPLER_NAME,
  scheduler = SEEDVR2_DEFAULT_SCHEDULER,
  denoise = SEEDVR2_DEFAULT_DENOISE,
} = {}) {
  const file = normalizeVideoAssetName(sourceName);
  const safePrefix = sanitizeFilenamePrefix(filenamePrefix);
  const samplerSeed = Number.isSafeInteger(seed) && seed >= 0 ? seed : Math.floor(Math.random() * 2_147_483_647);
  const settings = normalizeSeedVR2Settings({ scale, resizeMethod, colorCorrection, steps, cfg, samplerName, scheduler, denoise });
  return {
    "1": { class_type: "LoadVideo", inputs: { file } },
    "2": { class_type: "GetVideoComponents", inputs: { video: link(1) } },
    "3": {
      class_type: "ResizeImageMaskNode",
      inputs: {
        input: link(2),
        resize_type: "scale by multiplier",
        "resize_type.multiplier": settings.scale,
        scale_method: settings.resizeMethod,
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
    "9": { class_type: "SeedVR2TemporalChunk", inputs: { latent: link(6), temporal_overlap: 1, chunking_mode: "auto" } },
    "10": {
      class_type: "KSampler",
      inputs: {
        model: link(7),
        seed: samplerSeed,
        steps: settings.steps,
        cfg: settings.cfg,
        sampler_name: settings.samplerName,
        scheduler: settings.scheduler,
        positive: link(8, 0),
        negative: link(8, 1),
        latent_image: link(9),
        denoise: settings.denoise,
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
    "13": { class_type: "SeedVR2PostProcessing", inputs: { images: link(12), original_resized_images: link(3), color_correction_method: settings.colorCorrection } },
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

export function buildSeedVR2ImagePrompt({
  sourceName,
  filenamePrefix = "seedvr2_image_upscaled",
  unetName = SEEDVR2_UNET_NAME,
  vaeName = SEEDVR2_VAE_NAME,
  seed,
  scale = SEEDVR2_DEFAULT_SCALE,
  resizeMethod = SEEDVR2_DEFAULT_RESIZE_METHOD,
  colorCorrection = SEEDVR2_DEFAULT_COLOR_CORRECTION,
  steps = SEEDVR2_DEFAULT_STEPS,
  cfg = SEEDVR2_DEFAULT_CFG,
  samplerName = SEEDVR2_DEFAULT_SAMPLER_NAME,
  scheduler = SEEDVR2_DEFAULT_SCHEDULER,
  denoise = SEEDVR2_DEFAULT_DENOISE,
} = {}) {
  const file = normalizeUpscaleAssetName(sourceName);
  if (sourceKindFromName(file) !== "image") {
    throw makeError("SeedVR2 image upscale requires a PNG, JPEG, or WebP source.", 415, "SOURCE_KIND_INVALID");
  }
  const safePrefix = sanitizeFilenamePrefix(filenamePrefix);
  const samplerSeed = Number.isSafeInteger(seed) && seed >= 0 ? seed : Math.floor(Math.random() * 2_147_483_647);
  const settings = normalizeSeedVR2Settings({ scale, resizeMethod, colorCorrection, steps, cfg, samplerName, scheduler, denoise });
  return {
    "1": { class_type: "LoadImage", inputs: { image: file } },
    "2": {
      class_type: "ResizeImageMaskNode",
      inputs: {
        input: link(1),
        resize_type: "scale by multiplier",
        "resize_type.multiplier": settings.scale,
        scale_method: settings.resizeMethod,
      },
    },
    "3": { class_type: "SeedVR2Preprocess", inputs: { resized_images: link(2) } },
    "4": { class_type: "VAELoader", inputs: { vae_name: vaeName } },
    "5": {
      class_type: "VAEEncodeTiled",
      inputs: { pixels: link(3), vae: link(4), tile_size: 512, overlap: 128, temporal_size: 4096, temporal_overlap: 8 },
    },
    "6": { class_type: "UNETLoader", inputs: { unet_name: unetName, weight_dtype: "default" } },
    "7": { class_type: "SeedVR2Conditioning", inputs: { model: link(6), vae_conditioning: link(5) } },
    "8": {
      class_type: "KSampler",
      inputs: {
        model: link(6), seed: samplerSeed, steps: settings.steps, cfg: settings.cfg, sampler_name: settings.samplerName, scheduler: settings.scheduler,
        positive: link(7, 0), negative: link(7, 1), latent_image: link(5), denoise: settings.denoise,
      },
    },
    "9": {
      class_type: "VAEDecodeTiled",
      inputs: { samples: link(8), vae: link(4), tile_size: 512, overlap: 128, temporal_size: 4096, temporal_overlap: 8 },
    },
    "10": { class_type: "SeedVR2PostProcessing", inputs: { images: link(9), original_resized_images: link(2), color_correction_method: settings.colorCorrection } },
    "11": { class_type: "SaveImage", inputs: { images: link(10), filename_prefix: safePrefix } },
  };
}

export function buildSeedVR2DetailPrompt({
  sourceName,
  filenamePrefix = "seedvr2_detail_upscaled",
  unetName = SEEDVR2_FP16_UNET_NAME,
  vaeName = SEEDVR2_VAE_NAME,
  seed,
  ...input
} = {}) {
  const file = normalizeUpscaleAssetName(sourceName);
  const sourceKind = sourceKindFromName(file);
  const safePrefix = sanitizeFilenamePrefix(filenamePrefix);
  const samplerSeed = Number.isSafeInteger(seed) && seed >= 0 ? seed : Math.floor(Math.random() * 2_147_483_647);
  const settings = normalizeSeedVR2Settings(input);
  if (!usesSeedVR2Detail(settings)) {
    throw makeError("SeedVR2 detail graph requires non-default detail settings.", 400, "DETAIL_SETTINGS_REQUIRED");
  }
  const detailUnetName = seedVR2DetailUnetName(unetName);
  if (!detailUnetName || ![SEEDVR2_VAE_NAME, SEEDVR2_DETAIL_VAE_NAME].includes(vaeName)) {
    throw makeError("The selected SeedVR2 model is unavailable for tiled detail reconstruction.", 400, "SEEDVR2_DETAIL_MODEL_UNSUPPORTED");
  }
  if (settings.resizeMethod !== "lanczos" || settings.steps !== 1 || settings.cfg !== 1
      || settings.samplerName !== "euler" || settings.scheduler !== "simple" || settings.denoise !== 1) {
    throw makeError("Tiled detail reconstruction supports the native one-step Lanczos sampling contract only.", 400, "SEEDVR2_DETAIL_SAMPLING_UNSUPPORTED");
  }
  const ditInputs = {
    model: detailUnetName,
    device: "cuda:0",
    blocks_to_swap: 0,
    swap_io_components: false,
    offload_device: "cpu",
    cache_model: true,
    attention_mode: "sdpa",
  };
  const vaeInputs = {
    model: SEEDVR2_DETAIL_VAE_NAME,
    device: "cuda:0",
    encode_tiled: true,
    encode_tile_size: Math.min(settings.tileWidth, settings.tileHeight),
    encode_tile_overlap: settings.tilePadding,
    decode_tiled: true,
    decode_tile_size: Math.min(settings.tileWidth, settings.tileHeight),
    decode_tile_overlap: settings.tilePadding,
    tile_debug: "false",
    offload_device: "cpu",
    cache_model: true,
  };
  const detailInputs = (imageNode, ditNode, vaeNode) => ({
    image: link(imageNode),
    dit: link(ditNode),
    vae: link(vaeNode),
    seed: samplerSeed,
    new_resolution: settings.tileUpscaleResolution,
    input_noise_scale: settings.inputNoiseScale,
    latent_noise_scale: settings.latentNoiseScale,
    tile_width: settings.tileWidth,
    tile_height: settings.tileHeight,
    tile_padding: settings.tilePadding,
    tile_upscale_resolution: settings.tileUpscaleResolution,
    blending_method: settings.blendingMethod,
    anti_aliasing_strength: settings.antiAliasingStrength,
    mask_blur: settings.maskBlur,
    tiling_strategy: settings.tilingStrategy === "chess" ? "Chess" : "Linear",
    color_correction: settings.colorCorrection,
    resolution_target: "longest",
    tile_batch_size: 1,
    upscale_factor: settings.scale,
  });
  if (sourceKind === "image") {
    return {
      "1": { class_type: "LoadImage", inputs: { image: file } },
      "2": { class_type: SEEDVR2_DETAIL_DIT_LOADER_NODE, inputs: ditInputs },
      "3": { class_type: SEEDVR2_DETAIL_VAE_LOADER_NODE, inputs: vaeInputs },
      "4": { class_type: SEEDVR2_DETAIL_NODE, inputs: detailInputs(1, 2, 3) },
      "5": { class_type: "SaveImage", inputs: { images: link(4), filename_prefix: safePrefix } },
    };
  }
  return {
    "1": { class_type: "LoadVideo", inputs: { file } },
    "2": { class_type: "GetVideoComponents", inputs: { video: link(1) } },
    "3": { class_type: SEEDVR2_DETAIL_DIT_LOADER_NODE, inputs: ditInputs },
    "4": { class_type: SEEDVR2_DETAIL_VAE_LOADER_NODE, inputs: vaeInputs },
    "5": { class_type: SEEDVR2_DETAIL_NODE, inputs: detailInputs(2, 3, 4) },
    "6": { class_type: "CreateVideo", inputs: { images: link(5), fps: link(2, 2), audio: link(2, 1) } },
    "7": {
      class_type: "SaveVideo",
      inputs: {
        video: link(6),
        filename_prefix: safePrefix,
        format: "mp4",
        codec: "h264",
        "codec.encoding": "re-encode",
        "codec.encoding.crf": 18,
      },
    },
  };
}

export function buildH3LatentPrompt({
  sourceName,
  filenamePrefix = "h3latent_upscaled",
  diffusionName = H3_LATENT_DIFFUSION_NAMES[0],
  encoderName = H3_LATENT_ENCODER_NAME,
  vaeName = H3_LATENT_VAE_NAME,
  audioVaeName = H3_LATENT_AUDIO_VAE_NAME,
  promptText = H3_LATENT_PROMPT,
  scaleBy = H3_LATENT_SCALE,
  upscaleMethod = H3_LATENT_UPSCALE_METHOD,
  pass1Steps = H3_LATENT_PASS1_STEPS,
  pass2Sigmas = H3_LATENT_PASS2_SIGMAS,
  seed = 0,
} = {}) {
  const file = normalizeVideoAssetName(sourceName);
  const safePrefix = sanitizeFilenamePrefix(filenamePrefix);
  const samplerSeed = boundedSeed(seed, 0);
  const pass2Seed = boundedSeed(samplerSeed + 1, samplerSeed);
  return {
    "1": { class_type: "LoadVideo", inputs: { file } },
    "2": { class_type: "GetVideoComponents", inputs: { video: link(1) } },
    "3": { class_type: "GetImageSize", inputs: { image: link(2) } },
    "4": { class_type: "UNETLoader", inputs: { unet_name: diffusionName, weight_dtype: "default" } },
    "5": { class_type: "CLIPLoader", inputs: { clip_name: encoderName, type: "minimax", device: "default" } },
    "6": { class_type: "VAELoader", inputs: { vae_name: vaeName } },
    "7": { class_type: "VAELoader", inputs: { vae_name: audioVaeName } },
    "8": {
      class_type: "MiniMaxH3ReferenceToVideo",
      inputs: {
        clip: link(5),
        vae: link(6),
        audio_vae: link(7),
        prompt: String(promptText || H3_LATENT_PROMPT),
        width: link(3, 0),
        height: link(3, 1),
        length: link(3, 2),
        ref_image_size: "match",
        "ref_videos.ref_video_0": link(2, 0),
        "ref_video_audios.ref_video_audio_0": link(2, 1),
      },
    },
    // Pass 1: generate a native H3 low-resolution latent from the complete
    // source video/audio reference. This is the denoised latent the community
    // upscaler is designed to receive.
    "9": { class_type: "RandomNoise", inputs: { noise_seed: samplerSeed } },
    "10": { class_type: "KSamplerSelect", inputs: { sampler_name: "res_multistep" } },
    "11": {
      class_type: "BasicScheduler",
      inputs: { model: link(4), scheduler: "simple", steps: pass1Steps, denoise: 1.0 },
    },
    "12": { class_type: "BasicGuider", inputs: { model: link(4), conditioning: link(8, 0) } },
    "13": {
      class_type: "SamplerCustomAdvanced",
      inputs: {
        noise: link(9),
        guider: link(12),
        sampler: link(10),
        sigmas: link(11),
        latent_image: link(8, 1),
      },
    },
    "14": { class_type: "LTXVSeparateAVLatent", inputs: { av_latent: link(13) } },
    "15": {
      class_type: "MiniMaxH3LatentUpscale",
      inputs: { samples: link(14, 0), scale_by: scaleBy, upscale_method: upscaleMethod },
    },
    "16": { class_type: "RandomNoise", inputs: { noise_seed: pass2Seed } },
    "17": { class_type: "ManualSigmas", inputs: { sigmas: String(pass2Sigmas || H3_LATENT_PASS2_SIGMAS) } },
    "18": { class_type: "MiniMaxH3AddNoise", inputs: { model: link(4), noise: link(16), sigmas: link(17), latent_image: link(15) } },
    "19": {
      class_type: "MiniMaxH3ShiftSigmas",
      inputs: { sigmas: link(17), shift_video: 12.0, shift_audio: 3.0 },
    },
    "20": {
      class_type: "MiniMaxH3AddNoise",
      inputs: { model: link(4), noise: link(16), sigmas: link(19), latent_image: link(14, 1) },
    },
    "21": { class_type: "LTXVConcatAVLatent", inputs: { video_latent: link(18), audio_latent: link(20) } },
    "22": {
      class_type: "MiniMaxH3ConditioningUpscale",
      inputs: { conditioning: link(8, 0), scale_by: scaleBy, upscale_method: upscaleMethod },
    },
    "23": { class_type: "BasicGuider", inputs: { model: link(4), conditioning: link(22) } },
    "24": { class_type: "DisableNoise", inputs: {} },
    "25": {
      class_type: "SamplerCustomAdvanced",
      inputs: {
        noise: link(24),
        guider: link(23),
        sampler: link(10),
        sigmas: link(17),
        latent_image: link(21),
      },
    },
    "26": { class_type: "VAEDecode", inputs: { samples: link(25), vae: link(6) } },
    "27": { class_type: "VAEDecodeAudio", inputs: { samples: link(25), vae: link(7) } },
    "28": { class_type: "CreateVideo", inputs: { images: link(26), fps: link(2, 2), audio: link(27) } },
    "29": {
      class_type: "SaveVideo",
      inputs: {
        video: link(28),
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
  const extension = path.posix.extname(relativeName).toLowerCase();
  return VIDEO_EXTENSIONS.has(extension) || IMAGE_EXTENSIONS.has(extension) ? relativeName : null;
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
    resizeMethod: job.resizeMethod,
    colorCorrection: job.colorCorrection,
    ...(isSeedVR2Profile(job.profile) ? {
      steps: job.steps ?? SEEDVR2_DEFAULT_STEPS,
      cfg: job.cfg ?? SEEDVR2_DEFAULT_CFG,
      samplerName: job.samplerName || SEEDVR2_DEFAULT_SAMPLER_NAME,
      scheduler: job.scheduler || SEEDVR2_DEFAULT_SCHEDULER,
      denoise: job.denoise ?? SEEDVR2_DEFAULT_DENOISE,
      detailPreset: job.detailPreset || SEEDVR2_DEFAULT_DETAIL.detailPreset,
      inputNoiseScale: job.inputNoiseScale ?? SEEDVR2_DEFAULT_DETAIL.inputNoiseScale,
      latentNoiseScale: job.latentNoiseScale ?? SEEDVR2_DEFAULT_DETAIL.latentNoiseScale,
      tileWidth: job.tileWidth ?? SEEDVR2_DEFAULT_DETAIL.tileWidth,
      tileHeight: job.tileHeight ?? SEEDVR2_DEFAULT_DETAIL.tileHeight,
      tilePadding: job.tilePadding ?? SEEDVR2_DEFAULT_DETAIL.tilePadding,
      tileUpscaleResolution: job.tileUpscaleResolution ?? SEEDVR2_DEFAULT_DETAIL.tileUpscaleResolution,
      blendingMethod: job.blendingMethod || SEEDVR2_DEFAULT_DETAIL.blendingMethod,
      antiAliasingStrength: job.antiAliasingStrength ?? SEEDVR2_DEFAULT_DETAIL.antiAliasingStrength,
      maskBlur: job.maskBlur ?? SEEDVR2_DEFAULT_DETAIL.maskBlur,
      tilingStrategy: job.tilingStrategy || SEEDVR2_DEFAULT_DETAIL.tilingStrategy,
    } : {}),
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

function normalizeSeedVR2Scale(value, profile = SEEDVR2_PROFILE) {
  const scale = Number(value ?? SEEDVR2_DEFAULT_SCALE);
  if (!Number.isFinite(scale)) throw makeError("Upscale scale must be a number.", 400, "SCALE_INVALID");
  if (isH3VideoProfile(profile)) {
    const h3Scale = profile === MMH3_ULTIMATE_PROFILE ? MMH3_ULTIMATE_SCALE : H3_LATENT_SCALE;
    if (scale !== h3Scale) throw makeError(`${profileLabel(profile)} supports scale=2 only.`, 400, "SCALE_INVALID");
    return h3Scale;
  }
  if (scale < SEEDVR2_MIN_SCALE || scale > SEEDVR2_MAX_SCALE) {
    throw makeError(`SeedVR2 scale must be between ${SEEDVR2_MIN_SCALE} and ${SEEDVR2_MAX_SCALE}.`, 400, "SCALE_INVALID");
  }
  return Math.round(scale * 100) / 100;
}

function normalizeSeedVR2Choice(value, choices, fallback, field, code) {
  const candidate = value === undefined || value === null || value === "" ? fallback : value;
  const normalized = String(candidate).trim().toLowerCase();
  if (!choices.includes(normalized)) throw makeError(`SeedVR2 ${field} is invalid.`, 400, code);
  return normalized;
}

function normalizeSeedVR2Integer(value, fallback, min, max, field, code, multipleOf = 0) {
  const normalized = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max || (multipleOf && normalized % multipleOf !== 0)) {
    const suffix = multipleOf ? ` and a multiple of ${multipleOf}` : "";
    throw makeError(`SeedVR2 ${field} must be an integer between ${min} and ${max}${suffix}.`, 400, code);
  }
  return normalized;
}

function normalizeSeedVR2Decimal(value, fallback, min, max, field, code, precision = 2) {
  const numeric = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isFinite(numeric) || numeric < min || numeric > max) {
    throw makeError(`SeedVR2 ${field} must be between ${min} and ${max}.`, 400, code);
  }
  const factor = 10 ** precision;
  return Math.round(numeric * factor) / factor;
}

function hasSeedVR2SamplingOverride(input = {}) {
  return ["steps", "cfg", "samplerName", "scheduler", "denoise"]
    .some((key) => Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined);
}

const SEEDVR2_DETAIL_KEYS = Object.freeze([
  "inputNoiseScale", "latentNoiseScale", "tileWidth", "tileHeight", "tilePadding",
  "tileUpscaleResolution", "blendingMethod", "antiAliasingStrength", "maskBlur",
  "tilingStrategy", "detailPreset",
]);

function hasSeedVR2DetailOverride(input = {}) {
  return SEEDVR2_DETAIL_KEYS.some((key) => Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined);
}

export function usesSeedVR2Detail(settings = {}) {
  return settings.detailPreset !== SEEDVR2_DEFAULT_DETAIL.detailPreset
    || SEEDVR2_DETAIL_KEYS.some((key) => key !== "detailPreset" && settings[key] !== SEEDVR2_DEFAULT_DETAIL[key]);
}

export function normalizeSeedVR2Settings(input = {}, profile = SEEDVR2_PROFILE) {
  const normalizedProfile = normalizeProfile(profile);
  const detailPreset = normalizeSeedVR2Choice(
    input.detailPreset,
    SEEDVR2_DETAIL_PRESETS,
    SEEDVR2_DEFAULT_DETAIL.detailPreset,
    "detail preset",
    "DETAIL_PRESET_INVALID",
  );
  const defaults = detailPreset === "skin_detail" ? SEEDVR2_SKIN_DETAIL_SETTINGS : {
    scale: SEEDVR2_DEFAULT_SCALE,
    resizeMethod: SEEDVR2_DEFAULT_RESIZE_METHOD,
    colorCorrection: SEEDVR2_DEFAULT_COLOR_CORRECTION,
    steps: SEEDVR2_DEFAULT_STEPS,
    cfg: SEEDVR2_DEFAULT_CFG,
    samplerName: SEEDVR2_DEFAULT_SAMPLER_NAME,
    scheduler: SEEDVR2_DEFAULT_SCHEDULER,
    denoise: SEEDVR2_DEFAULT_DENOISE,
    ...SEEDVR2_DEFAULT_DETAIL,
  };
  const base = {
    scale: normalizeSeedVR2Scale(input.scale ?? defaults.scale, normalizedProfile),
    resizeMethod: normalizeSeedVR2Choice(input.resizeMethod, SEEDVR2_RESIZE_METHODS, defaults.resizeMethod, "resize method", "RESIZE_METHOD_INVALID"),
    colorCorrection: normalizeSeedVR2Choice(input.colorCorrection, SEEDVR2_COLOR_CORRECTION_METHODS, defaults.colorCorrection, "color correction", "COLOR_CORRECTION_INVALID"),
  };
  if (isH3VideoProfile(normalizedProfile)) {
    if (hasSeedVR2SamplingOverride(input) || hasSeedVR2DetailOverride(input)) {
      throw makeError(`SeedVR2 sampling and detail settings are not supported by ${profileLabel(normalizedProfile)}.`, 400, "SEEDVR2_SETTINGS_UNSUPPORTED");
    }
    return base;
  }
  return {
    ...base,
    steps: normalizeSeedVR2Integer(input.steps, defaults.steps, SEEDVR2_MIN_STEPS, SEEDVR2_MAX_STEPS, "steps", "STEPS_INVALID"),
    cfg: normalizeSeedVR2Decimal(input.cfg, defaults.cfg, SEEDVR2_MIN_CFG, SEEDVR2_MAX_CFG, "cfg", "CFG_INVALID"),
    samplerName: normalizeSeedVR2Choice(input.samplerName, SEEDVR2_SAMPLER_NAMES, defaults.samplerName, "sampler", "SAMPLER_INVALID"),
    scheduler: normalizeSeedVR2Choice(input.scheduler, SEEDVR2_SCHEDULERS, defaults.scheduler, "scheduler", "SCHEDULER_INVALID"),
    denoise: normalizeSeedVR2Decimal(input.denoise, defaults.denoise, SEEDVR2_MIN_DENOISE, SEEDVR2_MAX_DENOISE, "denoise", "DENOISE_INVALID"),
    detailPreset,
    inputNoiseScale: normalizeSeedVR2Decimal(input.inputNoiseScale, defaults.inputNoiseScale, 0, 0.2, "input noise scale", "INPUT_NOISE_SCALE_INVALID", 3),
    latentNoiseScale: normalizeSeedVR2Decimal(input.latentNoiseScale, defaults.latentNoiseScale, 0, 0.2, "latent noise scale", "LATENT_NOISE_SCALE_INVALID", 3),
    tileWidth: normalizeSeedVR2Integer(input.tileWidth, defaults.tileWidth, 256, 2048, "tile width", "TILE_WIDTH_INVALID", 64),
    tileHeight: normalizeSeedVR2Integer(input.tileHeight, defaults.tileHeight, 256, 2048, "tile height", "TILE_HEIGHT_INVALID", 64),
    tilePadding: normalizeSeedVR2Integer(input.tilePadding, defaults.tilePadding, 0, 256, "tile padding", "TILE_PADDING_INVALID"),
    tileUpscaleResolution: normalizeSeedVR2Integer(input.tileUpscaleResolution, defaults.tileUpscaleResolution, 512, 4096, "tile upscale resolution", "TILE_UPSCALE_RESOLUTION_INVALID", 64),
    blendingMethod: normalizeSeedVR2Choice(input.blendingMethod, SEEDVR2_BLENDING_METHODS, defaults.blendingMethod, "blending method", "BLENDING_METHOD_INVALID"),
    antiAliasingStrength: normalizeSeedVR2Decimal(input.antiAliasingStrength, defaults.antiAliasingStrength, 0, 1, "anti-aliasing strength", "ANTI_ALIASING_STRENGTH_INVALID", 3),
    maskBlur: normalizeSeedVR2Decimal(input.maskBlur, defaults.maskBlur, 0, 64, "mask blur", "MASK_BLUR_INVALID", 3),
    tilingStrategy: normalizeSeedVR2Choice(input.tilingStrategy, SEEDVR2_TILING_STRATEGIES, defaults.tilingStrategy, "tiling strategy", "TILING_STRATEGY_INVALID"),
  };
}

function normalizeProfile(value) {
  const profile = String(value || SEEDVR2_PROFILE).trim();
  if ([SEEDVR2_PROFILE, SEEDVR2_PROFILE_LABEL].includes(profile)) {
    return SEEDVR2_PROFILE;
  }
  if ([SEEDVR2_FP16_PROFILE, SEEDVR2_FP16_PROFILE_LABEL].includes(profile)) {
    return SEEDVR2_FP16_PROFILE;
  }
  if ([H3_LATENT_PROFILE, H3_LATENT_PROFILE_LABEL].includes(profile)) {
    return H3_LATENT_PROFILE;
  }
  if ([MMH3_ULTIMATE_PROFILE, MMH3_ULTIMATE_PROFILE_LABEL].includes(profile)) {
    return MMH3_ULTIMATE_PROFILE;
  }
  throw makeError("Upscale profile is invalid.", 400, "PROFILE_INVALID");
}

function profileReadinessConfig(profile) {
  if (isH3VideoProfile(profile)) {
    return {
      modelPaths: {
        diffusion: ["diffusion_models", H3_LATENT_DIFFUSION_NAMES],
        encoder: ["text_encoders", H3_LATENT_ENCODER_NAME],
        videoVae: ["vae", H3_LATENT_VAE_NAME],
        audioVae: ["vae", H3_LATENT_AUDIO_VAE_NAME],
      },
      evaluate: profile === MMH3_ULTIMATE_PROFILE ? evaluateMMH3UltimateReadiness : evaluateH3LatentReadiness,
      ...(profile === MMH3_ULTIMATE_PROFILE ? {
        evaluateOptions: {
          diffusionNames: H3_LATENT_DIFFUSION_NAMES,
          encoderName: H3_LATENT_ENCODER_NAME,
          vaeName: H3_LATENT_VAE_NAME,
          audioVaeName: H3_LATENT_AUDIO_VAE_NAME,
        },
      } : {}),
      modelFiles: ["diffusion", "encoder", "videoVae", "audioVae"],
    };
  }
  return {
    modelPaths: {
      unet: ["diffusion_models", seedVR2UnetName(profile)],
      vae: ["vae", SEEDVR2_VAE_NAME],
    },
    evaluate: evaluateSeedVR2Readiness,
    evaluateOptions: { unetName: seedVR2UnetName(profile), vaeName: SEEDVR2_VAE_NAME },
    modelFiles: ["unet", "vae"],
  };
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
  webSocketImpl = globalThis.WebSocket,
  gpuCoordinator = null,
  gpuWorkloadType = "seedvr2-upscale",
  gpuRuntime = remote ? "remote" : "local",
} = {}) {
  if (!inputRoot || !outputRoot) throw new Error("SeedVR2 controller requires inputRoot and outputRoot.");
  const comfyRootPath = path.resolve(comfyRoot || path.dirname(inputRoot));
  const modelPaths = {
    seedvr2Unet: {
      [SEEDVR2_PROFILE]: path.join(comfyRootPath, "models", "diffusion_models", SEEDVR2_UNET_NAME),
      [SEEDVR2_FP16_PROFILE]: path.join(comfyRootPath, "models", "diffusion_models", SEEDVR2_FP16_UNET_NAME),
    },
    vae: path.join(comfyRootPath, "models", "vae", SEEDVR2_VAE_NAME),
    h3Upscaler: path.join(comfyRootPath, "models", "h3_latent_upscalers", H3_LATENT_UPSCALER_NAME),
    h3Diffusion: Object.fromEntries(H3_LATENT_DIFFUSION_NAMES.map((name) => [
      name,
      path.join(comfyRootPath, "models", "diffusion_models", name),
    ])),
    h3Encoder: path.join(comfyRootPath, "models", "text_encoders", H3_LATENT_ENCODER_NAME),
    h3Vae: path.join(comfyRootPath, "models", "vae", H3_LATENT_VAE_NAME),
    h3AudioVae: path.join(comfyRootPath, "models", "vae", H3_LATENT_AUDIO_VAE_NAME),
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

  async function checkReadiness(requestedProfile = SEEDVR2_PROFILE, sourceKind = "video", input = {}) {
    const profile = normalizeProfile(requestedProfile);
    const config = profileReadinessConfig(profile);
    const detailSettings = isSeedVR2Profile(profile) ? normalizeSeedVR2Settings(input, profile) : null;
    const detailMode = isSeedVR2Profile(profile) && (input.detailMode === true || usesSeedVR2Detail(detailSettings));
    const [statsResult, objectResult, modelFiles] = await Promise.all([
      requestJson("/system_stats").then(() => true).catch(() => false),
      requestJson("/object_info").catch(() => null),
      Promise.all(config.modelFiles.map((key) => {
        const [, configuredNames] = config.modelPaths[key];
        const names = Array.isArray(configuredNames) ? configuredNames : [configuredNames];
        const candidates = isH3VideoProfile(profile)
          ? key === "diffusion"
            ? names.map((name) => modelPaths.h3Diffusion[name])
            : key === "encoder"
              ? [modelPaths.h3Encoder]
              : key === "videoVae"
                ? [modelPaths.h3Vae]
                : [modelPaths.h3AudioVae]
          : [key === "unet" ? modelPaths.seedvr2Unet[profile] : modelPaths.vae];
        return Promise.all(candidates.map((candidate, index) => (
          fileExists(candidate, fsApi).then((available) => [names[index], available])
        ))).then((entries) => [key, key === "diffusion" ? Object.fromEntries(entries) : Boolean(entries[0]?.[1])]);
      })).then((entries) => Object.fromEntries(entries)),
    ]);
    return {
      ...config.evaluate(objectResult, { modelFiles, comfyUi: statsResult, sourceKind, detailMode, detailSettings, ...config.evaluateOptions }),
      profile,
      profileLabel: profileLabel(profile),
      sourceKind,
    };
  }

  async function resolveAsset(rootName, sourceName) {
    const cleanName = normalizeUpscaleAssetName(sourceName);
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
    const relativeName = `${profileShortName(job.profile)}_temp_${job.id}${extension}`;
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
      throw makeError("Remote media upload is unavailable in this Node runtime.", 500, "UPLOAD_UNAVAILABLE");
    }
    assertNotCancelled(job);
    const extension = path.posix.extname(source.cleanName).toLowerCase() || ".mp4";
    const uploadName = `${profileShortName(job.profile)}_temp_${sanitizeFilenamePrefix(job.id)}${extension}`;
    let bytes;
    try {
      bytes = await fsApi.readFile(source.path);
    } catch (error) {
      throw makeError(`Unable to read source media for remote upload: ${asErrorMessage(error)}`, 502, "SOURCE_READ_FAILED");
    }
    assertNotCancelled(job);
    const form = new FormData();
    const mimeType = VIDEO_MIME_TYPES[extension] || IMAGE_MIME_TYPES[extension] || "application/octet-stream";
    form.append("image", new Blob([bytes], { type: mimeType }), uploadName);
    form.append("subfolder", `h3-studio-${profileShortName(job.profile)}`);
    form.append("type", "input");
    form.append("overwrite", "true");
    const payload = await requestJson("/upload/image", { method: "POST", body: form }, 60_000, signal);
    const uploaded = artifactRelativeName({
      filename: payload?.name || uploadName,
      subfolder: typeof payload?.subfolder === "string" ? payload.subfolder : `h3-studio-${profileShortName(job.profile)}`,
    });
    if (!uploaded) throw makeError("ComfyUI returned an invalid uploaded media path.", 502, "UPLOAD_RESPONSE_INVALID");
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
    return sanitizeFilenamePrefix(`${profileShortName(job.profile)}_${stem}_${job.id.slice(0, 8)}`);
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
    return { name: clean, root: "output", kind: sourceKindFromName(clean) };
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
    if (!response?.ok) throw makeError(`Unable to download generated media: HTTP ${response?.status || 0}.`, 502, "OUTPUT_DOWNLOAD_FAILED");
    if (typeof response.arrayBuffer !== "function") throw makeError("ComfyUI returned an unreadable media artifact.", 502, "OUTPUT_DOWNLOAD_FAILED");
    assertNotCancelled(job);
    const extension = path.posix.extname(relativeName).toLowerCase();
    const localName = `${profileShortName(job.profile)}/${outputPrefix(job)}${extension}`;
    const candidate = path.resolve(outputRoot, localName);
    if (!isInside(outputRoot, candidate)) throw makeError("Downloaded media path is unsafe.", 500, "OUTPUT_PATH_INVALID");
    const outputReal = await realPathOrResolved(outputRoot, fsApi);
    await fsApi.mkdir(path.dirname(candidate), { recursive: true });
    const parentReal = await realPathOrResolved(path.dirname(candidate), fsApi);
    if (!isInside(outputReal, parentReal)) throw makeError("Downloaded media path escaped its output root.", 500, "OUTPUT_PATH_INVALID");
    const existingReal = await fsApi.realpath(candidate).catch(() => null);
    if (existingReal && !isInside(outputReal, existingReal)) throw makeError("Downloaded media path escaped its output root.", 500, "OUTPUT_PATH_INVALID");
    await fsApi.writeFile(candidate, Buffer.from(await response.arrayBuffer()));
    const createdReal = await fsApi.realpath(candidate).catch(() => null);
    if (!createdReal || !isInside(outputReal, createdReal)) throw makeError("Downloaded media path escaped its output root.", 500, "OUTPUT_PATH_INVALID");
    assertNotCancelled(job);
    if (typeof toAsset === "function") return await toAsset("output", localName);
    return { name: localName, root: "output", kind: sourceKindFromName(localName) };
  }

  async function waitForHistory(job, promptId, signal, runtime = null) {
    const started = Date.now();
    while (true) {
      assertNotCancelled(job);
      if (runtime?.comfyError) {
        throw makeError(runtime.comfyError.message, 502, runtime.comfyError.code || "COMFY_EXECUTION_FAILED");
      }
      const payload = await requestJson(`/history/${encodeURIComponent(promptId)}`, {}, requestTimeoutMs, signal);
      assertNotCancelled(job);
      if (runtime?.comfyError) {
        throw makeError(runtime.comfyError.message, 502, runtime.comfyError.code || "COMFY_EXECUTION_FAILED");
      }
      const parsed = parseSeedVR2History(payload, promptId);
      if (parsed.state === "failed") throw makeError(parsed.error || "ComfyUI reported an execution error.", 502, "COMFY_EXECUTION_FAILED");
      const artifact = parsed.state === "completed" ? historyArtifact(payload, promptId) : null;
      if (artifact) return artifact;
      if (parsed.state === "completed") throw makeError("ComfyUI completed without a saved media artifact.", 502, "OUTPUT_ARTIFACT_MISSING");
      const elapsed = Date.now() - started;
      if (maxPollMs > 0 && elapsed >= maxPollMs) throw makeError("Timed out while waiting for ComfyUI output.", 504, "COMFY_POLL_TIMEOUT");
      const websocketProgressActive = runtime?.wsProgressSeen && !["error", "closed", "unavailable"].includes(runtime.wsState);
      if (!websocketProgressActive) {
        job.progress = Math.min(90, Math.max(Number(job.progress) || 0, 25 + Math.floor(Math.min(65, elapsed / 4000))));
        job.stage = `Processing ${profileLabel(job.profile)}`;
      }
      await persistJob(job);
      await sleep(pollIntervalMs, signal);
    }
  }

  async function runJob(job) {
    const profile = normalizeProfile(job.profile);
    job.profile = profile;
    const label = profileLabel(profile);
    const sourceKind = sourceKindFromName(job.sourceName);
    let staged = null;
    let succeeded = false;
    let failure = null;
    const abortController = typeof AbortController === "function" ? new AbortController() : null;
    const runtime = {
      abortController,
      promptId: "",
      wsState: "connecting",
      wsProgressSeen: false,
      wsTerminal: "",
      comfyError: null,
      comfySession: null,
    };
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
        stage: `Checking ${label} readiness`,
      });
      const readiness = await checkReadiness(profile, sourceKind, job);
      assertNotCancelled(job);
      if (!readiness.ready) {
        throw makeError(
          `${label} is unavailable: required ComfyUI nodes or model files are missing.`,
          503,
          profile === MMH3_ULTIMATE_PROFILE
            ? "MMH3_ULTIMATE_NOT_READY"
            : profile === H3_LATENT_PROFILE
              ? "H3_LATENT_NOT_READY"
              : readiness.detail?.requested ? "SEEDVR2_DETAIL_NOT_READY" : "SEEDVR2_NOT_READY",
        );
      }

      await updateJob(job, { progress: 12, stage: `Validating source ${sourceKind}` });
      const source = await resolveAsset(job.sourceRoot, job.sourceName);
      assertNotCancelled(job);
      let loadName = source.cleanName;
      if (remote) {
        await updateJob(job, { progress: 16, stage: `Uploading source ${sourceKind}` });
        staged = await uploadRemoteInput(job, source, abortController?.signal);
        loadName = staged.loadName;
      } else if (job.sourceRoot === "output") {
        await updateJob(job, { progress: 16, stage: `Staging source ${sourceKind}` });
        staged = await stageOutputSource(job, source);
        loadName = staged.loadName;
      }
      assertNotCancelled(job);

      const prompt = profile === MMH3_ULTIMATE_PROFILE
        ? buildMMH3UltimatePrompt({
          sourceName: loadName,
          filenamePrefix: outputPrefix(job),
          diffusionName: readiness.models?.diffusion?.name,
          encoderName: readiness.models?.encoder?.name,
          vaeName: readiness.models?.videoVae?.name,
          audioVaeName: readiness.models?.audioVae?.name,
          seed: job.seed,
        })
        : profile === H3_LATENT_PROFILE
        ? buildH3LatentPrompt({
          sourceName: loadName,
          filenamePrefix: outputPrefix(job),
          diffusionName: readiness.models?.diffusion?.name,
          encoderName: readiness.models?.encoder?.name,
          vaeName: readiness.models?.videoVae?.name,
          audioVaeName: readiness.models?.audioVae?.name,
          seed: job.seed,
        })
        : usesSeedVR2Detail(job) ? buildSeedVR2DetailPrompt({
          ...job,
          sourceName: loadName,
          filenamePrefix: outputPrefix(job),
          unetName: readiness.models?.unet?.name,
          vaeName: readiness.models?.vae?.name,
          seed: job.seed,
        })
        : sourceKind === "image" ? buildSeedVR2ImagePrompt({
          sourceName: loadName,
          filenamePrefix: outputPrefix(job),
          unetName: readiness.models?.unet?.name,
          vaeName: SEEDVR2_VAE_NAME,
          seed: job.seed,
          scale: job.scale,
          resizeMethod: job.resizeMethod,
          colorCorrection: job.colorCorrection,
          steps: job.steps,
          cfg: job.cfg,
          samplerName: job.samplerName,
          scheduler: job.scheduler,
          denoise: job.denoise,
        }) : buildSeedVR2Prompt({
          sourceName: loadName,
          filenamePrefix: outputPrefix(job),
          unetName: readiness.models?.unet?.name,
          vaeName: SEEDVR2_VAE_NAME,
          seed: job.seed,
          scale: job.scale,
          resizeMethod: job.resizeMethod,
          colorCorrection: job.colorCorrection,
          steps: job.steps,
          cfg: job.cfg,
          samplerName: job.samplerName,
          scheduler: job.scheduler,
          denoise: job.denoise,
        });
      await updateJob(job, { prompt, progress: 20, stage: "Submitting ComfyUI workflow" });
      assertNotCancelled(job);
      runtime.comfySession = createSeedVR2ProgressSession({
        comfyUrl,
        clientId,
        WebSocketImpl: webSocketImpl,
        onEvent: (event) => {
          applySeedVR2ProgressEvent(job, prompt, event, runtime);
          void persistJob(job).catch(() => {});
        },
      });
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
      await updateJob(job, { promptId: runtime.promptId, progress: 25, stage: `Processing ${label}`, provenance: { ...job.provenance, submittedAt: isoNow(now()) } });
      runtime.comfySession?.setPromptId(runtime.promptId);
      const artifact = await waitForHistory(job, runtime.promptId, abortController?.signal, runtime);
      assertNotCancelled(job);
      await updateJob(job, { progress: 92, stage: remote ? `Downloading output ${sourceKind}` : `Registering output ${sourceKind}` });
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
      runtime.comfySession?.close?.();
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

  function createJob({
    sourceName,
    sourceRoot,
    scale = SEEDVR2_DEFAULT_SCALE,
    profile = SEEDVR2_PROFILE,
    seed,
    resizeMethod = SEEDVR2_DEFAULT_RESIZE_METHOD,
    colorCorrection = SEEDVR2_DEFAULT_COLOR_CORRECTION,
    steps = SEEDVR2_DEFAULT_STEPS,
    cfg = SEEDVR2_DEFAULT_CFG,
    samplerName = SEEDVR2_DEFAULT_SAMPLER_NAME,
    scheduler = SEEDVR2_DEFAULT_SCHEDULER,
    denoise = SEEDVR2_DEFAULT_DENOISE,
    detailPreset = SEEDVR2_DEFAULT_DETAIL.detailPreset,
    inputNoiseScale = SEEDVR2_DEFAULT_DETAIL.inputNoiseScale,
    latentNoiseScale = SEEDVR2_DEFAULT_DETAIL.latentNoiseScale,
    tileWidth = SEEDVR2_DEFAULT_DETAIL.tileWidth,
    tileHeight = SEEDVR2_DEFAULT_DETAIL.tileHeight,
    tilePadding = SEEDVR2_DEFAULT_DETAIL.tilePadding,
    tileUpscaleResolution = SEEDVR2_DEFAULT_DETAIL.tileUpscaleResolution,
    blendingMethod = SEEDVR2_DEFAULT_DETAIL.blendingMethod,
    antiAliasingStrength = SEEDVR2_DEFAULT_DETAIL.antiAliasingStrength,
    maskBlur = SEEDVR2_DEFAULT_DETAIL.maskBlur,
    tilingStrategy = SEEDVR2_DEFAULT_DETAIL.tilingStrategy,
    attempt = 1,
    retryOf = "",
    provenance = null,
  } = {}) {
    const id = String(idFactory());
    const createdAt = isoNow(now());
    const seedvr2Settings = isSeedVR2Profile(profile) ? {
      steps,
      cfg,
      samplerName,
      scheduler,
      denoise,
      detailPreset,
      inputNoiseScale,
      latentNoiseScale,
      tileWidth,
      tileHeight,
      tilePadding,
      tileUpscaleResolution,
      blendingMethod,
      antiAliasingStrength,
      maskBlur,
      tilingStrategy,
    } : {};
    const request = {
      sourceName,
      sourceRoot,
      scale,
      profile,
      seed,
      resizeMethod,
      colorCorrection,
      ...seedvr2Settings,
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
      resizeMethod,
      colorCorrection,
      ...seedvr2Settings,
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
    const profile = normalizeProfile(input.profile);
    const settings = normalizeSeedVR2Settings(input, profile);
    const cleanName = normalizeUpscaleAssetName(input.sourceName);
    const sourceKind = sourceKindFromName(cleanName);
    if (sourceKind === "image" && isH3VideoProfile(profile)) {
      throw makeError(`${profileLabel(profile)} accepts video assets only; use SeedVR2 7B for images.`, 415, "SOURCE_KIND_INVALID");
    }
    const seed = boundedSeed(input.seed, Math.floor(Math.random() * 2_147_483_648));
    await resolveAsset(sourceRoot, cleanName);
    const job = createJob({ sourceName: cleanName, sourceRoot, profile, seed, ...settings });
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
      resizeMethod: source.resizeMethod,
      colorCorrection: source.colorCorrection,
      ...(isSeedVR2Profile(source.profile) ? {
        steps: source.steps,
        cfg: source.cfg,
        samplerName: source.samplerName,
        scheduler: source.scheduler,
        denoise: source.denoise,
        detailPreset: source.detailPreset,
        inputNoiseScale: source.inputNoiseScale,
        latentNoiseScale: source.latentNoiseScale,
        tileWidth: source.tileWidth,
        tileHeight: source.tileHeight,
        tilePadding: source.tilePadding,
        tileUpscaleResolution: source.tileUpscaleResolution,
        blendingMethod: source.blendingMethod,
        antiAliasingStrength: source.antiAliasingStrength,
        maskBlur: source.maskBlur,
        tilingStrategy: source.tilingStrategy,
      } : {}),
    };
    const profile = request.profile || source.profile || SEEDVR2_PROFILE;
    const settings = normalizeSeedVR2Settings(request, profile);
    const job = createJob({
      sourceName: source.sourceName,
      sourceRoot: source.sourceRoot,
      ...settings,
      profile,
      seed: boundedSeed(source.seed, 0),
      attempt,
      retryOf,
      provenance: {
        request: {
          sourceName: request.sourceName || source.sourceName,
          sourceRoot: request.sourceRoot || source.sourceRoot,
          ...settings,
          profile,
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
      try {
        const url = new URL(req.url || "/api/upscale/health", "http://localhost");
        const profile = normalizeProfile(url.searchParams.get("profile") || SEEDVR2_PROFILE);
        const sourceKind = url.searchParams.get("kind") === "image" ? "image" : "video";
        const detailMode = url.searchParams.get("detail") === "1";
        const detailSettings = detailMode ? {
          detailMode: true,
          detailPreset: url.searchParams.get("detailPreset") || "skin_detail",
          blendingMethod: url.searchParams.get("blendingMethod") || SEEDVR2_DEFAULT_DETAIL.blendingMethod,
          tilingStrategy: url.searchParams.get("tilingStrategy") || SEEDVR2_DEFAULT_DETAIL.tilingStrategy,
        } : {};
        respond(res, 200, await checkReadiness(profile, sourceKind, detailSettings));
      } catch (error) {
        fail(res, Number.isInteger(error?.status) ? error.status : 503, asErrorMessage(error, "Unable to check upscale readiness."), error?.code);
      }
      return true;
    }
    if (req.method === "POST" && pathname === "/api/upscale") {
      try {
        const body = typeof readJson === "function" ? await readJson(req) : {};
        const profile = normalizeProfile(body?.profile);
        const settings = normalizeSeedVR2Settings(body, profile);
        const cleanName = normalizeUpscaleAssetName(body?.sourceName);
        const sourceKind = sourceKindFromName(cleanName);
        if (sourceKind === "image" && isH3VideoProfile(profile)) {
          throw makeError(`${profileLabel(profile)} accepts video assets only; use SeedVR2 7B for images.`, 415, "SOURCE_KIND_INVALID");
        }
        const readiness = await checkReadiness(profile, sourceKind, settings);
        if (!readiness.ready) {
          respond(res, 503, {
            error: `${profileLabel(profile)} is not ready.`,
            code: profile === MMH3_ULTIMATE_PROFILE
              ? "MMH3_ULTIMATE_NOT_READY"
              : profile === H3_LATENT_PROFILE
                ? "H3_LATENT_NOT_READY"
                : readiness.detail?.requested ? "SEEDVR2_DETAIL_NOT_READY" : "SEEDVR2_NOT_READY",
            health: readiness,
          });
          return true;
        }
        respond(res, 202, { job: await enqueue(body) });
      } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : 400;
        fail(res, status, asErrorMessage(error, "Unable to queue media upscale."), error?.code);
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
        const listed = await listJobs();
        const limit = jobListLimit(req.url, { fallback: listed.length, max: 100 });
        const summarize = wantsJobSummary(req.url);
        respond(res, 200, { jobs: listed.slice(0, limit).map((job) => summarize ? summarizeJobRecord(job) : job) });
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
