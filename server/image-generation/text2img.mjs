import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  buildPersonPhotoRecipeBrief,
  personPhotoLibrarySummary,
  randomizePersonPhotoRecipes,
  validatePersonPhotoRecipe,
} from "./person-photo-randomizer.mjs";
import { createText2ImgStore } from "./text2img-store.mjs";

export const FLUX2_CLIP_TYPE = "flux2";
export const FLUX2_KLEIN_9B_MODEL = "flux-2-klein-9b-fp8.safetensors";
export const FLUX2_KLEIN_9B_TEXT_ENCODER = "qwen_3_8b_fp8mixed.safetensors";
export const FLUX2_KLEIN_9B_VAE = "full_encoder_small_decoder.safetensors";
export const DEFAULT_TEXT2IMG_MODEL_ID = "flux2-klein-9b";
export const DEFAULT_TEXT2IMG_ENCODER_ID = "official";

export const FLUX2_KLEIN_9B_LORAS = Object.freeze([
  Object.freeze({
    id: "consistency-v2",
    label: "Flux2-Klein-9B Consistency V2",
    filename: "flux2-klein-9b/Flux2-Klein-9B-consistency-V2.safetensors",
    defaultStrength: 0.8,
  }),
  Object.freeze({
    id: "image-restore-v1",
    label: "Ultimate Upscaler Klein-9B",
    filename: "flux2-klein-9b/Flux2-Klein-Image-RestoreV1.safetensors",
    defaultStrength: 0.8,
  }),
  Object.freeze({
    id: "ultrareal-v4",
    label: "UltraReal - Krea2, Klein9B · KL_9B_V4",
    filename: "flux2-klein-9b/ultra_real_v4.safetensors",
    defaultStrength: 0.55,
  }),
]);

const FLUX2_KLEIN_9B_LORA_BY_ID = Object.freeze(Object.fromEntries(FLUX2_KLEIN_9B_LORAS.map((lora) => [lora.id, lora])));

export const TEXT2IMG_MODEL_PROFILES = Object.freeze({
  [DEFAULT_TEXT2IMG_MODEL_ID]: Object.freeze({
    id: DEFAULT_TEXT2IMG_MODEL_ID,
    label: "FLUX.2 Klein 9B · FP8",
    model: FLUX2_KLEIN_9B_MODEL,
    textEncoder: FLUX2_KLEIN_9B_TEXT_ENCODER,
    vae: FLUX2_KLEIN_9B_VAE,
    clipType: FLUX2_CLIP_TYPE,
    precision: "FP8 + FP8 Mixed encoder",
    license: "FLUX Non-Commercial License",
    commercial: false,
    architecture: "flux2",
    encoderLabel: "Qwen3 8B · FP8 Mixed",
    encoderPrecision: "FP8 Mixed",
    defaultSteps: 4,
    maxSteps: 20,
    cfg: 1,
    sampler: "Euler",
    scheduler: "Flux2",
    minDimension: 512,
    maxDimension: 1536,
    dimensionStep: 16,
  }),
});

const FLUX2_KLEIN_REQUIRED_NODES = Object.freeze([
  "UNETLoader",
  "CLIPLoader",
  "VAELoader",
  "LoraLoaderModelOnly",
  "CLIPTextEncode",
  "CFGGuider",
  "RandomNoise",
  "KSamplerSelect",
  "Flux2Scheduler",
  "EmptyFlux2LatentImage",
  "SamplerCustomAdvanced",
  "VAEDecode",
  "SaveImage",
]);

export const TEXT2IMG_REQUIRED_NODES = FLUX2_KLEIN_REQUIRED_NODES;

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

function recipeRequiredClothing(recipe) {
  const requirements = recipe?.hardRequirements?.clothing
    ?? recipe?.hardRequirements?.clothingRequirements
    ?? recipe?.hardRequirements
    ?? recipe?.clothingRequirements
    ?? [];
  const values = [];
  const visit = (value) => {
    if (typeof value === "string" && value.trim()) values.push(value.trim());
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      if (value.selectedItem) visit(value.selectedItem);
      else if (Array.isArray(value.selectedItems)) visit(value.selectedItems);
      else if (typeof value.prompt === "string") visit(value.prompt);
      else if (typeof value.label === "string") visit(value.label);
      else if (typeof value.text === "string") visit(value.text);
      else if (typeof value.value === "string") visit(value.value);
      else Object.values(value).forEach(visit);
    }
  };
  visit(requirements);
  return [...new Set(values)];
}

