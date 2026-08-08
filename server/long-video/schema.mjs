import crypto from "node:crypto";

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
  "extracting_tail",
  "completed",
  "failed",
  "stale",
];

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

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function validateContinuityBible(value) {
  const source = value && typeof value === "object" ? value : {};
  const characters = Array.isArray(source.characters) ? source.characters : [];
  return {
    visualStyle: text(source.visualStyle, "Consistent cinematic style"),
    characters: characters.map((character, index) => ({
      id: text(character?.id, `character-${index + 1}`),
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
  return {
    id: text(value.id, `segment-${String(index + 1).padStart(3, "0")}`),
    index,
    start: Number(start.toFixed(3)),
    end: Number(end.toFixed(3)),
    duration: Number(duration.toFixed(3)),
    description,
    prompt: text(value.prompt),
    negativePrompt: text(value.negativePrompt),
    mode: value.mode === "i2v" ? "i2v" : value.mode === "ref2v" ? "ref2v" : "t2v",
    status: SEGMENT_STATES.includes(value.status) ? value.status : "pending",
    attempt: Math.max(0, Math.floor(finite(value.attempt, 0))),
    ...(value.firstFrame ? { firstFrame: value.firstFrame } : {}),
    ...(value.tailFrame ? { tailFrame: value.tailFrame } : {}),
    ...(value.error ? { error: String(value.error) } : {}),
  };
}

export function validateTimeline(segments, allowedDuration = undefined) {
  if (!Array.isArray(segments) || segments.length < 2) fail("TIMELINE_TOO_SHORT", "At least two segments are required.");
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
  const title = text(value.title, "Untitled sequence");
  if (value.inputType !== undefined && value.inputType !== "text" && value.inputType !== "image") fail("INPUT_TYPE_INVALID", "inputType must be text or image.");
  const inputType = value.inputType === "image" ? "image" : "text";
  const imagePurpose = value.imagePurpose === "first_frame" ? "first_frame" : undefined;
  if (inputType === "image" && imagePurpose !== "first_frame") {
    fail("IMAGE_PURPOSE_REQUIRED", "Image input must explicitly use imagePurpose=first_frame.");
  }
  if (inputType === "image" && (value.inputAsset === undefined || value.inputAsset === null)) {
    fail("INPUT_ASSET_REQUIRED", "Image first_frame input requires an image asset.", 400);
  }
  let inputAsset;
  if (value.inputAsset !== undefined) {
    inputAsset = sanitizeAssetRef(value.inputAsset);
    if (inputType === "image") {
      if (!inputAsset?.name) fail("INPUT_ASSET_REQUIRED", "Image first_frame input requires an image asset name.", 400);
      if (inputAsset && inputAsset.kind === "video") fail("INPUT_ASSET_KIND_INVALID", "Image first_frame input must reference an image asset.", 400);
      if (inputAsset && typeof inputAsset === "object") inputAsset = { ...inputAsset, kind: "image" };
    }
  }
  const duration = finite(value.duration, undefined);
  if (duration !== undefined && (duration <= 0 || duration > 3600)) fail("DURATION_INVALID", "Duration must be greater than 0 and no more than 3600 seconds.");
  let timeline;
  const timelineSource = value.timeline !== undefined ? value.timeline : value.segments;
  if (timelineSource !== undefined || requireTimeline) timeline = validateTimeline(timelineSource, duration);
  const width = finite(value.width, 736);
  const height = finite(value.height, 416);
  if (!Number.isInteger(width) || width < 32 || width > 2048 || width % 32 !== 0) fail("WIDTH_INVALID", "Sequence width must be an integer multiple of 32 between 32 and 2048.");
  if (!Number.isInteger(height) || height < 32 || height > 2048 || height % 32 !== 0) fail("HEIGHT_INVALID", "Sequence height must be an integer multiple of 32 between 32 and 2048.");
  if (value.seam === "drop_next_first_frame") fail("SEAM_UNSUPPORTED", "drop_next_first_frame seam handling is not available in this slice; use keep_duplicate_frame.", 400);
  return {
    ...value,
    title,
    inputType,
    ...(inputType === "image" ? { imagePurpose } : {}),
    ...(value.inputText !== undefined ? { inputText: text(value.inputText) } : {}),
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
  };
}

export function createSequenceRecord(input, { id = newId("seq"), now = new Date().toISOString() } = {}) {
  const payload = validateSequenceInput(input, { requireTimeline: true });
  const timeline = payload.timeline.map((segment, index) => ({
    ...segment,
    index,
    status: "pending",
    prompt: segment.prompt || "",
  }));
  return {
    schemaVersion: 1,
    id,
    title: payload.title,
    status: "ready",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    inputType: payload.inputType,
    ...(payload.imagePurpose ? { imagePurpose: payload.imagePurpose } : {}),
    ...(payload.inputText ? { inputText: payload.inputText } : {}),
    ...(payload.inputAsset ? { inputAsset: sanitizeAssetRef(payload.inputAsset) } : {}),
    continuityBible: validateContinuityBible(payload.continuityBible),
    duration: payload.duration ?? timeline[timeline.length - 1].end,
    timeline,
    segments: timeline,
    outputFolder: payload.outputFolder,
    // Output allocation is a server-side start transition.  Never trust a
    // client supplied `outputAllocated` flag while creating a draft.
    width: payload.width,
    height: payload.height,
    steps: payload.steps,
    seed: payload.seed,
    negativePrompt: payload.negativePrompt,
    modelProfile: payload.modelProfile,
    ...(payload.ollamaModel ? { ollamaModel: payload.ollamaModel } : {}),
    seam: payload.seam,
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
