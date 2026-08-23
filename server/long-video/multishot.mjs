export const MULTISHOT_FPS = 24;
export const MULTISHOT_FRAME_OPTIONS = Object.freeze([243, 362]);
export const MULTISHOT_CONTINUITY_MODES = Object.freeze(["first_frame", "context_pin"]);
export const MULTISHOT_PROMPT_MODES = Object.freeze(["manual_shots", "auto_extend"]);
export const MULTISHOT_CHAIN_GAIN_MODES = Object.freeze(["off", "flatten"]);
export const MULTISHOT_MASTER_NORMALIZE_MODES = Object.freeze(["off", "luma", "luma+contrast"]);
export const MULTISHOT_CONTEXT_FRAME_OPTIONS = Object.freeze([5, 22, 39, 56]);
export const MOTION_CONTEXT_NODE_CONTRACT = Object.freeze({
  MiniMaxH3MotionContext: ["conditioning", "vae", "latent", "context_length", "audio_context_length", "context_latent"],
  MiniMaxH3MotionContextTrim: ["images", "trim_frames", "audio", "fps", "match_tail"],
  MiniMaxH3MotionContextSaveLatent: ["latent", "filename_prefix", "clip_index"],
  MiniMaxH3MotionContextLoadLatent: ["latent_path", "clip_index"],
});

function invalid(code, message) {
  const error = new Error(message);
  error.name = "LongVideoError";
  error.code = code;
  error.status = 400;
  throw error;
}

function enumValue(value, allowed, fallback, code, label) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || !allowed.includes(value)) invalid(code, `${label} must be one of: ${allowed.join(", ")}.`);
  return value;
}

function integerValue(value, fallback, allowed, code, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || !allowed.includes(number)) invalid(code, `${label} must be one of: ${allowed.join(", ")}.`);
  return number;
}

export function normalizeMultishotSettings(value = {}) {
  const enabled = value.longVideoEnabled === true;
  const targetDurationSeconds = Number(value.targetDurationSeconds ?? value.duration ?? 30);
  if (!Number.isFinite(targetDurationSeconds) || targetDurationSeconds < 1 || targetDurationSeconds > 600) {
    invalid("TARGET_DURATION_SECONDS_INVALID", "targetDurationSeconds must be between 1 and 600.");
  }
  const framesPerShot = integerValue(value.framesPerShot, 243, MULTISHOT_FRAME_OPTIONS, "FRAMES_PER_SHOT_INVALID", "framesPerShot");
  const continuityMode = enumValue(value.continuityMode, MULTISHOT_CONTINUITY_MODES, "first_frame", "CONTINUITY_MODE_INVALID", "continuityMode");
  const promptMode = enumValue(value.promptMode, MULTISHOT_PROMPT_MODES, "auto_extend", "PROMPT_MODE_INVALID", "promptMode");
  const contextFrames = integerValue(value.contextFrames, 22, MULTISHOT_CONTEXT_FRAME_OPTIONS, "CONTEXT_FRAMES_INVALID", "contextFrames");
  const chainGainControl = enumValue(value.chainGainControl, MULTISHOT_CHAIN_GAIN_MODES, "off", "CHAIN_GAIN_CONTROL_INVALID", "chainGainControl");
  const masterNormalize = enumValue(value.masterNormalize, MULTISHOT_MASTER_NORMALIZE_MODES, "off", "MASTER_NORMALIZE_INVALID", "masterNormalize");
  const secondsPerShot = framesPerShot / MULTISHOT_FPS;
  const shotCount = Math.max(1, Math.ceil(targetDurationSeconds / secondsPerShot));
  return {
    longVideoEnabled: enabled,
    targetDurationSeconds: Number(targetDurationSeconds.toFixed(3)),
    framesPerShot,
    fps: MULTISHOT_FPS,
    secondsPerShot: Number(secondsPerShot.toFixed(6)),
    shotCount,
    continuityMode,
    promptMode,
    identityAnchor: value.identityAnchor !== false,
    voiceContinuity: value.voiceContinuity !== false,
    contextFrames,
    chainGainControl,
    masterNormalize,
  };
}

export function buildShotWindows(settings) {
  const normalized = normalizeMultishotSettings({ ...settings, longVideoEnabled: true });
  const windows = [];
  let cursor = 0;
  for (let index = 0; index < normalized.shotCount; index += 1) {
    const remaining = normalized.targetDurationSeconds - cursor;
    const duration = Math.min(normalized.secondsPerShot, remaining);
    const end = Number((cursor + duration).toFixed(3));
    windows.push({ index, start: Number(cursor.toFixed(3)), end, duration: Number(duration.toFixed(3)), frames: normalized.framesPerShot });
    cursor = end;
  }
  return windows;
}

export function splitManualShotPrompts(value, shotCount) {
  const prompts = String(value || "").split(/^\s*---+\s*$/m).map((part) => part.trim()).filter(Boolean);
  if (prompts.length !== shotCount) {
    invalid("MANUAL_SHOT_COUNT_MISMATCH", `manual_shots requires exactly ${shotCount} prompts separated by ---.`);
  }
  return prompts;
}

export function buildAutoExtendPrompts(value, shotCount) {
  const premise = String(value || "").trim();
  if (!premise) invalid("AUTO_EXTEND_PROMPT_REQUIRED", "auto_extend requires a scene description.");
  const continuity = "Continue naturally from the previous moment. Preserve the same people, identity, clothing, environment, time of day, camera, lens, lighting, action direction, and dialogue continuity. Do not introduce a new scene, a new shot, a cut, or a camera cut unless explicitly requested.";
  const boundary = "End this window on a stable readable face and a continuing action. Avoid a fast turn, full face occlusion, back-to-camera pose, heavy motion blur, abrupt camera motion, scene transition, or dialogue cut mid-word.";
  return Array.from({ length: shotCount }, (_, index) => index === 0
    ? `${premise}\n\n${boundary}`
    : `${continuity}\n\nContinue this same take: ${premise}\n\n${boundary}`);
}

function nodeInputs(node) {
  return new Set([
    ...Object.keys(node?.input?.required || {}),
    ...Object.keys(node?.input?.optional || {}),
  ]);
}

export function evaluateMotionContextCapability(objectInfo) {
  const missingNodes = [];
  const missingInputs = [];
  for (const [nodeName, inputs] of Object.entries(MOTION_CONTEXT_NODE_CONTRACT)) {
    const node = objectInfo?.[nodeName];
    if (!node) {
      missingNodes.push(nodeName);
      continue;
    }
    const advertised = nodeInputs(node);
    for (const input of inputs) if (!advertised.has(input)) missingInputs.push(`${nodeName}.${input}`);
  }
  return {
    available: missingNodes.length === 0 && missingInputs.length === 0,
    missingNodes,
    missingInputs,
  };
}

export function resolveMultishotContinuity(requested, capability) {
  if (requested !== "context_pin") return { requested: "first_frame", effective: "first_frame", fallback: false, warning: null };
  if (capability?.available) return { requested, effective: requested, fallback: false, warning: null };
  const details = [...(capability?.missingNodes || []), ...(capability?.missingInputs || [])];
  return {
    requested,
    effective: "first_frame",
    fallback: true,
    warning: `context_pin is unavailable; using first_frame${details.length ? ` (${details.join(", ")})` : ""}.`,
  };
}
