import crypto from "node:crypto";
import { normalizeRef2VCameraPlan } from "../../app/lib/ref2v-camera-plan.mjs";
import { normalizeMultishotSettings } from "./multishot.mjs";

export const SEQUENCE_STATES = [
  "draft",
  "planning",
  "ready",
  "queued",
  "running",
  "paused",
  "assembling",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];

export const SEGMENT_STATES = [
  "pending",
  "finalizing_prompt",
  "ready",
  "queued",
  "rendering",
  "normalizing",
  "extracting_context",
  "extracting_tail",
  "completed",
  "failed",
  "stale",
];

export const REFERENCE_MODES = ["continuity", "multi_reference"];
export const CONTINUATION_MODES = ["legacy_tail", "motion_context", "latent_context", "first_frame", "context_pin"];
export const DEFAULT_MOTION_CONTEXT_SECONDS = 2;
export const MAX_REFERENCE_ASSETS = 8;
export const CHARACTER_LORA_DEFAULT_STRENGTH = 0.75;
export const CHARACTER_LORA_MAX_NAME_LENGTH = 512;
// The H3 Realism People adapter is the only long-video LoRA that is admitted
// for Ref2VA/multi-reference.  Keep its trigger bridge-owned: the planner
// must not duplicate it in prompts.
export const H3_REALISM_PEOPLE_PRESET = "h3-realism-people-t2v-i2v-r2v.safetensors";
export const H3_REALISM_PEOPLE_TRIGGER = "r34l1sm";
export const H3_REALISM_PEOPLE_DEFAULT_STRENGTH = 0.8;
export const H3_REALISM_PEOPLE_LORA_NAME = H3_REALISM_PEOPLE_PRESET;
export const H3_REALISM_PEOPLE_LORA_TRIGGER = H3_REALISM_PEOPLE_TRIGGER;

function normalizeCharacterLoraName(value) {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return undefined;
  if (typeof value !== "string") fail("CHARACTER_LORA_NAME_INVALID", "Character LoRA name must be a string.");
  const normalized = value.trim().replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    !normalized || normalized.length > CHARACTER_LORA_MAX_NAME_LENGTH || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)
    || normalized.includes("\0") || segments.some((segment) => !segment || segment === "." || segment === ".." || /[<>:"|?*]/.test(segment))
  ) fail("CHARACTER_LORA_NAME_INVALID", "Character LoRA must be a safe relative path under models/loras.");
  return normalized;
}

function normalizeCharacterLoraId(value) {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return undefined;
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim())) {
    fail("CHARACTER_LORA_ID_INVALID", "Character LoRA registry id must be a UUID.");
  }
  return value.trim().toLowerCase();
}

function normalizeCharacterLoraStrength(value, fallback = CHARACTER_LORA_DEFAULT_STRENGTH) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 2) fail("CHARACTER_LORA_STRENGTH_INVALID", "Character LoRA strength must be a finite number between 0 and 2.");
  return number;
}

