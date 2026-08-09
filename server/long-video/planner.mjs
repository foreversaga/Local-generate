import { parseTimeline } from "./timeline-parser.mjs";
import { LongVideoError, sanitizeAssetRef, validateContinuityBible, validateSequenceInput, validateTimeline } from "./schema.mjs";
import { buildSegmentPrompt } from "./prompt-builder.mjs";
import { validatePrompt } from "./prompt-validator.mjs";

const DEFAULT_NEGATIVE_PROMPT = "blurry, low quality, flicker, jitter, identity drift, costume drift, deformed face, extra limbs, warped hands, unwanted random text, logo, watermark";
export const DEFAULT_OLLAMA_MODEL = "huihui_ai/qwen3-vl-abliterated:32b-instruct-q4_K_M";

function stripJsonFence(value) {
  return String(value || "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
}

function plannerProvider(input) {
  return input?.provider === "codex" || input?.promptProvider === "codex" ? "codex" : "ollama";
}

function plannerErrorCode(provider, suffix) {
  return `${provider === "codex" ? "CODEX" : "OLLAMA"}_${suffix}`;
}

function parseResponse(value, provider = "ollama") {
  if (value && typeof value === "object") {
    if (value.response !== undefined) return parseResponse(value.response, provider);
    if (value.message?.content !== undefined) return parseResponse(value.message.content, provider);
    return value;
  }
  const text = stripJsonFence(value);
  try { return JSON.parse(text); } catch (error) {
    // Codex occasionally adds one short sentence before or after an
    // otherwise valid JSON object. Recover the outer object before spending
    // another full CLI request on a formatting-only failure.
    const firstObject = text.indexOf("{");
    const lastObject = text.lastIndexOf("}");
    if (firstObject >= 0 && lastObject > firstObject) {
      try { return JSON.parse(text.slice(firstObject, lastObject + 1)); } catch {
        // Preserve the provider-specific INVALID_JSON error below.
      }
    }
    const label = provider === "codex" ? "Codex CLI" : "Ollama";
    throw new LongVideoError(plannerErrorCode(provider, "INVALID_JSON"), `${label} returned invalid JSON for sequence planning.`, 502, { cause: error.message });
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

function effectiveReferenceAssets(input) {
  if (input?.referenceMode !== "multi_reference") return [];
  const references = [];
  const seen = new Set();
  for (const reference of [input.inputAsset, ...(Array.isArray(input.referenceAssets) ? input.referenceAssets : [])]) {
    if (!reference?.name) continue;
    const normalized = { root: reference.root === "output" ? "output" : "input", name: String(reference.name).replaceAll("\\", "/"), kind: "image" };
    const key = `${normalized.root}:${normalized.name}`.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    references.push(normalized);
  }
  return references;
}

function plannerPrompt(input, canonicalTimeline = null) {
  const mode = planningMode(input);
  const duration = Number(input.duration);
  const hint = segmentDurationHint(input.segmentDurationHint);
  const suggestedCount = Number.isFinite(duration)
    ? Math.min(120, Math.max(2, Math.ceil(duration / hint), Math.ceil(duration / 60)))
    : 2;
  const idea = clean(input.inputText || input.brief);
  const multiReference = input.referenceMode === "multi_reference";
  const referenceAssets = effectiveReferenceAssets(input);
  const source = [
    idea ? `User's complete story direction: ${idea}` : "",
    multiReference
      ? `This sequence uses multi-reference Ref2VA. Treat the supplied image assets as ordered static references (${referenceAssets.map((reference, index) => `Picture ${index + 1}=${reference.name}`).join(", ") || "Picture 1"}), not as a first-frame lock. Every segment must use Ref2VA; continuation segments may append the previous normalized tail as the final reference while preserving the static reference order.`
      : input.inputType === "image"
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
    input.referenceMode === "multi_reference"
      ? `Use Ref2VA for every segment. Ordered static image references are: ${referenceAssets.map((reference, index) => `Picture ${index + 1} (${reference.name || "asset"})`).join(", ") || "provided references"}. Do not write a first-frame lock or I2VA continuation instruction.`
      : "",
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

function modelTimeline(segments, duration, provider = "ollama") {
  const label = provider === "codex" ? "Codex CLI" : "Ollama";
  if (!Array.isArray(segments) || segments.length < 2) {
    throw new LongVideoError(plannerErrorCode(provider, "TIMELINE_INVALID"), `${label} must return at least two timed storyboard segments.`, 502);
  }
  try {
    return validateTimeline(segments, duration);
  } catch (error) {
    if (error instanceof LongVideoError) {
      throw new LongVideoError(plannerErrorCode(provider, "TIMELINE_INVALID"), `${label} returned an invalid storyboard timeline: ${error.message}`, 502, { causeCode: error.code });
    }
    throw error;
  }
}

function recoverContiguousTimeline(segments, duration, segmentDurationHint) {
  if (!Array.isArray(segments) || segments.length < 2) return null;
  const totalDuration = Number(duration);
  if (!Number.isFinite(totalDuration) || totalDuration < 1) return null;
  const maxSegments = Math.floor((totalDuration + 0.000001) / 0.5);
  if (segments.length > maxSegments) return null;

  const fallbackDuration = segmentDurationHint || totalDuration / segments.length;
  const requestedDurations = segments.map((segment) => {
    const explicitDuration = Number(segment?.duration);
    if (Number.isFinite(explicitDuration) && explicitDuration > 0) return explicitDuration;
    const start = Number(segment?.start);
    const end = Number(segment?.end);
    return Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : fallbackDuration;
  });

  let cursor = 0;
  const recovered = segments.map((segment, index) => {
    const remainingSegments = segments.length - index;
    const remainingDuration = totalDuration - cursor;
    const minimumForLaterSegments = 0.5 * (remainingSegments - 1);
    const requested = requestedDurations[index];
    const segmentDuration = index === segments.length - 1
      ? remainingDuration
      : Math.min(
        Math.max(0.5, requested),
        Math.max(0.5, remainingDuration - minimumForLaterSegments),
      );
    const start = Number(cursor.toFixed(3));
    const end = index === segments.length - 1
      ? Number(totalDuration.toFixed(3))
      : Number((cursor + segmentDuration).toFixed(3));
    cursor = end;
    return { ...segment, start, end, duration: end - start };
  });

  try {
    return validateTimeline(recovered, totalDuration);
  } catch {
    return null;
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

async function requestPlannerModel({ request, requestInput, model, prompt, fetchImpl, ollamaUrl, comfyUrl, remoteComfy, timeoutMs, attempt }) {
  const provider = plannerProvider(requestInput);
  const label = provider === "codex" ? "Codex CLI" : "Ollama";
  try {
    if (request) return await request({ input: requestInput, model, prompt, attempt, repair: attempt > 1 });
    if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
    if (comfyUrl && remoteComfy) {
      const freeResponse = await fetchImpl(`${String(comfyUrl).replace(/\/$/, "")}/free`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unload_models: true, free_memory: true }),
        signal: AbortSignal.timeout(30000),
      }).catch((error) => {
        if (remoteComfy) throw error;
        return null;
      });
      if (remoteComfy && freeResponse && !freeResponse.ok) {
        throw new Error(`remote ComfyUI refused GPU release (${freeResponse.status})`);
      }
    }
    const response = await fetchImpl(`${String(ollamaUrl).replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        format: "json",
        think: false,
        keep_alive: 0,
        options: { temperature: attempt > 1 ? 0.2 : 0.65, top_p: attempt > 1 ? 0.75 : 0.9, num_ctx: 8192 },
      }),
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
    throw new LongVideoError(plannerErrorCode(provider, "UNAVAILABLE"), `Unable to reach ${label}: ${error.message}`, 502);
  }
}

function promptDraft(segment, bible, mode, provider = "ollama", options = {}) {
  const rawPrompt = clean(segment.prompt);
  let fallbackReason = null;
  if (rawPrompt) {
    try {
      validatePrompt(rawPrompt, { mode, duration: segment.duration });
      if (mode === "ref2v" && !/<Picture\s+1>/i.test(rawPrompt)) {
        throw new LongVideoError("PROMPT_REFERENCE_ORDER_REQUIRED", "Ref2VA prompt must declare ordered picture labels.", 400);
      }
      return { prompt: rawPrompt, promptSource: provider };
    } catch (error) {
      // Structured fields below are composed server-side into the exact H3
      // wrapper when a local model returns a malformed full prompt.
      fallbackReason = {
        code: error?.code || "PROMPT_INVALID",
        message: error?.message || String(error),
      };
    }
  }
  const prompt = buildSegmentPrompt(segment, bible, { mode, firstFrame: mode === "i2v", pictureLabel: "Picture 1", shotId: "Shot 1", ...options });
  try {
    validatePrompt(prompt, { mode, duration: segment.duration });
  } catch (error) {
    throw new LongVideoError("PROMPT_FALLBACK_INVALID", "Deterministic H3 prompt fallback failed validation.", 502, {
      mode,
      segmentDuration: segment.duration,
      fallbackError: { code: error?.code || "PROMPT_INVALID", message: error?.message || String(error) },
      ...(fallbackReason ? { originalError: fallbackReason } : {}),
    });
  }
  if (fallbackReason) {
    const notice = {
      source: `${provider}_structured`,
      reasonCode: fallbackReason.code,
      reason: fallbackReason.message,
      ...fallbackReason,
    };
    if (typeof options.onFallback === "function") options.onFallback(notice);
    return { prompt, promptSource: `${provider}_structured`, promptFallback: notice };
  }
  return { prompt, promptSource: `${provider}_structured` };
}

function withReferenceLabels(segment, references) {
  const labels = Array.isArray(references) && references.length
    ? `Ordered reference pictures: ${references.map((reference, index) => `<Picture ${index + 1}> (${reference.name || "reference"})`).join(", ")}.`
    : "";
  return labels ? { ...segment, description: `${labels}\n${segment.description || ""}`.trim() } : segment;
}

export async function planSequence(input, options = {}) {
  input = input || {};
  const provider = plannerProvider(input);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const ollamaUrl = options.ollamaUrl || process.env.OLLAMA_URL || "http://127.0.0.1:11434";
  const comfyUrl = options.comfyUrl || process.env.COMFY_URL || "";
  const remoteComfy = options.remoteComfy ?? /^(?:1|true|yes)$/i.test(String(process.env.COMFY_REMOTE || ""));
  const model = options.model || (provider === "codex" ? input.codexModel || input.model || "gpt-5.6-luna" : input.ollamaModel || input.model || DEFAULT_OLLAMA_MODEL);
  const timeoutMs = options.timeoutMs ?? 120000;
  const request = options.request || null;
  const normalizedInput = validateSequenceInput(input || {});
  const normalizedReferenceAssets = effectiveReferenceAssets(normalizedInput);
  if (normalizedInput.inputType === "text" && !normalizedInput.inputText && !normalizedInput.brief && !input.timelineText && !input.storyboard) {
    throw new LongVideoError("PLAN_INPUT_REQUIRED", "Text planning requires inputText.", 400);
  }
  if (normalizedInput.referenceMode !== "multi_reference" && normalizedInput.inputType === "image" && !normalizedInput.inputAsset) {
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
  let retryCodes = [];
  let lastCandidate = null;
  let lastCandidateSegments = [];
  let serverTimelineRepair = false;
  const promptFallbacks = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let raw;
    try {
      raw = await requestPlannerModel({ request, requestInput, model, prompt: activePrompt, fetchImpl, ollamaUrl, comfyUrl, remoteComfy, timeoutMs, attempt });
      const candidate = parseResponse(raw, provider);
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        const label = provider === "codex" ? "Codex CLI" : "Ollama";
        throw new LongVideoError(plannerErrorCode(provider, "INVALID_JSON"), `${label} must return one JSON object for sequence planning.`, 502);
      }
      const candidateSegments = Array.isArray(candidate.segments) ? candidate.segments : Array.isArray(candidate.timeline) ? candidate.timeline : [];
      lastCandidate = candidate;
      lastCandidateSegments = candidateSegments;
      if (timelineMode === "auto") canonicalTimeline = modelTimeline(candidateSegments, normalizedInput.duration, provider);
      parsed = candidate;
      semanticSegments = candidateSegments;
      break;
    } catch (error) {
      const repairable = error instanceof LongVideoError && [
        plannerErrorCode(provider, "INVALID_JSON"),
        plannerErrorCode(provider, "TIMELINE_INVALID"),
      ].includes(error.code);
      const transientCodexFailure = provider === "codex" && error instanceof LongVideoError && [
        "CODEX_REQUEST_FAILED",
        "CODEX_EMPTY_RESPONSE",
      ].includes(error.code);
      if (attempt === 1 && (repairable || transientCodexFailure)) {
        retryCodes.push(error.code);
        if (repairable) repairAttempts += 1;
        console.warn("[long-video] planner.retry", JSON.stringify({
          model,
          attempt,
          errorCode: error.code,
          retryKind: repairable ? "format" : "codex_transient",
          timelineMode,
        }));
        activePrompt = repairable
          ? repairPlannerPrompt(basePrompt, raw, error, { duration: normalizedInput.duration, timelineMode })
          : [
              basePrompt,
              "",
              "RETRY REQUEST: The previous Codex CLI invocation ended without a usable response.",
              "Run the same planning task again and return the complete JSON object only. Do not explain the retry.",
            ].join("\n");
        continue;
      }
      if (
        attempt === 2 &&
        provider === "codex" &&
        timelineMode === "auto" &&
        error instanceof LongVideoError &&
        error.code === "CODEX_TIMELINE_INVALID"
      ) {
        const recovered = recoverContiguousTimeline(lastCandidateSegments, normalizedInput.duration, durationHint);
        if (recovered && lastCandidate) {
          parsed = lastCandidate;
          semanticSegments = lastCandidateSegments;
          canonicalTimeline = recovered;
          serverTimelineRepair = true;
          console.warn("[long-video] planner.timeline_recovered", JSON.stringify({
            model,
            attempt,
            errorCode: error.code,
            segments: recovered.length,
            duration: normalizedInput.duration,
          }));
          break;
        }
      }
      throw error;
    }
  }
  if (!parsed) {
    const label = provider === "codex" ? "Codex CLI" : "Ollama";
    throw new LongVideoError(plannerErrorCode(provider, "INVALID_JSON"), `${label} did not return a usable sequence plan.`, 502);
  }
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
  // Continuity mode keeps the legacy T2VA/I2VA split. Multi-reference mode
  // deliberately uses Ref2VA for every segment; the runner appends a previous
  // tail reference without turning it into a frame-zero lock.
  const drafts = segments.map((segment, index) => {
    const mode = normalizedInput.referenceMode === "multi_reference"
      ? "ref2v"
      : normalizedInput.inputType === "image" || index > 0 ? "i2v" : "t2v";
    const generated = promptDraft(
      normalizedInput.referenceMode === "multi_reference" ? withReferenceLabels(segment, normalizedReferenceAssets) : segment,
      bible,
      mode,
      provider,
      {
        ...(normalizedInput.referenceMode === "multi_reference" ? { references: { assets: normalizedReferenceAssets } } : {}),
        onFallback: (reason) => promptFallbacks.push({ segmentIndex: index, ...reason }),
      },
    );
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
    referenceMode: normalizedInput.referenceMode,
    referenceAssets: normalizedInput.referenceAssets.map((reference) => sanitizeAssetRef(reference)),
    ...(normalizedInput.imagePurpose ? { imagePurpose: normalizedInput.imagePurpose } : {}),
    ...(normalizedInput.inputText ? { inputText: normalizedInput.inputText } : {}),
    ...(normalizedInput.inputAsset ? { inputAsset: sanitizeAssetRef(normalizedInput.inputAsset) } : {}),
    duration: normalizedInput.duration ?? drafts[drafts.length - 1].end,
    negativePrompt,
    ...(provider === "codex" ? { codexModel: model } : { ollamaModel: model }),
    promptProvider: provider,
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
      source: provider,
      timelineSource: timelineMode === "auto" ? provider : "author",
      promptSource: drafts.every((segment) => segment.promptSource === provider) ? provider : `${provider}_structured`,
      segmentDurationHint: durationHint,
      repairAttempts,
      ...(retryCodes.length ? { retryAttempts: retryCodes.length, retryCodes } : {}),
      ...(serverTimelineRepair ? { timelineRepair: "server_contiguous" } : {}),
      ...(promptFallbacks.length ? { promptFallbacks } : {}),
    },
  };
}

export { plannerPrompt, parseResponse as parsePlannerResponse };
export const createPlan = planSequence;
