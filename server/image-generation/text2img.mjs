import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const FLUX_KLEIN_MODEL = "flux-2-klein-4b.safetensors";
export const FLUX_KLEIN_TEXT_ENCODER = "qwen_3_4b.safetensors";
export const FLUX2_VAE = "flux2-vae.safetensors";
export const FLUX_KLEIN_CLIP_TYPE = "flux2";
export const FLUX_KLEIN_9B_MODEL = "flux-2-klein-9b.safetensors";
export const FLUX_KLEIN_9B_TEXT_ENCODER = "qwen_3_8b_fp8mixed.safetensors";
export const FLUX_KLEIN_9B_UNCENSORED_TEXT_ENCODER = "flux2-klein-9b-uncensored/model.safetensors";
export const FLUX_KLEIN_9B_VAE = "full_encoder_small_decoder.safetensors";
export const FLUX2_DEV_MODEL = "flux2_dev_fp8mixed.safetensors";
export const FLUX2_DEV_TEXT_ENCODER = "mistral_3_small_flux2_bf16.safetensors";
export const JUGGERNAUT_XL_MODEL = "Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors";
export const SDXL_ADULT_LORA = "sexy.safetensors";
export const DEFAULT_TEXT2IMG_MODEL_ID = "flux2-klein-4b";
export const DEFAULT_TEXT2IMG_ENCODER_ID = "official";

export const TEXT2IMG_MODEL_PROFILES = Object.freeze({
  [DEFAULT_TEXT2IMG_MODEL_ID]: Object.freeze({
    id: DEFAULT_TEXT2IMG_MODEL_ID,
    label: "FLUX.2 Klein 4B · Distilled BF16",
    model: FLUX_KLEIN_MODEL,
    textEncoder: FLUX_KLEIN_TEXT_ENCODER,
    vae: FLUX2_VAE,
    clipType: FLUX_KLEIN_CLIP_TYPE,
    precision: "BF16",
    license: "Apache 2.0",
    commercial: true,
    architecture: "flux2",
    defaultSteps: 4,
    maxSteps: 8,
    cfg: 1,
    sampler: "Euler",
  }),
  "flux2-klein-9b": Object.freeze({
    id: "flux2-klein-9b",
    label: "FLUX.2 Klein 9B · Distilled BF16",
    model: FLUX_KLEIN_9B_MODEL,
    textEncoder: FLUX_KLEIN_9B_TEXT_ENCODER,
    vae: FLUX_KLEIN_9B_VAE,
    clipType: FLUX_KLEIN_CLIP_TYPE,
    precision: "BF16 + FP8 encoder",
    license: "FLUX Non-Commercial License",
    commercial: false,
    architecture: "flux2",
    defaultSteps: 4,
    maxSteps: 8,
    cfg: 1,
    sampler: "Euler",
  }),
  "flux2-dev": Object.freeze({
    id: "flux2-dev",
    label: "FLUX.2 Dev · FP8 Mixed",
    model: FLUX2_DEV_MODEL,
    textEncoder: FLUX2_DEV_TEXT_ENCODER,
    vae: FLUX2_VAE,
    clipType: FLUX_KLEIN_CLIP_TYPE,
    precision: "FP8 Mixed + BF16 encoder",
    license: "FLUX Non-Commercial License",
    commercial: false,
    architecture: "flux2",
    defaultSteps: 20,
    maxSteps: 50,
    cfg: 4,
    sampler: "Euler",
  }),
  "juggernaut-xl-v9": Object.freeze({
    id: "juggernaut-xl-v9",
    label: "Juggernaut XL v9 · SDXL",
    model: JUGGERNAUT_XL_MODEL,
    precision: "FP16",
    license: "CreativeML Open RAIL-M",
    commercial: false,
    architecture: "sdxl",
    defaultSteps: 35,
    maxSteps: 50,
    cfg: 5,
    sampler: "DPM++ 2M Karras",
    adultLora: Object.freeze({
      id: "sexy-slider",
      label: "SDXL Sexy Slider · MIT",
      file: SDXL_ADULT_LORA,
      strengthModel: 2,
      strengthClip: 2,
      license: "MIT",
    }),
  }),
});

export const TEXT2IMG_REQUIRED_NODES = Object.freeze([
  "UNETLoader",
  "CLIPLoader",
  "VAELoader",
  "CLIPTextEncode",
  "ConditioningZeroOut",
  "CFGGuider",
  "BasicGuider",
  "FluxGuidance",
  "RandomNoise",
  "KSamplerSelect",
  "Flux2Scheduler",
  "EmptyFlux2LatentImage",
  "SamplerCustomAdvanced",
  "VAEDecode",
  "SaveImage",
  "CheckpointLoaderSimple",
  "LoraLoader",
  "EmptyLatentImage",
  "KSampler",
]);