function ensureRequiredClothing(prompt, recipe) {
  const required = recipeRequiredClothing(recipe).filter((item) => !prompt.toLocaleLowerCase().includes(item.toLocaleLowerCase()));
  if (!required.length) return prompt;
  const clause = `Mandatory visible clothing: ${required.join(", ")}.`;
  const result = `${prompt.replace(/[\s.]+$/, "")}. ${clause}`;
  if (result.length > TEXT2IMG_MAX_PROMPT_LENGTH) {
    throw makeError(`Prompt with mandatory clothing exceeds ${TEXT2IMG_MAX_PROMPT_LENGTH} characters.`, 400, "TEXT2IMG_PROMPT_TOO_LONG");
  }
  return result;
}

function normalizeRecipe(recipe) {
  if (recipe === undefined || recipe === null) return null;
  try {
    const validation = validatePersonPhotoRecipe(recipe);
    if (!validation?.passed) {
      throw Object.assign(new Error("Person-photo recipe failed hard validation."), { status: 400, code: "TEXT2IMG_RECIPE_INVALID", validation });
    }
    return structuredClone({ ...recipe, brief: buildPersonPhotoRecipeBrief(recipe), validation });
  } catch (error) {
    if (error?.status || error?.code) throw error;
    throw makeError(errorMessage(error, "Invalid person-photo recipe."), 400, "TEXT2IMG_RECIPE_INVALID");
  }
}

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

function boundedNumber(value, name, fallback, min, max, step = 0.1) {
  const resolved = value === undefined || value === null || value === "" ? fallback : Number(value);
  const units = resolved / step;
  if (!Number.isFinite(resolved) || resolved < min || resolved > max || Math.abs(units - Math.round(units)) > 1e-9) {
    throw makeError(`${name} must be a number between ${min} and ${max} in steps of ${step}.`, 400, `TEXT2IMG_${name.toUpperCase()}_INVALID`);
  }
  return Math.round(units) * step;
}

function resolveText2ImgModel(modelId = DEFAULT_TEXT2IMG_MODEL_ID) {
  const id = String(modelId || DEFAULT_TEXT2IMG_MODEL_ID).trim();
  const profile = TEXT2IMG_MODEL_PROFILES[id];
  if (!profile) throw makeError(`Unsupported text-to-image model: ${id}.`, 400, "TEXT2IMG_MODEL_INVALID");
  return profile;
}

function encoderProfilesFor(profile) {
  const official = Object.freeze({
    id: DEFAULT_TEXT2IMG_ENCODER_ID,
    label: profile.encoderLabel,
    textEncoder: profile.textEncoder,
    precision: profile.encoderPrecision,
    thirdParty: false,
    license: profile.license,
  });
  return Object.freeze({ [official.id]: official });
}

function resolveText2ImgEncoder(profile, encoderId = DEFAULT_TEXT2IMG_ENCODER_ID) {
  const id = String(encoderId || DEFAULT_TEXT2IMG_ENCODER_ID).trim();
  const encoder = encoderProfilesFor(profile)[id];
  if (!encoder) throw makeError(`Unsupported text encoder ${id} for ${profile.id}.`, 400, "TEXT2IMG_ENCODER_INVALID");
  return encoder;
}

function normalizeText2ImgLoras(value, profile) {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value)) throw makeError("loras must be an array.", 400, "TEXT2IMG_LORAS_INVALID");
  if (profile.id !== "flux2-klein-9b" && value.length) {
    throw makeError("Selected LoRAs are only compatible with FLUX.2 Klein 9B.", 400, "TEXT2IMG_LORAS_MODEL_INVALID");
  }
  const seen = new Set();
  const loras = value.map((item) => {
    const id = String(item?.id || "").trim();
    const preset = FLUX2_KLEIN_9B_LORA_BY_ID[id];
    if (!preset || seen.has(id)) throw makeError(`Unsupported or duplicate Klein 9B LoRA: ${id || "(empty)"}.`, 400, "TEXT2IMG_LORA_INVALID");
    seen.add(id);
    return Object.freeze({
      id,
      label: preset.label,
      filename: preset.filename,
      strength: boundedNumber(item?.strength, `lora_${id}_strength`, preset.defaultStrength, 0, 2, 0.05),
    });
  });
  return Object.freeze(loras);
}

