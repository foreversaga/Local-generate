import { parseTimeline } from "./timeline-parser.mjs";
import { LongVideoError, sanitizeAssetRef, validateContinuityBible, validateSequenceInput, validateTimeline } from "./schema.mjs";
import { buildSegmentPrompt } from "./prompt-builder.mjs";
import { validatePrompt } from "./prompt-validator.mjs";
import { createOllamaCoordinator } from "../ollama-coordinator.mjs";
import { loadH3PromptSkillPack, resolveH3OllamaContextLength } from "../h3-prompt/skill-loader.mjs";
import { DEFAULT_NEGATIVE_PROMPT, mergeLongVideoNegativePrompt } from "./quality-defaults.mjs";

export { DEFAULT_NEGATIVE_PROMPT } from "./quality-defaults.mjs";
export const DEFAULT_OLLAMA_MODEL = "hf.co/Blackfrost-AI/Qwen3.8-27B-ABLITERATED-GGUF:Q3_K_M";

async function releasePlannerComfy(target = {}) {
  if (!target.remoteComfy || !target.comfyUrl) return;
  const requestFetch = target.requestFetch || ((...args) => globalThis.fetch(...args));
  const response = await requestFetch(`${String(target.comfyUrl).replace(/\/$/, "")}/free`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ unload_models: true, free_memory: true }),
    signal: AbortSignal.timeout(30000),
  });
  const body = typeof response?.text === "function" ? await response.text() : "";
  if (!response?.ok) throw new Error(`remote ComfyUI refused GPU release (${response?.status || "unknown"})${body ? `: ${body.slice(-500)}` : ""}`);
}

const defaultOllamaCoordinator = createOllamaCoordinator({ beforeRequest: releasePlannerComfy });

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

// `plannerImages` is the normalized hand-off for real visual references.  It
// mirrors the existing prompt bridge shape ({ role, data }) while accepting a
// bare base64 string for small integrations.  Image bytes never enter the
// textual planner prompt or persisted plan; they are only forwarded to
// Ollama's `images` request field.
function normalizePlannerImages(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const rawData = typeof item === "string" ? item : item?.data;
    const data = clean(rawData).replace(/^data:[^;]+;base64,/i, "").trim();
    if (!data) return null;
    return {
      role: clean(typeof item === "object" ? item?.role : "") || `reference_image_${index + 1}`,
      data,
    };
  }).filter(Boolean);
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
  return mergeLongVideoNegativePrompt(clean(userValue), clean(modelValue));
}