const FLUX_REQUIRED_NODES = Object.freeze([
  "UNETLoader", "CLIPLoader", "VAELoader", "CLIPTextEncode", "ConditioningZeroOut", "CFGGuider",
  "RandomNoise", "KSamplerSelect", "Flux2Scheduler", "EmptyFlux2LatentImage", "SamplerCustomAdvanced", "VAEDecode", "SaveImage",
]);
const FLUX_DEV_REQUIRED_NODES = Object.freeze([
  "UNETLoader", "CLIPLoader", "VAELoader", "CLIPTextEncode", "FluxGuidance", "BasicGuider",
  "RandomNoise", "KSamplerSelect", "Flux2Scheduler", "EmptyFlux2LatentImage", "SamplerCustomAdvanced", "VAEDecode", "SaveImage",
]);
const SDXL_REQUIRED_NODES = Object.freeze(["CheckpointLoaderSimple", "LoraLoader", "CLIPTextEncode", "EmptyLatentImage", "KSampler", "VAEDecode", "SaveImage"]);

const TERMINAL_STAGES = new Set(["completed", "success", "succeeded", "finished", "done"]);
const ERROR_STAGES = new Set(["error", "failed", "failure", "cancelled", "canceled"]);
const TEXT2IMG_MAX_PROMPT_LENGTH = 4_000;
const TEXT2IMG_MAX_DESCRIPTION_LENGTH = 2_000;

export const NATURE_CAMERA_PROFILE = "nature-camera-v1";
export const NATURE_CAMERA_PHOTOGRAPHY_INSTRUCTION = [
  "You turn a short user description into one production-ready photographic prompt for a local image-generation model.",
  "Preserve the requested subject, action, location, mood, medium, aspect-ratio intent, and any explicit camera or lens choice. Match the user's language and do not invent a narrower nationality, age, or appearance than supplied.",
  "When people appear, describe them as adults and make the frame feel captured by a real person at a particular moment. Default to an everyday handheld smartphone candid when the user gives no camera direction; use a coherent 35–50mm documentary view when the scene calls for a cleaner still-camera photograph. Use short telephoto only when the physical shooting distance makes sense, and polished editorial lighting only when explicitly requested.",
  "Build a physically coherent capture story with one plausible viewpoint, one lens behavior, and available window, street, overcast, or practical light. Prefer an in-between action, restrained expression or off-camera gaze, mildly imperfect crop or unequal negative space, and environmental context over a centered commercial pose.",
  "For human realism, include restrained pores, fine facial hair, mild tonal variation, flyaway hair, small natural asymmetries, realistic eye proportions and eyelids, and anatomically correct hands, fingers, joints, overlaps, grip, and contact with props. Keep attractive people attractive without plastic skin, waxy gloss, beauty-filter smoothness, enlarged eyes, perfect bilateral symmetry, or doll-like faces.",
  "Use at most two subtle and compatible capture artifacts such as slight hand motion, modest sensor noise, gentle focus falloff, restrained phone sharpening, or minor resolution loss. Do not stack defects or mix contradictory optics, camera distances, or lighting setups.",
].join(" ");
export const NATURE_CAMERA_SYSTEM_PROMPT = [
  NATURE_CAMERA_PHOTOGRAPHY_INSTRUCTION,
  "Return exactly one JSON object with one key named prompt. The prompt must be a single non-empty string, with no Markdown, headings, explanations, negative-prompt list, or extra keys.",
].join(" ");
export const NATURE_CAMERA_ADULT_SYSTEM_PROMPT = `${NATURE_CAMERA_SYSTEM_PROMPT} Preserve consensual adult sensual or explicit intent when the user requests it, and include the literal trigger token sexy exactly once. Every depicted person must be clearly described as an adult; never introduce minors, coercion, incest, or non-consensual situations.`;

function isoNow(now = new Date()) {
  return new Date(now).toISOString();
}

function makeError(message, status = 500, code = "TEXT2IMG_ERROR") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function errorMessage(error, fallback = "Text-to-image generation failed.") {
  return String(error?.message || error || fallback).replace(/[\r\n]+/g, " ").slice(0, 1_200);
}

function link(node, output = 0) {
  return [String(node), output];
}

function inside(root, candidate) {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  return absoluteCandidate === absoluteRoot || absoluteCandidate.startsWith(absoluteRoot + path.sep);
}

function boundedInteger(value, name, fallback, min, max, step = 1) {
  const resolved = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max || resolved % step !== 0) {
    throw makeError(`${name} must be an integer between ${min} and ${max}${step > 1 ? ` in steps of ${step}` : ""}.`, 400, `TEXT2IMG_${name.toUpperCase()}_INVALID`);
  }
  return resolved;
}

function resolveText2ImgModel(modelId = DEFAULT_TEXT2IMG_MODEL_ID) {
  const id = String(modelId || DEFAULT_TEXT2IMG_MODEL_ID).trim();
  const profile = TEXT2IMG_MODEL_PROFILES[id];
  if (!profile) throw makeError(`Unsupported text-to-image model: ${id}.`, 400, "TEXT2IMG_MODEL_INVALID");
  return profile;
}

