export const SINGLE_CREATE_DRAFT_STORAGE_KEY = "h3-studio.single-create.draft.v1";

const SINGLE_CREATE_DRAFT_VERSION = 1;
const MODES = new Set(["t2v", "i2v", "fl2v", "l2v", "ref2v", "replace"]);
const DEFAULT_DRAFT = Object.freeze({
  version: SINGLE_CREATE_DRAFT_VERSION,
  mode: "t2v",
  prompt: "",
  negativePrompt: "",
  modelProfile: "nvfp4_blackwell",
  width: 736,
  height: 416,
  duration: 5,
  steps: 20,
  seed: 12345,
  renderCount: 1,
  outputName: "",
  referenceImageKey: null,
  referenceImageKeys: [],
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
    referenceImageKey: normalizeNullableString(input.referenceImageKey),
    referenceImageKeys: normalizeStringArray(input.referenceImageKeys),
    lastFrameImageKey: normalizeNullableString(input.lastFrameImageKey),
    sourceVideoKey: normalizeNullableString(input.sourceVideoKey),
  };
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
