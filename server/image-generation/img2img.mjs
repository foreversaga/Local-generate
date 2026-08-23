import { randomInt, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createImg2ImgStore } from "./img2img-store.mjs";
import { jobListLimit, summarizeJobRecord, wantsJobSummary } from "../../app/lib/job-list-query.mjs";

export const IMG2IMG_REQUIRED_NODES = Object.freeze([
  "CheckpointLoaderSimple",
  "LoadImage",
  "VAEEncode",
  "CLIPTextEncode",
  "KSampler",
  "VAEDecode",
  "SaveImage",
]);

export const IMG2IMG_FLUX2_REQUIRED_NODES = Object.freeze([
  "UNETLoader",
  "CLIPLoader",
  "VAELoader",
  "LoadImage",
  "GetImageSize",
  "VAEEncode",
  "CLIPTextEncode",
  "FluxGuidance",
  "ReferenceLatent",
  "BasicGuider",
  "RandomNoise",
  "KSamplerSelect",
  "Flux2Scheduler",
  "EmptyFlux2LatentImage",
  "SamplerCustomAdvanced",
  "VAEDecode",
  "SaveImage",
]);

// Pose references use the native ComfyUI ControlNet API plus the already
// installed controlnet_aux DWPose preprocessor.  The actual ControlNet model
// is intentionally configured by the runtime (no model is downloaded here).
export const IMG2IMG_POSE_REQUIRED_NODES = Object.freeze([
  "ControlNetLoader",
  "ControlNetApplyAdvanced",
  "DWPreprocessor",
]);

const IMG2IMG_PROFILE_DEFINITIONS = {
  "sd_xl_turbo_1.0_fp16.safetensors": {
    model: "sd_xl_turbo_1.0_fp16.safetensors",
    workflow: "checkpoint",
    loader: "CheckpointLoaderSimple",
    loraLoader: "LoraLoader",
    localOnly: false,
    requiredNodes: IMG2IMG_REQUIRED_NODES,
    defaults: { steps: 4, cfg: 1, denoise: 0.65 },
  },
  "v1-5-pruned-emaonly-fp16.safetensors": {
    model: "v1-5-pruned-emaonly-fp16.safetensors",
    workflow: "checkpoint",
    loader: "CheckpointLoaderSimple",
    loraLoader: "LoraLoader",
    localOnly: false,
    requiredNodes: IMG2IMG_REQUIRED_NODES,
    defaults: { steps: 20, cfg: 7, denoise: 0.65 },
  },
  "waiIllustriousSDXL_v170.safetensors": {
    model: "waiIllustriousSDXL_v170.safetensors",
    workflow: "checkpoint",
    loader: "CheckpointLoaderSimple",
    loraLoader: "LoraLoader",
    localOnly: true,
    requiredNodes: IMG2IMG_REQUIRED_NODES,
    defaults: { steps: 20, cfg: 7, denoise: 0.65 },
  },
  "flux2_dev_fp8mixed.safetensors": {
    model: "flux2_dev_fp8mixed.safetensors",
    workflow: "flux2-dev-edit",
    loader: "UNETLoader",
    localOnly: true,
    requiredNodes: IMG2IMG_FLUX2_REQUIRED_NODES,
    companions: {
      textEncoder: "mistral_3_small_flux2_bf16.safetensors",
      vae: "full_encoder_small_decoder.safetensors",
      clipType: "flux2",
    },
    defaults: { steps: 20, cfg: 4, denoise: 1 },
    sampling: { samplerName: "euler" },
  },
};

function freezeProfile(profile) {
  return Object.freeze({
    ...profile,
    requiredNodes: Object.freeze([...profile.requiredNodes]),
    ...(profile.companions ? { companions: Object.freeze({ ...profile.companions }) } : {}),
    defaults: Object.freeze({ ...profile.defaults }),
    ...(profile.sampling ? { sampling: Object.freeze({ ...profile.sampling }) } : {}),
  });
}

export const IMG2IMG_MODEL_PROFILES = Object.freeze(
  Object.fromEntries(Object.entries(IMG2IMG_PROFILE_DEFINITIONS).map(([model, profile]) => [model, freezeProfile(profile)])),
);

export const IMG2IMG_MODELS = Object.freeze(Object.keys(IMG2IMG_MODEL_PROFILES));

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const TERMINAL_STAGES = new Set(["completed", "success", "succeeded", "finished", "done"]);
const ERROR_STAGES = new Set(["error", "failed", "failure", "cancelled", "canceled"]);
const IMG2IMG_BATCH_MAX = 20;
const IMG2IMG_PARAMETER_RULES = Object.freeze({
  denoise: Object.freeze({ min: 0.01, max: 1, step: 0.01, integer: false }),
  steps: Object.freeze({ min: 1, max: 50, step: 1, integer: true }),
  cfg: Object.freeze({ min: 0, max: 20, step: 0.5, integer: false }),
  seed: Object.freeze({ min: 0, max: 2_147_483_647, step: 1, integer: true }),
});
const IMG2IMG_SEED_RANGE = Object.freeze({ min: 0, max: 2_147_483_647 });
const IMG2IMG_POSE_CONTROLNET_ENV = "H3_IMG2IMG_POSE_CONTROLNET";
const IMG2IMG_POSE_STRENGTH_ENV = "H3_IMG2IMG_POSE_STRENGTH";
const IMG2IMG_POSE_RESOLUTION_ENV = "H3_IMG2IMG_POSE_RESOLUTION";
const COMFY_WS_BUFFER_MAX = 64;
const COMFY_NODE_PROGRESS = Object.freeze({
  CheckpointLoaderSimple: 30,
  UNETLoader: 30,
  CLIPLoader: 32,
  VAELoader: 32,
  LoadImage: 34,
  VAEEncode: 38,
  CLIPTextEncode: 42,
  DWPreprocessor: 46,
  ControlNetLoader: 48,
  ControlNetApplyAdvanced: 50,
  KSampler: 54,
  ReferenceLatent: 46,
  FluxGuidance: 48,
  BasicGuider: 50,
  Flux2Scheduler: 52,
  EmptyFlux2LatentImage: 54,
  SamplerCustomAdvanced: 56,
  VAEDecode: 88,
  SaveImage: 92,
});

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

export function parseComfyWebSocketMessage(value) {
  if (typeof value !== "string") return null;
  let payload;
  try {
    payload = JSON.parse(value);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || typeof payload.type !== "string") return null;
  const data = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
    ? payload.data
    : {};
  return { ...data, type: payload.type };
}