function encoderProfilesFor(profile) {
  if (profile.architecture !== "flux2") return Object.freeze({});
  const official = Object.freeze({
    id: DEFAULT_TEXT2IMG_ENCODER_ID,
    label: profile.id === "flux2-dev"
      ? "Mistral 3 Small · BF16"
      : profile.id === "flux2-klein-9b"
        ? "Official Qwen 3 8B · FP8 Mixed"
        : "Official Qwen 3 4B · BF16",
    textEncoder: profile.textEncoder,
    precision: profile.id === "flux2-klein-9b" ? "FP8 Mixed" : "BF16",
    thirdParty: false,
    license: profile.license,
  });
  if (profile.id !== "flux2-klein-9b") return Object.freeze({ [official.id]: official });
  return Object.freeze({
    [official.id]: official,
    uncensored: Object.freeze({
      id: "uncensored",
      label: "Uncensored Qwen 3 8B · BF16",
      textEncoder: FLUX_KLEIN_9B_UNCENSORED_TEXT_ENCODER,
      precision: "BF16",
      thirdParty: true,
      license: "FLUX Non-Commercial License v2.1",
    }),
  });
}

function resolveText2ImgEncoder(profile, encoderId = DEFAULT_TEXT2IMG_ENCODER_ID) {
  const id = String(encoderId || DEFAULT_TEXT2IMG_ENCODER_ID).trim();
  const encoder = encoderProfilesFor(profile)[id];
  if (!encoder) throw makeError(`Unsupported text encoder ${id} for ${profile.id}.`, 400, "TEXT2IMG_ENCODER_INVALID");
  return encoder;
}

export function normalizeText2ImgInput(input = {}) {
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) throw makeError("Prompt is required.", 400, "TEXT2IMG_PROMPT_REQUIRED");
  if (prompt.length > TEXT2IMG_MAX_PROMPT_LENGTH) {
    throw makeError(`Prompt must not exceed ${TEXT2IMG_MAX_PROMPT_LENGTH} characters.`, 400, "TEXT2IMG_PROMPT_TOO_LONG");
  }
  const profile = resolveText2ImgModel(input.modelId);
  const encoder = profile.architecture === "flux2" ? resolveText2ImgEncoder(profile, input.encoderId) : null;
  const adultMode = input.adultMode === true;
  if (adultMode && !profile.adultLora) throw makeError(`Adult LoRA is not supported by ${profile.id}.`, 400, "TEXT2IMG_ADULT_MODE_INVALID");
  return Object.freeze({
    prompt,
    modelId: profile.id,
    encoderId: encoder?.id || DEFAULT_TEXT2IMG_ENCODER_ID,
    adultMode,
    width: boundedInteger(input.width, "width", 1024, 512, 1536, 16),
    height: boundedInteger(input.height, "height", 1024, 512, 1536, 16),
    steps: boundedInteger(input.steps, "steps", profile.defaultSteps, 1, profile.maxSteps),
    seed: boundedInteger(input.seed, "seed", 12345, 0, 2_147_483_647),
  });
}

export function normalizeText2ImgDescription(input = {}) {
  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (!description) throw makeError("Image description is required.", 400, "TEXT2IMG_DESCRIPTION_REQUIRED");
  if (description.length > TEXT2IMG_MAX_DESCRIPTION_LENGTH) {
    throw makeError(`Image description must not exceed ${TEXT2IMG_MAX_DESCRIPTION_LENGTH} characters.`, 400, "TEXT2IMG_DESCRIPTION_TOO_LONG");
  }
  return description;
}

