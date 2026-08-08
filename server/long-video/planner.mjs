import { parseTimeline } from "./timeline-parser.mjs";
import { LongVideoError, sanitizeAssetRef, validateContinuityBible, validateSequenceInput, validateTimeline } from "./schema.mjs";
import { buildSegmentPrompt } from "./prompt-builder.mjs";
import { validatePrompt } from "./prompt-validator.mjs";

const DEFAULT_NEGATIVE_PROMPT = "blurry, low quality, flicker, jitter, identity drift, costume drift, deformed face, extra limbs, warped hands, text, logo, watermark";

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

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function hasTimelineInput(input) {
  return Boolean(clean(input?.timelineText || input?.storyboard)) || Array.isArray(input?.timeline) || Array.isArray(input?.segments);
}

function planningMode(input) {
  if (input?.timelineMode === "auto" || input?.timelineMode === "manual") return input.timelineMode;
  return hasTimelineInput(input) ? "manual" : "auto";
}

function segmentDurationHint(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 5;
  return Number(Math.min(60, Math.max(0.5, number)).toFixed(3));
}

function mergeNegativePrompt(userValue, modelValue) {
  const user = clean(userValue);
  const model = clean(modelValue);
  if (!user) return model || DEFAULT_NEGATIVE_PROMPT;
  if (!model || model.toLocaleLowerCase().includes(user.toLocaleLowerCase())) return user;
  return `${user}, ${model}`;
}

function plannerPrompt(input, canonicalTimeline = null) {
  const mode = planningMode(input);
  const duration = Number(input.duration);
  const hint = segmentDurationHint(input.segmentDurationHint);
  const suggestedCount = Number.isFinite(duration)
    ? Math.min(120, Math.max(2, Math.ceil(duration / hint), Math.ceil(duration / 60)))
    : 2;
  const idea = clean(input.inputText || input.brief);
  const source = [
    idea ? `User's complete story direction: ${idea}` : "",
    input.inputType === "image"
      ? `The supplied image asset is the first frame reference (${input.inputAsset?.name || input.inputAsset || "provided asset"}). Do not invent unseen image details; write the first segment as I2VA and preserve the referenced frame.`
      : "The first segment is T2VA. Every later segment is I2VA and starts from the actual normalized tail frame of the previous segment.",
    clean(input.negativePrompt) ? `User negative constraints that must be preserved: ${clean(input.negativePrompt)}` : "",
  ].filter(Boolean).join("\n");
  const timing = mode === "manual"
    ? [
        "The author supplied the authoritative global timeline below. Return exactly the same number of segments in the same order. The server will ignore any changed timing.",
        `Authoritative timeline: ${JSON.stringify((canonicalTimeline || []).map(({ start, end, duration: segmentDuration, description }) => ({ start, end, duration: segmentDuration, description })))}.`,
      ].join("\n")
    : [
        `Create the global storyboard timing yourself for exactly ${duration.toFixed(3)} seconds, aiming for about ${suggestedCount} segments near ${hint.toFixed(3)} seconds each.`,
        "Return at least two contiguous segments. The first starts at 0, every next start equals the previous end, and the final end equals the target duration.",
        "Each segment duration must be between 0.5 and 60 seconds. Choose cut points for narrative and motion continuity, then calculate start and end exactly with no gaps or overlaps.",
      ].join("\n");
  return [
    "Return one JSON object only. Do not use markdown or commentary.",
    "Plan a coherent MiniMax H3 long-video sequence from the user's direction.",
    timing,
    "Required top-level JSON keys: negativePrompt, continuityBible, segments.",
    "continuityBible keys: visualStyle, characters, environment, lighting, camera, motionDirection, keyObjects, sound, nonDiegeticMusic, mustPreserve, mustAvoid.",
    "Each character uses id, appearance, clothing, and optional voice.",
    "Each segment must use these keys: start, end, description, integratedMultimodalDescription, overallSoundscape, nonDiegeticMusic, continuityNote, endingState, negativePrompt.",
    "start and end are global seconds. description is a concise editable storyboard summary. endingState is a concise description of the exact final visual state that the next segment must continue.",
    "integratedMultimodalDescription is English H3 content for this segment only. It must begin with [Shot 1], cover composition, subjects, environment, action, camera, dialogue and diegetic sound, and use timestamps relative to this segment starting at 0 only for later cuts.",
    "overallSoundscape is 1-4 English sentences. nonDiegeticMusic is 1-3 English sentences or N/A. Preserve dialogue, lyrics, and visible text in their original language.",
    "For continuation segments, describe forward motion from Picture 1 without writing the Picture 1 instruction line; the server adds the exact I2VA wrapper.",
    "negativePrompt is the full-video negative prompt. A segment negativePrompt may add only segment-specific exclusions and may otherwise be an empty string.",
    source,
  ].join("\n");
}

