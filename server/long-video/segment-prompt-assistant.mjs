import { LongVideoError } from "./schema.mjs";

export const LONG_SEGMENT_PROMPT_PURPOSE = "long_video_segment_continuation";
const REF2VA_FIELDS = [
  "subject_definitions",
  "summary",
  "retention_analysis",
  "detailed_description",
  "overall_soundscape",
  "non_diegetic_music",
];

function text(value, maxLength, field, { required = false } = {}) {
  const normalized = String(value || "").trim();
  if (required && !normalized) throw new LongVideoError("LONG_SEGMENT_PROMPT_INPUT_REQUIRED", `${field} is required.`, 400);
  if (normalized.length > maxLength) throw new LongVideoError("LONG_SEGMENT_PROMPT_INPUT_TOO_LONG", `${field} must be no more than ${maxLength} characters.`, 400);
  return normalized;
}

export function normalizeLongSegmentPromptInput(value = {}) {
  const duration = Number(value.duration);
  if (!Number.isFinite(duration) || duration < 0.5 || duration > 60) {
    throw new LongVideoError("LONG_SEGMENT_PROMPT_DURATION_INVALID", "Segment duration must be between 0.5 and 60 seconds.", 400);
  }
  const segmentIndex = Number(value.segmentIndex);
  if (!Number.isInteger(segmentIndex) || segmentIndex < 1) {
    throw new LongVideoError("LONG_SEGMENT_PROMPT_INDEX_INVALID", "Continuation prompt generation starts from the second segment.", 400);
  }
  const staticReferenceCount = Math.min(8, Math.max(0, Number(value.staticReferenceCount) || 0));
  const continuationMode = value.continuationMode === "latent_context" ? "latent_context" : "motion_context";
  return {
    previousPrompt: text(value.previousPrompt, 7000, "Previous segment prompt", { required: true }),
    description: text(value.description, 4000, "Current segment description", { required: true }),
    negativePrompt: text(value.negativePrompt, 20_000, "Negative prompt"),
    duration: Number(duration.toFixed(3)),
    segmentIndex,
    staticReferenceCount,
    continuationMode,
  };
}

export function buildLongSegmentPromptUserMessage(value = {}) {
  const input = normalizeLongSegmentPromptInput(value);
  const pictures = input.staticReferenceCount
    ? `The runtime will supply ${input.staticReferenceCount} fixed image reference${input.staticReferenceCount === 1 ? "" : "s"}, labeled ${Array.from({ length: input.staticReferenceCount }, (_, index) => `<Picture ${index + 1}>`).join(", ")}. Use them only as identity, appearance, environment, or style references; they are not frame-zero locks.`
    : "No fixed reference image will be supplied. Do not invent or define a <Picture N> label.";
  return [
    `Write the Ref2VA prompt and negative prompt for storyboard segment ${input.segmentIndex + 1}.`,
    input.continuationMode === "latent_context"
      ? `Delivered target duration: ${input.duration.toFixed(3)} seconds after the protected prefix is trimmed. This shot directly continues the preceding timeline.`
      : `Target duration: ${input.duration.toFixed(3)} seconds. This is an independently composed storyboard shot.`,
    pictures,
    input.continuationMode === "latent_context"
      ? "The runtime copies and protects the immediately preceding segment's final 39-frame audiovisual latent at the beginning of this generation, then trims that repeated prefix from delivery. Do not invent a <Video N> label. Begin by preserving the inherited composition, pose, object state, camera direction, motion velocity, ambience, and timing; introduce the new action only after the inherited state is established. Use [video continuation + reference generation]."
      : "The runtime will supply <Video 1>, the immediately preceding segment's final two silent seconds. Use it only as a weak visual reference for explicit character identity, environment, lighting, and ending visual state. Do not copy audio, replay the prior footage, lock its last frame at time zero, or continue the previous camera motion.",
    "Use the previous prompt only as textual continuity evidence. Preserve explicit identity and world details that remain relevant, but make the current storyboard description authoritative for this segment's action and composition. Never invent face shape, eyes, hair, clothing, body features, props, or environmental details that are not explicitly stated in the previous prompt or current description; keep an unspecified subject generic instead.",
    "Previous segment H3 prompt:",
    input.previousPrompt,
    "",
    "Current storyboard description:",
    input.description,
    input.negativePrompt ? `\nExisting negative constraints to preserve and refine:\n${input.negativePrompt}` : "",
    "",
    "Return exactly one JSON object with exactly two string keys: prompt and negativePrompt. prompt must be a complete English Ref2VA prompt using these six top-level fields in order: subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music. negativePrompt must be a concise English comma-separated list of visual and continuity failures to avoid. Do not return Markdown or commentary.",
  ].filter(Boolean).join("\n");
}

