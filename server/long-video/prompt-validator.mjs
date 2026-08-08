import { LongVideoError } from "./schema.mjs";
import { REF2VA_FIELDS, T2VA_FIELDS } from "./prompt-builder.mjs";

function fieldNames(prompt) {
  return String(prompt || "").split(/\r?\n/).map((line) => line.match(/^\s*([a-z][a-z0-9_]*)\s*:/i)?.[1]).filter(Boolean);
}

export function validatePrompt(prompt, { mode = "t2v" } = {}) {
  const value = String(prompt || "").trim();
  if (!value) throw new LongVideoError("PROMPT_REQUIRED", "Prompt is required.", 400);
  if (mode === "i2v") {
    if (!/^For the target video, at 0\.00 seconds into the target video, <Picture 1> \(from \[Shot \d+\]\) is fully referenced\./.test(value)) throw new LongVideoError("PROMPT_I2VA_FIRST_LINE", "I2VA prompt must begin with the Picture 1 first-frame reference line.", 400);
  }
  const names = fieldNames(value);
  const required = mode === "ref2v" ? REF2VA_FIELDS : T2VA_FIELDS;
  const positions = required.map((field) => names.indexOf(field));
  if (positions.some((position) => position < 0) || positions.some((position, index) => index > 0 && position <= positions[index - 1])) {
    throw new LongVideoError("PROMPT_FIELDS_INVALID", `Prompt fields must appear in order: ${required.join(", ")}.`, 400, { required });
  }
  return { valid: true, mode, fields: required, prompt: value };
}

export const validateH3Prompt = validatePrompt;