function modelTimeline(segments, duration) {
  if (!Array.isArray(segments) || segments.length < 2) {
    throw new LongVideoError("OLLAMA_TIMELINE_INVALID", "Ollama must return at least two timed storyboard segments.", 502);
  }
  try {
    return validateTimeline(segments, duration);
  } catch (error) {
    if (error instanceof LongVideoError) {
      throw new LongVideoError("OLLAMA_TIMELINE_INVALID", `Ollama returned an invalid storyboard timeline: ${error.message}`, 502, { causeCode: error.code });
    }
    throw error;
  }
}

function responseExcerpt(value) {
  let content = value;
  if (content && typeof content === "object" && content.response !== undefined) content = content.response;
  else if (content && typeof content === "object" && content.message?.content !== undefined) content = content.message.content;
  if (typeof content !== "string") {
    try { content = JSON.stringify(content); } catch { content = String(content); }
  }
  return String(content || "").slice(0, 12000);
}

function repairPlannerPrompt(basePrompt, raw, error, { duration, timelineMode }) {
  const timingRule = timelineMode === "auto"
    ? `The corrected timeline must start at 0, contain at least two contiguous segments, and end at exactly ${Number(duration).toFixed(3)} seconds.`
    : "Keep the authoritative segment count and order from the original request; do not change its timing.";
  return [
    basePrompt,
    "",
    "CORRECTION REQUEST: The previous response failed server validation.",
    `Failure code: ${error.code}.`,
    `Failure reason: ${error.message}`,
    timingRule,
    "Return the complete corrected JSON object only, with all required top-level, continuityBible, and segment fields. Do not explain the correction.",
    `Previous response to repair: ${responseExcerpt(raw)}`,
  ].join("\n");
}

