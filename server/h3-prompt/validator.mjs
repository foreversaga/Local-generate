import { LongVideoError } from "../long-video/schema.mjs";

/**
 * The H3 prompt grammar is intentionally kept separate from request-level
 * validation.  This module checks the text contract that is sent to H3; it
 * does not impose the API's 4-15 second generation range.
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

const BASE_FIELDS = T2VA_FIELDS;
const FIELD_SET = new Set([...BASE_FIELDS, ...REF2VA_FIELDS]);
const SUMMARY_TASKS = [
  "keyframe completion",
  "reference generation",
  "video editing",
  "video continuation",
  "audio reuse",
  "audio reference",
];
const SUMMARY_TASK_PATTERN = SUMMARY_TASKS.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
const SUMMARY_TASK_RE = new RegExp(
  `^\\[(?:${SUMMARY_TASK_PATTERN})(?:\\s*\\+\\s*(?:${SUMMARY_TASK_PATTERN}))*\\]\\s+\\S`,
  "i",
);
const LABEL_RE = /<(Subject|Picture|Video|Audio)\s+(\d+)>/gi;
const SHOT_TIMESTAMP_PATTERN = "(?:\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)";
const SHOT_TIMESTAMP_START_RE = new RegExp(`^\\s*At\\s+${SHOT_TIMESTAMP_PATTERN}\\s*,`, "i");

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

function firstNonEmptyLine(value) {
  return value.split(/\r?\n/).find((line) => line.trim())?.trim() || "";
}

function parseFields(value, required) {
  const matches = [...value.matchAll(/^\s*([a-z][a-z0-9_]*)\s*:/gim)].map((match) => ({
    name: match[1].toLowerCase(),
    index: match.index,
    prefixLength: match[0].length,
  }));
  const recognized = matches.filter((match) => FIELD_SET.has(match.name));
  const names = recognized.map((match) => match.name);
  const first = names[0];
  if (first !== required[0]) {
    fail("PROMPT_FIRST_FIELD_INVALID", `Prompt must begin with ${required[0]}.`, { expected: required[0], actual: first || null });
  }
  const positions = required.map((field) => names.indexOf(field));
  const missing = required.filter((field, index) => positions[index] < 0);
  if (missing.length) {
    fail("PROMPT_FIELD_MISSING", `Prompt is missing required field(s): ${missing.join(", ")}.`, { missing, required });
  }
  const duplicate = required.find((field) => names.filter((name) => name === field).length > 1);
  if (duplicate) fail("PROMPT_FIELD_DUPLICATE", `Prompt field ${duplicate} may appear only once.`, { field: duplicate });
  if (positions.some((position, index) => index > 0 && position <= positions[index - 1])) {
    fail("PROMPT_FIELDS_INVALID", `Prompt fields must appear in order: ${required.join(", ")}.`, { required, fields: names });
  }
  const sections = {};
  for (let index = 0; index < required.length; index += 1) {
    const field = required[index];
    const match = recognized.find((entry) => entry.name === field);
    const next = recognized.find((entry) => entry.index > match.index);
    const end = next ? next.index : value.length;
    const content = value.slice(match.index + match.prefixLength, end).trim();
    if (!content) fail("PROMPT_FIELD_EMPTY", `Prompt field ${field} must not be empty.`, { field });
    sections[field] = content;
  }
  return { names, sections };
}

function parseClock(value) {
  const text = String(value);
  if (!text.includes(":")) return Number(text);
  const parts = text.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part)) || parts.length < 2 || parts.length > 3) return NaN;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function parseShots(body, duration, field) {
  const markers = [...body.matchAll(/\[Shot\s+(\d+)\]/gi)];
  if (!markers.length || Number(markers[0][1]) !== 1) {
    fail("PROMPT_SHOT1_REQUIRED", `${field} must contain [Shot 1].`, { field });
  }
  const shots = [];
  let previousTimestamp;
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    const shot = Number(marker[1]);
    const expected = index + 1;
    if (shot !== expected) {
      fail("PROMPT_SHOT_SEQUENCE", `${field} shot numbers must be sequential starting at [Shot 1].`, { field, expected, actual: shot });
    }
    let timestamp;
    if (index === 0 && SHOT_TIMESTAMP_START_RE.test(body.slice(marker.index + marker[0].length))) {
      fail("PROMPT_SHOT1_TIMESTAMP_FORBIDDEN", `${field} [Shot 1] must not include a timestamp.`, { field, shot: 1 });
    }
    if (index > 0) {
      const end = index + 1 < markers.length ? markers[index + 1].index : body.length;
      const prefix = body.slice(marker.index + marker[0].length, end);
      const match = prefix.match(new RegExp(`^\\s*At\\s+(${SHOT_TIMESTAMP_PATTERN})\\s*,`, "i"));
      if (!match) {
        fail("PROMPT_SHOT_TIMESTAMP_REQUIRED", `${field} [Shot ${shot}] must begin with an At <timestamp>, cut marker.`, { field, shot });
      }
      timestamp = parseClock(match[1]);
      if (!Number.isFinite(timestamp)) {
        fail("PROMPT_SHOT_TIMESTAMP_INVALID", `${field} [Shot ${shot}] contains an invalid timestamp.`, { field, shot, timestamp: match[1] });
      }
      if (previousTimestamp !== undefined && timestamp <= previousTimestamp + 1e-9) {
        fail("PROMPT_SHOT_TIMESTAMP_ORDER", `${field} shot timestamps must be strictly increasing.`, { field, shot, previousTimestamp, timestamp });
      }
      if (duration !== undefined && timestamp > duration + 1e-9) {
        fail("PROMPT_SHOT_TIMESTAMP_OUT_OF_RANGE", `${field} [Shot ${shot}] timestamp must be within the target duration.`, { field, shot, timestamp, duration });
      }
      previousTimestamp = timestamp;
    }
    shots.push({ shot, timestamp });
  }
  return shots;
}

function parseInstruction(mode, firstLine) {
  if (mode === "i2v") {
    const expected = "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.";
    if (firstLine !== expected) fail("PROMPT_I2VA_FIRST_LINE", "I2VA prompt must begin with the exact Picture 1 first-frame reference line.", { expected, actual: firstLine });
    return {};
  }
  if (mode === "t2v" || mode === "ref2v") return {};
  if (mode === "fl2v") {
    const match = firstLine.match(new RegExp(
      `^How the reference pictures align with the target video — Picture 1 \\(from Shot 1\\) aligns with the 0\\.00-second mark of the target video; Picture 2 \\(from Shot (\\d+)\\) aligns with the (\\d+\\.\\d{2})-second mark of the target video\\.$`,
    ));
    if (!match) fail("PROMPT_FL2VA_FIRST_LINE", "FL2VA prompt must begin with the two-picture alignment line using a two-decimal duration and a concrete final shot number.", { actual: firstLine });
    return { finalShot: Number(match[1]), instructionDuration: Number(match[2]) };
  }
  const match = firstLine.match(new RegExp(
    `^How the reference pictures align with the target video — <Picture 1> \\(from \\[Shot (\\d+)\\]\\) aligns with the (\\d+\\.\\d{2})-second mark of the target video\\.$`,
  ));
  if (!match) fail("PROMPT_L2VA_FIRST_LINE", "L2VA prompt must begin with the last-frame alignment line using a two-decimal duration and a concrete final shot number.", { actual: firstLine });
  return { finalShot: Number(match[1]), instructionDuration: Number(match[2]) };
}

function assertFieldPlacement(value, mode) {
  const lines = value.split(/\r?\n/);
  const first = lines[0] || "";
  const firstField = mode === "ref2v" ? "subject_definitions" : "integrated_multimodal_description";
  if (mode === "t2v" || mode === "ref2v") {
    if (!new RegExp(`^${firstField}\\s*:`, "i").test(first)) {
      fail("PROMPT_FIRST_LINE_INVALID", `${mode.toUpperCase()} prompt must begin directly with ${firstField}:.`, { expected: firstField, actual: first });
    }
    return;
  }
  const expectedLine = mode === "i2v"
    ? "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced."
    : mode === "fl2v"
      ? "How the reference pictures align with the target video — Picture 1"
      : "How the reference pictures align with the target video — <Picture 1>";
  if (lines[1] !== "" || !first.startsWith(expectedLine) || !new RegExp(`^${firstField}\\s*:`, "i").test(lines[2] || "")) {
    fail("PROMPT_ALIGNMENT_FIELD_GAP", `${mode.toUpperCase()} alignment instruction must be followed by exactly one blank line and then ${firstField}:.`, { expectedField: firstField });
  }
}

function validateDialogueTags(value) {
  const tokens = [...value.matchAll(/<\/?d\b[^>]*>/gi)];
  let openCount = 0;
  let closeCount = 0;
  for (const token of tokens) {
    const text = token[0];
    if (!/^<d>$|^<\/d>$/i.test(text)) {
      fail("PROMPT_DIALOGUE_TAG_INVALID", "Dialogue tags must use <d>[Language] ...</d> without attributes.");
    }
    if (/^<d>/i.test(text)) openCount += 1;
    else closeCount += 1;
  }
  if (openCount !== closeCount) fail("PROMPT_DIALOGUE_TAG_UNBALANCED", "Every <d> dialogue tag must have a matching </d> tag.", { openCount, closeCount });
  for (let index = 0; index < tokens.length; index += 1) {
    if (!/^<d>$/i.test(tokens[index][0])) continue;
    const close = tokens.slice(index + 1).find((token) => /^<\/d>$/i.test(token[0]));
    if (!close) break;
    const content = value.slice(tokens[index].index + tokens[index][0].length, close.index);
    if (!/^\s*\[[^\]\r\n]+\]\s+\S[\s\S]*$/u.test(content)) {
      fail("PROMPT_DIALOGUE_LANGUAGE_TAG", "Each <d> block must begin with a non-empty [Language] tag and spoken content.");
    }
    index += 1;
  }
}

function normalizeLabel(type, number) {
  return `<${type[0].toUpperCase()}${type.slice(1).toLowerCase()} ${Number(number)}>`;
}

function labelsIn(value) {
  const labels = new Set();
  for (const match of String(value).matchAll(LABEL_RE)) labels.add(normalizeLabel(match[1], match[2]));
  return labels;
}

function definedLabelsInSubjectDefinitions(value) {
  const labels = new Set();
  for (const line of String(value).split(/\r?\n/)) {
    const match = line.match(/^[ \t]*<(Subject|Picture|Video|Audio)\s+(\d+)>/i);
    if (!match || !line.slice(match[0].length).trim()) continue;
    labels.add(normalizeLabel(match[1], match[2]));
  }
  return labels;
}

function validateReferenceLabels(sections) {
  const defined = definedLabelsInSubjectDefinitions(sections.subject_definitions);
  if (!defined.size) fail("PROMPT_REFERENCE_DEFINITIONS_REQUIRED", "subject_definitions must define at least one <Subject>, <Picture>, <Video>, or <Audio> label.");
  const laterFields = REF2VA_FIELDS.slice(1).map((field) => sections[field]).join("\n");
  const unresolved = [...labelsIn(laterFields)].filter((label) => !defined.has(label));
  if (unresolved.length) {
    fail("PROMPT_REFERENCE_UNDEFINED", `Reference label(s) must be defined in subject_definitions before use: ${unresolved.join(", ")}.`, { labels: unresolved });
  }
  return [...defined];
}

/**
 * Validate a complete H3 prompt.  On success a compact, API-friendly result
 * is returned; failures are LongVideoError instances with stable codes and
 * optional details for UI repair messages.
 */