function createComfyProgressSession({ comfyUrl, clientId, WebSocketImpl = globalThis.WebSocket, onEvent } = {}) {
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
    const eventPromptId = String(event.prompt_id || "");
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
    const event = parseComfyWebSocketMessage(message?.data ?? message);
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

function comfyNodeInfo(graph, event = {}) {
  const rawNodeId = event.node ?? event.display_node ?? event.node_id ?? event.display_node_id;
  const nodeId = rawNodeId === undefined || rawNodeId === null || rawNodeId === "" ? "" : String(rawNodeId);
  const node = nodeId ? graph?.[nodeId] : null;
  const classType = String(node?.class_type || event.class_type || nodeId || "ComfyUI");
  const title = String(node?._meta?.title || node?.title || event.node_title || "").trim();
  const label = title && title !== classType ? `${title} (${classType})` : classType;
  return { nodeId, classType, title, label };
}

function comfyNodeBaseline(classType) {
  return Number(COMFY_NODE_PROGRESS[classType]) || 28;
}

function resetComfyProgress(target, connectionState = "connecting") {
  if (!target) return;
  target.progressSource = "estimated";
  target.nativeCurrent = null;
  target.nativeMaximum = null;
  target.comfyNode = null;
  target.comfyNodeId = null;
  target.comfyNodeTitle = null;
  target.connectionState = connectionState;
  target.comfyQueueRemaining = null;
}

function applyComfyProgressEvent(job, item, graph, event, runtime) {
  if (!event?.type) return;
  const targets = [job, item].filter(Boolean);
  const assign = (patch) => {
    for (const target of targets) Object.assign(target, patch);
  };
  const node = comfyNodeInfo(graph, event);
  const setNode = (extra = {}) => assign({
    comfyNode: node.classType,
    comfyNodeId: node.nodeId || null,
    comfyNodeTitle: node.title || null,
    ...extra,
  });
  const setStage = (stage) => {
    for (const target of targets) target.stage = stage;
  };
  const stageForNode = (suffix = "") => `ComfyUI / ${node.label}${suffix ? ` · ${suffix}` : ""}`;

  if (event.type === "websocket_connected") {
    assign({ connectionState: "connected" });
    return;
  }
  if (event.type === "websocket_unavailable" || event.type === "websocket_error") {
    assign({ connectionState: event.connectionState || "error", progressSource: "estimated" });
    if (job.status === "running" && !job.comfyNode) setStage("Generating image (history fallback)");
    return;
  }
  if (event.type === "websocket_closed") {
    assign({ connectionState: "closed", progressSource: "estimated" });
    return;
  }
  if (event.type === "status") {
    const remaining = Number(event.status?.exec_info?.queue_remaining);
    assign({
      connectionState: "connected",
      ...(Number.isFinite(remaining) ? { comfyQueueRemaining: remaining } : {}),
    });
    if (job.status === "running" && !job.comfyNode && job.progress < 28) setStage("Waiting for ComfyUI");
    return;
  }
  if (event.type === "execution_start") {
    assign({ connectionState: "connected" });
    if (job.status === "running") setStage("ComfyUI / starting execution");
    return;
  }
  if (event.type === "execution_cached") {
    assign({ connectionState: "connected" });
    const count = Array.isArray(event.nodes) ? event.nodes.length : 0;
    if (job.status === "running") setStage(count ? `ComfyUI / cached ${count} node${count === 1 ? "" : "s"}` : "ComfyUI / loading workflow");
    return;
  }
  if (event.type === "executing") {
    assign({ connectionState: "connected" });
    if (event.node === null || event.node === undefined || event.node === "") {
      assign({ comfyNode: "finalizing", comfyNodeId: null, comfyNodeTitle: null });
      if (job.status === "running") setStage("ComfyUI / finalizing output");
      return;
    }
    setNode();
    for (const target of targets) target.progress = Math.min(90, Math.max(Number(target.progress) || 0, comfyNodeBaseline(node.classType)));
    if (job.status === "running") setStage(stageForNode());
    return;
  }
  if (event.type === "progress") {
    const current = Number(event.value);
    const maximum = Number(event.max);
    if (!Number.isFinite(current) || !Number.isFinite(maximum) || maximum <= 0) return;
    assign({
      progressSource: "native",
      nativeCurrent: Math.max(0, current),
      nativeMaximum: Math.max(1, maximum),
      connectionState: "connected",
    });
    setNode();
    for (const target of targets) target.progress = Math.min(90, Math.max(Number(target.progress) || 0, comfyNodeBaseline(node.classType)));
    if (job.status === "running") setStage(stageForNode(`${Math.max(0, current)}/${Math.max(1, maximum)}`));
    return;
  }
  if (event.type === "progress_state") {
    const entries = Object.entries(event.nodes || {});
    const active = entries.find(([, value]) => value?.state === "running");
    if (!active) return;
    const [nodeId, value] = active;
    applyComfyProgressEvent(job, item, graph, {
      type: "progress",
      node: nodeId,
      display_node: value?.display_node_id,
      value: value?.value,
      max: value?.max,
    }, runtime);
    return;
  }
  if (event.type === "execution_error" || event.type === "execution_interrupted") {
    const message = errorMessage(event.exception_message || event.message || event.error || "ComfyUI reported an image execution error.");
    setNode({ connectionState: "error" });
    if (job.status === "running") setStage(`ComfyUI error / ${node.label}`);
    runtime.comfyError = { message, code: "COMFY_EXECUTION_FAILED" };
    return;
  }
  if (event.type === "execution_success") {
    assign({ connectionState: "connected" });
    if (job.status === "running") setStage("ComfyUI / completed, reading output");
  }
}

function compactComfyValue(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (!text) return "";
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function comfyRequestErrorMessage(payload, fallback) {
  const primary = errorMessage(payload?.error || payload?.message || payload?.raw || fallback);
  const nodeErrors = payload?.node_errors;
  if (!nodeErrors || typeof nodeErrors !== "object" || Array.isArray(nodeErrors)) return primary;
  const details = [];
  for (const [nodeId, nodeError] of Object.entries(nodeErrors)) {
    const classType = String(nodeError?.class_type || `node ${nodeId}`);
    for (const issue of Array.isArray(nodeError?.errors) ? nodeError.errors : []) {
      const inputName = String(issue?.extra_info?.input_name || "").trim();
      const label = inputName ? `${classType}.${inputName}` : classType;
      const message = errorMessage(issue, String(issue?.type || "validation failed"));
      const received = Object.prototype.hasOwnProperty.call(issue?.extra_info || {}, "received_value")
        ? compactComfyValue(issue.extra_info.received_value)
        : "";
      details.push(`${label}: ${message}${received ? ` (received ${received})` : ""}`);
      if (details.length >= 4) break;
    }
    if (details.length >= 4) break;
  }
  return details.length ? `${primary} — ${[...new Set(details)].join("; ")}` : primary;
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

/**
 * Normalize the optional pose/control reference independently from the
 * required character/source image.  Keeping a separate validator gives API
 * callers an actionable field-specific error while retaining the legacy
 * sourceName/sourceRoot contract.
 */
export function normalizePoseImageName(value) {
  if (typeof value !== "string") throw makeError("poseName must be a relative image asset name.", 400, "POSE_NAME_INVALID");
  const raw = value.replaceAll("\\", "/");
  if (!raw || raw.length > 512 || raw.includes("\0") || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) {
    throw makeError("poseName must be a relative image asset name.", 400, "POSE_NAME_INVALID");
  }
  const pieces = raw.split("/");
  if (pieces.some((piece) => !piece || piece === "." || piece === "..")) {
    throw makeError("poseName must not contain traversal segments.", 400, "POSE_NAME_INVALID");
  }
  const normalized = pieces.join("/");
  if (!IMAGE_EXTENSIONS.has(path.posix.extname(normalized).toLowerCase())) {
    throw makeError("Pose reference accepts PNG, JPG, or WEBP assets only.", 415, "POSE_KIND_INVALID");
  }
  return normalized;
}

export function normalizePoseRoot(value, fallback = "input") {
  const root = value === undefined || value === null || value === "" ? fallback : String(value);
  if (root !== "input" && root !== "output") {
    throw makeError("poseRoot must be input or output.", 400, "POSE_ROOT_INVALID");
  }
  return root;
}

export function normalizePoseControlNetName(value) {
  if (value === undefined || value === null || String(value).trim() === "") return "";
  if (typeof value !== "string") {
    throw makeError("Pose ControlNet model name must be a string.", 400, "POSE_CONTROLNET_NAME_INVALID");
  }
  const normalized = value.trim().replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    !normalized
    || normalized.length > 512
    || normalized.startsWith("/")
    || /^[A-Za-z]:/.test(normalized)
    || normalized.includes("\0")
    || segments.some((segment) => !segment || segment === "." || segment === ".." || /[<>:"|?*]/.test(segment))
  ) {
    throw makeError("Pose ControlNet model name must be a safe relative ComfyUI controlnet path.", 400, "POSE_CONTROLNET_NAME_INVALID");
  }
  return normalized;
}

export function normalizePoseControlStrength(value, fallback = 1) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "number" && typeof value !== "string") {
    throw makeError("Pose ControlNet strength must be a finite number between 0 and 10.", 400, "POSE_CONTROL_STRENGTH_INVALID");
  }
  if (typeof value === "string" && value.trim() === "") {
    throw makeError("Pose ControlNet strength must be a finite number between 0 and 10.", 400, "POSE_CONTROL_STRENGTH_INVALID");
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 10) {
    throw makeError("Pose ControlNet strength must be a finite number between 0 and 10.", 400, "POSE_CONTROL_STRENGTH_INVALID");
  }
  return number;
}

export function normalizePoseResolution(value, fallback = 512) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "number" && typeof value !== "string") {
    throw makeError("Pose DWPose resolution must be an integer multiple of 64 between 64 and 2048.", 400, "POSE_RESOLUTION_INVALID");
  }
  if (typeof value === "string" && value.trim() === "") {
    throw makeError("Pose DWPose resolution must be an integer multiple of 64 between 64 and 2048.", 400, "POSE_RESOLUTION_INVALID");
  }
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < 64 || number > 2048 || number % 64 !== 0) {
    throw makeError("Pose DWPose resolution must be an integer multiple of 64 between 64 and 2048.", 400, "POSE_RESOLUTION_INVALID");
  }
  return number;
}

export function normalizeCharacterLoraName(value) {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return "";
  if (typeof value !== "string") {
    throw makeError("Character LoRA name must be a string.", 400, "CHARACTER_LORA_NAME_INVALID");
  }
  const normalized = value.trim().replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    !normalized
    || normalized.length > 512
    || normalized.startsWith("/")
    || /^[A-Za-z]:/.test(normalized)
    || normalized.includes("\0")
    || segments.some((segment) => !segment || segment === "." || segment === ".." || /[<>:"|?*]/.test(segment))
  ) {
    throw makeError(
      "Character LoRA must be a safe relative path under ComfyUI/models/loras.",
      400,
      "CHARACTER_LORA_NAME_INVALID",
    );
  }
  return normalized;
}

export function normalizeCharacterLoraStrength(value, fallback = 0.75) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" && typeof value !== "string") {
    throw makeError("Character LoRA strength must be a finite number between 0 and 2.", 400, "CHARACTER_LORA_STRENGTH_INVALID");
  }
  if (typeof value === "string" && value.trim() === "") {
    throw makeError("Character LoRA strength must be a finite number between 0 and 2.", 400, "CHARACTER_LORA_STRENGTH_INVALID");
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 2) {
    throw makeError("Character LoRA strength must be a finite number between 0 and 2.", 400, "CHARACTER_LORA_STRENGTH_INVALID");
  }
  return number;
}

function preserveCharacterLoraLoaderName(value) {
  if (typeof value !== "string") {
    throw makeError("Character LoRA loader name must be a string.", 400, "CHARACTER_LORA_NAME_INVALID");
  }
  const loaderName = value.trim();
  normalizeCharacterLoraName(loaderName);
  return loaderName;
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

function modelProfile(model) {
  return IMG2IMG_MODEL_PROFILES[String(model)] || null;
}

function unsupportedModelError(model) {
  return makeError(
    `Unsupported image model: ${String(model || "(empty)")}.`,
    400,
    "MODEL_UNSUPPORTED",
  );
}

function localOnlyModelError(model) {
  return makeError(
    `Image model ${String(model)} is available only on the local runtime.`,
    400,
    "MODEL_RUNTIME_UNSUPPORTED",
  );
}

function assertModelForRuntime(model, { remote = false } = {}) {
  const profile = modelProfile(model);
  if (!profile) throw unsupportedModelError(model);
  if (remote && profile.localOnly) throw localOnlyModelError(model);
  return profile;
}

function modelDefaults(profile) {
  return profile?.defaults || { steps: 20, cfg: 7, denoise: 0.65 };
}

function boundedModelParameters(profile, { denoise, steps, cfg, seed } = {}) {
  const defaults = modelDefaults(profile);
  return {
    denoise: boundedNumber(denoise, defaults.denoise, 0.01, 1),
    steps: boundedInteger(steps, defaults.steps, 1, 50),
    cfg: boundedNumber(cfg, defaults.cfg, 0, 20),
    seed: boundedInteger(seed, 12345, 0, 2_147_483_647),
  };
}

function roundParameterValue(value, rule) {
  const units = Math.round((Number(value) - rule.min) / rule.step);
  const rounded = rule.min + units * rule.step;
  return Number(rounded.toFixed(12));
}

function parameterValueAligned(value, rule) {
  const units = (Number(value) - rule.min) / rule.step;
  return Math.abs(units - Math.round(units)) <= 1e-8;
}

function batchCountError() {
  return makeError(`batchCount must be an integer between 1 and ${IMG2IMG_BATCH_MAX}.`, 400, "BATCH_COUNT_INVALID");
}

function randomRangeError(name, detail = "is invalid") {
  return makeError(`randomRanges.${name} ${detail}.`, 400, "RANDOM_RANGE_INVALID");
}

function normalizeBatchCount(value) {
  if (value === undefined) return 1;
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < 1 || number > IMG2IMG_BATCH_MAX) throw batchCountError();
  return number;
}