export function normalizeText2ImgInput(input = {}) {
  const recipe = normalizeRecipe(input.recipe);
  const rawPrompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  const prompt = recipe ? ensureRequiredClothing(rawPrompt, recipe) : rawPrompt;
  if (!prompt) throw makeError("Prompt is required.", 400, "TEXT2IMG_PROMPT_REQUIRED");
  if (prompt.length > TEXT2IMG_MAX_PROMPT_LENGTH) {
    throw makeError(`Prompt must not exceed ${TEXT2IMG_MAX_PROMPT_LENGTH} characters.`, 400, "TEXT2IMG_PROMPT_TOO_LONG");
  }
  const profile = resolveText2ImgModel(input.modelId);
  const encoder = resolveText2ImgEncoder(profile, input.encoderId);
  const loras = normalizeText2ImgLoras(input.loras, profile);
  return Object.freeze({
    prompt,
    modelId: profile.id,
    encoderId: encoder.id,
    width: boundedInteger(input.width ?? recipe?.dimensions?.width, "width", 1024, profile.minDimension, profile.maxDimension, profile.dimensionStep),
    height: boundedInteger(input.height ?? recipe?.dimensions?.height, "height", 1024, profile.minDimension, profile.maxDimension, profile.dimensionStep),
    steps: boundedInteger(input.steps, "steps", profile.defaultSteps, 1, profile.maxSteps),
    cfg: boundedNumber(input.cfg, "cfg", profile.cfg, 1, 8, 0.1),
    seed: boundedInteger(input.seed, "seed", 12345, 0, 2_147_483_647),
    loras,
    ...(recipe ? {
      batchId: String(input.batchId ?? recipe.batchId ?? ""),
      batchIndex: boundedInteger(input.batchIndex ?? recipe.batchIndex, "batchIndex", 0, 0, 19),
      batchSize: boundedInteger(input.batchSize ?? recipe.batchSize, "batchSize", 1, 1, 20),
      recipeSeed: boundedInteger(input.recipeSeed ?? recipe.recipeSeed, "recipeSeed", 0, 0, 2_147_483_647),
      libraryVersion: String(recipe.libraryVersion || ""),
      recipe,
      validation: recipe.validation || null,
    } : {}),
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
    .replace(/^<think>[\s\S]*?<\/think>\s*/i, "")
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

/** Build the official FLUX.2 Klein 9B distilled text-to-image graph. */
export function buildFlux2Klein9BText2ImgPrompt(input = {}, { filenamePrefix = "text2img/flux2_klein_9b" } = {}) {
  const request = normalizeText2ImgInput({ ...input, modelId: "flux2-klein-9b" });
  const profile = resolveText2ImgModel(request.modelId);
  const encoder = resolveText2ImgEncoder(profile, request.encoderId);
  const graph = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: profile.model, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: encoder.textEncoder, type: profile.clipType, device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: profile.vae } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: request.prompt, clip: link(2) } },
    "5": { class_type: "CLIPTextEncode", inputs: { text: "", clip: link(2) } },
    "6": { class_type: "CFGGuider", inputs: { model: link(1), positive: link(4), negative: link(5), cfg: request.cfg } },
    "7": { class_type: "RandomNoise", inputs: { noise_seed: request.seed } },
    "8": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
    "9": { class_type: "Flux2Scheduler", inputs: { steps: request.steps, width: request.width, height: request.height } },
    "10": { class_type: "EmptyFlux2LatentImage", inputs: { width: request.width, height: request.height, batch_size: 1 } },
    "11": {
      class_type: "SamplerCustomAdvanced",
      inputs: { noise: link(7), guider: link(6), sampler: link(8), sigmas: link(9), latent_image: link(10) },
    },
    "12": { class_type: "VAEDecode", inputs: { samples: link(11), vae: link(3) } },
    "13": { class_type: "SaveImage", inputs: { images: link(12), filename_prefix: String(filenamePrefix || "text2img/flux2_klein_9b") } },
  };
  let modelNodeId = "1";
  request.loras.forEach((lora, index) => {
    const nodeId = String(14 + index);
    graph[nodeId] = {
      class_type: "LoraLoaderModelOnly",
      inputs: { model: link(modelNodeId), lora_name: lora.filename, strength_model: lora.strength },
    };
    modelNodeId = nodeId;
  });
  graph["6"].inputs.model = link(modelNodeId);
  return graph;
}