export function validateCharacterLora(value, { rejectProvenance = true } = {}) {
  const source = value && typeof value === "object" ? value : {};
  if (rejectProvenance && (Object.prototype.hasOwnProperty.call(source, "loraProvenance") || Object.prototype.hasOwnProperty.call(source, "characterLoraProvenance"))) {
    fail("CHARACTER_LORA_PROVENANCE_FORBIDDEN", "LoRA provenance is server-owned and cannot be supplied by the client.");
  }
  const h3Enabled = source.h3LoraEnabled === true;
  const h3Disabled = source.h3LoraEnabled === false;
  const h3Preset = text(source.h3LoraPreset);
  const name = normalizeCharacterLoraName(source.characterLoraName);
  const id = normalizeCharacterLoraId(source.characterLoraId);
  const inferredH3 = h3Enabled || h3Preset || name === H3_REALISM_PEOPLE_PRESET;
  if (h3Disabled && ((!name && !id && !h3Preset) || h3Preset || name === H3_REALISM_PEOPLE_PRESET)) {
    // An explicit disabled selection is a clear operation.  This prevents a
    // stale persisted LoRA from surviving a UI toggle/PATCH.
    return {
      h3LoraEnabled: false,
      h3LoraPreset: null,
      characterLoraName: null,
      characterLoraId: null,
      characterLoraStrength: null,
    };
  }
  if (inferredH3) {
    if (h3Preset && h3Preset !== H3_REALISM_PEOPLE_PRESET) {
      fail("CHARACTER_LORA_PRESET_INVALID", `Unsupported H3 LoRA preset: ${h3Preset}.`);
    }
    if (name && name !== H3_REALISM_PEOPLE_PRESET) {
      fail("CHARACTER_LORA_PRESET_INVALID", "H3 Realism People must use its fixed preset filename.");
    }
    if (id) fail("CHARACTER_LORA_PRESET_INVALID", "H3 Realism People uses its fixed preset filename, not a registry id.");
    return {
      h3LoraEnabled: true,
      h3LoraPreset: H3_REALISM_PEOPLE_PRESET,
      characterLoraName: H3_REALISM_PEOPLE_PRESET,
      characterLoraStrength: normalizeCharacterLoraStrength(source.characterLoraStrength, H3_REALISM_PEOPLE_DEFAULT_STRENGTH),
    };
  }
  if (!name && !id) {
    if (source.characterLoraStrength !== undefined && source.characterLoraStrength !== null && source.characterLoraStrength !== "") fail("CHARACTER_LORA_STRENGTH_WITHOUT_LORA", "Character LoRA strength requires a LoRA name or registry id.");
    return {};
  }
  return {
    ...(name ? { characterLoraName: name } : {}),
    ...(id ? { characterLoraId: id } : {}),
    characterLoraStrength: normalizeCharacterLoraStrength(source.characterLoraStrength),
  };
}

export function assertLongLoraSupported(value, { mode } = {}) {
  const lora = validateCharacterLora(value);
  const hasLora = Boolean(lora.characterLoraName || lora.characterLoraId || lora.h3LoraEnabled === true);
  if (!hasLora) return lora;
  const profile = text(value?.modelProfile, "nvfp4_blackwell");
  const fixedH3 = lora.h3LoraEnabled === true && lora.characterLoraName === H3_REALISM_PEOPLE_PRESET;
  const ref2v = mode === "ref2v" || value?.referenceMode === "multi_reference" || value?.segments?.some?.((segment) => segment?.mode === "ref2v");
  if (!fixedH3 && ref2v) {
    fail("CHARACTER_LORA_MODE_UNSUPPORTED", "Character LoRA is not supported for Ref2VA/multi-reference long-video segments.", 422);
  }
  const profileSupported = ["nvfp4_blackwell", "int8_convrot_quality"].includes(profile)
    || (fixedH3 && ref2v && ["ref2va_pruned_nvfp4", "ref2va_pruned_int8_convrot"].includes(profile));
  if (!profileSupported) {
    fail("CHARACTER_LORA_PROFILE_UNSUPPORTED", `Character LoRA is not supported for model profile ${profile}.`, 422, { modelProfile: profile });
  }
  return lora;
}

export class LongVideoError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = "LongVideoError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function fail(code, message, status = 400, details) {
  throw new LongVideoError(code, message, status, details);
}