function normalizeRandomRange(name, value, base) {
  const rule = IMG2IMG_PARAMETER_RULES[name];
  if (value === undefined || value === null) return { min: roundParameterValue(base, rule), max: roundParameterValue(base, rule) };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw randomRangeError(name);
  if (typeof value.min !== "number" || typeof value.max !== "number") throw randomRangeError(name, "must contain numeric min and max values");
  const min = value.min;
  const max = value.max;
  if (!Number.isFinite(min) || !Number.isFinite(max)) throw randomRangeError(name, "must contain finite min and max values");
  if (min < rule.min || min > rule.max || max < rule.min || max > rule.max) {
    throw randomRangeError(name, `must stay within ${rule.min} and ${rule.max}`);
  }
  if (min > max) throw randomRangeError(name, "min must not exceed max");
  if (!parameterValueAligned(min, rule) || !parameterValueAligned(max, rule)) {
    throw randomRangeError(name, `min and max must align to step ${rule.step}`);
  }
  return { min: roundParameterValue(min, rule), max: roundParameterValue(max, rule) };
}

function normalizeRandomRanges(input, base) {
  if (input !== undefined && input !== null && (typeof input !== "object" || Array.isArray(input))) {
    throw makeError("randomRanges must be an object.", 400, "RANDOM_RANGE_INVALID");
  }
  const ranges = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return Object.freeze(Object.fromEntries(Object.keys(IMG2IMG_PARAMETER_RULES).map((name) => [
    name,
    Object.freeze(normalizeRandomRange(name, ranges[name], base[name])),
  ])));
}

function sampleRandomRange(name, range, randomFn) {
  const rule = IMG2IMG_PARAMETER_RULES[name];
  if (range.min === range.max) return range.min;
  const span = Math.max(0, Math.round((range.max - range.min) / rule.step));
  const raw = Number(typeof randomFn === "function" ? randomFn() : Math.random());
  const unit = Number.isFinite(raw) ? Math.min(0.999999999999, Math.max(0, raw)) : 0;
  const index = Math.min(span, Math.floor(unit * (span + 1)));
  return roundParameterValue(range.min + index * rule.step, rule);
}

function randomizeParameters(ranges, randomFn) {
  return {
    denoise: sampleRandomRange("denoise", ranges.denoise, randomFn),
    steps: sampleRandomRange("steps", ranges.steps, randomFn),
    cfg: sampleRandomRange("cfg", ranges.cfg, randomFn),
    seed: sampleRandomRange("seed", IMG2IMG_SEED_RANGE, randomFn),
  };
}

export function buildImg2ImgPrompt({
  sourceName,
  poseName,
  poseControlNetName,
  poseControlStrength,
  poseResolution,
  prompt,
  negativePrompt = "",
  model = IMG2IMG_MODELS[0],
  characterLoraName,
  characterLoraLoaderName,
  characterLoraStrength,
  denoise,
  steps,
  cfg,
  seed = 12345,
  filenamePrefix = "img2img/h3_img2img",
} = {}) {
  const image = normalizeImageAssetName(sourceName);
  const poseImage = poseName ? normalizePoseImageName(poseName) : "";
  const poseControlModel = poseImage ? normalizePoseControlNetName(poseControlNetName) : "";
  const poseStrength = poseImage ? normalizePoseControlStrength(poseControlStrength) : null;
  const poseSize = poseImage ? normalizePoseResolution(poseResolution) : null;
  if (poseImage && !poseControlModel) {
    throw makeError(
      `Pose reference selected but no ControlNet model is configured. Set ${IMG2IMG_POSE_CONTROLNET_ENV} to an installed OpenPose ControlNet filename.`,
      503,
      "IMG2IMG_POSE_NOT_READY",
    );
  }
  const positive = String(prompt || "").trim();
  const profile = modelProfile(model);
  if (!profile) throw unsupportedModelError(model);
  const parameters = boundedModelParameters(profile, { denoise, steps, cfg, seed });
  if (poseImage && profile.workflow !== "checkpoint") {
    throw makeError(
      `Pose references are not supported by the ${profile.workflow} image workflow. Select an SDXL or SD1.5 checkpoint.`,
      400,
      "IMG2IMG_POSE_UNSUPPORTED",
    );
  }
  const loraName = normalizeCharacterLoraName(characterLoraName);
  const loraLoaderName = loraName
    ? preserveCharacterLoraLoaderName(characterLoraLoaderName || characterLoraName)
    : "";
  if (loraName && normalizeCharacterLoraName(loraLoaderName).toLowerCase() !== loraName.toLowerCase()) {
    throw makeError("Character LoRA loader name does not match the selected LoRA.", 400, "CHARACTER_LORA_NAME_MISMATCH");
  }
  const loraStrength = loraName ? normalizeCharacterLoraStrength(characterLoraStrength) : null;
  const cleanNegative = String(negativePrompt || "").trim();
  const cleanPrefix = String(filenamePrefix || "img2img/h3_img2img");

  if (loraName && profile.workflow !== "checkpoint") {
    throw makeError(
      "Character LoRAs are not supported by the " + profile.workflow + " image workflow.",
      400,
      "IMG2IMG_LORA_UNSUPPORTED",
    );
  }

  if (profile.workflow === "checkpoint") {
    const sampling = profile.sampling || {};
    const graph = {
      "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: profile.model } },
      "2": { class_type: "LoadImage", inputs: { image } },
      "3": { class_type: "VAEEncode", inputs: { pixels: link(2), vae: link(1, 2) } },
      "4": { class_type: "CLIPTextEncode", inputs: { text: positive, clip: link(1, 1) } },
      "5": { class_type: "CLIPTextEncode", inputs: { text: cleanNegative, clip: link(1, 1) } },
      "6": {
        class_type: "KSampler",
        inputs: {
          model: link(1),
          seed: parameters.seed,
          steps: parameters.steps,
          cfg: parameters.cfg,
          sampler_name: sampling.samplerName || "euler_ancestral",
          scheduler: sampling.scheduler || "normal",
          positive: link(4),
          negative: link(5),
          latent_image: link(3),
          denoise: parameters.denoise,
        },
      },
      "7": { class_type: "VAEDecode", inputs: { samples: link(6), vae: link(1, 2) } },
      "8": { class_type: "SaveImage", inputs: { images: link(7), filename_prefix: cleanPrefix } },
    };
    if (profile.normalizeMegapixels) {
      graph["14"] = {
        class_type: "ImageScaleToTotalPixels",
        inputs: {
          image: link(2),
          upscale_method: "lanczos",
          megapixels: profile.normalizeMegapixels,
          resolution_steps: 64,
        },
      };
      graph["3"].inputs.pixels = link(14);
    }
    if (poseImage) {
      graph["9"] = { class_type: "LoadImage", inputs: { image: poseImage } };
      graph["10"] = {
        class_type: "DWPreprocessor",
        inputs: {
          image: link(9),
          detect_hand: "enable",
          detect_body: "enable",
          detect_face: "disable",
          resolution: poseSize,
          bbox_detector: "yolox_l.onnx",
          pose_estimator: "dw-ll_ucoco_384_bs5.torchscript.pt",
          scale_stick_for_xinsr_cn: /xinsir/i.test(poseControlModel) ? "enable" : "disable",
        },
      };
      graph["11"] = { class_type: "ControlNetLoader", inputs: { control_net_name: poseControlModel } };
      graph["12"] = {
        class_type: "ControlNetApplyAdvanced",
        inputs: {
          positive: link(4),
          negative: link(5),
          control_net: link(11),
          image: link(10),
          strength: poseStrength,
          start_percent: 0,
          end_percent: 1,
          vae: link(1, 2),
        },
      };
      graph["6"].inputs.positive = link(12, 0);
      graph["6"].inputs.negative = link(12, 1);
    }
    if (loraName) {
      const loraNodeId = poseImage ? "13" : "9";
      graph[loraNodeId] = {
        class_type: "LoraLoader",
        inputs: {
          model: link(1),
          clip: link(1, 1),
          lora_name: loraLoaderName,
          strength_model: loraStrength,
          strength_clip: loraStrength,
        },
      };
      graph["4"].inputs.clip = link(loraNodeId, 1);
      graph["5"].inputs.clip = link(loraNodeId, 1);
      graph["6"].inputs.model = link(loraNodeId);
    }
    return graph;
  }

  if (profile.workflow === "flux2-dev-edit") {
    const sampling = profile.sampling || {};
    return {
      "1": { class_type: "UNETLoader", inputs: { unet_name: profile.model, weight_dtype: "default" } },
      "2": { class_type: "CLIPLoader", inputs: { clip_name: profile.companions.textEncoder, type: profile.companions.clipType, device: "default" } },
      "3": { class_type: "VAELoader", inputs: { vae_name: profile.companions.vae } },
      "4": { class_type: "LoadImage", inputs: { image } },
      "5": { class_type: "GetImageSize", inputs: { image: link(4) } },
      "6": { class_type: "VAEEncode", inputs: { pixels: link(4), vae: link(3) } },
      "7": { class_type: "CLIPTextEncode", inputs: { text: positive, clip: link(2) } },
      "8": { class_type: "FluxGuidance", inputs: { conditioning: link(7), guidance: parameters.cfg } },
      "9": { class_type: "ReferenceLatent", inputs: { conditioning: link(8), latent: link(6) } },
      "10": { class_type: "BasicGuider", inputs: { model: link(1), conditioning: link(9) } },
      "11": { class_type: "RandomNoise", inputs: { noise_seed: parameters.seed } },
      "12": { class_type: "KSamplerSelect", inputs: { sampler_name: sampling.samplerName || "euler" } },
      "13": { class_type: "Flux2Scheduler", inputs: { steps: parameters.steps, width: link(5), height: link(5, 1) } },
      "14": { class_type: "EmptyFlux2LatentImage", inputs: { width: link(5), height: link(5, 1), batch_size: 1 } },
      "15": { class_type: "SamplerCustomAdvanced", inputs: { noise: link(11), guider: link(10), sampler: link(12), sigmas: link(13), latent_image: link(14) } },
      "16": { class_type: "VAEDecode", inputs: { samples: link(15), vae: link(3) } },
      "17": { class_type: "SaveImage", inputs: { images: link(16), filename_prefix: cleanPrefix } },
    };
  }

  throw makeError(`Image model ${String(model)} has no workflow implementation.`, 500, "MODEL_WORKFLOW_UNSUPPORTED");
}

function comboValues(nodeInfo, key) {
  const spec = nodeInfo?.input?.required?.[key];
  const choices = Array.isArray(spec) ? spec[0] : spec;
  if (Array.isArray(choices)) return choices.map(String);
  if (choices && typeof choices === "object" && Array.isArray(choices.value)) return choices.value.map(String);
  return [];
}

