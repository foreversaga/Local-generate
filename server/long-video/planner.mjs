import { parseTimeline } from "./timeline-parser.mjs";
import { LongVideoError, sanitizeAssetRef, validateContinuityBible, validateSequenceInput } from "./schema.mjs";
import { buildSegmentPrompt } from "./prompt-builder.mjs";

function stripJsonFence(value) {
  return String(value || "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
}

function parseResponse(value) {
  if (value && typeof value === "object") {
    if (value.response !== undefined) return parseResponse(value.response);
    if (value.message?.content !== undefined) return parseResponse(value.message.content);
    return value;
  }
  const text = stripJsonFence(value);
  try { return JSON.parse(text); } catch (error) {
    throw new LongVideoError("OLLAMA_INVALID_JSON", "Ollama returned invalid JSON for sequence planning.", 502, { cause: error.message });
  }
}

function plannerPrompt(input, canonicalTimeline = []) {
  const source = input.inputType === "image"
    ? `The supplied image asset is the first frame reference (${input.inputAsset?.name || input.inputAsset || "provided asset"}). Do not describe unseen image details as facts; preserve it as an explicit reference.`
    : `Text brief: ${input.inputText || input.brief || ""}`;
  return [
    "Return JSON only. Plan a coherent MiniMax H3 long-video sequence.",
    "The JSON object must contain continuityBible and segments.",
    "continuityBible fields: visualStyle, characters, environment, lighting, camera, motionDirection, keyObjects, sound, nonDiegeticMusic, mustPreserve, mustAvoid.",
    "segments must contain at least two semantic entries; do not change the supplied start/end times.",
    `Canonical timeline (authoritative): ${JSON.stringify(canonicalTimeline.map(({ start, end, duration, description }) => ({ start, end, duration, description })))}.`,
    source,
  ].join("\n");
}

export async function planSequence(input, {
  fetchImpl = globalThis.fetch,
  ollamaUrl = process.env.OLLAMA_URL || "http://127.0.0.1:11434",
  model = input?.ollamaModel || input?.model || "gemma4:12b",
  timeoutMs = 120000,
  request = null,
} = {}) {
  const normalizedInput = validateSequenceInput(input || {});
  if (normalizedInput.inputType === "text" && !normalizedInput.inputText && !normalizedInput.brief && !input.timelineText && !input.storyboard) {
    throw new LongVideoError("PLAN_INPUT_REQUIRED", "Text planning requires inputText.", 400);
  }
  if (normalizedInput.inputType === "image" && !normalizedInput.inputAsset) {
    throw new LongVideoError("PLAN_IMAGE_REQUIRED", "Image planning requires an inputAsset reference.", 400);
  }
  let canonicalTimeline;
  if (input.timelineText || input.storyboard) {
    canonicalTimeline = parseTimeline(input.timelineText || input.storyboard, { duration: normalizedInput.duration });
  } else if (Array.isArray(input.timeline) || Array.isArray(input.segments)) {
    canonicalTimeline = parseTimeline(input.timeline || input.segments, { duration: normalizedInput.duration });
  } else if (normalizedInput.duration !== undefined) {
    const half = Number((normalizedInput.duration / 2).toFixed(3));
    canonicalTimeline = parseTimeline([
      { start: 0, end: half, description: "Opening segment" },
      { start: half, end: normalizedInput.duration, description: "Continuation segment" },
    ], { duration: normalizedInput.duration });
  } else {
    throw new LongVideoError("TIMELINE_REQUIRED", "Planning requires timelineText/storyboard or a duration.", 400);
  }
  let raw;
  try {
    if (request) raw = await request({ input: { ...normalizedInput, timeline: canonicalTimeline }, model, prompt: plannerPrompt(normalizedInput, canonicalTimeline) });
    else {
      if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
      const response = await fetchImpl(`${String(ollamaUrl).replace(/\/$/, "")}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: plannerPrompt(normalizedInput, canonicalTimeline), stream: false, format: "json" }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = typeof response.text === "function"
        ? await response.text()
        : JSON.stringify(await response.json());
      if (!response.ok) throw new LongVideoError("OLLAMA_REQUEST_FAILED", `Ollama planning failed (${response.status}).`, 502, { body: text.slice(-2000) });
      try {
        raw = JSON.parse(text || "{}");
      } catch (error) {
        throw new LongVideoError("OLLAMA_INVALID_JSON", "Ollama returned invalid JSON for sequence planning.", 502, { cause: error.message });
      }
    }
  } catch (error) {
    if (error instanceof LongVideoError) throw error;
    throw new LongVideoError("OLLAMA_UNAVAILABLE", `Unable to reach Ollama: ${error.message}`, 502);
  }
  const parsed = parseResponse(raw);
  const bible = validateContinuityBible(parsed.continuityBible || parsed.continuity_bible);
  const semanticSegments = Array.isArray(parsed.segments) ? parsed.segments : Array.isArray(parsed.timeline) ? parsed.timeline : [];
  const segments = canonicalTimeline.map((canonical, index) => ({
    ...canonical,
    ...(semanticSegments[index] && typeof semanticSegments[index] === "object" ? semanticSegments[index] : {}),
    start: canonical.start,
    end: canonical.end,
    duration: canonical.duration,
    description: semanticSegments[index]?.description || semanticSegments[index]?.scene || canonical.description,
  }));
  // The first text segment is T2VA; every continuation segment is I2VA so
  // the previous normalized tail can be used as Picture 1. Image input starts
  // with I2VA and continues with I2VA as well.
  const drafts = segments.map((segment, index) => ({
    ...segment,
    id: segment.id || `segment-${String(index + 1).padStart(3, "0")}`,
    mode: normalizedInput.inputType === "image" || index > 0 ? "i2v" : "t2v",
    prompt: segment.prompt || buildSegmentPrompt(segment, bible, {
      mode: normalizedInput.inputType === "image" || index > 0 ? "i2v" : "t2v",
      firstFrame: index === 0,
    }),
    status: "pending",
  }));
  return {
    title: normalizedInput.title,
    inputType: normalizedInput.inputType,
    ...(normalizedInput.imagePurpose ? { imagePurpose: normalizedInput.imagePurpose } : {}),
    ...(normalizedInput.inputText ? { inputText: normalizedInput.inputText } : {}),
    ...(normalizedInput.inputAsset ? { inputAsset: sanitizeAssetRef(normalizedInput.inputAsset) } : {}),
    duration: normalizedInput.duration ?? drafts[drafts.length - 1].end,
    continuityBible: bible,
    segments: drafts,
    timeline: drafts,
    planMeta: { model, generatedAt: new Date().toISOString(), source: "ollama" },
  };
}

export { plannerPrompt, parseResponse as parsePlannerResponse };
export const createPlan = planSequence;
