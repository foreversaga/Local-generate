import { SINGLE_RENDER_DURATION_DEFAULT_SECONDS } from "./single-duration.mjs";

export const SINGLE_CREATE_DRAFT_STORAGE_KEY = "h3-studio.single-create.draft.v1";

const SINGLE_CREATE_DRAFT_VERSION = 1;
const MODES = new Set(["t2v", "i2v", "fl2v", "l2v", "ref2v", "ref2v_motion", "replace"]);
const DEFAULT_DRAFT = Object.freeze({
  version: SINGLE_CREATE_DRAFT_VERSION,
  mode: "t2v",
  initialDescription: "",
  prompt: "",
  negativePrompt: "",
  modelProfile: "nvfp4_blackwell",
  width: 736,
  height: 416,
  duration: SINGLE_RENDER_DURATION_DEFAULT_SECONDS,
  steps: 20,
  seed: 12345,
  renderCount: 1,
  outputName: "",
  characterLoraName: "",
  characterLoraStrength: 0.75,
  h3LoraEnabled: false,
  h3LoraStrength: 0.8,
  h3LoraPreset: null,
  characterLoraTrigger: null,
  referenceImageKey: null,
  referenceImageKeys: [],
  faceReferenceImageKeys: [],
  clothingReferenceImageKeys: [],
  clothingMode: "character",
  clothingDescription: "",
  referenceVideoStart: 0,
  referenceVideoEnd: SINGLE_RENDER_DURATION_DEFAULT_SECONDS,
  referenceVideoMaxDimension: 720,
  lastFrameImageKey: null,
  sourceVideoKey: null,
});

/**
 * @param {Omit<typeof DEFAULT_DRAFT, "version"> & Record<string, unknown>} input
 */
export function createSingleCreateDraft(input) {
  return {
    version: SINGLE_CREATE_DRAFT_VERSION,
    mode: normalizeMode(input.mode),
    initialDescription: normalizeString(input.initialDescription),
    prompt: normalizeString(input.prompt),
    negativePrompt: normalizeString(input.negativePrompt),
    modelProfile: normalizeNonEmptyString(input.modelProfile, DEFAULT_DRAFT.modelProfile),
    width: normalizeNumberDraft(input.width, DEFAULT_DRAFT.width),
    height: normalizeNumberDraft(input.height, DEFAULT_DRAFT.height),
    duration: normalizeFiniteNumber(input.duration, DEFAULT_DRAFT.duration),
    steps: normalizeNumberDraft(input.steps, DEFAULT_DRAFT.steps),
    seed: normalizeNumberDraft(input.seed, DEFAULT_DRAFT.seed),
    renderCount: normalizeNumberDraft(input.renderCount, DEFAULT_DRAFT.renderCount),
    outputName: normalizeString(input.outputName),
    characterLoraName: normalizeString(input.characterLoraName),
    characterLoraStrength: normalizeNumberDraft(input.characterLoraStrength, DEFAULT_DRAFT.characterLoraStrength),
    h3LoraEnabled: input.h3LoraEnabled === true,
    h3LoraStrength: normalizeNumberDraft(input.h3LoraStrength, DEFAULT_DRAFT.h3LoraStrength),
    h3LoraPreset: input.h3LoraEnabled === true ? "h3-realism-people-t2v-i2v-r2v.safetensors" : null,
    characterLoraTrigger: input.h3LoraEnabled === true ? "r34l1sm" : null,
    referenceImageKey: normalizeNullableString(input.referenceImageKey),
    referenceImageKeys: normalizeStringArray(input.referenceImageKeys),
    faceReferenceImageKeys: normalizeStringArray(input.faceReferenceImageKeys),
    clothingReferenceImageKeys: normalizeStringArray(input.clothingReferenceImageKeys),
    clothingMode: normalizeClothingMode(input.clothingMode),
    clothingDescription: normalizeString(input.clothingDescription).slice(0, 2000),
    referenceVideoStart: normalizeFiniteNumber(input.referenceVideoStart, DEFAULT_DRAFT.referenceVideoStart),
    referenceVideoEnd: normalizeFiniteNumber(input.referenceVideoEnd, DEFAULT_DRAFT.referenceVideoEnd),
    referenceVideoMaxDimension: normalizeVideoMaxDimension(input.referenceVideoMaxDimension),
    lastFrameImageKey: normalizeNullableString(input.lastFrameImageKey),
    sourceVideoKey: normalizeNullableString(input.sourceVideoKey),
  };
}

/**
 * Convert a persisted public Single-video job into the normal Create form
 * draft. New jobs retain initialDescription; legacy jobs leave it blank.
 *
 * @param {Record<string, any>} job
 */