export function validateH3Prompt(prompt, options = {}) {
  const mode = normalizeH3Mode(options.mode ?? options.inputType ?? "t2v");
  const raw = typeof prompt === "string" ? prompt : String(prompt ?? "");
  if (!raw.trim()) fail("PROMPT_REQUIRED", "Prompt is required.");
  if (raw.length > H3_MAX_PROMPT_CHARS) {
    fail("PROMPT_TOO_LONG", `Prompt must be no more than ${H3_MAX_PROMPT_CHARS} characters.`, { maxChars: H3_MAX_PROMPT_CHARS, actualChars: raw.length });
  }
  const value = raw.trim();
  const firstLine = firstNonEmptyLine(value);
  const instruction = parseInstruction(mode, firstLine);
  assertFieldPlacement(value, mode);
  const duration = finiteDuration(options.duration) ?? instruction.instructionDuration;
  if (options.duration !== undefined && instruction.instructionDuration !== undefined && Math.abs(Number(options.duration) - instruction.instructionDuration) > 0.005) {
    fail("PROMPT_DURATION_MISMATCH", "Prompt alignment duration does not match the requested target duration.", { requested: Number(options.duration), instruction: instruction.instructionDuration });
  }
  const required = mode === "ref2v" ? REF2VA_FIELDS : BASE_FIELDS;
  const { sections } = parseFields(value, required);
  const bodyField = mode === "ref2v" ? "detailed_description" : "integrated_multimodal_description";
  const shots = parseShots(sections[bodyField], duration, bodyField);
  if (instruction.finalShot !== undefined && instruction.finalShot !== shots.at(-1).shot) {
    fail("PROMPT_FINAL_SHOT_MISMATCH", `The ${mode.toUpperCase()} alignment line must reference the actual final shot number.`, { expected: shots.at(-1).shot, actual: instruction.finalShot });
  }
  if (mode === "ref2v") {
    if (!SUMMARY_TASK_RE.test(sections.summary)) {
      fail("PROMPT_SUMMARY_TASK_PREFIX", "Ref2VA summary must begin with a supported bracketed task-type prefix.", { supportedTasks: SUMMARY_TASKS });
    }
    validateReferenceLabels(sections);
  }
  validateDialogueTags(value);
  return {
    valid: true,
    mode,
    fields: required,
    prompt: value,
    duration,
    shots,
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