function resolveCharacterLoraLoaderName(objectInfo, profile, value) {
  const normalized = normalizeCharacterLoraName(value);
  if (!normalized) return "";
  const choices = comboValues(objectInfo?.[profile?.loraLoader], "lora_name");
  const loaderName = choices.find((choice) => {
    try {
      return normalizeCharacterLoraName(choice).toLowerCase() === normalized.toLowerCase();
    } catch {
      return false;
    }
  });
  if (loaderName) return preserveCharacterLoraLoaderName(loaderName);
  throw makeError(
    `Character LoRA ${normalized} is not available in ComfyUI ${profile?.loraLoader || "LoRA loader"}.`,
    409,
    "IMG2IMG_LORA_NOT_READY",
  );
}

function nodeAvailability(objectInfo, requiredNodes) {
  return Object.fromEntries(requiredNodes.map((name) => [name, Boolean(objectInfo?.[name])]));
}

function poseControlNetAvailability(objectInfo, poseControlNetName = "") {
  const configuredModel = normalizePoseControlNetName(poseControlNetName);
  const nodes = nodeAvailability(objectInfo, IMG2IMG_POSE_REQUIRED_NODES);
  const models = comboValues(objectInfo?.ControlNetLoader, "control_net_name");
  const model = Boolean(configuredModel && models.some((choice) => {
    try {
      return normalizePoseControlNetName(choice).toLowerCase() === configuredModel.toLowerCase();
    } catch {
      return false;
    }
  }));
  const available = Boolean(configuredModel && Object.values(nodes).every(Boolean) && model);
  let reason = "";
  if (!configuredModel) reason = "POSE_CONTROLNET_NOT_CONFIGURED";
  else if (!Object.values(nodes).every(Boolean)) reason = "POSE_REQUIRED_NODE_MISSING";
  else if (!model) reason = "POSE_CONTROLNET_MODEL_MISSING";
  return {
    available,
    configuredModel: configuredModel || null,
    model,
    nodes,
    ...(reason ? { reason } : {}),
  };
}

function resolvePoseControlNetLoaderName(objectInfo, value) {
  const normalized = normalizePoseControlNetName(value);
  if (!normalized) return "";
  const choices = comboValues(objectInfo?.ControlNetLoader, "control_net_name");
  const loaderName = choices.find((choice) => {
    try {
      return normalizePoseControlNetName(choice).toLowerCase() === normalized.toLowerCase();
    } catch {
      return false;
    }
  });
  if (loaderName) return String(loaderName).trim();
  throw makeError(
    `Pose ControlNet model ${normalized} is not available in ComfyUI.`,
    409,
    "IMG2IMG_POSE_CONTROLNET_NOT_FOUND",
  );
}

function checkpointModelAvailability(objectInfo, profile) {
  return comboValues(objectInfo?.CheckpointLoaderSimple, "ckpt_name").includes(profile.model);
}

function modelCompanionAvailability(objectInfo, profile) {
  if (profile.workflow === "checkpoint") return { model: checkpointModelAvailability(objectInfo, profile) };
  if (profile.workflow === "flux2-dev-edit") {
    return {
      model: comboValues(objectInfo?.UNETLoader, "unet_name").includes(profile.model),
      textEncoder: comboValues(objectInfo?.CLIPLoader, "clip_name").includes(profile.companions.textEncoder),
      clipType: comboValues(objectInfo?.CLIPLoader, "type").includes(profile.companions.clipType),
      vae: comboValues(objectInfo?.VAELoader, "vae_name").includes(profile.companions.vae),
    };
  }
  return { model: false };
}

function evaluateModelProfile(objectInfo, profile, { remote = false } = {}) {
  const nodes = nodeAvailability(objectInfo, profile.requiredNodes);
  const companionAvailability = modelCompanionAvailability(objectInfo, profile);
  const localOnly = Boolean(profile.localOnly);
  const loraLoader = profile.loraLoader || null;
  const runtimeSupported = !(remote && localOnly);
  const nodesReady = Object.values(nodes).every(Boolean);
  const companionsReady = Object.values(companionAvailability).every(Boolean);
  const available = runtimeSupported && nodesReady && companionsReady;
  let reason = "";
  if (!runtimeSupported) reason = "LOCAL_ONLY_MODEL";
  else if (!nodesReady) reason = "REQUIRED_NODE_MISSING";
  else if (!companionsReady) reason = "MODEL_OR_COMPANION_MISSING";
  return {
    available,
    localOnly,
    workflow: profile.workflow,
    loader: profile.loader,
    loraLoader,
    loraAvailable: Boolean(loraLoader && objectInfo?.[loraLoader]),
    nodes,
    companions: companionAvailability,
    ...(reason ? { reason } : {}),
  };
}

export function evaluateImg2ImgReadiness(objectInfo, {
  comfyUi = true,
  remote = false,
  poseControlNetName = process.env[IMG2IMG_POSE_CONTROLNET_ENV] || "",
} = {}) {
  const nodes = Object.fromEntries(IMG2IMG_REQUIRED_NODES.map((name) => [name, Boolean(objectInfo?.[name])]));
  const profiles = Object.fromEntries(IMG2IMG_MODELS.map((name) => [
    name,
    evaluateModelProfile(objectInfo, IMG2IMG_MODEL_PROFILES[name], { remote }),
  ]));
  const models = Object.fromEntries(IMG2IMG_MODELS.map((name) => [name, profiles[name].available]));
  return {
    ready: Boolean(comfyUi) && Object.values(models).some(Boolean),
    comfyUi: Boolean(comfyUi),
    remote: Boolean(remote),
    nodes,
    pose: poseControlNetAvailability(objectInfo, poseControlNetName),
    models,
    profiles,
  };
}

