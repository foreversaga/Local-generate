import { validateH3Prompt, inspectH3Prompt, checkH3Prompt, normalizeH3Mode, T2VA_FIELDS, REF2VA_FIELDS } from "../h3-prompt/validator.mjs";

/**
 * Long-video's historical adapter accepts `{ mode }`.  Keep that surface,
 * while also accepting `{ inputType, duration }` for callers that validate a
 * single prompt before they have a normalized segment object.
 */
export function validatePrompt(prompt, options = {}) {
  const mode = options.mode ?? options.inputType ?? "t2v";
  return validateH3Prompt(prompt, { ...options, mode });
}

export { validateH3Prompt, inspectH3Prompt, checkH3Prompt, normalizeH3Mode, T2VA_FIELDS, REF2VA_FIELDS };