function cleanPromptResponse(value) {
  return String(value || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

export function parseNatureCameraPromptResponse(value) {
  const raw = cleanPromptResponse(value);
  let prompt = "";
  try {
    const parsed = JSON.parse(raw);
    prompt = typeof parsed === "string" ? parsed.trim() : typeof parsed?.prompt === "string" ? parsed.prompt.trim() : "";
  } catch {
    prompt = raw.replace(/^prompt\s*:\s*/i, "").trim();
  }
  if (!prompt) throw makeError("Ollama returned an empty photographic prompt.", 502, "TEXT2IMG_OLLAMA_EMPTY_PROMPT");
  if (prompt.length > TEXT2IMG_MAX_PROMPT_LENGTH) {
    throw makeError(`Ollama prompt exceeds ${TEXT2IMG_MAX_PROMPT_LENGTH} characters.`, 502, "TEXT2IMG_OLLAMA_PROMPT_TOO_LONG");
  }
  return prompt;
}

/** Build the native ComfyUI API graph used by the official distilled workflow. */
export function buildFluxKleinText2ImgPrompt(input = {}, { filenamePrefix = "text2img/flux_klein" } = {}) {
  const request = normalizeText2ImgInput(input);
  const profile = resolveText2ImgModel(request.modelId);
  const encoder = resolveText2ImgEncoder(profile, request.encoderId);
  if (profile.id === "flux2-dev") {
    return {
      "1": { class_type: "UNETLoader", inputs: { unet_name: profile.model, weight_dtype: "default" } },
      "2": { class_type: "CLIPLoader", inputs: { clip_name: encoder.textEncoder, type: profile.clipType, device: "default" } },
      "3": { class_type: "VAELoader", inputs: { vae_name: profile.vae } },
      "4": { class_type: "CLIPTextEncode", inputs: { text: request.prompt, clip: link(2) } },
      "5": { class_type: "FluxGuidance", inputs: { conditioning: link(4), guidance: profile.cfg } },
      "6": { class_type: "BasicGuider", inputs: { model: link(1), conditioning: link(5) } },
      "7": { class_type: "RandomNoise", inputs: { noise_seed: request.seed } },
      "8": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
      "9": { class_type: "Flux2Scheduler", inputs: { steps: request.steps, width: request.width, height: request.height } },
      "10": { class_type: "EmptyFlux2LatentImage", inputs: { width: request.width, height: request.height, batch_size: 1 } },
      "11": { class_type: "SamplerCustomAdvanced", inputs: { noise: link(7), guider: link(6), sampler: link(8), sigmas: link(9), latent_image: link(10) } },
      "12": { class_type: "VAEDecode", inputs: { samples: link(11), vae: link(3) } },
      "13": { class_type: "SaveImage", inputs: { images: link(12), filename_prefix: String(filenamePrefix || "text2img/flux2_dev") } },
    };
  }
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: profile.model, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: encoder.textEncoder, type: profile.clipType, device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: profile.vae } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: request.prompt, clip: link(2) } },
    "5": { class_type: "ConditioningZeroOut", inputs: { conditioning: link(4) } },
    "6": { class_type: "CFGGuider", inputs: { model: link(1), positive: link(4), negative: link(5), cfg: 1 } },
    "7": { class_type: "RandomNoise", inputs: { noise_seed: request.seed } },
    "8": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
    "9": { class_type: "Flux2Scheduler", inputs: { steps: request.steps, width: request.width, height: request.height } },
    "10": { class_type: "EmptyFlux2LatentImage", inputs: { width: request.width, height: request.height, batch_size: 1 } },
    "11": {
      class_type: "SamplerCustomAdvanced",
      inputs: { noise: link(7), guider: link(6), sampler: link(8), sigmas: link(9), latent_image: link(10) },
    },
    "12": { class_type: "VAEDecode", inputs: { samples: link(11), vae: link(3) } },
    "13": { class_type: "SaveImage", inputs: { images: link(12), filename_prefix: String(filenamePrefix || "text2img/flux_klein") } },
  };
}

export function buildJuggernautText2ImgPrompt(input = {}, { filenamePrefix = "text2img/juggernaut_xl" } = {}) {
  const request = normalizeText2ImgInput({ ...input, modelId: "juggernaut-xl-v9" });
  const profile = resolveText2ImgModel(request.modelId);
  const modelLink = request.adultMode ? link(2) : link(1);
  const clipLink = request.adultMode ? link(2, 1) : link(1, 1);
  const graph = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: profile.model } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: request.prompt, clip: clipLink } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: "low quality, blurry, deformed anatomy, malformed hands, extra fingers, plastic skin, CGI, illustration", clip: clipLink } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: request.width, height: request.height, batch_size: 1 } },
    "6": { class_type: "KSampler", inputs: { model: modelLink, positive: link(3), negative: link(4), latent_image: link(5), seed: request.seed, control_after_generate: "fixed", steps: request.steps, cfg: profile.cfg, sampler_name: "dpmpp_2m", scheduler: "karras", denoise: 1 } },
    "12": { class_type: "VAEDecode", inputs: { samples: link(6), vae: link(1, 2) } },
    "13": { class_type: "SaveImage", inputs: { images: link(12), filename_prefix: String(filenamePrefix || "text2img/juggernaut_xl") } },
  };
  if (request.adultMode) {
    graph["2"] = { class_type: "LoraLoader", inputs: { model: link(1), clip: link(1, 1), lora_name: profile.adultLora.file, strength_model: profile.adultLora.strengthModel, strength_clip: profile.adultLora.strengthClip } };
  }
  return graph;
}

export function buildText2ImgPrompt(input = {}, options = {}) {
  const profile = resolveText2ImgModel(input.modelId);
  return profile.architecture === "sdxl" ? buildJuggernautText2ImgPrompt(input, options) : buildFluxKleinText2ImgPrompt(input, options);
}

function comboValues(nodeInfo, key) {
  const spec = nodeInfo?.input?.required?.[key];
  const choices = Array.isArray(spec) ? spec[0] : spec;
  if (Array.isArray(choices)) return choices.map(String);
  if (choices && typeof choices === "object" && Array.isArray(choices.value)) return choices.value.map(String);
  return [];
}