function assertPoseReadiness(profile, readiness) {
  if (profile?.workflow !== "checkpoint") {
    throw makeError(
      `Pose references are not supported by the ${profile?.workflow || "selected"} image workflow. Select an SDXL or SD1.5 checkpoint.`,
      400,
      "IMG2IMG_POSE_UNSUPPORTED",
    );
  }
  if (readiness?.pose?.available) return;
  const reason = readiness?.pose?.reason;
  const detail = reason === "POSE_CONTROLNET_NOT_CONFIGURED"
    ? `Pose reference selected but no ControlNet model is configured. Set ${IMG2IMG_POSE_CONTROLNET_ENV} to an installed OpenPose ControlNet filename.`
    : reason === "POSE_REQUIRED_NODE_MISSING"
      ? "Pose reference selected but ComfyUI is missing ControlNet/DWPose nodes. Install or enable the existing controlnet_aux nodes and restart ComfyUI."
      : "Pose reference selected but the configured ControlNet model is not available in ComfyUI/models/controlnet.";
  throw makeError(detail, 503, "IMG2IMG_POSE_NOT_READY");
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

function cancellationError() {
  return makeError("Image-to-image cancellation requested.", 499, "IMG2IMG_CANCELLED");
}

function assertNotCancelled(job) {
  if (job?.cancelRequested) throw cancellationError();
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(cancellationError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      reject(cancellationError());
    };
    function done() {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
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

function publicComfyProgress(target) {
  if (!target || typeof target !== "object") return {};
  return {
    ...(target.progressSource ? { progressSource: target.progressSource } : {}),
    ...(target.connectionState ? { connectionState: target.connectionState } : {}),
    ...(target.comfyNode ? { comfyNode: target.comfyNode } : {}),
    ...(target.comfyNodeId ? { comfyNodeId: target.comfyNodeId } : {}),
    ...(target.comfyNodeTitle ? { comfyNodeTitle: target.comfyNodeTitle } : {}),
    ...(Number.isFinite(target.nativeCurrent) ? { nativeCurrent: target.nativeCurrent } : {}),
    ...(Number.isFinite(target.nativeMaximum) ? { nativeMaximum: target.nativeMaximum } : {}),
    ...(Number.isFinite(target.comfyQueueRemaining) ? { comfyQueueRemaining: target.comfyQueueRemaining } : {}),
  };
}

function publicJob(job, gpuCoordinator = null, gpuWorkloadType = "img2img") {
  const gpu = publicGpuLease(gpuCoordinator, gpuWorkloadType, job);
  return {
    id: job.id,
    status: job.status,
    ...(gpu ? { gpu } : {}),
    progress: job.progress,
    stage: job.stage,
    ...publicComfyProgress(job),
    sourceName: job.sourceName,
    sourceRoot: job.sourceRoot,
    ...(job.poseName ? {
      poseName: job.poseName,
      poseRoot: job.poseRoot || "input",
      poseControlStrength: job.poseControlStrength,
      poseResolution: job.poseResolution,
    } : {}),
    prompt: job.prompt,
    negativePrompt: job.negativePrompt,
    model: job.model,
    ...(job.characterLoraName ? {
      characterLoraName: job.characterLoraName,
      characterLoraStrength: job.characterLoraStrength,
      ...(job.characterLoraId ? { characterLoraId: job.characterLoraId } : {}),
      ...(job.loraProvenance ? { loraProvenance: structuredClone(job.loraProvenance) } : {}),
    } : {}),
    denoise: job.denoise,
    steps: job.steps,
    cfg: job.cfg,
    seed: job.seed,
    ...(job.cancelReason ? { cancelReason: job.cancelReason } : {}),
    ...(Number.isInteger(job.attempt) ? { attempt: job.attempt } : {}),
    ...(job.retryOf ? { retryOf: job.retryOf } : {}),
    ...(job.recoverable ? { recoverable: true } : {}),
    ...(job.recovery ? { recovery: structuredClone(job.recovery) } : {}),
    batchCount: job.batchCount || 1,
    randomRanges: job.randomRanges ? Object.fromEntries(Object.entries(job.randomRanges).map(([name, range]) => [name, { ...range }])) : undefined,
    completedCount: Number(job.completedCount || 0),
    failedCount: Number(job.failedCount || 0),
    items: Array.isArray(job.items) ? job.items.map((item) => ({
      index: item.index,
      status: item.status,
      ...(item.promptId ? { promptId: item.promptId } : {}),
      ...(item.parameters ? { parameters: { ...item.parameters } } : { parameters: null }),
      output: item.output ? { ...item.output } : null,
      error: item.error || null,
      ...(item.stage ? { stage: item.stage } : {}),
      ...(Number.isFinite(item.progress) ? { progress: item.progress } : {}),
      ...publicComfyProgress(item),
      startedAt: item.startedAt ?? null,
      completedAt: item.completedAt ?? null,
    })) : [],
    ...(job.output ? { output: { ...job.output } } : {}),
    ...(job.error ? { error: job.error } : {}),
    createdAt: job.createdAt,
    ...(job.updatedAt ? { updatedAt: job.updatedAt } : {}),
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
  resolveCharacterLora,
  fetchImpl = globalThis.fetch,
  fsApi = fs,
  now = () => new Date(),
  idFactory = randomUUID,
  pollIntervalMs = 1000,
  maxPollMs = 30 * 60 * 1000,
  requestTimeoutMs = 30_000,
  clientId = "h3-img2img",
  webSocketImpl = globalThis.WebSocket,
  store = null,
  storeRoot,
  randomFn = null,
  gpuCoordinator = null,
  gpuWorkloadType = "img2img",
  gpuRuntime = remote ? "remote" : "local",
  poseControlNetName = process.env[IMG2IMG_POSE_CONTROLNET_ENV] || "",
  poseControlStrength = process.env[IMG2IMG_POSE_STRENGTH_ENV] || 1,
  poseResolution = process.env[IMG2IMG_POSE_RESOLUTION_ENV] || 512,
} = {}) {
  if (!inputRoot || !outputRoot) throw new Error("Image-to-image controller requires inputRoot and outputRoot.");
  poseControlNetName = normalizePoseControlNetName(poseControlNetName);
  poseControlStrength = normalizePoseControlStrength(poseControlStrength);
  poseResolution = normalizePoseResolution(poseResolution);
  const jobStore = store || createImg2ImgStore({ root: storeRoot });
  const jobs = new Map();
  const queue = [];
  const runtimes = new Map();
  const gpuAdmissions = new Map();
  let active = null;
  let storeLoaded = false;
  let storeLoading = null;
  const randomSource = typeof randomFn === "function" ? randomFn : () => randomInt(0, 1_000_000_000) / 1_000_000_000;
  const pendingPersistence = new Map();
  const toPublicJob = (job) => publicJob(job, gpuCoordinator, gpuWorkloadType);

  function ensureGpuAdmission(job) {
    if (!gpuCoordinator) return null;
    const existing = gpuAdmissions.get(String(job.id));
    if (existing) return existing;
    const admission = gpuCoordinator.request({
      requestId: `${gpuWorkloadType}:${job.id}`,
      jobId: `${gpuWorkloadType}:${job.id}`,
      workloadType: gpuWorkloadType,
      runtime: gpuRuntime,
      metadata: { model: job.model, batchCount: job.batchCount },
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
        let persisted;
        try {
          persisted = await jobStore.list();
        } catch {
          throw makeError("Unable to load image-to-image job history.", 503, "IMG2IMG_PERSISTENCE_FAILED");
        }
        const recoveredAt = isoNow(now());
        for (const persistedJob of persisted) {
          if (!persistedJob?.id) continue;
          const job = { ...persistedJob };
          const previousStatus = String(job.status || "queued");
          const items = Array.isArray(job.items) ? job.items.map((item) => ({ ...item })) : [];
          if (previousStatus === "running") {
            for (const item of items) {
              if (["running", "cancelling"].includes(item.status)) {
                item.status = "interrupted";
                item.stage = "Interrupted";
                item.error = item.error || "Image generation was interrupted by a bridge restart.";
                item.completedAt = null;
              }
            }
            job.status = "interrupted";
            job.stage = "Interrupted";
            job.recoverable = true;
            job.error = job.error || "Image-to-image was interrupted by a bridge restart; retry is available.";
            job.recovery = { reason: "bridge_restart", previousStatus, recoveredAt };
            job.cancelRequested = false;
            job.completedAt = null;
            job.items = items;
            job.completedCount = items.filter((item) => item.status === "completed").length;
            job.failedCount = items.filter((item) => item.status === "failed").length;
            job.updatedAt = recoveredAt;
            await jobStore.save(job);
          } else if (previousStatus === "cancelling" || job.cancelRequested) {
            for (const item of items) {
              if (!["completed", "failed"].includes(item.status)) {
                item.status = "cancelled";
                item.stage = "Cancelled";
                item.completedAt = item.completedAt || recoveredAt;
              }
            }
            job.status = "cancelled";
            job.stage = "Cancelled";
            job.cancelRequested = false;
            job.cancelReason = job.cancelReason || "Image-to-image cancellation was persisted before the bridge restarted.";
            job.recovery = { reason: "bridge_restart_cancelled", previousStatus, recoveredAt };
            job.completedAt = job.completedAt || recoveredAt;
            job.items = items;
            job.completedCount = items.filter((item) => item.status === "completed").length;
            job.failedCount = items.filter((item) => item.status === "failed").length;
            job.updatedAt = recoveredAt;
            await jobStore.save(job);
          } else if (previousStatus === "queued") {
            for (const item of items) {
              if (["running", "cancelling", "interrupted"].includes(item.status)) {
                item.status = "queued";
                item.stage = "Queued";
                item.error = null;
                item.progress = 0;
                item.startedAt = null;
                item.completedAt = null;
              }
            }
            job.recovery = { reason: "bridge_restart", previousStatus, recoveredAt };
            job.items = items;
            job.updatedAt = recoveredAt;
            await jobStore.save(job);
          }
          jobs.set(String(job.id), job);
          if (job.status === "queued") {
            ensureGpuAdmission(job);
            queue.push(job);
          }
        }
        storeLoaded = true;
        pump();
      }).finally(() => {
        storeLoading = null;
      });
    }
    await storeLoading;
  }

  async function persistJob(job, { required = false } = {}) {
    const key = String(job.id);
    const previous = pendingPersistence.get(key) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      job.updatedAt = isoNow(now());
      await jobStore.save(job);
    });
    const tracked = operation.finally(() => {
      if (pendingPersistence.get(key) === tracked) pendingPersistence.delete(key);
    }).catch(() => {});
    pendingPersistence.set(key, tracked);
    try {
      await operation;
      return true;
    } catch (error) {
      if (required) throw makeError("Unable to persist image-to-image job.", 503, "IMG2IMG_PERSISTENCE_FAILED");
      job.persistenceError = errorMessage(error, "Unable to persist image-to-image job.");
      console.error("[img2img] Unable to persist job:", job.persistenceError);
      return false;
    }
  }

  async function waitForPersistence(id) {
    const key = String(id);
    let observed = null;
    // A caller can hold the in-memory job object while the runner advances it
    // to a terminal state and schedules the corresponding save in the next
    // microtask.  Yield once and follow any successor promise so cleanup or a
    // GET cannot observe a completed job before its final record is durable.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const pending = pendingPersistence.get(key);
      if (pending && pending !== observed) {
        observed = pending;
        await pending;
        continue;
      }
      await Promise.resolve();
      const successor = pendingPersistence.get(key);
      if (!successor || successor === observed) return;
    }
  }

  async function request(endpoint, init = {}, timeoutMs = requestTimeoutMs, signal) {
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
      throw makeError(`ComfyUI request failed: ${errorMessage(error)}`, 503, "COMFY_UNAVAILABLE");
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    }
    return response;
  }

  async function requestJson(endpoint, init = {}, timeoutMs = requestTimeoutMs, signal) {
    const response = await request(endpoint, init, timeoutMs, signal);
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text || "{}"); } catch { payload = { raw: text }; }
    if (!response.ok) throw makeError(comfyRequestErrorMessage(payload, response.statusText), response.status === 404 ? 404 : 502, "COMFY_REQUEST_FAILED");
    return payload;
  }

  async function cancelComfyPrompt(promptId, { runtime = null, reason = "cleanup" } = {}) {
    const normalizedPromptId = String(promptId || "").trim();
    if (!normalizedPromptId) {
      console.warn(`[img2img] Cannot cancel Comfy prompt: missing prompt id (${reason}).`);
      return { attempted: false, cancelled: false };
    }
    if (runtime?.comfyCancel?.promptId === normalizedPromptId && runtime.comfyCancel.promise) {
      return runtime.comfyCancel.promise;
    }

    const promise = (async () => {
      try {
        const result = await requestJson(`/api/jobs/${encodeURIComponent(normalizedPromptId)}/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        if (result?.cancelled === false) {
          console.warn(`[img2img] Comfy prompt ${normalizedPromptId} was already terminal or not found during ${reason} cleanup.`);
          return { attempted: true, cancelled: false, terminal: true };
        }
        return { attempted: true, cancelled: true, fallback: false };
      } catch (primaryError) {
        console.warn(`[img2img] Targeted Comfy cancel failed for prompt ${normalizedPromptId} during ${reason}:`, errorMessage(primaryError));
        let fallbackSucceeded = false;
        try {
          await requestJson("/queue", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ delete: [normalizedPromptId] }),
          });
          fallbackSucceeded = true;
        } catch (queueError) {
          console.warn(`[img2img] Targeted Comfy queue deletion failed for prompt ${normalizedPromptId}:`, errorMessage(queueError));
        }
        try {
          await requestJson("/interrupt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt_id: normalizedPromptId }),
          });
          fallbackSucceeded = true;
        } catch (interruptError) {
          console.warn(`[img2img] Targeted Comfy interrupt failed for prompt ${normalizedPromptId}:`, errorMessage(interruptError));
        }
        return { attempted: true, cancelled: fallbackSucceeded, fallback: true };
      }
    })();
    if (runtime) runtime.comfyCancel = { promptId: normalizedPromptId, promise };
    return promise;
  }

  async function inspectReadiness() {
    const [stats, objectInfo] = await Promise.all([
      requestJson("/system_stats").then(() => true).catch(() => false),
      requestJson("/object_info").catch(() => null),
    ]);
    return {
      readiness: evaluateImg2ImgReadiness(objectInfo, { comfyUi: stats, remote, poseControlNetName }),
      objectInfo,
    };
  }

  async function checkReadiness() {
    return (await inspectReadiness()).readiness;
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

  async function copyOutputToLocalInput(job, source, suffix = "") {
    const extension = path.posix.extname(source.cleanName).toLowerCase();
    const loadName = `img2img_temp_${job.id}${suffix}${extension}`;
    const target = path.resolve(inputRoot, loadName);
    if (!inside(inputRoot, target)) throw makeError("Temporary image path is unsafe.", 500, "TEMP_PATH_INVALID");
    await fsApi.mkdir(inputRoot, { recursive: true });
    await fsApi.copyFile(source.path, target);
    return { loadName, path: target, created: true };
  }

  async function uploadRemoteInput(job, source, signal, suffix = "") {
    if (typeof FormData !== "function" || typeof Blob !== "function") throw makeError("Remote image upload is unavailable in this Node runtime.", 500, "UPLOAD_UNAVAILABLE");
    assertNotCancelled(job);
    const extension = path.posix.extname(source.cleanName).toLowerCase();
    const uploadName = `${job.id}${suffix}${extension}`;
    const form = new FormData();
    form.append("image", new Blob([await fsApi.readFile(source.path)], { type: extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg" }), uploadName);
    form.append("subfolder", "h3-studio-img2img");
    form.append("type", "input");
    form.append("overwrite", "true");
    const payload = await requestJson("/upload/image", { method: "POST", body: form }, 60_000, signal);
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

  async function waitForHistory(job, promptId, onProgress = null, signal, { getComfyError = null, runtime = null } = {}) {
    const started = Date.now();
    while (true) {
      assertNotCancelled(job);
      const comfyError = typeof getComfyError === "function" ? getComfyError() : null;
      if (comfyError) throw makeError(comfyError.message, 502, comfyError.code || "COMFY_EXECUTION_FAILED");
      const parsed = parseImg2ImgHistory(await requestJson(`/history/${encodeURIComponent(promptId)}`, {}, requestTimeoutMs, signal), promptId);
      assertNotCancelled(job);
      if (parsed.state === "failed") throw makeError(parsed.error, 502, "COMFY_EXECUTION_FAILED");
      if (parsed.state === "completed" && parsed.artifact) return parsed.artifact;
      if (parsed.state === "completed") throw makeError("ComfyUI completed without a SaveImage artifact.", 502, "OUTPUT_ARTIFACT_MISSING");
      const elapsed = Date.now() - started;
      if (maxPollMs > 0 && elapsed >= maxPollMs) {
        await cancelComfyPrompt(promptId, { runtime, reason: "history timeout" });
        throw makeError("Timed out waiting for the generated image.", 504, "COMFY_POLL_TIMEOUT");
      }
      const progress = Math.min(90, 28 + Math.floor(Math.min(62, elapsed / 3000)));
      if (typeof onProgress === "function") await onProgress(progress, "Generating image");
      else {
        job.progress = progress;
        job.stage = "Generating image";
      }
      await sleep(pollIntervalMs, signal);
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

  async function downloadRemoteArtifact(job, artifact, itemIndex = 0, signal) {
    assertNotCancelled(job);
    const query = new URLSearchParams({ filename: artifact.filename, subfolder: artifact.subfolder, type: artifact.type });
    const response = await request(`/view?${query.toString()}`, {}, 60_000, signal);
    if (!response.ok) throw makeError(`Unable to download generated image: HTTP ${response.status}.`, 502, "OUTPUT_DOWNLOAD_FAILED");
    const extension = path.posix.extname(artifact.filename).toLowerCase();
    const suffix = job.batchCount > 1 ? `-${String(itemIndex + 1).padStart(2, "0")}` : "";
    const localName = `img2img/${sanitizePrefix(path.posix.basename(job.sourceName, path.posix.extname(job.sourceName)))}-${job.id.slice(0, 8)}${suffix}${extension}`;
    const candidate = path.resolve(outputRoot, localName);
    if (!inside(outputRoot, candidate)) throw makeError("Downloaded image path is unsafe.", 500, "OUTPUT_PATH_INVALID");
    await fsApi.mkdir(path.dirname(candidate), { recursive: true });
    await fsApi.writeFile(candidate, Buffer.from(await response.arrayBuffer()));
    assertNotCancelled(job);
    return typeof toAsset === "function" ? toAsset("output", localName) : { root: "output", name: localName, kind: "image" };
  }

  function updateParentProgress(job, itemIndex, itemProgress, stage) {
    const count = Math.max(1, Number(job.batchCount || 1));
    const child = Math.max(0, Math.min(100, Number(itemProgress) || 0));
    job.progress = Math.min(100, Math.max(0, Math.round(((itemIndex + child / 100) / count) * 100)));
    job.stage = count > 1 ? `${stage} (${itemIndex + 1}/${count})` : stage;
  }

  function itemFilenamePrefix(job, itemIndex) {
    const suffix = job.batchCount > 1 ? `_${String(itemIndex + 1).padStart(2, "0")}` : "";
    return `img2img/h3_img2img_${job.id.slice(0, 8)}${suffix}`;
  }

  async function runItem(job, item, itemIndex, parameters, runtime) {
    let staged = null;
    let stagedPose = null;
    runtime.itemIndex = itemIndex;
    runtime.promptId = "";
    runtime.clientId = "";
    runtime.comfySession = null;
    runtime.comfyError = null;
    runtime.comfyCancel = null;
    resetComfyProgress(job, "idle");
    resetComfyProgress(item, "idle");
    item.parameters = { ...parameters };
    item.status = "running";
    item.progress = 4;
    item.stage = "Preparing GPU";
    item.startedAt = isoNow(now());
    item.completedAt = null;
    updateParentProgress(job, itemIndex, item.progress, item.stage);
    await persistJob(job);
    try {
      assertNotCancelled(job);
      const profile = assertModelForRuntime(job.model, { remote });
      if (typeof beforeRun === "function") await beforeRun(job);
      assertNotCancelled(job);
      const { readiness, objectInfo } = await inspectReadiness();
      assertNotCancelled(job);
      if (!readiness.ready || !readiness.models[job.model]) {
        const detail = readiness.profiles?.[job.model]?.reason === "REQUIRED_NODE_MISSING"
          ? `Required ComfyUI nodes for ${profile.workflow} are unavailable.`
          : `Selected image model ${job.model} or its companion files are unavailable.`;
        throw makeError(detail, 503, "IMG2IMG_NOT_READY");
      }
      if (job.characterLoraName && !readiness.profiles?.[job.model]?.loraAvailable) {
        throw makeError(
          `ComfyUI does not provide the ${profile.loraLoader} node required for a character LoRA with ${job.model}.`,
          503,
          "IMG2IMG_LORA_NOT_READY",
        );
      }
      if (job.poseName) assertPoseReadiness(profile, readiness);
      const poseControlNetLoaderName = job.poseName
        ? resolvePoseControlNetLoaderName(objectInfo, poseControlNetName)
        : "";
      const characterLoraLoaderName = job.characterLoraName
        ? resolveCharacterLoraLoaderName(objectInfo, profile, job.characterLoraName)
        : "";
      item.progress = 12;
      item.stage = "Preparing source image";
      updateParentProgress(job, itemIndex, item.progress, item.stage);
      await persistJob(job);
      const source = await resolveAsset(job.sourceRoot, job.sourceName);
      assertNotCancelled(job);
      if (remote) staged = await uploadRemoteInput(job, source, runtime.abortController?.signal);
      else if (job.sourceRoot === "output") staged = await copyOutputToLocalInput(job, source);
      else staged = { loadName: source.cleanName, created: false };
      if (job.poseName) {
        const poseSource = await resolveAsset(job.poseRoot || "input", job.poseName);
        if (remote) stagedPose = await uploadRemoteInput(job, poseSource, runtime.abortController?.signal, "-pose");
        else if ((job.poseRoot || "input") === "output") stagedPose = await copyOutputToLocalInput(job, poseSource, "-pose");
        else stagedPose = { loadName: poseSource.cleanName, created: false };
      }
      assertNotCancelled(job);
      const graph = buildImg2ImgPrompt({
        ...job,
        ...parameters,
        sourceName: staged.loadName,
        poseName: stagedPose?.loadName,
        poseControlNetName: poseControlNetLoaderName,
        poseControlStrength: job.poseControlStrength ?? poseControlStrength,
        poseResolution: job.poseResolution ?? poseResolution,
        characterLoraLoaderName,
        filenamePrefix: itemFilenamePrefix(job, itemIndex),
      });
      item.progress = 22;
      item.stage = "Submitting ComfyUI workflow";
      updateParentProgress(job, itemIndex, item.progress, item.stage);
      await persistJob(job);
      assertNotCancelled(job);
      const promptClientId = `${String(clientId || "h3-img2img")}-${randomUUID()}`;
      runtime.clientId = promptClientId;
      resetComfyProgress(job, "connecting");
      resetComfyProgress(item, "connecting");
      runtime.comfySession = createComfyProgressSession({
        comfyUrl,
        clientId: promptClientId,
        WebSocketImpl: webSocketImpl,
        onEvent: (event) => {
          applyComfyProgressEvent(job, item, graph, event, runtime);
          updateParentProgress(job, itemIndex, item.progress, item.stage);
          void persistJob(job);
        },
      });
      const submitted = await requestJson("/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: graph, client_id: promptClientId }),
      }, requestTimeoutMs, runtime.abortController?.signal);
      const promptId = submitted.prompt_id || submitted.promptId;
      if (!promptId) throw makeError("ComfyUI rejected the image workflow.", 502, "COMFY_PROMPT_REJECTED");
      runtime.promptId = String(promptId);
      runtime.comfySession?.setPromptId(runtime.promptId);
      item.promptId = runtime.promptId;
      if (!(item.connectionState === "connected" && item.comfyNode)) {
        item.progress = 28;
        item.stage = "Generating image";
        updateParentProgress(job, itemIndex, item.progress, item.stage);
      } else {
        updateParentProgress(job, itemIndex, item.progress, item.stage);
      }
      await persistJob(job);
      const artifact = await waitForHistory(job, runtime.promptId, async (progress, stage) => {
        const comfyStageActive = item.connectionState === "connected" && item.comfyNode;
        if (!comfyStageActive) {
          item.progress = progress;
          item.stage = stage;
        }
        const visibleProgress = comfyStageActive ? item.progress : progress;
        const visibleStage = comfyStageActive ? item.stage : stage;
        updateParentProgress(job, itemIndex, visibleProgress, visibleStage);
        await persistJob(job);
      }, runtime.abortController?.signal, { getComfyError: () => runtime.comfyError, runtime });
      runtime.promptId = "";
      assertNotCancelled(job);
      item.progress = 94;
      item.stage = remote ? "Downloading image" : "Registering image";
      updateParentProgress(job, itemIndex, item.progress, item.stage);
      item.output = remote
        ? await downloadRemoteArtifact(job, artifact, itemIndex, runtime.abortController?.signal)
        : await registerLocalArtifact(artifact);
      assertNotCancelled(job);
      item.progress = 100;
      item.status = "completed";
      item.stage = "Completed";
      item.completedAt = isoNow(now());
      updateParentProgress(job, itemIndex, item.progress, item.stage);
      await persistJob(job);
      return { success: true, cancelled: false };
    } catch (error) {
      if (job.cancelRequested || error?.code === "IMG2IMG_CANCELLED") {
        item.status = "cancelled";
        item.stage = "Cancelled";
        item.error = null;
        item.completedAt = isoNow(now());
        updateParentProgress(job, itemIndex, item.progress, item.stage);
        await persistJob(job);
        return { success: false, cancelled: true };
      }
      item.status = "failed";
      item.stage = "Failed";
      item.error = errorMessage(error);
      item.completedAt = isoNow(now());
      updateParentProgress(job, itemIndex, 100, item.stage);
      await persistJob(job);
      return { success: false, cancelled: false };
    } finally {
      runtime.comfySession?.close?.();
      runtime.comfySession = null;
      runtime.promptId = "";
      runtime.clientId = "";
      runtime.comfyError = null;
      await cleanupLocalTemp(staged);
      await cleanupLocalTemp(stagedPose);
    }
  }

  function hasItemParameters(item) {
    return item?.parameters
      && Object.keys(IMG2IMG_PARAMETER_RULES).every((key) => Number.isFinite(Number(item.parameters[key])));
  }

  function parametersForItem(job, item, itemIndex) {
    if (hasItemParameters(item)) return { ...item.parameters };
    const baseParameters = { denoise: job.denoise, steps: job.steps, cfg: job.cfg, seed: job.seed };
    if (job.batchCount === 1) return baseParameters;
    return itemIndex === 0
      ? { ...baseParameters, seed: sampleRandomRange("seed", IMG2IMG_SEED_RANGE, randomSource) }
      : randomizeParameters(job.randomRanges, randomSource);
  }

  function cancelRemainingItems(job) {
    const cancelledAt = isoNow(now());
    for (const item of job.items || []) {
      if (["completed", "failed", "cancelled"].includes(item.status)) continue;
      item.status = "cancelled";
      item.stage = "Cancelled";
      item.error = null;
      item.completedAt = item.completedAt || cancelledAt;
    }
    job.completedCount = (job.items || []).filter((item) => item.status === "completed").length;
    job.failedCount = (job.items || []).filter((item) => item.status === "failed").length;
    job.progress = Math.round((job.completedCount / Math.max(1, job.batchCount)) * 100);
  }

  async function runJob(job) {
    const abortController = typeof AbortController === "function" ? new AbortController() : null;
    const runtime = { abortController, promptId: "", itemIndex: -1 };
    const gpuAdmission = ensureGpuAdmission(job);
    let gpuLease = null;
    runtimes.set(job.id, runtime);
    try {
      if (gpuAdmission) {
        job.stage = "Waiting for GPU";
        await persistJob(job);
        gpuLease = await gpuAdmission.granted;
        if (!gpuLease) throw cancellationError();
        assertNotCancelled(job);
      }
      job.completedCount = (job.items || []).filter((item) => item.status === "completed" && item.output).length;
      job.failedCount = (job.items || []).filter((item) => item.status === "failed").length;
      if (!job.output) {
        const preservedOutput = (job.items || []).find((item) => item.status === "completed" && item.output)?.output;
        if (preservedOutput) job.output = { ...preservedOutput };
      }
      job.status = "running";
      job.startedAt = isoNow(now());
      job.error = undefined;
      job.recoverable = false;
      job.progress = Math.round((Number(job.completedCount || 0) / Math.max(1, job.batchCount)) * 100);
      job.stage = "Preparing batch";
      await persistJob(job);
      for (let itemIndex = 0; itemIndex < job.batchCount; itemIndex += 1) {
        const item = job.items[itemIndex];
        if (item.status === "completed" && item.output) continue;
        if (job.cancelRequested) {
          cancelRemainingItems(job);
          break;
        }
        const result = await runItem(job, item, itemIndex, parametersForItem(job, item, itemIndex), runtime);
        if (result.success) {
          job.completedCount += 1;
          if (!job.output && item.output) job.output = { ...item.output };
        } else if (!result.cancelled) {
          job.failedCount += 1;
        }
        await persistJob(job);
        if (result.cancelled || job.cancelRequested) {
          cancelRemainingItems(job);
          break;
        }
      }
      if (job.cancelRequested) {
        cancelRemainingItems(job);
        job.status = "cancelled";
        job.stage = "Cancelled";
        job.cancelReason = job.cancelReason || "Cancelled by user.";
        job.cancelledAt = isoNow(now());
      } else if (job.completedCount === job.batchCount) job.status = "completed";
      else if (job.failedCount === job.batchCount) job.status = "failed";
      else job.status = "partial";
      if (job.status === "failed" || job.status === "partial") {
        const failures = job.items.filter((item) => item.status === "failed");
        job.error = failures.length === 1
          ? failures[0].error
          : `${failures.length} of ${job.batchCount} image generations failed.`;
      }
      job.progress = job.status === "cancelled"
        ? Math.round((job.completedCount / Math.max(1, job.batchCount)) * 100)
        : 100;
      job.stage = job.status === "completed" ? "Completed" : job.status === "partial" ? "Partial" : job.status === "cancelled" ? "Cancelled" : "Failed";
      job.completedAt = isoNow(now());
      job.cancelRequested = false;
      await persistJob(job);
    } catch (error) {
      if (job.cancelRequested || error?.code === "IMG2IMG_CANCELLED" || error?.code === "GPU_LEASE_CANCELLED") {
        cancelRemainingItems(job);
        job.status = "cancelled";
        job.stage = "Cancelled";
        job.cancelReason = job.cancelReason || "Cancelled by user.";
        job.cancelledAt = isoNow(now());
        job.cancelRequested = false;
      } else {
        job.status = "failed";
        job.stage = "Failed";
        job.error = errorMessage(error);
      }
      job.completedAt = isoNow(now());
      await persistJob(job);
    } finally {
      gpuLease?.release?.();
      gpuAdmissions.delete(String(job.id));
      runtimes.delete(job.id);
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

  async function enqueue(input = {}, internal = {}) {
    await ensureStoreLoaded();
    const model = String(input.model || IMG2IMG_MODELS[0]);
    const profile = assertModelForRuntime(model, { remote });
    const requestedLora = String(input.characterLoraId || input.characterLoraName || "").trim();
    const resolvedLora = requestedLora && typeof resolveCharacterLora === "function"
      ? await resolveCharacterLora(requestedLora, { model, profile })
      : null;
    const characterLoraName = normalizeCharacterLoraName(resolvedLora?.name || requestedLora);
    const characterLoraStrength = characterLoraName
      ? normalizeCharacterLoraStrength(input.characterLoraStrength)
      : null;
    const sourceRoot = String(input.sourceRoot || "input");
    const sourceName = normalizeImageAssetName(input.sourceName);
    await resolveAsset(sourceRoot, sourceName);
    const hasPoseName = typeof input.poseName === "string"
      ? input.poseName.trim() !== ""
      : input.poseName !== undefined && input.poseName !== null;
    const poseName = hasPoseName
      ? normalizePoseImageName(typeof input.poseName === "string" ? input.poseName.trim() : input.poseName)
      : "";
    const poseRoot = poseName ? normalizePoseRoot(input.poseRoot) : "";
    const jobPoseControlStrength = poseName
      ? normalizePoseControlStrength(input.poseControlStrength, poseControlStrength)
      : null;
    const jobPoseResolution = poseName
      ? normalizePoseResolution(input.poseResolution, poseResolution)
      : null;
    if (poseName) await resolveAsset(poseRoot, poseName);
    if (poseName) {
      const readiness = await checkReadiness();
      assertPoseReadiness(profile, readiness);
    }
    const prompt = String(input.prompt || "").trim();
    const ollamaPromptReceipt = typeof input.ollamaPromptReceipt === "string"
      ? input.ollamaPromptReceipt.trim()
      : "";
    const batchCount = normalizeBatchCount(input.batchCount);
    const baseSeed = input.seed === undefined ? Math.floor(randomSource() * 2_147_483_647) : input.seed;
    const parameters = boundedModelParameters(profile, {
      denoise: input.denoise,
      steps: input.steps,
      cfg: input.cfg,
      seed: baseSeed,
    });
    const randomRanges = normalizeRandomRanges(input.randomRanges, parameters);
    const preservedItems = Array.isArray(internal.items) ? internal.items : null;
    const job = {
      id: String(idFactory()),
      status: "queued",
      progress: 0,
      stage: "Queued",
      sourceName,
      sourceRoot,
      ...(poseName ? {
        poseName,
        poseRoot,
        poseControlStrength: jobPoseControlStrength,
        poseResolution: jobPoseResolution,
      } : {}),
      prompt,
      negativePrompt: String(input.negativePrompt || "").trim(),
      model,
      ...(ollamaPromptReceipt ? { ollamaPromptReceipt } : {}),
      ...(characterLoraName ? {
        characterLoraName,
        characterLoraStrength,
        ...(resolvedLora?.registry?.id ? { characterLoraId: resolvedLora.registry.id } : {}),
        loraProvenance: internal.loraProvenance || (resolvedLora?.registry ? {
          registryId: resolvedLora.registry.id,
          displayName: resolvedLora.registry.displayName,
          relativePath: resolvedLora.registry.relativePath,
          family: resolvedLora.registry.family,
          baseProfile: resolvedLora.registry.baseProfile,
          sha256: resolvedLora.registry.sha256,
          triggerWords: resolvedLora.registry.triggerWords,
        } : { relativePath: characterLoraName, legacy: true }),
      } : {}),
      denoise: parameters.denoise,
      steps: parameters.steps,
      cfg: parameters.cfg,
      seed: parameters.seed,
      batchCount,
      randomRanges,
      completedCount: 0,
      failedCount: 0,
      items: Array.from({ length: batchCount }, (_, index) => {
        const preserved = preservedItems?.[index];
        if (preserved?.status === "completed" && preserved.output) {
          return {
            index,
            status: "completed",
            parameters: preserved.parameters ? { ...preserved.parameters } : null,
            output: { ...preserved.output },
            error: null,
            progress: 100,
            stage: "Completed",
            startedAt: preserved.startedAt || null,
            completedAt: preserved.completedAt || null,
          };
        }
        return {
          index,
          status: "queued",
          parameters: null,
          output: null,
          error: null,
          progress: 0,
          stage: "Queued",
          startedAt: null,
          completedAt: null,
        };
      }),
      createdAt: isoNow(now()),
      updatedAt: isoNow(now()),
      startedAt: null,
      completedAt: null,
      cancelRequested: false,
      cancelReason: "",
      cancelledAt: null,
      recoverable: false,
      recovery: null,
      attempt: Number.isInteger(internal.attempt) ? internal.attempt : 1,
      ...(internal.retryOf ? { retryOf: internal.retryOf } : {}),
      provenance: internal.provenance || {
        request: {
          sourceName,
          sourceRoot,
          ...(poseName ? {
            poseName,
            poseRoot,
            poseControlStrength: jobPoseControlStrength,
            poseResolution: jobPoseResolution,
          } : {}),
          prompt,
          negativePrompt: String(input.negativePrompt || "").trim(),
          model,
          ...(ollamaPromptReceipt ? { ollamaPromptReceipt } : {}),
          characterLoraName: characterLoraName || null,
          characterLoraStrength,
          denoise: parameters.denoise,
          steps: parameters.steps,
          cfg: parameters.cfg,
          seed: parameters.seed,
          batchCount,
          randomRanges,
        },
        attempt: 1,
      },
    };
    job.completedCount = job.items.filter((item) => item.status === "completed").length;
    job.output = job.items.find((item) => item.output)?.output || undefined;
    // Validate the full graph contract before admitting the job.
    buildImg2ImgPrompt({
      ...job,
      poseControlNetName,
      poseControlStrength: job.poseControlStrength ?? poseControlStrength,
      poseResolution: job.poseResolution ?? poseResolution,
    });
    await persistJob(job, { required: true });
    jobs.set(job.id, job);
    ensureGpuAdmission(job);
    queue.push(job);
    pump();
    return toPublicJob(job);
  }

  async function cancelJob(id, reason = "Cancelled by user.") {
    await ensureStoreLoaded();
    const key = String(id);
    const job = jobs.get(key) || await jobStore.read(key);
    await waitForPersistence(key);
    if (!job) throw makeError("Image-to-image job not found.", 404, "IMG2IMG_JOB_NOT_FOUND");
    if (["completed", "failed", "partial", "cancelled", "interrupted"].includes(job.status)) {
      throw makeError(`Image-to-image job cannot be cancelled from ${job.status}.`, 409, "IMG2IMG_CANCEL_NOT_ALLOWED");
    }
    if (job.status === "cancelling") return toPublicJob(job);
    job.cancelRequested = true;
    job.cancelReason = errorMessage(reason, "Cancelled by user.");
    const runtime = runtimes.get(key);
    const queued = job.status === "queued" && active !== job;
    if (queued) {
      cancelGpuAdmission(key, job.cancelReason);
      const index = queue.findIndex((queuedJob) => queuedJob.id === key);
      if (index >= 0) queue.splice(index, 1);
      for (const item of job.items || []) {
        if (!["completed", "failed"].includes(item.status)) {
          item.status = "cancelled";
          item.stage = "Cancelled";
          item.completedAt = isoNow(now());
        }
      }
      job.status = "cancelled";
      job.stage = "Cancelled";
      job.cancelRequested = false;
      job.cancelledAt = isoNow(now());
      job.completedAt = job.completedAt || job.cancelledAt;
      await persistJob(job, { required: true });
      return toPublicJob(job);
    }
    job.status = "cancelling";
    job.stage = "Cancelling image generation";
    await persistJob(job, { required: true });
    cancelGpuAdmission(key, job.cancelReason);
    if (runtime) await cancelComfyPrompt(runtime.promptId, { runtime, reason: "manual cancellation" });
    runtime?.abortController?.abort();
    return toPublicJob(job);
  }

  async function retryJob(id) {
    await ensureStoreLoaded();
    const source = jobs.get(String(id)) || await jobStore.read(String(id));
    if (!source) throw makeError("Image-to-image job not found.", 404, "IMG2IMG_JOB_NOT_FOUND");
    if (!["failed", "partial", "cancelled", "interrupted"].includes(source.status)) {
      throw makeError("Only failed, partial, cancelled, or interrupted image-to-image jobs can be retried.", 409, "IMG2IMG_JOB_NOT_RETRYABLE");
    }
    const nextAttempt = Math.max(1, Number(source.attempt || source.provenance?.attempt || 1) + 1);
    const retryItems = Array.isArray(source.items) ? source.items : [];
    const body = {
      sourceName: source.sourceName,
      sourceRoot: source.sourceRoot,
      ...(source.poseName ? { poseName: source.poseName, poseRoot: source.poseRoot || "input" } : {}),
      prompt: source.prompt,
      negativePrompt: source.negativePrompt,
      model: source.model,
      ...(source.ollamaPromptReceipt ? { ollamaPromptReceipt: source.ollamaPromptReceipt } : {}),
      characterLoraId: source.characterLoraId,
      characterLoraName: source.characterLoraName,
      characterLoraStrength: source.characterLoraStrength,
      denoise: source.denoise,
      steps: source.steps,
      cfg: source.cfg,
      seed: source.seed,
      batchCount: source.batchCount,
      randomRanges: source.randomRanges,
    };
    return await enqueue(body, {
      attempt: nextAttempt,
      retryOf: source.id,
      items: retryItems,
      loraProvenance: source.loraProvenance ? structuredClone(source.loraProvenance) : undefined,
      provenance: {
        request: structuredClone(source.provenance?.request || body),
        attempt: nextAttempt,
        retryOf: source.id,
        originalId: source.provenance?.originalId || source.id,
        skippedCompletedItems: retryItems.filter((item) => item.status === "completed" && item.output).map((item) => item.index),
      },
    });
  }

  async function handleRoute(req, res, { pathname = new URL(req.url || "/", "http://localhost").pathname, readJson, sendJson, sendError } = {}) {
    const respond = sendJson || ((response, status, payload) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(payload));
    });
    const fail = sendError || ((response, status, message, code) => respond(response, status, { error: message, ...(code ? { code } : {}) }));
    if (req.method === "GET" && pathname === "/api/img2img/health") {
      respond(res, 200, await checkReadiness());
      return true;
    }
    if (req.method === "POST" && pathname === "/api/img2img") {
      try {
        const body = await readJson(req);
        const requestedModel = String(body?.model || IMG2IMG_MODELS[0]);
        assertModelForRuntime(requestedModel, { remote });
        const requestedLoraName = normalizeCharacterLoraName(body?.characterLoraId || body?.characterLoraName);
        if (requestedLoraName) normalizeCharacterLoraStrength(body?.characterLoraStrength);
        const readiness = await checkReadiness();
        if (!readiness.ready || !readiness.models[requestedModel]) {
          respond(res, 503, {
            error: !readiness.ready
              ? "Image-to-image is not ready."
              : `Image model ${requestedModel} is not ready on this runtime.`,
            health: readiness,
          });
          return true;
        }
        if (requestedLoraName && !readiness.profiles?.[requestedModel]?.loraAvailable) {
          respond(res, 503, {
            error: `ComfyUI does not provide the ${readiness.profiles?.[requestedModel]?.loraLoader || "LoRA"} node required for a character LoRA with ${requestedModel}.`,
            code: "IMG2IMG_LORA_NOT_READY",
            health: readiness,
          });
          return true;
        }
        const requestedPoseName = typeof body?.poseName === "string" ? body.poseName.trim() : "";
        if (requestedPoseName) {
          const requestedProfile = modelProfile(requestedModel);
          if (requestedProfile?.workflow !== "checkpoint" || !readiness.pose?.available) {
            try {
              assertPoseReadiness(requestedProfile, readiness);
            } catch (error) {
              respond(res, Number.isInteger(error?.status) ? error.status : 503, {
                error: errorMessage(error),
                code: error?.code || "IMG2IMG_POSE_NOT_READY",
                health: readiness,
              });
              return true;
            }
          }
        }
        respond(res, 202, { job: await enqueue(body) });
      } catch (error) {
        fail(res, Number.isInteger(error?.status) ? error.status : 400, errorMessage(error), error?.code);
      }
      return true;
    }
    const actionMatch = pathname.match(/^\/api\/img2img\/jobs\/([^/]+)\/(cancel|retry)$/);
    if (req.method === "POST" && actionMatch) {
      const id = decodeURIComponent(actionMatch[1]);
      try {
        const body = typeof readJson === "function" ? await readJson(req) : {};
        const job = actionMatch[2] === "cancel"
          ? await cancelJob(id, body?.reason || body?.cancelReason || "Cancelled by user.")
          : await retryJob(id);
        respond(res, actionMatch[2] === "retry" ? 201 : 200, { job });
      } catch (error) {
        fail(res, Number.isInteger(error?.status) ? error.status : 400, errorMessage(error), error?.code);
      }
      return true;
    }
    if (req.method === "GET" && pathname === "/api/img2img/jobs") {
      try {
        await ensureStoreLoaded();
        await Promise.all([...pendingPersistence.values()]);
        const records = await jobStore.list();
        const merged = new Map(records.map((job) => [String(job.id), job]));
        for (const job of jobs.values()) merged.set(String(job.id), job);
        const listed = [...merged.values()]
          .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))
          .map(toPublicJob);
        const limit = jobListLimit(req.url, { fallback: listed.length, max: 100 });
        const summarize = wantsJobSummary(req.url);
        respond(res, 200, { jobs: listed.slice(0, limit).map((job) => summarize ? summarizeJobRecord(job) : job) });
      } catch {
        fail(res, 503, "Unable to load image-to-image job history.", "IMG2IMG_PERSISTENCE_FAILED");
      }
      return true;
    }
    if (req.method === "GET" && pathname.startsWith("/api/img2img/jobs/")) {
      const id = decodeURIComponent(pathname.slice("/api/img2img/jobs/".length));
      try {
        await ensureStoreLoaded();
        const job = jobs.get(id) || await jobStore.read(id);
        await waitForPersistence(id);
        if (job && !jobs.has(id)) jobs.set(id, job);
        if (!job) fail(res, 404, "Image-to-image job not found.");
        else respond(res, 200, { job: toPublicJob(job) });
      } catch {
        fail(res, 503, "Unable to load image-to-image job history.", "IMG2IMG_PERSISTENCE_FAILED");
      }
      return true;
    }
    return false;
  }

  return {
    checkReadiness,
    enqueue,
    getJob: async (id) => {
      await ensureStoreLoaded();
      const key = String(id);
      const job = jobs.get(key) || await jobStore.read(key);
      await waitForPersistence(key);
      if (job && !jobs.has(key)) jobs.set(key, job);
      return job ? toPublicJob(job) : null;
    },
    getJobs: () => [...jobs.values()].map(toPublicJob),
    listJobs: async () => {
      await ensureStoreLoaded();
      await Promise.all([...pendingPersistence.values()]);
      const records = await jobStore.list();
      const merged = new Map(records.map((job) => [String(job.id), job]));
      for (const job of jobs.values()) merged.set(String(job.id), job);
      return [...merged.values()].sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""))).map(toPublicJob);
    },
    handleRoute,
    cancel: cancelJob,
    retry: retryJob,
    active: () => active ? toPublicJob(active) : null,
  };
}
