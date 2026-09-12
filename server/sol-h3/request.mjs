export const SOL_H3_MODES = Object.freeze(["t2va", "fl2va", "ref2va"]);
export const SOL_H3_MEDIA_ROOTS = Object.freeze(["input", "output"]);
export const SOL_H3_OUTPUT_SPEC = Object.freeze({
  width: 1344,
  height: 768,
  frames: 121,
  fps: 24,
  container: "mp4",
  audioCodec: "aac",
});

const SAFE_SEGMENT_RE = /[<>:"|?*]/u;

function hasUnsafeControl(value) {
  return [...String(value || "")].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x08 || codePoint === 0x0b || codePoint === 0x0c || (codePoint >= 0x0e && codePoint <= 0x1f) || codePoint === 0x7f;
  });
}

export function solH3Error(code, message, status = 422, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  if (details && typeof details === "object") error.details = details;
  return error;
}

function fail(code, message, details) {
  throw solH3Error(code, message, 422, details);
}

export function normalizeSolH3RelativePath(value, field = "relativePath") {
  if (typeof value !== "string") fail("SOL_H3_MEDIA_PATH_INVALID", field + " must be a relative path.");
  const normalized = value.replaceAll("\\", "/").trim();
  const segments = normalized.split("/");
  if (
    !normalized
    || normalized.startsWith("/")
    || /^[A-Za-z]:/u.test(normalized)
    || normalized.includes("\0")
    || segments.some((segment) => !segment || segment === "." || segment === ".." || SAFE_SEGMENT_RE.test(segment))
    || hasUnsafeControl(normalized)
  ) {
    fail("SOL_H3_MEDIA_PATH_INVALID", field + " must be a safe relative path.");
  }
  return normalized;
}

function normalizeRoot(value, field) {
  if (!SOL_H3_MEDIA_ROOTS.includes(value)) fail("SOL_H3_MEDIA_ROOT_INVALID", field + ".root must be input or output.");
  return value;
}

export function normalizeSolH3MediaLocator(value, field = "media") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("SOL_H3_MEDIA_INVALID", field + " must include root and relativePath.");
  }
  const root = normalizeRoot(value.root, field);
  const relativePath = normalizeSolH3RelativePath(value.relativePath ?? value.name, field + ".relativePath");
  const kind = value.kind === undefined ? undefined : String(value.kind);
  if (kind !== undefined && !["image", "video", "audio"].includes(kind)) {
    fail("SOL_H3_MEDIA_KIND_INVALID", field + ".kind is not supported.");
  }
  const fingerprint = value.fingerprint && typeof value.fingerprint === "object"
    ? {
      ...(Number.isSafeInteger(Number(value.fingerprint.size)) && Number(value.fingerprint.size) >= 0
        ? { size: Number(value.fingerprint.size) }
        : {}),
      ...(Number.isFinite(Number(value.fingerprint.mtimeMs)) && Number(value.fingerprint.mtimeMs) >= 0
        ? { mtimeMs: Number(value.fingerprint.mtimeMs) }
        : {}),
    }
    : undefined;
  return {
    root,
    relativePath,
    ...(kind ? { kind } : {}),
    ...(fingerprint && Object.keys(fingerprint).length ? { fingerprint } : {}),
  };
}

function ensurePrompt(value) {
  if (typeof value !== "string" || !value.trim()) fail("SOL_H3_PROMPT_REQUIRED", "prompt is required.");
  if (value.length > 4000) fail("SOL_H3_PROMPT_TOO_LONG", "prompt must be at most 4,000 characters.");
  if (hasUnsafeControl(value)) fail("SOL_H3_PROMPT_INVALID", "prompt contains an unsafe control character.");
  return value;
}

function ensureSeed(value) {
  if (value === undefined || value === null || value === "") return 42;
  if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** 63) {
    fail("SOL_H3_SEED_INVALID", "seed must be a non-negative integer accepted by Sol-H3.");
  }
  return value;
}

function ensurePlainObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("SOL_H3_INPUTS_INVALID", field + " must be an object.");
  return value;
}

function rejectExtraKeys(value, allowed, field) {
  for (const key of Object.keys(value || {})) {
    if (!allowed.includes(key)) fail("SOL_H3_FIELD_UNSUPPORTED", field + "." + key + " is not supported in this schema.");
  }
}

export function normalizeSolH3Request(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("SOL_H3_REQUEST_INVALID", "Sol-H3 request must be a JSON object.");
  }
  const allowedTopLevel = ["schemaVersion", "mode", "prompt", "seed", "audio", "inputs"];
  rejectExtraKeys(payload, allowedTopLevel, "request");
  const schemaVersion = payload.schemaVersion === undefined ? 1 : payload.schemaVersion;
  if (schemaVersion !== 1) fail("SOL_H3_SCHEMA_UNSUPPORTED", "Unsupported Sol-H3 request schemaVersion.");
  const mode = String(payload.mode || "").trim().toLowerCase();
  if (!SOL_H3_MODES.includes(mode)) fail("SOL_H3_MODE_INVALID", "mode must be t2va, fl2va, or ref2va.");
  const prompt = ensurePrompt(payload.prompt);
  const seed = ensureSeed(payload.seed);
  const audio = payload.audio === undefined ? {} : ensurePlainObject(payload.audio, "audio");
  rejectExtraKeys(audio, ["generate"], "audio");
  if (audio.generate !== undefined && audio.generate !== true) {
    fail("SOL_H3_AUDIO_REQUIRED", "Sol-H3 WebUI output always generates native audio.");
  }
  const inputs = payload.inputs === undefined ? {} : ensurePlainObject(payload.inputs, "inputs");

  if (mode === "t2va") {
    if (Object.keys(inputs).length) fail("SOL_H3_T2VA_INPUTS_UNSUPPORTED", "t2va does not accept media inputs.");
    return { schemaVersion, mode, prompt, seed, audio: { generate: true }, inputs: {} };
  }

  if (mode === "fl2va") {
    rejectExtraKeys(inputs, ["firstFrame", "lastFrame"], "inputs");
    if (!inputs.firstFrame || !inputs.lastFrame) {
      fail("SOL_H3_FL2VA_FRAMES_REQUIRED", "fl2va requires one firstFrame and one lastFrame.");
    }
    return {
      schemaVersion,
      mode,
      prompt,
      seed,
      audio: { generate: true },
      inputs: {
        firstFrame: normalizeSolH3MediaLocator(inputs.firstFrame, "inputs.firstFrame"),
        lastFrame: normalizeSolH3MediaLocator(inputs.lastFrame, "inputs.lastFrame"),
      },
    };
  }

  rejectExtraKeys(inputs, ["references"], "inputs");
  if (!Array.isArray(inputs.references) || inputs.references.length !== 1) {
    fail("SOL_H3_REF2VA_REFERENCE_COUNT", "ref2va MVP requires exactly one reference.");
  }
  return {
    schemaVersion,
    mode,
    prompt,
    seed,
    audio: { generate: true },
    inputs: {
      references: [normalizeSolH3MediaLocator(inputs.references[0], "inputs.references[0]")],
    },
  };
}

export function inferSolH3MediaKind(relativePath, declaredKind = undefined) {
  if (declaredKind) return declaredKind;
  const extension = String(relativePath).toLowerCase().split(".").pop();
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(extension)) return "image";
  if (["mp4", "mov", "webm", "mkv", "avi"].includes(extension)) return "video";
  if (["wav", "mp3", "m4a", "aac", "flac", "ogg"].includes(extension)) return "audio";
  return null;
}