export function buildText2ImgPrompt(input = {}, options = {}) {
  const profile = resolveText2ImgModel(input.modelId);
  if (profile.id === "flux2-klein-9b") return buildFlux2Klein9BText2ImgPrompt(input, options);
  throw makeError(`Unsupported text-to-image model: ${profile.id}`, 400, "TEXT2IMG_MODEL_INVALID");
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
  const loraFiles = comboValues(objectInfo?.LoraLoaderModelOnly, "lora_name");
  const profiles = Object.fromEntries(Object.values(TEXT2IMG_MODEL_PROFILES).map((profile) => {
    const requiredNodes = FLUX2_KLEIN_REQUIRED_NODES;
    const profileNodesReady = requiredNodes.every((name) => Boolean(objectInfo?.[name]));
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
    const loras = profile.id === "flux2-klein-9b"
      ? Object.fromEntries(FLUX2_KLEIN_9B_LORAS.map((lora) => [lora.id, { ...lora, available: loraFiles.includes(lora.filename) }]))
      : {};
    return [profile.id, { ...profile, ready, models, encoders, loras, ...(reason ? { reason } : {}) }];
  }));
  const selectedProfile = resolveText2ImgModel(modelId);
  const selectedId = selectedProfile.id;
  const selected = profiles[selectedId];
  const selectedEncoder = resolveText2ImgEncoder(selectedProfile, encoderId);
  const selectedModels = { ...selected.models, textEncoder: selected.encoders[selectedEncoder.id].available };
  const selectedReady = selected.encoders[selectedEncoder.id].ready;
  return {
    ready: selectedReady,
    comfyUi: Boolean(comfyUi),
    remote: Boolean(remote),
    modelId: selectedId,
    encoderId: selectedEncoder.id,
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
  promptAssistant = null,
  fetchImpl = globalThis.fetch,
  fsApi = fs,
  now = () => new Date(),
  idFactory = randomUUID,
  pollIntervalMs = 750,
  maxPollMs = 15 * 60 * 1000,
  requestTimeoutMs = 30_000,
  gpuCoordinator = null,
  gpuRuntime = remote ? "remote" : "local",
  store = null,
  storeRoot,
} = {}) {
  if (!outputRoot) throw new Error("Text-to-image controller requires outputRoot.");
  const jobStore = store || createText2ImgStore({ ...(storeRoot ? { root: storeRoot } : {}) });
  const jobs = new Map();
  let initializationPromise = null;

  async function persistJob(job, { required = false } = {}) {
    try {
      const saved = await jobStore.save(cloneJob(job));
      delete job.persistenceError;
      return saved;
    } catch (error) {
      job.persistenceError = errorMessage(error, "Unable to persist text-to-image job.");
      if (required) throw makeError(job.persistenceError, 503, "TEXT2IMG_PERSISTENCE_FAILED");
      console.error("[text2img] Unable to persist job:", job.persistenceError);
      return null;
    }
  }

  async function initialize() {
    if (!initializationPromise) {
      initializationPromise = (async () => {
        const records = await jobStore.list();
        for (const persisted of records) {
          if (!persisted?.id) continue;
          const job = cloneJob(persisted);
          if (["queued", "running"].includes(job.status)) {
            job.status = "interrupted";
            job.stage = "Interrupted";
            job.error = job.error || "Text-to-image generation was interrupted when the Web service restarted.";
            job.errorCode = job.errorCode || "TEXT2IMG_INTERRUPTED";
            job.completedAt = job.completedAt || isoNow(now());
            job.updatedAt = job.completedAt;
            await persistJob(job);
          }
          jobs.set(String(job.id), job);
        }
      })().catch((error) => {
        initializationPromise = null;
        throw error;
      });
    }
    await initializationPromise;
  }

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
    if (promptAssistant?.status) {
      try {
        const status = await promptAssistant.status();
        const models = Array.isArray(status?.models) ? status.models.map(String).filter(Boolean) : [];
        const model = models.includes(status?.model) ? status.model : models[0] || "";
        return { ready: Boolean(status?.online && model), online: Boolean(status?.online), provider: promptAssistant.provider || "openai", models, model, profile: NATURE_CAMERA_PROFILE, ...((status?.online && model) ? {} : { reason: "PROMPT_MODEL_UNAVAILABLE" }) };
      } catch {
        return { ready: false, online: false, provider: promptAssistant.provider || "openai", models: [], model: "", profile: NATURE_CAMERA_PROFILE, reason: "PROMPT_MODEL_UNREACHABLE" };
      }
    }
    if (!ollamaCoordinator?.generate) {
      return { ready: false, online: false, provider: "ollama", models: [], model: "", profile: NATURE_CAMERA_PROFILE, reason: "OLLAMA_UNAVAILABLE" };
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
        provider: "ollama",
        models,
        model,
        profile: NATURE_CAMERA_PROFILE,
        ...(model ? {} : { reason: "OLLAMA_MODEL_MISSING" }),
      };
    } catch {
      return { ready: false, online: false, provider: "ollama", models: [], model: "", profile: NATURE_CAMERA_PROFILE, reason: "OLLAMA_UNREACHABLE" };
    }
  }

  async function generatePhotographicPrompt(input = {}) {
    const recipe = normalizeRecipe(input.recipe);
    const description = recipe
      ? normalizeText2ImgDescription({ description: buildPersonPhotoRecipeBrief(recipe) })
      : normalizeText2ImgDescription(input);
    const requiredClothing = recipeRequiredClothing(recipe);
    const assistantInput = requiredClothing.length
      ? `${description}\nMandatory visible clothing (preserve these exact requirements): ${requiredClothing.join(", ")}.`
      : description;
    const unloadPromptModel = !promptAssistant?.generate && input.unloadPromptModel === true;
    const assistant = await checkPromptAssistant();
    if (!assistant.ready) throw makeError("Photographic prompt model is not ready.", 503, assistant.reason || "PROMPT_MODEL_UNAVAILABLE");
    const requestedModel = String(input.model || "").trim();
    const model = requestedModel || assistant.model;
    if (!assistant.models.includes(model)) {
      throw makeError(`Prompt model ${model} is not available.`, 400, "TEXT2IMG_PROMPT_MODEL_MISSING");
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
      if (promptAssistant?.generate) {
        const response = await promptAssistant.generate({ model, system: NATURE_CAMERA_SYSTEM_PROMPT, prompt: `User image description:\n${assistantInput}` });
        const prompt = ensureRequiredClothing(parseNatureCameraPromptResponse(response), recipe);
        return { description, prompt, model, provider: promptAssistant.provider || "openai", profile: NATURE_CAMERA_PROFILE, unloadPromptModel: false, ...(recipe ? { recipe, validation: recipe.validation || null } : {}) };
      }
      const response = await ollamaCoordinator.generate({
        ollamaUrl,
        comfyUrl,
        remoteComfy: remote,
        model,
        body: {
          system: NATURE_CAMERA_SYSTEM_PROMPT,
          prompt: `User image description:\n${assistantInput}`,
          think: false,
          options: { temperature: 0.25, top_p: 0.9, num_ctx: 8192 },
        },
        timeoutMs: 120_000,
        requestFetch: fetchImpl,
        unloadAfter: unloadPromptModel,
      });
      const payload = response?.payload && typeof response.payload === "object" ? response.payload : {};
      const prompt = ensureRequiredClothing(parseNatureCameraPromptResponse(payload.response || payload.message?.content || response?.text), recipe);
      return { description, prompt, model, profile: NATURE_CAMERA_PROFILE, unloadPromptModel, ...(recipe ? { recipe, validation: recipe.validation || null } : {}) };
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
      const previousProgress = job.progress;
      const elapsedRatio = Math.min(1, (Date.now() - started) / Math.max(1, maxPollMs));
      job.progress = Math.max(job.progress, Math.min(88, 32 + Math.round(elapsedRatio * 56)));
      job.stage = "Generating image";
      job.updatedAt = isoNow(now());
      if (job.progress !== previousProgress) await persistJob(job);
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
      await persistJob(job);
      if (typeof beforeRun === "function") await beforeRun(job);
      const readiness = await checkReadiness(job.modelId, job.encoderId);
      if (!readiness.ready) throw makeError(`${job.modelLabel} is not ready in ComfyUI.`, 503, readiness.reason || "TEXT2IMG_NOT_READY");
      const missingLora = (job.loras || []).find((lora) => !readiness.profiles?.[job.modelId]?.loras?.[lora.id]?.available);
      if (missingLora) throw makeError(`${missingLora.label} is not installed in ComfyUI.`, 503, "TEXT2IMG_LORA_MISSING");
      const graph = buildText2ImgPrompt(job, { filenamePrefix: `text2img/${job.modelId.replaceAll("-", "_")}_${job.id.slice(0, 8)}` });
      job.progress = 20;
      job.stage = "Submitting ComfyUI workflow";
      job.updatedAt = isoNow(now());
      await persistJob(job);
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
      await persistJob(job);
      job.progress = 30;
      job.stage = "Generating image";
      job.updatedAt = isoNow(now());
      await persistJob(job);
      const artifact = await waitForHistory(job);
      job.progress = 94;
      job.stage = "Registering image";
      job.updatedAt = isoNow(now());
      await persistJob(job);
      job.output = await registerArtifact(artifact);
      job.status = "completed";
      job.progress = 100;
      job.stage = "Completed";
      job.completedAt = isoNow(now());
      job.updatedAt = job.completedAt;
      await persistJob(job);
    } catch (error) {
      job.status = "failed";
      job.stage = "Failed";
      job.error = errorMessage(error);
      job.errorCode = error?.code || "TEXT2IMG_ERROR";
      job.completedAt = isoNow(now());
      job.updatedAt = job.completedAt;
      await persistJob(job);
    } finally {
      lease?.release?.();
    }
  }

  async function enqueue(input = {}) {
    await initialize();
    if (remote) throw makeError("Text-to-image models are installed on the local runtime only.", 400, "LOCAL_ONLY_MODEL");
    const request = normalizeText2ImgInput(input);
    const profile = resolveText2ImgModel(request.modelId);
    const encoder = resolveText2ImgEncoder(profile, request.encoderId);
    const createdAt = isoNow(now());
    const job = {
      id: String(idFactory()),
      status: "queued",
      progress: 0,
      stage: "Queued",
      ...request,
      submittedPrompt: request.prompt,
      model: profile.model,
      modelLabel: profile.label,
      encoder: encoder.textEncoder,
      encoderLabel: encoder.label,
      encoderPrecision: encoder.precision,
      thirdPartyEncoder: encoder.thirdParty,
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
    try {
      await persistJob(job, { required: true });
    } catch (error) {
      jobs.delete(job.id);
      throw error;
    }
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
    if (req.method === "GET" && pathname === "/api/text2img/person-photo/library") {
      try {
        respond(res, 200, { library: await personPhotoLibrarySummary() });
      } catch (error) {
        fail(res, Number.isInteger(error?.status) ? error.status : 500, errorMessage(error), error?.code || "TEXT2IMG_PERSON_PHOTO_LIBRARY_FAILED");
      }
      return true;
    }
    if (req.method === "POST" && pathname === "/api/text2img/person-photo/randomize") {
      try {
        const input = await readJson(req);
        const count = boundedInteger(input?.count, "count", 1, 1, 20);
        const result = await randomizePersonPhotoRecipes({ ...input, count });
        const randomized = Array.isArray(result)
          ? { mode: count === 1 ? "single" : "batch", batchSeed: input?.seed ?? null, count: result.length, recipes: result }
          : result;
        const batchId = String(idFactory());
        const recipes = randomized.recipes.map((item, batchIndex) => ({
          ...item,
          id: String(idFactory()),
          batchId,
          batchIndex,
          batchSize: randomized.count,
        }));
        respond(res, 200, { ...randomized, batchId, recipes });
      } catch (error) {
        fail(res, Number.isInteger(error?.status) ? error.status : 400, errorMessage(error), error?.code || "TEXT2IMG_PERSON_PHOTO_RANDOMIZE_FAILED");
      }
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
        const encoderId = resolveText2ImgEncoder(profile, input?.encoderId).id;
        const readiness = await checkReadiness(modelId, encoderId);
        if (!readiness.ready) {
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
      try {
        await initialize();
        const requestUrl = new URL(req.url || pathname, "http://localhost");
        const requestedLimit = Number(requestUrl.searchParams.get("limit"));
        const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 100) : 100;
        respond(res, 200, { jobs: [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(cloneJob) });
      } catch (error) {
        fail(res, 503, errorMessage(error, "Unable to load text-to-image jobs."), "TEXT2IMG_PERSISTENCE_UNAVAILABLE");
      }
      return true;
    }
    if (req.method === "GET" && pathname.startsWith("/api/text2img/jobs/")) {
      const id = decodeURIComponent(pathname.slice("/api/text2img/jobs/".length));
      await initialize();
      const job = jobs.get(id) || await jobStore.read(id);
      if (!job) fail(res, 404, "Text-to-image job not found.", "TEXT2IMG_JOB_NOT_FOUND");
      else respond(res, 200, { job: cloneJob(job) });
      return true;
    }
    return false;
  }

  void initialize().catch((error) => console.error("[text2img] Unable to initialize persisted jobs:", errorMessage(error)));
  return Object.freeze({ checkReadiness, checkPromptAssistant, generatePhotographicPrompt, enqueue, getJob: (id) => jobs.has(String(id)) ? cloneJob(jobs.get(String(id))) : null, handleRoute });
}