async function requestPlannerModel({ request, requestInput, model, prompt, fetchImpl, ollamaUrl, timeoutMs, attempt }) {
  try {
    if (request) return await request({ input: requestInput, model, prompt, attempt, repair: attempt > 1 });
    if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
    const response = await fetchImpl(`${String(ollamaUrl).replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false, format: "json", options: { temperature: attempt > 1 ? 0.2 : 0.65, top_p: attempt > 1 ? 0.75 : 0.9 } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = typeof response.text === "function"
      ? await response.text()
      : JSON.stringify(await response.json());
    if (!response.ok) throw new LongVideoError("OLLAMA_REQUEST_FAILED", `Ollama planning failed (${response.status}).`, 502, { body: text.slice(-2000) });
    try {
      return JSON.parse(text || "{}");
    } catch {
      // Pass the raw response to the plan parser so a malformed first reply
      // can be included in one bounded correction request.
      return text;
    }
  } catch (error) {
    if (error instanceof LongVideoError) throw error;
    throw new LongVideoError("OLLAMA_UNAVAILABLE", `Unable to reach Ollama: ${error.message}`, 502);
  }
}

function promptDraft(segment, bible, mode) {
  const rawPrompt = clean(segment.prompt);
  if (rawPrompt) {
    try {
      validatePrompt(rawPrompt, { mode });
      return { prompt: rawPrompt, promptSource: "ollama" };
    } catch {
      // Structured fields below are composed server-side into the exact H3
      // wrapper when a local model returns a malformed full prompt.
    }
  }
  const prompt = buildSegmentPrompt(segment, bible, { mode, firstFrame: mode === "i2v", pictureLabel: "Picture 1", shotId: "Shot 1" });
  validatePrompt(prompt, { mode });
  return { prompt, promptSource: "ollama_structured" };
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
  const timelineMode = planningMode(input);
  const durationHint = segmentDurationHint(input.segmentDurationHint);
  let canonicalTimeline = null;
  if (timelineMode === "manual") {
    if (input.timelineText || input.storyboard) {
      canonicalTimeline = parseTimeline(input.timelineText || input.storyboard, { duration: normalizedInput.duration });
    } else if (Array.isArray(input.timeline) || Array.isArray(input.segments)) {
      canonicalTimeline = parseTimeline(input.timeline || input.segments, { duration: normalizedInput.duration });
    } else {
      throw new LongVideoError("TIMELINE_REQUIRED", "Manual planning requires timelineText/storyboard or timeline segments.", 400);
    }
  } else if (normalizedInput.duration === undefined || normalizedInput.duration < 1) {
    throw new LongVideoError("AUTO_TIMELINE_DURATION_REQUIRED", "Automatic storyboard planning requires a total duration of at least 1 second.", 400);
  }
  const requestInput = {
    ...normalizedInput,
    timelineMode,
    segmentDurationHint: durationHint,
    ...(canonicalTimeline ? { timeline: canonicalTimeline } : {}),
  };
  const basePrompt = plannerPrompt(requestInput, canonicalTimeline);
  let activePrompt = basePrompt;
  let parsed;
  let semanticSegments = [];
  let repairAttempts = 0;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const raw = await requestPlannerModel({ request, requestInput, model, prompt: activePrompt, fetchImpl, ollamaUrl, timeoutMs, attempt });
    try {
      const candidate = parseResponse(raw);
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new LongVideoError("OLLAMA_INVALID_JSON", "Ollama must return one JSON object for sequence planning.", 502);
      }
      const candidateSegments = Array.isArray(candidate.segments) ? candidate.segments : Array.isArray(candidate.timeline) ? candidate.timeline : [];
      if (timelineMode === "auto") canonicalTimeline = modelTimeline(candidateSegments, normalizedInput.duration);
      parsed = candidate;
      semanticSegments = candidateSegments;
      repairAttempts = attempt - 1;
      break;
    } catch (error) {
      const repairable = error instanceof LongVideoError && ["OLLAMA_INVALID_JSON", "OLLAMA_TIMELINE_INVALID"].includes(error.code);
      if (attempt === 1 && repairable) {
        console.warn("[long-video] planner.retry", JSON.stringify({ model, attempt, errorCode: error.code, timelineMode }));
        activePrompt = repairPlannerPrompt(basePrompt, raw, error, { duration: normalizedInput.duration, timelineMode });
        continue;
      }
      throw error;
    }
  }
  if (!parsed) throw new LongVideoError("OLLAMA_INVALID_JSON", "Ollama did not return a usable sequence plan.", 502);
  const bible = validateContinuityBible(parsed.continuityBible || parsed.continuity_bible);
  const negativePrompt = mergeNegativePrompt(normalizedInput.negativePrompt, parsed.negativePrompt || parsed.negative_prompt);
  const segments = canonicalTimeline.map((canonical, index) => ({
    ...canonical,
    ...(semanticSegments[index] && typeof semanticSegments[index] === "object" ? semanticSegments[index] : {}),
    start: canonical.start,
    end: canonical.end,
    duration: canonical.duration,
    description: clean(semanticSegments[index]?.description || semanticSegments[index]?.scene) || canonical.description,
  }));
  // The first text segment is T2VA; every continuation segment is I2VA so
  // the previous normalized tail can be used as Picture 1. Image input starts
  // with I2VA and continues with I2VA as well.
  const drafts = segments.map((segment, index) => {
    const mode = normalizedInput.inputType === "image" || index > 0 ? "i2v" : "t2v";
    const generated = promptDraft(segment, bible, mode);
    return {
      ...segment,
      id: segment.id || `segment-${String(index + 1).padStart(3, "0")}`,
      mode,
      ...generated,
      negativePrompt: clean(segment.negativePrompt || segment.negative_prompt),
      status: "pending",
    };
  });
  return {
    title: normalizedInput.title,
    inputType: normalizedInput.inputType,
    ...(normalizedInput.imagePurpose ? { imagePurpose: normalizedInput.imagePurpose } : {}),
    ...(normalizedInput.inputText ? { inputText: normalizedInput.inputText } : {}),
    ...(normalizedInput.inputAsset ? { inputAsset: sanitizeAssetRef(normalizedInput.inputAsset) } : {}),
    duration: normalizedInput.duration ?? drafts[drafts.length - 1].end,
    negativePrompt,
    ollamaModel: model,
    continuityBible: bible,
    segments: drafts,
    timeline: drafts,
    planningSettings: {
      timelineMode,
      targetDuration: normalizedInput.duration ?? drafts[drafts.length - 1].end,
      segmentDurationHint: durationHint,
      segmentCount: drafts.length,
    },
    planMeta: {
      model,
      generatedAt: new Date().toISOString(),
      source: "ollama",
      timelineSource: timelineMode === "auto" ? "ollama" : "author",
      promptSource: drafts.every((segment) => segment.promptSource === "ollama") ? "ollama" : "ollama_structured",
      segmentDurationHint: durationHint,
      repairAttempts,
    },
  };
}

export { plannerPrompt, parseResponse as parsePlannerResponse };
export const createPlan = planSequence;