export function evaluateText2ImgReadiness(objectInfo, { comfyUi = true, remote = false, modelId = DEFAULT_TEXT2IMG_MODEL_ID, encoderId = DEFAULT_TEXT2IMG_ENCODER_ID } = {}) {
  const nodes = Object.fromEntries(TEXT2IMG_REQUIRED_NODES.map((name) => [name, Boolean(objectInfo?.[name])]));
  const diffusionModels = comboValues(objectInfo?.UNETLoader, "unet_name");
  const textEncoders = comboValues(objectInfo?.CLIPLoader, "clip_name");
  const clipTypes = comboValues(objectInfo?.CLIPLoader, "type");
  const vaes = comboValues(objectInfo?.VAELoader, "vae_name");
  const checkpoints = comboValues(objectInfo?.CheckpointLoaderSimple, "ckpt_name");
  const loras = comboValues(objectInfo?.LoraLoader, "lora_name");
  const profiles = Object.fromEntries(Object.values(TEXT2IMG_MODEL_PROFILES).map((profile) => {
    const requiredNodes = profile.architecture === "sdxl"
      ? SDXL_REQUIRED_NODES
      : profile.id === "flux2-dev"
        ? FLUX_DEV_REQUIRED_NODES
        : FLUX_REQUIRED_NODES;
    const profileNodesReady = requiredNodes.every((name) => Boolean(objectInfo?.[name]));
    if (profile.architecture === "sdxl") {
      const checkpoint = checkpoints.includes(profile.model);
      const adultLoraAvailable = loras.includes(profile.adultLora.file);
      const ready = Boolean(comfyUi) && !remote && profileNodesReady && checkpoint;
      let reason = "";
      if (!comfyUi) reason = "COMFY_UNREACHABLE";
      else if (remote) reason = "LOCAL_ONLY_MODEL";
      else if (!profileNodesReady) reason = "REQUIRED_NODE_MISSING";
      else if (!checkpoint) reason = "MODEL_OR_COMPANION_MISSING";
      return [profile.id, { ...profile, ready, models: { checkpoint }, encoders: {}, adultLora: { ...profile.adultLora, available: adultLoraAvailable, ready: ready && adultLoraAvailable }, ...(reason ? { reason } : {}) }];
    }
    const encoders = Object.fromEntries(Object.values(encoderProfilesFor(profile)).map((encoder) => {
      const available = textEncoders.includes(encoder.textEncoder);
      const ready = Boolean(comfyUi) && !remote && profileNodesReady && diffusionModels.includes(profile.model) && available && clipTypes.includes(profile.clipType) && vaes.includes(profile.vae);
      return [encoder.id, { ...encoder, available, ready }];
    }));
    const models = {
      diffusion: diffusionModels.includes(profile.model),
      textEncoder: encoders[DEFAULT_TEXT2IMG_ENCODER_ID].available,
      clipType: clipTypes.includes(profile.clipType),
      vae: vaes.includes(profile.vae),
    };
    const ready = Boolean(comfyUi) && !remote && profileNodesReady && Object.values(models).every(Boolean);
    let reason = "";
    if (!comfyUi) reason = "COMFY_UNREACHABLE";
    else if (remote) reason = "LOCAL_ONLY_MODEL";
    else if (!profileNodesReady) reason = "REQUIRED_NODE_MISSING";
    else if (!Object.values(models).every(Boolean)) reason = "MODEL_OR_COMPANION_MISSING";
    return [profile.id, { ...profile, ready, models, encoders, ...(reason ? { reason } : {}) }];
  }));
  const selectedProfile = resolveText2ImgModel(modelId);
  const selectedId = selectedProfile.id;
  const selected = profiles[selectedId];
  const selectedEncoder = selectedProfile.architecture === "flux2" ? resolveText2ImgEncoder(selectedProfile, encoderId) : null;
  const selectedModels = selectedEncoder ? { ...selected.models, textEncoder: selected.encoders[selectedEncoder.id].available } : selected.models;
  const selectedReady = selectedEncoder ? selected.encoders[selectedEncoder.id].ready : selected.ready;
  return {
    ready: selectedReady,
    comfyUi: Boolean(comfyUi),
    remote: Boolean(remote),
    modelId: selectedId,
    encoderId: selectedEncoder?.id || DEFAULT_TEXT2IMG_ENCODER_ID,
    nodes,
    models: selectedModels,
    profiles,
    ...(!selectedReady ? { reason: selected.reason || "MODEL_OR_COMPANION_MISSING" } : {}),
  };
}

