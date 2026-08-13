import { LongVideoError } from "../long-video/schema.mjs";

/**
 * Validate the request-level boundaries for a prompt sent to H3.
 *
 * Prompt content is intentionally treated as user-authored text here.  H3
 * formatting (fields, alignment lines, shot markers, reference labels, and
 * dialogue notation) is no longer a submission gate: callers may send a
 * normal sentence, a complete H3 prompt, or any other non-empty text.
 */

export const H3_MODES = Object.freeze(["t2v", "i2v", "fl2v", "l2v", "ref2v"]);
export const T2VA_FIELDS = Object.freeze([
  "integrated_multimodal_description",
  "overall_soundscape",
  "non_diegetic_music",
]);
export const REF2VA_FIELDS = Object.freeze([
  "subject_definitions",
  "summary",
  "retention_analysis",
  "detailed_description",
  "overall_soundscape",
  "non_diegetic_music",
]);
export const H3_MAX_PROMPT_CHARS = 7000;
export const MAX_PROMPT_CHARS = H3_MAX_PROMPT_CHARS;

const FIELD_SET = new Set([...T2VA_FIELDS, ...REF2VA_FIELDS]);
const MODE_ALIASES = new Map([
  ["t2va", "t2v"],
  ["i2va", "i2v"],
  ["fl2va", "fl2v"],
  ["l2va", "l2v"],
  ["ref2va", "ref2v"],
  ["text", "t2v"],
  ["image", "i2v"],
]);

function fail(code, message, details = undefined) {
  throw new LongVideoError(code, message, 400, details);
}

export function normalizeH3Mode(mode = "t2v") {
  const key = String(mode ?? "t2v").trim().toLowerCase().replaceAll("-", "").replaceAll("_", "");
  const normalized = MODE_ALIASES.get(key) || key;
  if (!H3_MODES.includes(normalized)) {
    fail("PROMPT_MODE_INVALID", `Unsupported H3 prompt mode: ${String(mode)}.`, { mode, supportedModes: H3_MODES });
  }
  return normalized;
}

function finiteDuration(value) {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0) {
    fail("PROMPT_DURATION_INVALID", "Prompt duration must be a positive number when supplied.", { duration: value });
  }
  return duration;
}

function recognizedFields(value) {
  const names = [];
  for (const match of String(value).matchAll(/^\s*([a-z][a-z0-9_]*)\s*:/gim)) {
    const name = match[1].toLowerCase();
    if (FIELD_SET.has(name)) names.push(name);
  }
  return names;
}

/**
 * Keep a useful, non-blocking view of conventional H3 prompts for callers
 * that display diagnostics.  This deliberately does not validate ordering,
 * duplicates, section contents, timestamps, or any other prompt grammar.
 */
function inspectStructuredShape(value, mode) {
  const fields = recognizedFields(value);
  const required = mode === "ref2v" ? REF2VA_FIELDS : T2VA_FIELDS;
  const structured = required.every((field) => fields.includes(field));
  const shots = structured
    ? [...String(value).matchAll(/\[Shot\s+(\d+)\]/gi)].map((match) => ({ shot: Number(match[1]) }))
    : [];
  return {
    fields,
    shots,
    structured,
  };
}

/**
 * Validate only the stable request contract.  A successful result keeps the
 * historical API shape (`fields`, `shots`, and `structured`) while allowing
 * every prompt format, including ordinary natural-language text.
 */
export function validateH3Prompt(prompt, options = {}) {
  const mode = normalizeH3Mode(options.mode ?? options.inputType ?? "t2v");
  const raw = typeof prompt === "string" ? prompt : String(prompt ?? "");
  if (!raw.trim()) fail("PROMPT_REQUIRED", "Prompt is required.");
  if (raw.length > H3_MAX_PROMPT_CHARS) {
    fail("PROMPT_TOO_LONG", `Prompt must be no more than ${H3_MAX_PROMPT_CHARS} characters.`, {
      maxChars: H3_MAX_PROMPT_CHARS,
      actualChars: raw.length,
    });
  }

  const value = raw.trim();
  const duration = finiteDuration(options.duration);
  const shape = inspectStructuredShape(value, mode);
  return {
    valid: true,
    mode,
    fields: shape.fields,
    prompt: value,
    duration,
    shots: shape.shots,
    structured: shape.structured,
  };
}

/** Return a non-throwing result for API callers that want to display errors. */
export function inspectH3Prompt(prompt, options = {}) {
  try {
    return validateH3Prompt(prompt, options);
  } catch (error) {
    return {
      valid: false,
      mode: (() => {
        try { return normalizeH3Mode(options.mode ?? options.inputType ?? "t2v"); } catch { return options.mode ?? options.inputType ?? "t2v"; }
      })(),
      error: { code: error?.code || "PROMPT_INVALID", message: error?.message || String(error), ...(error?.details ? { details: error.details } : {}) },
    };
  }
}

export const checkH3Prompt = inspectH3Prompt;