export function newId(prefix = "seq") {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(5).toString("hex")}`;
}

function text(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

// Character identity anchors are deliberately normalized to short text.  The
// planner accepts either a scalar or a list for palette/marks because model
// providers commonly vary those shapes; persisting one deterministic string
// keeps the continuity bible backward compatible with the existing text
// appearance/clothing fields.
function identityText(value) {
  if (Array.isArray(value)) return value.map((item) => String(item ?? "").trim()).filter(Boolean).join(", ");
  return text(value, "");
}

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeScriptDraft(value, index) {
  const content = text(value?.content || value?.prompt);
  return {
    id: text(value?.id, `script-${index + 1}`),
    name: text(value?.name, `劇本 ${index + 1}`),
    content,
    description: text(value?.description || value?.scene || content),
    negativePrompt: text(value?.negativePrompt),
    duration: finite(value?.duration, 5),
  };
}

export function validateContinuityBible(value) {
  const source = value && typeof value === "object" ? value : {};
  const characters = Array.isArray(source.characters) ? source.characters : [];
  return {
    visualStyle: text(source.visualStyle, "Consistent cinematic style"),
    characters: characters.map((character, index) => ({
      id: text(character?.id, `character-${index + 1}`),
      faceIdentity: identityText(character?.faceIdentity),
      hair: identityText(character?.hair),
      silhouette: identityText(character?.silhouette),
      palette: identityText(character?.palette),
      distinctiveMarks: identityText(character?.distinctiveMarks),
      appearance: text(character?.appearance, ""),
      clothing: text(character?.clothing, ""),
      ...(text(character?.voice) ? { voice: text(character.voice) } : {}),
    })),
    environment: text(source.environment, ""),
    lighting: text(source.lighting, ""),
    camera: text(source.camera, ""),
    motionDirection: text(source.motionDirection, ""),
    keyObjects: Array.isArray(source.keyObjects) ? source.keyObjects.map(String).map((item) => item.trim()).filter(Boolean) : [],
    sound: text(source.sound, "Natural diegetic sound"),
    nonDiegeticMusic: text(source.nonDiegeticMusic, "N/A"),
    mustPreserve: Array.isArray(source.mustPreserve) ? source.mustPreserve.map(String).map((item) => item.trim()).filter(Boolean) : [],
    mustAvoid: Array.isArray(source.mustAvoid) ? source.mustAvoid.map(String).map((item) => item.trim()).filter(Boolean) : [],
  };
}

export function validateSegment(value, index = 0) {
  if (!value || typeof value !== "object") fail("SEGMENT_INVALID", `Segment ${index + 1} must be an object.`);
  const start = finite(value.start, NaN);
  const end = finite(value.end, NaN);
  if (!Number.isFinite(start) || !Number.isFinite(end)) fail("SEGMENT_TIME_INVALID", `Segment ${index + 1} requires numeric start and end.`);
  if (start < 0 || end <= start) fail("SEGMENT_TIME_INVALID", `Segment ${index + 1} has an invalid time range.`);
  const duration = end - start;
  if (duration < 0.5 || duration > 60) fail("SEGMENT_DURATION_INVALID", `Segment ${index + 1} duration must be between 0.5 and 60 seconds.`);
  const description = text(value.description || value.scene || value.text || value.brief);
  if (!description) fail("SEGMENT_DESCRIPTION_REQUIRED", `Segment ${index + 1} requires a description.`);
  const integratedMultimodalDescription = text(value.integratedMultimodalDescription || value.integrated_multimodal_description);
  const overallSoundscape = text(value.overallSoundscape || value.overall_soundscape);
  const nonDiegeticMusic = text(value.nonDiegeticMusic || value.non_diegetic_music);
  const continuityNote = text(value.continuityNote || value.continuity_note);
  const endingState = text(value.endingState || value.ending_state);
  const cameraPlan = value.cameraPlan && typeof value.cameraPlan === "object"
    ? normalizeRef2VCameraPlan(value.cameraPlan, { duration, referenceCount: 9, hasVideo: index > 0 })
    : null;
  return {
    id: text(value.id, `segment-${String(index + 1).padStart(3, "0")}`),
    index,
    start: Number(start.toFixed(3)),
    end: Number(end.toFixed(3)),
    duration: Number(duration.toFixed(3)),
    description,
    prompt: text(value.prompt),
    negativePrompt: text(value.negativePrompt),
    ...(integratedMultimodalDescription ? { integratedMultimodalDescription } : {}),
    ...(overallSoundscape ? { overallSoundscape } : {}),
    ...(nonDiegeticMusic ? { nonDiegeticMusic } : {}),
    ...(continuityNote ? { continuityNote } : {}),
    ...(endingState ? { endingState } : {}),
    ...(cameraPlan ? { cameraPlan } : {}),
    ...(value.promptSource === "ollama" || value.promptSource === "ollama_structured" || value.promptSource === "sglang" || value.promptSource === "sglang_structured" || value.promptSource === "codex" || value.promptSource === "codex_structured" || value.promptSource === "manual" ? { promptSource: value.promptSource } : {}),
    mode: value.mode === "i2v" ? "i2v" : value.mode === "ref2v" ? "ref2v" : "t2v",
    status: SEGMENT_STATES.includes(value.status) ? value.status : "pending",
    attempt: Math.max(0, Math.floor(finite(value.attempt, 0))),
    ...(value.firstFrame ? { firstFrame: value.firstFrame } : {}),
    ...(value.tailFrame ? { tailFrame: value.tailFrame } : {}),
    ...(value.error ? { error: String(value.error) } : {}),
  };
}

export function validateTimeline(segments, allowedDuration = undefined, { minSegments = 2 } = {}) {
  if (!Array.isArray(segments) || segments.length < minSegments) fail("TIMELINE_TOO_SHORT", `At least ${minSegments} segment${minSegments === 1 ? "" : "s"} are required.`);
  const normalized = segments.map((segment, index) => validateSegment(segment, index));
  const epsilon = 0.001;
  if (normalized[0].start > epsilon) fail("TIMELINE_START_GAP", "Timeline must start at 0.00 seconds.");
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    if (current.start < previous.end - epsilon) fail("TIMELINE_OVERLAP", `Segments ${index} and ${index + 1} overlap.`);
    if (Math.abs(current.start - previous.end) > epsilon) fail("TIMELINE_GAP", `Segments ${index} and ${index + 1} leave a gap.`);
  }
  const totalDuration = normalized[normalized.length - 1].end;
  if (allowedDuration !== undefined && Math.abs(totalDuration - Number(allowedDuration)) > 0.01) {
    fail("TIMELINE_DURATION_MISMATCH", `Timeline ends at ${totalDuration.toFixed(3)}s, expected ${Number(allowedDuration).toFixed(3)}s.`);
  }
  return normalized;
}

export function validateSequenceInput(value, { requireTimeline = false } = {}) {
  if (!value || typeof value !== "object") fail("SEQUENCE_INVALID", "Sequence payload must be an object.");
  const characterLora = validateCharacterLora(value);
  const title = text(value.title, "Untitled sequence");
  if (value.inputType !== undefined && value.inputType !== "text" && value.inputType !== "image") fail("INPUT_TYPE_INVALID", "inputType must be text or image.");
  const inputType = value.inputType === "image" ? "image" : "text";
  const referenceMode = value.referenceMode === undefined ? "continuity" : value.referenceMode;
  if (!REFERENCE_MODES.includes(referenceMode)) fail("REFERENCE_MODE_INVALID", "referenceMode must be continuity or multi_reference.");
  let multishot;
  try {
    multishot = normalizeMultishotSettings(value.longVideoEnabled === true ? {
      ...value,
      continuityMode: value.continuityMode || (value.continuationMode === "context_pin" ? "context_pin" : "first_frame"),
    } : { longVideoEnabled: false });
  } catch (error) {
    if (error?.code && error?.status === 400) fail(error.code, error.message, 400);
    throw error;
  }
  // Missing means an older saved job. Keep historical jobs on their original
  // path; only an explicitly enabled multishot request uses the new modes.
  const continuationMode = multishot.longVideoEnabled
    ? multishot.continuityMode
    : value.continuationMode === undefined ? "legacy_tail" : value.continuationMode;
  if (!CONTINUATION_MODES.includes(continuationMode)) fail("CONTINUATION_MODE_INVALID", "continuationMode must be legacy_tail, motion_context, latent_context, first_frame, or context_pin.");
  if (continuationMode === "latent_context" && inputType !== "image") {
    fail("LATENT_CONTEXT_IMAGE_REQUIRED", "latent_context currently requires an image-origin sequence so later Ref2VA segments retain a fixed visual reference.", 400);
  }
  const requestedMotionContextSeconds = Number(value.motionContextSeconds ?? DEFAULT_MOTION_CONTEXT_SECONDS);
  if (!Number.isFinite(requestedMotionContextSeconds) || requestedMotionContextSeconds < 1 || requestedMotionContextSeconds > 2) {
    fail("MOTION_CONTEXT_DURATION_INVALID", "motionContextSeconds must be between 1 and 2 seconds.");
  }
  const motionContextSeconds = continuationMode === "motion_context" ? 2 : requestedMotionContextSeconds;
  const rawReferenceAssets = value.referenceAssets === undefined ? [] : value.referenceAssets;
  if (!Array.isArray(rawReferenceAssets)) fail("REFERENCE_ASSETS_INVALID", "referenceAssets must be an array of image assets.");
  let inputAsset;
  if (value.inputAsset !== undefined && value.inputAsset !== null) {
    inputAsset = sanitizeAssetRef(value.inputAsset);
    if (inputType === "image" || referenceMode === "multi_reference") {
      if (!inputAsset?.name) fail("INPUT_ASSET_REQUIRED", referenceMode === "multi_reference" ? "Reference input requires an image asset name." : "Image first_frame input requires an image asset name.", 400);
      if (inputAsset && inputAsset.kind === "video") fail("INPUT_ASSET_KIND_INVALID", "Reference input must reference an image asset.", 400);
      if (inputAsset && typeof inputAsset === "object") inputAsset = { ...inputAsset, kind: "image" };
    }
  }
  const referenceAssets = [];
  const seenReferenceAssets = new Set();
  for (const valueRef of rawReferenceAssets) {
    const reference = sanitizeAssetRef(valueRef);
    if (!reference?.name) fail("REFERENCE_ASSET_REQUIRED", "Each reference asset requires an image name.", 400);
    if (reference.kind === "video") fail("REFERENCE_ASSET_KIND_INVALID", "referenceAssets may contain image assets only.", 400);
    const normalized = { ...reference, root: reference.root === "output" ? "output" : "input", kind: "image" };
    const key = `${normalized.root}:${normalized.name}`.toLocaleLowerCase();
    if (seenReferenceAssets.has(key)) continue;
    seenReferenceAssets.add(key);
    referenceAssets.push(normalized);
  }
  if (referenceMode === "continuity" && referenceAssets.length) {
    fail("REFERENCE_ASSETS_CONTINUITY", "referenceAssets require referenceMode=multi_reference.", 400);
  }
  if (referenceMode === "multi_reference") {
    const effectiveReferences = [];
    const effectiveKeys = new Set();
    for (const reference of [inputAsset, ...referenceAssets]) {
      if (!reference?.name) continue;
      const normalized = { ...reference, root: reference.root === "output" ? "output" : "input", kind: "image" };
      const key = `${normalized.root}:${normalized.name}`.toLocaleLowerCase();
      if (effectiveKeys.has(key)) continue;
      effectiveKeys.add(key);
      effectiveReferences.push(normalized);
    }
    if (!effectiveReferences.length) fail("REFERENCE_ASSETS_REQUIRED", "multi_reference requires at least one image reference.", 400);
    if (effectiveReferences.length > MAX_REFERENCE_ASSETS) {
      fail("REFERENCE_ASSETS_LIMIT", `multi_reference supports at most ${MAX_REFERENCE_ASSETS} image references.`, 400);
    }
  }
  const imagePurpose = referenceMode === "continuity" && value.imagePurpose === "first_frame" ? "first_frame" : undefined;
  if (referenceMode === "continuity" && inputType === "image" && imagePurpose !== "first_frame") {
    fail("IMAGE_PURPOSE_REQUIRED", "Image input must explicitly use imagePurpose=first_frame.");
  }
  if (referenceMode === "continuity" && inputType === "image" && (value.inputAsset === undefined || value.inputAsset === null)) {
    fail("INPUT_ASSET_REQUIRED", "Image first_frame input requires an image asset.", 400);
  }
  const duration = finite(value.duration, undefined);
  if (duration !== undefined && (duration <= 0 || duration > 3600)) fail("DURATION_INVALID", "Duration must be greater than 0 and no more than 3600 seconds.");
  let timeline;
  const timelineSource = value.timeline !== undefined ? value.timeline : value.segments;
  if (timelineSource !== undefined || requireTimeline) timeline = validateTimeline(timelineSource, duration, { minSegments: multishot.longVideoEnabled ? 1 : 2 });
  if (timeline && multishot.longVideoEnabled && timeline.length !== multishot.shotCount) {
    fail("MULTISHOT_COUNT_MISMATCH", `Multishot timeline requires exactly ${multishot.shotCount} generation windows.`, 400);
  }
  if (timeline && referenceMode === "multi_reference") timeline = timeline.map((segment) => ({ ...segment, mode: "ref2v" }));
  const hasIdentityReference = Boolean(inputAsset?.name || referenceAssets.length);
  if (timeline && (["motion_context", "latent_context"].includes(continuationMode) || ["context_pin", "first_frame"].includes(continuationMode) && hasIdentityReference)) {
    timeline = timeline.map((segment, index) => ({
      ...segment,
      mode: index === 0 ? segment.mode : "ref2v",
    }));
  }
  const width = finite(value.width, 736);
  const height = finite(value.height, 416);
  if (!Number.isInteger(width) || width < 32 || width > 2048 || width % 32 !== 0) fail("WIDTH_INVALID", "Sequence width must be an integer multiple of 32 between 32 and 2048.");
  if (!Number.isInteger(height) || height < 32 || height > 2048 || height % 32 !== 0) fail("HEIGHT_INVALID", "Sequence height must be an integer multiple of 32 between 32 and 2048.");
  if (value.seam === "drop_next_first_frame") fail("SEAM_UNSUPPORTED", "drop_next_first_frame seam handling is not available in this slice; use keep_duplicate_frame.", 400);
  const normalized = {
    ...value,
    title,
    inputType,
    referenceMode,
    ...multishot,
    continuationMode,
    motionContextSeconds: Number(motionContextSeconds.toFixed(3)),
    referenceAssets,
    ...(imagePurpose ? { imagePurpose } : {}),
    ...(value.inputText !== undefined ? { inputText: text(value.inputText) } : {}),
    ...(Array.isArray(value.scripts) ? { scripts: value.scripts.slice(0, 120).map(normalizeScriptDraft) } : {}),
    ...(inputAsset !== undefined ? { inputAsset } : {}),
    ...(duration !== undefined ? { duration } : {}),
    ...(timeline ? { timeline } : {}),
    width,
    height,
    steps: Math.round(Math.min(80, Math.max(1, finite(value.steps, 20)))),
    seed: Math.round(Math.min(2147483647, Math.max(0, finite(value.seed, 12345)))),
    negativePrompt: text(value.negativePrompt),
    modelProfile: text(value.modelProfile, "nvfp4_blackwell"),
    seam: value.seam === "drop_next_first_frame" ? "drop_next_first_frame" : "keep_duplicate_frame",
    ...characterLora,
  };
  for (const field of ["h3LoraEnabled", "h3LoraPreset", "characterLoraName", "characterLoraId", "characterLoraStrength"]) {
    if (!Object.prototype.hasOwnProperty.call(characterLora, field)) delete normalized[field];
  }
  return normalized;
}

export function createSequenceRecord(input, { id = newId("seq"), now = new Date().toISOString() } = {}) {
  const payload = validateSequenceInput(input, { requireTimeline: true });
  const timeline = payload.timeline.map((segment, index) => ({
    ...segment,
    index,
    status: "pending",
    prompt: segment.prompt || "",
  }));
  const rawSegmentDurationHint = finite(payload.planningSettings?.segmentDurationHint ?? payload.planMeta?.segmentDurationHint, 5);
  const normalizedSegmentDurationHint = Number(Math.min(60, Math.max(0.5, rawSegmentDurationHint)).toFixed(3));
  const timelineMode = ["ollama", "sglang", "codex"].includes(payload.planMeta?.timelineSource) || payload.planningSettings?.timelineMode === "auto" ? "auto" : "manual";
  const duration = payload.duration ?? timeline[timeline.length - 1].end;
  return {
    schemaVersion: 1,
    id,
    title: payload.title,
    status: "ready",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    inputType: payload.inputType,
    referenceMode: payload.referenceMode,
    continuationMode: payload.continuationMode,
    longVideoEnabled: payload.longVideoEnabled,
    targetDurationSeconds: payload.targetDurationSeconds,
    framesPerShot: payload.framesPerShot,
    fps: payload.fps,
    secondsPerShot: payload.secondsPerShot,
    shotCount: payload.shotCount,
    continuityMode: payload.continuityMode,
    promptMode: payload.promptMode,
    identityAnchor: payload.identityAnchor,
    voiceContinuity: payload.voiceContinuity,
    contextFrames: payload.contextFrames,
    chainGainControl: payload.chainGainControl,
    masterNormalize: payload.masterNormalize,
    motionContextSeconds: payload.motionContextSeconds,
    referenceAssets: payload.referenceAssets.map((reference) => sanitizeAssetRef(reference)),
    ...(payload.imagePurpose ? { imagePurpose: payload.imagePurpose } : {}),
    ...(payload.inputText ? { inputText: payload.inputText } : {}),
    ...(payload.scripts ? { scripts: payload.scripts } : {}),
    ...(payload.inputAsset ? { inputAsset: sanitizeAssetRef(payload.inputAsset) } : {}),
    continuityBible: validateContinuityBible(payload.continuityBible),
    duration,
    timeline,
    segments: timeline,
    planningSettings: {
      timelineMode,
      targetDuration: duration,
      segmentDurationHint: normalizedSegmentDurationHint,
      segmentCount: timeline.length,
    },
    outputFolder: payload.outputFolder,
    // Output allocation is a server-side start transition.  Never trust a
    // client supplied `outputAllocated` flag while creating a draft.
    width: payload.width,
    height: payload.height,
    steps: payload.steps,
    seed: payload.seed,
    negativePrompt: payload.negativePrompt,
    modelProfile: payload.modelProfile,
    ...(payload.promptProvider ? { promptProvider: payload.promptProvider } : {}),
    ...(payload.ollamaModel ? { ollamaModel: payload.ollamaModel } : {}),
    ...(payload.sglangModel ? { sglangModel: payload.sglangModel } : {}),
    ...(payload.codexModel ? { codexModel: payload.codexModel } : {}),
    ...(payload.codexReasoningEffort ? { codexReasoningEffort: payload.codexReasoningEffort } : {}),
    seam: payload.seam,
    ...(Object.prototype.hasOwnProperty.call(payload, "h3LoraEnabled") ? {
      h3LoraEnabled: payload.h3LoraEnabled,
      h3LoraPreset: payload.h3LoraPreset ?? null,
      characterLoraName: payload.characterLoraName ?? null,
      characterLoraId: payload.characterLoraId ?? null,
      characterLoraStrength: payload.characterLoraStrength ?? null,
    } : {
      ...(payload.characterLoraName ? { characterLoraName: payload.characterLoraName } : {}),
      ...(payload.characterLoraId ? { characterLoraId: payload.characterLoraId } : {}),
      ...(payload.characterLoraName || payload.characterLoraId ? { characterLoraStrength: payload.characterLoraStrength ?? CHARACTER_LORA_DEFAULT_STRENGTH } : {}),
    }),
    ...(payload.planMeta ? { planMeta: payload.planMeta } : {}),
  };
}

export function sanitizeAssetRef(value) {
  if (value === undefined || value === null) return value;
  const source = value && typeof value === "object" ? value : { name: String(value) };
  const hasName = Object.prototype.hasOwnProperty.call(source, "name");
  let name;
  if (hasName) {
    name = source.name === undefined || source.name === null ? "" : String(source.name);
    const normalized = name.replaceAll("\\", "/");
    const segments = normalized.split("/");
    const isDrivePath = /^[A-Za-z]:/.test(normalized);
    const isAbsolute = normalized.startsWith("/") || isDrivePath;
    const hasTraversal = segments.some((segment) => segment === "..");
    if (!normalized.trim() || normalized.includes("\0") || isAbsolute || hasTraversal) {
      throw new LongVideoError("ASSET_REF_INVALID", "Asset name must be a non-empty relative path without traversal.", 400);
    }
    name = normalized;
  }
  return {
    ...(source.root ? { root: source.root === "output" ? "output" : "input" } : {}),
    ...(hasName ? { name } : {}),
    ...(source.kind ? { kind: source.kind === "video" ? "video" : "image" } : {}),
  };
}

export function publicSequence(sequence) {
  if (!sequence) return null;
  return JSON.parse(JSON.stringify(sequence));
}

export const validateSequence = validateSequenceInput;
export const validateJob = validateSequenceInput;
export const validateSegmentDraft = validateSegment;