function safeArtifact(value) {
  if (!value || typeof value !== "object") return null;
  const filename = String(value.filename || value.name || "").replaceAll("\\", "/");
  const subfolder = String(value.subfolder || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  const type = String(value.type || "output");
  const parts = [...(subfolder ? subfolder.split("/") : []), ...filename.split("/")];
  if (!filename || type !== "output" || parts.some((part) => !part || part === "." || part === "..")) return null;
  const relativeName = parts.join("/");
  if (![".png", ".jpg", ".jpeg", ".webp"].includes(path.posix.extname(relativeName).toLowerCase())) return null;
  return { filename, subfolder, type, relativeName };
}

export function parseText2ImgHistory(payload, promptId = "") {
  const record = payload?.[promptId] && typeof payload[promptId] === "object" ? payload[promptId] : payload;
  if (!record || typeof record !== "object" || Object.keys(record).length === 0) return { state: "pending" };
  const status = record.status && typeof record.status === "object" ? record.status : {};
  const statusText = String(status.status_str || status.status || "").toLowerCase();
  const messages = Array.isArray(status.messages) ? status.messages : [];
  const executionError = messages
    .filter((item) => Array.isArray(item) && /error|exception|failed/i.test(String(item[0] || "")))
    .map((item) => item[1]?.exception_message || item[1]?.message || item[1])
    .find(Boolean);
  if (ERROR_STAGES.has(statusText) || status.completed === false || executionError) {
    return { state: "failed", error: errorMessage(executionError || record.error || "ComfyUI reported an image execution error.") };
  }
  const outputs = record.outputs && typeof record.outputs === "object" ? record.outputs : {};
  for (const nodeId of ["13", ...Object.keys(outputs).filter((key) => key !== "13")]) {
    for (const image of Array.isArray(outputs[nodeId]?.images) ? outputs[nodeId].images : []) {
      const artifact = safeArtifact(image);
      if (artifact) return { state: "completed", artifact };
    }
  }
  if (status.completed === true || TERMINAL_STAGES.has(statusText)) {
    return { state: "failed", error: "ComfyUI completed without returning an image artifact." };
  }
  return { state: "running" };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cloneJob(job) {
  return structuredClone(job);
}

export function createText2ImgController({
  comfyUrl = (process.env.COMFY_URL || "http://127.0.0.1:8188").replace(/\/$/, ""),
  ollamaUrl = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, ""),
  remote = false,
  outputRoot,
  toAsset,
  beforeRun,
  ollamaCoordinator = null,
  preferredOllamaModel = "",
  fetchImpl = globalThis.fetch,
  fsApi = fs,
  now = () => new Date(),
  idFactory = randomUUID,
  pollIntervalMs = 750,
  maxPollMs = 15 * 60 * 1000,
  requestTimeoutMs = 30_000,
  gpuCoordinator = null,
  gpuRuntime = remote ? "remote" : "local",
} = {}) {
  if (!outputRoot) throw new Error("Text-to-image controller requires outputRoot.");
  const jobs = new Map();

  async function requestJson(pathname, init = {}, timeoutMs = requestTimeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${comfyUrl}${pathname}`, { ...init, signal: controller.signal });
      const text = await response.text();
      let payload = {};
      try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
      if (!response.ok) throw makeError(`ComfyUI request failed (${response.status}): ${text.slice(0, 800)}`, 502, "COMFY_REQUEST_FAILED");
      return payload;
    } catch (error) {
      if (error?.name === "AbortError") throw makeError("ComfyUI request timed out.", 504, "COMFY_REQUEST_TIMEOUT");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function requestOllamaJson(pathname, init = {}, timeoutMs = 10_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${ollamaUrl}${pathname}`, { ...init, signal: controller.signal });
      const text = await response.text();
      let payload = {};
      try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
      if (!response.ok) throw makeError(`Ollama request failed (${response.status}).`, 502, "TEXT2IMG_OLLAMA_REQUEST_FAILED");
      return payload;
    } catch (error) {
      if (error?.name === "AbortError") throw makeError("Ollama request timed out.", 504, "TEXT2IMG_OLLAMA_TIMEOUT");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function checkPromptAssistant() {
    if (!ollamaCoordinator?.generate) {
      return { ready: false, online: false, models: [], model: "", profile: NATURE_CAMERA_PROFILE, reason: "OLLAMA_UNAVAILABLE" };
    }
    try {
      const payload = await requestOllamaJson("/api/tags");
      const models = Array.isArray(payload?.models)
        ? payload.models.map((item) => String(item?.name || item?.model || "").trim()).filter(Boolean)
        : [];
      const preferred = String(preferredOllamaModel || "").trim();
      const model = models.includes(preferred) ? preferred : models[0] || "";
      return {
        ready: Boolean(model),
        online: true,
        models,
        model,
        profile: NATURE_CAMERA_PROFILE,
        ...(model ? {} : { reason: "OLLAMA_MODEL_MISSING" }),
      };
    } catch {
      return { ready: false, online: false, models: [], model: "", profile: NATURE_CAMERA_PROFILE, reason: "OLLAMA_UNREACHABLE" };
    }
  }

  async function generatePhotographicPrompt(input = {}) {
    const description = normalizeText2ImgDescription(input);
    const adultMode = input.adultMode === true;
    const unloadPromptModel = input.unloadPromptModel === true;
    const assistant = await checkPromptAssistant();
    if (!assistant.ready) throw makeError("Ollama prompt model is not ready.", 503, assistant.reason || "OLLAMA_UNAVAILABLE");
    const requestedModel = String(input.model || "").trim();
    const model = requestedModel || assistant.model;
    if (!assistant.models.includes(model)) {
      throw makeError(`Ollama model ${model} is not installed.`, 400, "TEXT2IMG_OLLAMA_MODEL_MISSING");
    }
    let lease = null;
    try {
      const admission = gpuCoordinator?.request?.({
        requestId: `text2img-prompt:${idFactory()}`,
        jobId: `text2img-prompt:${Date.now()}`,
        workloadType: "ollama-vision",
        runtime: gpuRuntime,
        metadata: { model, profile: NATURE_CAMERA_PROFILE },
      });
      lease = admission ? await admission.granted : null;
      const response = await ollamaCoordinator.generate({
        ollamaUrl,
        comfyUrl,
        remoteComfy: remote,
        model,
        body: {
          system: adultMode ? NATURE_CAMERA_ADULT_SYSTEM_PROMPT : NATURE_CAMERA_SYSTEM_PROMPT,
          prompt: `User image description:\n${description}`,
          think: false,
          options: { temperature: 0.25, top_p: 0.9, num_ctx: 8192 },
        },
        timeoutMs: 120_000,
        requestFetch: fetchImpl,
        unloadAfter: unloadPromptModel,
      });
      const payload = response?.payload && typeof response.payload === "object" ? response.payload : {};
      const prompt = parseNatureCameraPromptResponse(payload.response || payload.message?.content || response?.text);
      return { description, prompt, model, profile: NATURE_CAMERA_PROFILE, adultMode, unloadPromptModel };
    } finally {
      lease?.release?.();
    }
  }

  async function checkReadiness(modelId = DEFAULT_TEXT2IMG_MODEL_ID, encoderId = DEFAULT_TEXT2IMG_ENCODER_ID) {
    if (remote) return evaluateText2ImgReadiness({}, { comfyUi: true, remote: true, modelId, encoderId });
    try {
      return evaluateText2ImgReadiness(await requestJson("/object_info", {}, 10_000), { comfyUi: true, remote: false, modelId, encoderId });
    } catch {
      return evaluateText2ImgReadiness({}, { comfyUi: false, remote: false, modelId, encoderId });
    }
  }

  async function registerArtifact(artifact) {
    const outputReal = await fsApi.realpath(outputRoot).catch(() => path.resolve(outputRoot));
    const candidate = path.resolve(outputRoot, artifact.relativeName);
    const candidateReal = await fsApi.realpath(candidate).catch(() => null);
    if (!candidateReal || !inside(outputReal, candidateReal)) {
      throw makeError("ComfyUI image output is missing or unsafe.", 502, "TEXT2IMG_OUTPUT_MISSING");
    }
    return typeof toAsset === "function"
      ? toAsset("output", artifact.relativeName)
      : { root: "output", name: artifact.relativeName, kind: "image" };
  }

  async function waitForHistory(job) {
    const started = Date.now();
    while (Date.now() - started < maxPollMs) {
      const parsed = parseText2ImgHistory(await requestJson(`/history/${encodeURIComponent(job.promptId)}`), job.promptId);
      if (parsed.state === "failed") throw makeError(parsed.error, 502, "COMFY_EXECUTION_FAILED");
      if (parsed.state === "completed") return parsed.artifact;
      const elapsedRatio = Math.min(1, (Date.now() - started) / Math.max(1, maxPollMs));
      job.progress = Math.max(job.progress, Math.min(88, 32 + Math.round(elapsedRatio * 56)));
      job.stage = "Generating image";
      job.updatedAt = isoNow(now());
      await sleep(pollIntervalMs);
    }
    throw makeError("Timed out while waiting for the generated image.", 504, "TEXT2IMG_HISTORY_TIMEOUT");
  }

  async function runJob(job) {
    let lease = null;
    try {
      const admission = gpuCoordinator?.request?.({
        requestId: `text2img:${job.id}`,
        jobId: `text2img:${job.id}`,
        workloadType: "img2img",
        runtime: gpuRuntime,
        metadata: { model: job.model, width: job.width, height: job.height },
      });
      lease = admission ? await admission.granted : null;
      job.status = "running";
      job.progress = 8;
      job.stage = "Checking image models";
      job.startedAt = isoNow(now());
      job.updatedAt = job.startedAt;
      if (typeof beforeRun === "function") await beforeRun(job);
      const readiness = await checkReadiness(job.modelId, job.encoderId);
      if (!readiness.ready) throw makeError(`${job.modelLabel} is not ready in ComfyUI.`, 503, readiness.reason || "TEXT2IMG_NOT_READY");
      const graph = buildText2ImgPrompt(job, { filenamePrefix: `text2img/${job.modelId.replaceAll("-", "_")}_${job.id.slice(0, 8)}` });
      job.progress = 20;
      job.stage = "Submitting ComfyUI workflow";
      job.updatedAt = isoNow(now());
      const submitted = await requestJson("/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: graph, client_id: `h3-text2img-${job.id}` }),
      });
      job.promptId = String(submitted.prompt_id || submitted.promptId || "");
      if (!job.promptId) {
        const detail = submitted.node_errors ? ` ${JSON.stringify(submitted.node_errors).slice(0, 800)}` : "";
        throw makeError(`ComfyUI rejected the image workflow.${detail}`, 502, "COMFY_PROMPT_REJECTED");
      }
      job.progress = 30;
      job.stage = "Generating image";
      job.updatedAt = isoNow(now());
      const artifact = await waitForHistory(job);
      job.progress = 94;
      job.stage = "Registering image";
      job.updatedAt = isoNow(now());
      job.output = await registerArtifact(artifact);
      job.status = "completed";
      job.progress = 100;
      job.stage = "Completed";
      job.completedAt = isoNow(now());
      job.updatedAt = job.completedAt;
    } catch (error) {
      job.status = "failed";
      job.stage = "Failed";
      job.error = errorMessage(error);
      job.errorCode = error?.code || "TEXT2IMG_ERROR";
      job.completedAt = isoNow(now());
      job.updatedAt = job.completedAt;
    } finally {
      lease?.release?.();
    }
  }

  async function enqueue(input = {}) {
    if (remote) throw makeError("Text-to-image models are installed on the local runtime only.", 400, "LOCAL_ONLY_MODEL");
    const request = normalizeText2ImgInput(input);
    const profile = resolveText2ImgModel(request.modelId);
    const encoder = profile.architecture === "flux2" ? resolveText2ImgEncoder(profile, request.encoderId) : null;
    const createdAt = isoNow(now());
    const job = {
      id: String(idFactory()),
      status: "queued",
      progress: 0,
      stage: "Queued",
      ...request,
      model: profile.model,
      modelLabel: profile.label,
      encoder: encoder?.textEncoder || "Built into checkpoint",
      encoderLabel: encoder?.label || "SDXL dual CLIP",
      encoderPrecision: encoder?.precision || profile.precision,
      thirdPartyEncoder: encoder?.thirdParty || false,
      adultLora: request.adultMode ? profile.adultLora : null,
      precision: profile.precision,
      license: profile.license,
      commercial: profile.commercial,
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      completedAt: null,
      promptId: "",
      output: null,
      error: "",
    };
    jobs.set(job.id, job);
    queueMicrotask(() => { void runJob(job); });
    return cloneJob(job);
  }

  async function handleRoute(req, res, { pathname = new URL(req.url || "/", "http://localhost").pathname, readJson, sendJson, sendError } = {}) {
    const respond = sendJson || ((response, status, payload) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(payload));
    });
    const fail = sendError || ((response, status, message, code) => respond(response, status, { error: message, ...(code ? { code } : {}) }));
    if (req.method === "GET" && pathname === "/api/text2img/health") {
      respond(res, 200, { ...(await checkReadiness()), promptAssistant: await checkPromptAssistant() });
      return true;
    }
    if (req.method === "POST" && pathname === "/api/text2img/prompt") {
      try {
        respond(res, 200, await generatePhotographicPrompt(await readJson(req)));
      } catch (error) {
        fail(res, Number.isInteger(error?.status) ? error.status : 502, errorMessage(error), error?.code);
      }
      return true;
    }
    if (req.method === "POST" && pathname === "/api/text2img") {
      try {
        const input = await readJson(req);
        const modelId = resolveText2ImgModel(input?.modelId).id;
        const profile = TEXT2IMG_MODEL_PROFILES[modelId];
        const encoderId = profile.architecture === "flux2" ? resolveText2ImgEncoder(profile, input?.encoderId).id : DEFAULT_TEXT2IMG_ENCODER_ID;
        const readiness = await checkReadiness(modelId, encoderId);
        const adultMode = input?.adultMode === true;
        const adultLoraReady = !adultMode || readiness.profiles?.[modelId]?.adultLora?.ready;
        if (!readiness.ready || !adultLoraReady) {
          respond(res, 503, { error: `${TEXT2IMG_MODEL_PROFILES[modelId].label} is not ready.`, code: readiness.reason || "TEXT2IMG_NOT_READY", health: readiness });
          return true;
        }
        respond(res, 202, { job: await enqueue(input) });
      } catch (error) {
        fail(res, Number.isInteger(error?.status) ? error.status : 400, errorMessage(error), error?.code);
      }
      return true;
    }
    if (req.method === "GET" && pathname === "/api/text2img/jobs") {
      respond(res, 200, { jobs: [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(cloneJob) });
      return true;
    }
    if (req.method === "GET" && pathname.startsWith("/api/text2img/jobs/")) {
      const id = decodeURIComponent(pathname.slice("/api/text2img/jobs/".length));
      const job = jobs.get(id);
      if (!job) fail(res, 404, "Text-to-image job not found.", "TEXT2IMG_JOB_NOT_FOUND");
      else respond(res, 200, { job: cloneJob(job) });
      return true;
    }
    return false;
  }

  return Object.freeze({ checkReadiness, checkPromptAssistant, generatePhotographicPrompt, enqueue, getJob: (id) => jobs.has(String(id)) ? cloneJob(jobs.get(String(id))) : null, handleRoute });
}