export function createSingleCreateDraftFromJob(job) {
  const request = job?.provenance?.request && typeof job.provenance.request === "object"
    ? job.provenance.request
    : {};
  const refs = job?.inputRefs && typeof job.inputRefs === "object" ? job.inputRefs : {};
  const storedMode = normalizeMode(job?.mode ?? request.mode);
  const mode = storedMode === "ref2v" && request.ref2vWorkflow === "character_motion"
    ? "ref2v_motion"
    : storedMode;
  const inputImageName = normalizeString(request.inputImageName || refs.inputImage);
  const lastFrameName = normalizeString(request.lastImageName || refs.lastFrame);
  const sourceVideoName = normalizeString(request.inputVideoName || refs.inputVideo);
  const referenceImageName = normalizeString(request.referenceImageName || refs.referenceImage);
  const referenceImageNames = normalizeStringArray(request.referenceImageNames || refs.referenceImages);
  const referenceImageRoles = Array.isArray(request.referenceImageRoles) && request.referenceImageRoles.length === referenceImageNames.length
    ? request.referenceImageRoles
    : referenceImageNames.map(() => "character");
  const h3LoraEnabled = request.h3LoraEnabled === true
    || job?.h3LoraPreset === "h3-realism-people-t2v-i2v-r2v.safetensors"
    || request.h3LoraPreset === "h3-realism-people-t2v-i2v-r2v.safetensors";

  return createSingleCreateDraft({
    mode,
    initialDescription: job?.initialDescription ?? request.initialDescription,
    prompt: job?.prompt ?? request.prompt,
    negativePrompt: job?.negativePrompt ?? request.negativePrompt,
    modelProfile: job?.modelProfile ?? job?.model ?? request.modelProfile ?? request.model,
    width: job?.width ?? request.width,
    height: job?.height ?? request.height,
    duration: job?.duration ?? request.duration,
    steps: job?.steps ?? request.steps,
    seed: job?.seed ?? request.seed,
    renderCount: 1,
    outputName: job?.outputName ?? request.outputName,
    characterLoraName: job?.characterLoraName ?? request.characterLoraName,
    characterLoraStrength: job?.characterLoraStrength ?? request.characterLoraStrength,
    h3LoraEnabled,
    h3LoraStrength: job?.characterLoraStrength ?? request.characterLoraStrength,
    h3LoraPreset: h3LoraEnabled ? "h3-realism-people-t2v-i2v-r2v.safetensors" : null,
    characterLoraTrigger: h3LoraEnabled ? "r34l1sm" : null,
    referenceImageKey: assetDraftKey(
      mode === "i2v" || mode === "fl2v" ? inputImageName : referenceImageName,
      mode === "i2v" || mode === "fl2v" ? request.inputImageRoot : request.referenceImageRoot,
    ),
    referenceImageKeys: mode === "ref2v" || mode === "ref2v_motion"
      ? referenceImageNames.map((name, index) => referenceImageRoles[index] === "character" ? assetDraftKey(name, request.referenceImageRoots?.[index]) : null).filter(Boolean)
      : [],
    faceReferenceImageKeys: mode === "ref2v_motion"
      ? referenceImageNames.map((name, index) => referenceImageRoles[index] === "face" ? assetDraftKey(name, request.referenceImageRoots?.[index]) : null).filter(Boolean)
      : [],
    clothingReferenceImageKeys: mode === "ref2v_motion"
      ? referenceImageNames.map((name, index) => referenceImageRoles[index] === "clothing" ? assetDraftKey(name, request.referenceImageRoots?.[index]) : null).filter(Boolean)
      : [],
    clothingMode: request.clothingMode,
    clothingDescription: request.clothingDescription,
    referenceVideoStart: request.referenceVideoStart,
    referenceVideoEnd: request.referenceVideoEnd ?? request.duration,
    referenceVideoMaxDimension: request.referenceVideoMaxDimension,
    lastFrameImageKey: assetDraftKey(lastFrameName, request.lastImageRoot),
    sourceVideoKey: assetDraftKey(sourceVideoName, request.inputVideoRoot),
  });
}

/**
 * @param {string | null | undefined} serialized
 */
export function parseSingleCreateDraft(serialized) {
  if (!serialized) return null;

  try {
    const parsed = JSON.parse(serialized);
    if (!parsed || typeof parsed !== "object" || parsed.version !== SINGLE_CREATE_DRAFT_VERSION) {
      return null;
    }
    return createSingleCreateDraft(parsed);
  } catch {
    return null;
  }
}

function normalizeMode(value) {
  return typeof value === "string" && MODES.has(value) ? value : DEFAULT_DRAFT.mode;
}

function normalizeString(value) {
  return typeof value === "string" ? value : "";
}

function normalizeNonEmptyString(value, fallback) {
  return typeof value === "string" && value ? value : fallback;
}

function normalizeNullableString(value) {
  return typeof value === "string" && value ? value : null;
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item) : [];
}

function normalizeNumberDraft(value, fallback) {
  if (value === "") return "";
  return Number.isFinite(value) ? value : fallback;
}

function normalizeFiniteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function normalizeClothingMode(value) {
  return ["character", "reference", "description"].includes(value) ? value : "character";
}

function normalizeVideoMaxDimension(value) {
  return [0, 480, 720, 960].includes(value) ? value : 720;
}

function assetDraftKey(name, root) {
  if (!name) return null;
  return `${root === "output" ? "output" : "input"}:${name}`;
}