export function parseLongSegmentPromptResponse(value, { staticReferenceCount = 0, continuationMode = "motion_context" } = {}) {
  const raw = String(value || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new LongVideoError("LONG_SEGMENT_PROMPT_INVALID_JSON", "Ollama did not return the required prompt JSON.", 502, { cause: error.message });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LongVideoError("LONG_SEGMENT_PROMPT_INVALID_JSON", "Ollama must return one prompt JSON object.", 502);
  }
  const prompt = normalizeLongSegmentPromptStructure(text(parsed.prompt, 7000, "Generated prompt", { required: true }));
  if (continuationMode !== "latent_context" && !/<Video\s+1>/i.test(prompt)) {
    throw new LongVideoError("LONG_SEGMENT_PROMPT_REFERENCE_MISSING", "Ollama Ref2VA prompt must define and use <Video 1> for the previous segment context.", 502);
  }
  if (continuationMode === "latent_context" && /<Video\s+\d+>/i.test(prompt)) {
    throw new LongVideoError("LONG_SEGMENT_PROMPT_REFERENCE_INVALID", "Latent continuation must not invent a <Video N> reference label.", 502);
  }
  if (continuationMode === "latent_context" && !/summary\s*:\s*\[(?=[^\]]*video continuation)(?=[^\]]*reference generation)[^\]]+\]/i.test(prompt)) {
    throw new LongVideoError("LONG_SEGMENT_PROMPT_TASK_INVALID", "Latent continuation summary must use video continuation + reference generation.", 502);
  }
  for (let index = 1; index <= Math.min(8, Math.max(0, Number(staticReferenceCount) || 0)); index += 1) {
    if (!new RegExp(`<Picture\\s+${index}>`, "i").test(prompt)) {
      throw new LongVideoError("LONG_SEGMENT_PROMPT_REFERENCE_MISSING", `Ollama Ref2VA prompt must define and use <Picture ${index}>.`, 502);
    }
  }
  return {
    prompt,
    negativePrompt: text(parsed.negativePrompt, 20_000, "Generated negative prompt", { required: true }),
  };
}

export function normalizeLongSegmentPromptStructure(value) {
  let prompt = String(value || "").trim();
  for (const field of REF2VA_FIELDS) {
    const heading = new RegExp(`^[\\t ]*${field}[\\t ]*:?[\\t ]*$`, "im");
    if (heading.test(prompt)) prompt = prompt.replace(heading, `${field}:`);
  }
  let cursor = -1;
  for (const field of REF2VA_FIELDS) {
    const index = prompt.toLocaleLowerCase().indexOf(`${field}:`);
    if (index < 0 || index <= cursor) {
      throw new LongVideoError(
        "LONG_SEGMENT_PROMPT_STRUCTURE_INVALID",
        `Ollama prompt must contain the six Ref2VA sections in order; invalid section: ${field}.`,
        502,
      );
    }
    cursor = index;
  }
  if (!/\[Shot\s+1\]/i.test(prompt)) {
    throw new LongVideoError("LONG_SEGMENT_PROMPT_STRUCTURE_INVALID", "Ollama Ref2VA prompt must contain [Shot 1].", 502);
  }
  return prompt;
}

export function buildLongSegmentPromptRepairMessage(originalMessage, previousResponse, error) {
  return [
    originalMessage,
    "",
    "REPAIR REQUEST:",
    `The previous response was invalid: ${error?.message || String(error)}.`,
    `Previous response: ${String(previousResponse || "").slice(0, 8000)}`,
    "Return the complete corrected JSON object only, with exactly prompt and negativePrompt string keys.",
  ].join("\n");
}