function effectiveReferenceAssets(input) {
  if (input?.referenceMode !== "multi_reference" && !["motion_context", "latent_context"].includes(input?.continuationMode)) return [];
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
  const motionContext = input.continuationMode === "motion_context";
  const latentContext = input.continuationMode === "latent_context";
  const referenceAssets = effectiveReferenceAssets(input);
  const plannerImages = normalizePlannerImages(input.plannerImages || input.images);
  const visualInspection = plannerImages.length
    ? "Actual reference image bytes are attached to this planning request. You may inspect those attached images and describe only visible details."
    : "No actual reference image bytes are attached to this planning request. Do not claim to have inspected an image; use only the supplied asset names and text direction.";
  const source = [
    Array.isArray(input.scripts) ? "The author supplied a script list. Each script is exactly one storyboard and exactly one independently generated video. Never split, merge, omit, or reorder scripts." : "",
    idea ? `User's complete story direction: ${idea}` : "",
    multiReference && latentContext
      ? `This sequence uses latent-masked Ref2VA continuation. Treat the supplied image assets as ordered static references (${referenceAssets.map((reference, index) => `Picture ${index + 1}=${reference.name}`).join(", ") || "Picture 1"}). Starting with segment 2, the preceding shot's final 39-frame audiovisual latent is copied into and protected at the beginning of the next target latent. Continue its exact pose, object state, camera direction, motion velocity, ambience, and timing before introducing the next storyboard action.`
      : multiReference
      ? `This sequence uses multi-reference Ref2VA. Treat the supplied image assets as ordered static references (${referenceAssets.map((reference, index) => `Picture ${index + 1}=${reference.name}`).join(", ") || "Picture 1"}), not as a first-frame lock. Every storyboard segment is an independent video shot. Starting with segment 2, the previous shot's final two silent seconds are supplied only as <Video 1>, a weak visual-consistency reference.`
      : latentContext
      ? "Starting with segment 2, continue from the preceding shot's exact protected 39-frame audiovisual latent prefix. Preserve the ending composition, character and object state, camera direction, motion velocity, ambience, and timing at the boundary. Introduce the new storyboard action only after the inherited state is established."
      : motionContext && input.inputType === "image"
      ? `The supplied image is the first-frame input for segment 1 and a fixed identity reference for later segments. Segment 1 is I2VA. Every later segment is an independent Ref2VA storyboard shot using the fixed image plus the previous shot's final two silent seconds as <Video 1>, only for weak visual consistency.`
      : motionContext
      ? "Segment 1 is T2VA. Every later segment is an independent Ref2VA storyboard shot using the previous shot's final two silent seconds as <Video 1>, only for weak character, scene, lighting, and visual-state consistency."
      : input.inputType === "image"
      ? `The supplied image asset is the first frame reference (${input.inputAsset?.name || input.inputAsset || "provided asset"}). Do not invent unseen image details; write the first segment as I2VA and preserve the referenced frame.`
      : "The first segment is T2VA. Every later segment is I2VA and starts from the actual normalized tail frame of the previous segment.",
    visualInspection,
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
    input.referenceMode === "multi_reference" && latentContext
      ? `Use Ref2VA with the ordered static references for every segment. From segment 2 onward, write [video continuation + reference generation] and treat the protected latent prefix as the exact preceding timeline state, not as a separately labelled <Video N> reference.`
      : input.referenceMode === "multi_reference"
      ? `Use Ref2VA for every segment. Ordered static image references are: ${referenceAssets.map((reference, index) => `Picture ${index + 1} (${reference.name || "asset"})`).join(", ") || "provided references"}. Do not write a first-frame lock or I2VA continuation instruction.`
      : latentContext
      ? "Use T2VA/I2VA for segment 1 according to its input type. Every later segment continues from an exact protected audiovisual latent prefix. Preserve the inherited boundary state and motion first; do not define a synthetic <Video N> label when no reference video is supplied."
      : motionContext
      ? "Use T2VA/I2VA only for segment 1 according to its input type. Use Ref2VA for every later independent storyboard shot. Preserve ordered static pictures and use <Video 1> only as a weak visual-consistency reference; do not define <Audio 1>, lock a previous frame at time zero, replay footage, or continue the previous camera motion."
      : "",
    "continuityBible keys: visualStyle, characters, environment, lighting, camera, motionDirection, keyObjects, sound, nonDiegeticMusic, mustPreserve, mustAvoid.",
    "Each character uses id, faceIdentity, hair, silhouette, palette, distinctiveMarks, appearance, clothing, and optional voice. Define these identity anchors once and reuse the same values for every segment where that character is visible.",
    "When a face is visible, every segment's endingState must preserve the same faceIdentity, hair, silhouette, palette, and distinctiveMarks for the next segment.",
    "For visible hands, describe stable anatomy and finger count, natural articulation, and physically correct contact, grip, occlusion, and release. For clothing, preserve design and fit while making fabric follow gravity, body motion, contact, inertia, and wind without clipping, penetration, floating, rigidity, implausible stretching, or independent motion.",
    "Each segment must use these keys: start, end, description, integratedMultimodalDescription, overallSoundscape, nonDiegeticMusic, continuityNote, endingState, negativePrompt.",
    latentContext
      ? "start and end are global seconds. description is a concise editable storyboard summary. Each segment continues the protected ending state of the preceding segment before advancing its own action. endingState records the exact final visual and motion state inherited by the next shot."
      : "start and end are global seconds. description is a concise editable storyboard summary. Each segment is one independently composed video shot. endingState records its final visual state only as continuity context for the next shot.",
    "integratedMultimodalDescription is English H3 content for this segment only. It must begin with [Shot 1], cover composition, subjects, environment, action, camera, dialogue and diegetic sound, and use timestamps relative to this segment starting at 0 only for later cuts.",
    "overallSoundscape is 1-4 English sentences. nonDiegeticMusic is 1-3 English sentences or N/A. Preserve dialogue, lyrics, and visible text in their original language.",
    motionContext
      ? "For segments after the first, use Ref2VA summary mode [reference generation]. Define <Video 1> as the previous shot's final two silent seconds and use it weakly for appearance, environment, lighting, and visual-state consistency only. Never define <Audio 1>, replay the reference, or make it a frame-zero lock."
      : "For continuation segments, describe forward motion from Picture 1 without writing the Picture 1 instruction line; the server adds the exact I2VA wrapper.",
    input.referenceMode === "multi_reference" || motionContext
      ? "For every Ref2VA segment, provide concrete subjectDefinitions, summary, retentionAnalysis, and detailedDescription. Define each visible subject with the continuityBible identity anchors; do not use a generic principal-subject fallback when a character identity is available."
      : "",
    `The server always adds this global quality baseline to negativePrompt: ${DEFAULT_NEGATIVE_PROMPT}. Add only useful story-specific global exclusions instead of repeating that baseline. A segment negativePrompt may add only segment-specific exclusions and may otherwise be an empty string.`,
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

function deterministicTimeline(input, duration, segmentDurationHint) {
  const totalDuration = Number(duration);
  const maxSegments = Math.max(2, Math.floor(totalDuration / 0.5));
  const requestedCount = Math.max(2, Math.ceil(totalDuration / segmentDurationHint), Math.ceil(totalDuration / 60));
  const segmentCount = Math.min(120, maxSegments, requestedCount);
  const idea = clean(input?.inputText || input?.brief) || "Continue the requested story with stable audiovisual continuity.";
  let cursor = 0;
  return Array.from({ length: segmentCount }, (_, index) => {
    const remaining = totalDuration - cursor;
    const remainingSegments = segmentCount - index;
    const segmentDuration = index === segmentCount - 1 ? remaining : remaining / remainingSegments;
    const start = Number(cursor.toFixed(3));
    const end = index === segmentCount - 1 ? Number(totalDuration.toFixed(3)) : Number((cursor + segmentDuration).toFixed(3));
    cursor = end;
    const phase = index === 0
      ? "Establish the opening state and begin the requested action."
      : index === segmentCount - 1
        ? "Continue from the previous state, complete the requested action, and land on a stable final state."
        : "Continue directly from the previous state while advancing the requested action.";
    return { start, end, duration: end - start, description: `${idea} ${phase}` };
  });
}

function addUnique(values, additions) {
  const result = Array.isArray(values) ? values.map(String).map((value) => value.trim()).filter(Boolean) : [];
  const seen = new Set(result.map((value) => value.toLocaleLowerCase()));
  for (const addition of additions) {
    const key = addition.toLocaleLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(addition);
    }
  }
  return result;
}

function qualityContinuityBible(value) {
  const bible = validateContinuityBible(value);
  return {
    ...bible,
    mustPreserve: addUnique(bible.mustPreserve, [
      "When visible, preserve each character's facial identity, facial proportions, hairstyle silhouette, body silhouette, clothing design, colors, and distinctive marks across every shot and segment.",
      "When hands are visible, preserve coherent anatomy and finger count with natural articulation and physically correct object contact, grip, occlusion, and release.",
      "Keep clothing design and fit stable while fabric follows gravity, body motion, contact, inertia, and wind naturally.",
    ]),
    mustAvoid: addUnique(bible.mustAvoid, [
      "Face morphing, facial feature drift, inconsistent eyes, identity resets, or facial flicker.",
      "Extra, missing, fused, malformed, or independently moving fingers; broken grips or hands passing through objects.",
      "Costume drift, cloth/body intersection, fabric penetration, floating or rigid fabric, implausible stretching, or garment motion detached from the body.",
    ]),
  };
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

async function requestPlannerModel({ request, requestInput, model, prompt, system, contextLength, skillPolicy, fetchImpl, ollamaUrl, comfyUrl, remoteComfy, timeoutMs, attempt, ollamaCoordinator }) {
  const provider = plannerProvider(requestInput);
  const label = provider === "codex" ? "Codex CLI" : "Ollama";
  try {
    if (request) return await request({ input: requestInput, model, prompt, system, contextLength, skillPolicy, attempt, repair: attempt > 1 });
    if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
    const plannerImages = normalizePlannerImages(requestInput?.plannerImages || requestInput?.images);
    const requestBody = {
      model,
      ...(system ? { system } : {}),
      prompt,
      stream: false,
      format: "json",
      think: false,
      keep_alive: 0,
      options: { temperature: 0, top_p: attempt > 1 ? 0.75 : 0.85, num_ctx: contextLength },
      ...(plannerImages.length ? { images: plannerImages.map((image) => image.data) } : {}),
    };
    const coordinator = ollamaCoordinator || defaultOllamaCoordinator;
    const coordinated = await coordinator.generate({
      ollamaUrl,
      comfyUrl,
      remoteComfy,
      model,
      body: requestBody,
      timeoutMs,
      requestFetch: fetchImpl,
    });
    return coordinated.payload ?? coordinated.text;
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
  let structuredWarning = null;
  try {
    validatePrompt(prompt, { mode, duration: segment.duration });
  } catch (error) {
    structuredWarning = {
      code: error?.code || "PROMPT_INVALID",
      message: error?.message || String(error),
    };
  }
  if (fallbackReason || structuredWarning) {
    const notice = {
      source: `${provider}_structured`,
      reasonCode: fallbackReason?.code || structuredWarning.code,
      reason: fallbackReason?.message || structuredWarning.message,
      ...(fallbackReason || structuredWarning),
      ...(structuredWarning ? { nonBlocking: true, structuredWarning } : {}),
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
  const ollamaCoordinator = options.ollamaCoordinator || null;
  const loadSkillPack = options.loadSkillPack || loadH3PromptSkillPack;
  const contextLength = resolveH3OllamaContextLength(options.contextLength);
  const plannerImages = normalizePlannerImages(input.plannerImages || input.images);
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
    ...(plannerImages.length ? { plannerImages } : {}),
    ...(canonicalTimeline ? { timeline: canonicalTimeline } : {}),
  };
  const skillPack = provider === "ollama"
    ? await loadSkillPack({
        purpose: "planning",
        mode: normalizedInput.referenceMode === "multi_reference" || ["motion_context", "latent_context"].includes(normalizedInput.continuationMode) ? "ref2v" : "t2v",
        referenceMode: normalizedInput.referenceMode,
        continuationMode: normalizedInput.continuationMode,
        hasVisualReference: plannerImages.length > 0,
        skillPath: options.skillPath,
      })
    : null;
  const basePrompt = plannerPrompt(requestInput, canonicalTimeline);
  let activePrompt = basePrompt;
  let parsed;
  let semanticSegments = [];
  let repairAttempts = 0;
  let retryCodes = [];
  let lastCandidate = null;
  let lastCandidateSegments = [];
  let serverTimelineRepair = false;
  let validationFallback = null;
  const promptFallbacks = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let raw;
    try {
      raw = await requestPlannerModel({
        request,
        requestInput,
        model,
        prompt: activePrompt,
        system: skillPack?.systemPrompt,
        contextLength,
        skillPolicy: skillPack?.policy,
        fetchImpl,
        ollamaUrl,
        comfyUrl,
        remoteComfy,
        timeoutMs,
        attempt,
        ollamaCoordinator,
      });
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
      if (attempt === 2 && repairable) {
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
        canonicalTimeline ||= deterministicTimeline(normalizedInput, normalizedInput.duration, durationHint);
        parsed = lastCandidate && typeof lastCandidate === "object" ? lastCandidate : { continuityBible: {}, segments: [] };
        semanticSegments = lastCandidateSegments;
        validationFallback = {
          code: error.code,
          strategy: timelineMode === "manual" ? "author_timeline_structured" : "server_storyboard_structured",
        };
        console.warn("[long-video] planner.validation_fallback", JSON.stringify({
          model,
          provider,
          errorCode: error.code,
          strategy: validationFallback.strategy,
          segments: canonicalTimeline.length,
        }));
        break;
      }
      throw error;
    }
  }
  if (!parsed) {
    const label = provider === "codex" ? "Codex CLI" : "Ollama";
    throw new LongVideoError(plannerErrorCode(provider, "INVALID_JSON"), `${label} did not return a usable sequence plan.`, 502);
  }
  const bible = qualityContinuityBible(parsed.continuityBible || parsed.continuity_bible);
  const negativePrompt = mergeNegativePrompt(normalizedInput.negativePrompt, parsed.negativePrompt || parsed.negative_prompt);
  const segments = canonicalTimeline.map((canonical, index) => ({
    ...canonical,
    ...(semanticSegments[index] && typeof semanticSegments[index] === "object" ? semanticSegments[index] : {}),
    start: canonical.start,
    end: canonical.end,
    duration: canonical.duration,
    description: Array.isArray(normalizedInput.scripts) ? canonical.description : clean(semanticSegments[index]?.description || semanticSegments[index]?.scene) || canonical.description,
  }));
  // Storyboard shots switch to Ref2VA after the first segment so the runner
  // can supply the preceding shot's final two silent seconds as a weak visual
  // reference. Missing mode on
  // older jobs retains the historical T2VA/I2VA path.
  const drafts = segments.map((segment, index) => {
    const mode = normalizedInput.referenceMode === "multi_reference"
      ? "ref2v"
      : ["motion_context", "latent_context"].includes(normalizedInput.continuationMode) && index > 0
        ? "ref2v"
        : normalizedInput.inputType === "image" || index > 0 ? "i2v" : "t2v";
    const ref2vAssets = mode === "ref2v" ? normalizedReferenceAssets : [];
    const generated = promptDraft(
      mode === "ref2v" ? withReferenceLabels(segment, ref2vAssets) : segment,
      bible,
      mode,
      provider,
      {
        ...(mode === "ref2v" ? { references: { assets: ref2vAssets, hasVideo: normalizedInput.continuationMode === "motion_context" && index > 0 } } : {}),
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
    continuationMode: normalizedInput.continuationMode,
    motionContextSeconds: normalizedInput.motionContextSeconds,
    referenceAssets: normalizedInput.referenceAssets.map((reference) => sanitizeAssetRef(reference)),
    ...(normalizedInput.imagePurpose ? { imagePurpose: normalizedInput.imagePurpose } : {}),
    ...(normalizedInput.inputText ? { inputText: normalizedInput.inputText } : {}),
    ...(normalizedInput.scripts ? { scripts: normalizedInput.scripts } : {}),
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
      ...(validationFallback ? { validationFallback } : {}),
      ...(skillPack?.policy ? { promptPolicy: skillPack.policy, ollamaContextLength: contextLength } : {}),
      ...(promptFallbacks.length ? { promptFallbacks } : {}),
    },
  };
}

export { plannerPrompt, parseResponse as parsePlannerResponse, normalizePlannerImages };
export const createPlan = planSequence;
