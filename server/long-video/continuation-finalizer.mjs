import path from "node:path";
import { promises as fs } from "node:fs";
import { buildSegmentPrompt } from "./prompt-builder.mjs";
import { validatePrompt } from "./prompt-validator.mjs";
import { loadH3PromptSkillPack, resolveH3OllamaContextLength } from "../h3-prompt/skill-loader.mjs";

export const DEFAULT_TAIL_IMAGE_MAX_BYTES = 12 * 1024 * 1024;
const IMAGE_MIME_TYPES = Object.freeze({
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
});

function text(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function optionValue(value, context) {
  return typeof value === "function" ? value(context) : value;
}

function compactValue(value, fallback = "Not provided.") {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string") return value.trim() || fallback;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return fallback;
  }
}

function errorReason(error) {
  return text(error?.code, "VISION_FINALIZER_FAILED").slice(0, 120);
}

function errorCode(error) {
  const code = text(error?.code);
  return code ? code.slice(0, 120) : undefined;
}

function provenance({ provider, model, fallback, reason, error, skill }) {
  return {
    provider: text(provider, "deterministic"),
    model: text(model) || null,
    fallback: Boolean(fallback),
    ...(reason ? { reason: text(reason).slice(0, 160) } : {}),
    ...(errorCode(error) ? { errorCode: errorCode(error) } : {}),
    ...(skill ? { skill } : {}),
  };
}

function continuationInstruction(previousEndingState, { mode = "i2v", references = [] } = {}) {
  const ending = text(previousEndingState);
  const referenceInstruction = mode === "ref2v"
    ? `Use the supplied actual normalized previous-segment tail as <Picture ${Math.max(1, references.length)}> after the ordered static references. It is an ordinary continuity reference, not a frame-zero lock. Use <Video 1> and its paired <Audio 1> as the previous segment's short audiovisual continuation context: inherit ending motion, pacing, ambience, and voice timbre without replaying the source clip.`
    : "Begin directly from the supplied actual normalized previous-segment tail frame as Picture 1 at 0.00 seconds.";
  return [
    `Continuation: ${referenceInstruction}`,
    ending ? `Preserve the previous segment's ending state exactly: ${ending}.` : "Preserve the previous segment's ending state and motion direction.",
    "Change only continuity details; preserve the next segment's user-authored subjects, actions, setting, camera, sound, and negative constraints.",
  ].join(" ");
}

function appendToPromptBody(prompt, mode, instruction) {
  const bodyField = mode === "ref2v" ? "detailed_description" : "integrated_multimodal_description";
  const nextField = "overall_soundscape";
  const boundary = new RegExp(`(\\b${bodyField}\\s*:[\\s\\S]*?)(\\n\\n(?=${nextField}\\s*:))`, "i");
  if (boundary.test(prompt)) return prompt.replace(boundary, `$1\n${instruction}$2`).trim();
  return `${prompt}${prompt ? "\n\n" : ""}${instruction}`.trim();
}

export function ensureRef2vaAvContextPrompt(prompt) {
  let next = String(prompt || "");
  const definitions = [
    "<Video 1> is the final short audiovisual excerpt of the previous segment, used only for ending motion and pacing continuity.",
    "<Audio 1> is the soundtrack paired with <Video 1>, used only for ambience, rhythm, and voice-timbre continuity.",
  ];
  const definitionBoundary = /(subject_definitions\s*:[\s\S]*?)(\n\n(?=summary\s*:))/i;
  if (definitionBoundary.test(next)) {
    const missing = definitions.filter((line) => !next.toLocaleLowerCase().includes(line.split(" is ")[0].toLocaleLowerCase()));
    if (missing.length) next = next.replace(definitionBoundary, `$1\n${missing.join("\n")}$2`);
  }
  next = next.replace(/(summary\s*:\s*)\[(?:reference generation|video continuation|audio reuse|audio reference)(?:\s*\+\s*(?:reference generation|video continuation|audio reuse|audio reference))*\]/i, "$1[video continuation + audio reuse]");
  return next;
}

export function ensureRef2vaVisualContextPrompt(prompt) {
  let next = normalizeRef2vaSectionHeadings(String(prompt || ""))
    .split(/\r?\n/)
    .filter((line) => !/^\s*<Audio\s+\d+>/i.test(line))
    .join("\n");
  const definition = "<Video 1> is the final two-second silent visual excerpt of the previous storyboard shot, used only as a weak reference for character, scene, lighting, and visual-state consistency; it is not footage to replay and does not define the new shot's opening frame or motion.";
  const definitionBoundary = /(subject_definitions\s*:[\s\S]*?)(\n\n(?=summary\s*:))/i;
  if (definitionBoundary.test(next) && !/subject_definitions\s*:[\s\S]*?<Video\s+1>/i.test(next)) {
    next = next.replace(definitionBoundary, `$1\n${definition}$2`);
  }
  next = next.replace(
    /(summary\s*:\s*)\[(?:keyframe completion|reference generation|video editing|video continuation|audio reuse|audio reference)(?:\s*\+\s*(?:keyframe completion|reference generation|video editing|video continuation|audio reuse|audio reference))*\]/i,
    "$1[reference generation]",
  );
  const bodyBoundary = /(detailed_description\s*:[\s\S]*?)(\n\n(?=overall_soundscape\s*:))/i;
  const instruction = "Use <Video 1> only to keep appearance, environment, lighting, and the preceding visual state consistent. Start a new independent storyboard shot according to this shot's own composition, action, and camera plan; do not replay or continue the reference video's footage or motion.";
  if (bodyBoundary.test(next) && !next.includes(instruction)) next = next.replace(bodyBoundary, `$1\n${instruction}$2`);
  return next;
}

export function normalizeRef2vaSectionHeadings(prompt) {
  const fields = [
    "subject_definitions",
    "summary",
    "retention_analysis",
    "detailed_description",
    "overall_soundscape",
    "non_diegetic_music",
  ];
  let next = String(prompt || "");
  for (const field of fields) {
    next = next.replace(new RegExp(`^[ \\t]*${field}[ \\t]*:?[ \\t]*$`, "gim"), `${field}:`);
  }
  return next;
}

export function ensureRef2vaLatentContinuationPrompt(prompt) {
  let next = normalizeRef2vaSectionHeadings(prompt)
    .split(/\r?\n/)
    .filter((line) => !/^\s*<Video\s+\d+>/i.test(line))
    .join("\n")
    .replace(/<Video\s+\d+>/gi, "the protected audiovisual context");
  next = next.replace(
    /(summary\s*:\s*)\[(?:keyframe completion|reference generation|video editing|video continuation|audio reuse|audio reference)(?:\s*\+\s*(?:keyframe completion|reference generation|video editing|video continuation|audio reuse|audio reference))*\]/i,
    "$1[video continuation + reference generation]",
  );
  const instruction = "The opening protected audiovisual context is the exact ending of the previous storyboard shot. Preserve its final composition, pose, object state, camera direction, motion velocity, ambience, and timing through the continuation boundary; introduce this shot's new action only after that inherited state is established, without replaying or redescribing the protected context as a separate reference clip.";
  const bodyBoundary = /(detailed_description\s*:[\s\S]*?)(\n\n(?=overall_soundscape\s*:))/i;
  if (bodyBoundary.test(next) && !next.includes(instruction)) next = next.replace(bodyBoundary, `$1\n${instruction}$2`);
  return next;
}

function orderedReferenceDescription(references = []) {
  if (!Array.isArray(references) || !references.length) return "";
  return `Ordered reference pictures: ${references.map((reference, index) => `<Picture ${index + 1}> (${reference?.name || "reference"})`).join(", ")}.`;
}

function isValidDraftPrompt(prompt, mode) {
  if (!text(prompt)) return false;
  try {
    validatePrompt(prompt, { mode });
    if (mode === "ref2v" && !/<Picture\s+1>/i.test(prompt)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a deterministic continuation while preserving the supplied draft.
 * The only appended text is continuity guidance; an absent/invalid draft is
 * repaired through the existing H3 segment prompt builder.
 */
export function buildDeterministicContinuationPrompt({
  draftPrompt,
  segment = {},
  continuityBible = {},
  previousEndingState = "",
  mode = "i2v",
  references = [],
} = {}) {
  const orderedDescription = orderedReferenceDescription(references);
  const fallbackSegment = orderedDescription
    ? { ...segment, description: `${orderedDescription}\n${segment.description || ""}`.trim() }
    : segment;
  const suppliedDraft = text(draftPrompt);
  const base = isValidDraftPrompt(suppliedDraft, mode)
    ? suppliedDraft
    : buildSegmentPrompt(fallbackSegment, continuityBible, {
        mode,
        firstFrame: false,
        pictureLabel: "Picture 1",
        shotId: "Shot 1",
        references,
      });
  const contractedBase = mode === "ref2v" ? ensureRef2vaAvContextPrompt(base) : base;
  const instruction = continuationInstruction(previousEndingState, { mode, references });
  if (contractedBase.toLocaleLowerCase().includes(instruction.toLocaleLowerCase())) return contractedBase;
  return appendToPromptBody(contractedBase, mode, instruction);
}

function resolveTailPath(tailPath, tailRoot) {
  const resolvedTail = path.resolve(String(tailPath || ""));
  const resolvedRoot = path.resolve(String(tailRoot || path.dirname(resolvedTail)));
  const relative = path.relative(resolvedRoot, resolvedTail);
  if (!resolvedTail || !relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    const error = new Error("Tail image must remain inside the sequence output folder.");
    error.code = "TAIL_IMAGE_OUTSIDE_SEQUENCE";
    throw error;
  }
  return resolvedTail;
}

export async function readNormalizedTailImage({ tailPath, tailRoot, maxBytes = DEFAULT_TAIL_IMAGE_MAX_BYTES } = {}) {
  const resolvedTail = resolveTailPath(tailPath, tailRoot);
  const extension = path.extname(resolvedTail).toLocaleLowerCase();
  const mimeType = IMAGE_MIME_TYPES[extension];
  if (!mimeType) {
    const error = new Error("Normalized tail must be a PNG, JPEG, or WebP image.");
    error.code = "TAIL_IMAGE_TYPE_INVALID";
    throw error;
  }
  const limit = Math.max(1, Number(maxBytes) || DEFAULT_TAIL_IMAGE_MAX_BYTES);
  const stats = await fs.lstat(resolvedTail);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    const error = new Error("Normalized tail must be a regular file, not a link.");
    error.code = "TAIL_IMAGE_NOT_REGULAR_FILE";
    throw error;
  }
  if (stats.size < 1 || stats.size > limit) {
    const error = new Error(`Normalized tail image exceeds the ${limit}-byte safety limit.`);
    error.code = "TAIL_IMAGE_SIZE_INVALID";
    throw error;
  }
  const bytes = await fs.readFile(resolvedTail);
  if (bytes.length < 1 || bytes.length > limit) {
    const error = new Error(`Normalized tail image exceeds the ${limit}-byte safety limit.`);
    error.code = "TAIL_IMAGE_SIZE_INVALID";
    throw error;
  }
  return { bytes, data: bytes.toString("base64"), mimeType, byteLength: bytes.length };
}

function responseText(response) {
  if (typeof response === "string") return text(response);
  const payload = response?.payload && typeof response.payload === "object" ? response.payload : response;
  return text(payload?.response || payload?.message?.content || response?.text);
}

function finalizerRequestPrompt({ mode, segment, references, continuityBible, previousEndingState, draftPrompt }) {
  const referenceCount = Array.isArray(references) ? references.length : 0;
  const tailLabel = mode === "ref2v" ? `<Picture ${Math.max(1, referenceCount)}>` : "<Picture 1>";
  return [
    `Use the attached image as the actual normalized tail frame from the previous segment and treat it as ${tailLabel}.`,
    mode === "ref2v"
      ? "Keep all earlier ordered static references in their original slots. The tail is the final ordinary continuity reference and must not become a frame-zero lock. The runtime also supplies the previous 1-2 second tail as <Video 1> with paired <Audio 1>; use it only for ending motion, pacing, ambience, and voice-timbre continuity, never as footage to replay."
      : "The tail is the actual first frame at 0.00 seconds for this I2VA continuation.",
    "Finalize only continuity for the next segment.",
    `NEXT SEGMENT METADATA:\n${compactValue(segment)}`,
    orderedReferenceDescription(references),
    `CONTINUITY BIBLE:\n${compactValue(continuityBible)}`,
    `PREVIOUS SEGMENT ENDING STATE:\n${compactValue(previousEndingState)}`,
    `NEXT SEGMENT DRAFT PROMPT (preserve its locked intent):\n${text(draftPrompt, "No draft was supplied; construct the prompt from the segment metadata.")}`,
    "Return one complete H3 prompt only. Preserve the draft's subjects, actions, setting, camera, sound, and negative constraints; do not invent a new story or mention this instruction, file path, or image encoding.",
  ].join("\n\n");
}

function finalizerSystemPrompt() {
  return [
    "You are a vision-capable long-video continuation prompt finalizer.",
    "Inspect the attached normalized tail image and use it as visual truth for continuity.",
    "Change only continuity details needed to connect the previous ending to the next segment.",
    "Maximize facial identity stability, anatomically coherent hands and finger motion, physically correct hand-object contact, and clothing motion governed by gravity, body motion, contact, inertia, and wind without clipping or penetration.",
    "Preserve every user-locked subject, action, setting, camera direction, sound choice, and negative constraint in the next-segment draft.",
    "Return only one complete valid H3 prompt with no markdown, headings, explanation, file path, base64, or image metadata.",
  ].join(" ");
}

function isOllamaUnloadFailure(error) {
  return error?.code === "OLLAMA_UNLOAD_FAILED"
    || error?.details?.unloadError?.code === "OLLAMA_UNLOAD_FAILED"
    || error?.cause?.code === "OLLAMA_UNLOAD_FAILED";
}

function normalizeCandidate(candidate) {
  if (typeof candidate === "string") {
    const raw = candidate.trim();
    if (raw.startsWith("{") && raw.endsWith("}")) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") return text(parsed.prompt || parsed.response || parsed.text) || raw;
      } catch {
        // Keep the raw model response so the normal H3 validator can reject it.
      }
    }
    return raw;
  }
  if (candidate && typeof candidate === "object") return text(candidate.prompt || candidate.response || candidate.text);
  return "";
}

/**
 * Create the runtime seam used by the long-video runner. Image bytes are
 * transient request data only; the return value contains prompt provenance,
 * never the bytes or their filesystem path.
 */
export function createContinuationPromptFinalizer({
  ollamaCoordinator,
  checkAvailable,
  request,
  model,
  getModel,
  ollamaUrl,
  getOllamaUrl,
  comfyUrl,
  getComfyUrl,
  remoteComfy,
  getRemoteComfy,
  timeoutMs = 120000,
  maxTailBytes = DEFAULT_TAIL_IMAGE_MAX_BYTES,
  tailRoot,
  validate = validatePrompt,
  loadSkillPack = loadH3PromptSkillPack,
  skillPath,
  contextLength,
} = {}) {
  return async function finalizeContinuationPrompt(context = {}) {
    const selectedModel = text(optionValue(getModel, context) || optionValue(model, context) || context.model);
    const provider = "ollama-vision";
    let skillPolicy = null;
    const fallbackPrompt = buildDeterministicContinuationPrompt(context);
    const fallback = (reason, error = undefined) => ({
      prompt: fallbackPrompt,
      provenance: provenance({ provider, model: selectedModel, fallback: true, reason, error, skill: skillPolicy }),
    });
    if (typeof checkAvailable === "function") {
      try {
        if (!(await checkAvailable(context))) return fallback("OLLAMA_UNAVAILABLE");
      } catch (error) {
        return fallback("OLLAMA_UNAVAILABLE", error);
      }
    }
    try {
      if (!context.previousTail) return fallback("tail_missing");
      if (!selectedModel) {
        const error = new Error("A vision-capable Ollama model is required for continuation finalization.");
        error.code = "VISION_MODEL_REQUIRED";
        return fallback(error.code, error);
      }
      const tail = await readNormalizedTailImage({
        tailPath: context.previousTail,
        tailRoot: context.tailRoot || optionValue(tailRoot, context),
        maxBytes: maxTailBytes,
      });
      const skillPack = await loadSkillPack({
        purpose: "prompt",
        mode: context.mode,
        referenceMode: context.job?.referenceMode,
        duration: context.segment?.duration,
        hasVisualReference: true,
        skillPath,
      });
      skillPolicy = skillPack?.policy || null;
      const draftPrompt = text(context.draftPrompt || context.segment?.prompt) || buildDeterministicContinuationPrompt(context);
      const body = {
        system: [skillPack?.systemPrompt, finalizerSystemPrompt()].filter(Boolean).join("\n\n"),
        prompt: finalizerRequestPrompt({
          mode: context.mode,
          segment: context.segment,
          references: context.references,
          continuityBible: context.continuityBible,
          previousEndingState: context.previousEndingState,
          draftPrompt,
        }),
        think: false,
        options: { temperature: 0, top_p: 0.9, num_ctx: resolveH3OllamaContextLength(contextLength) },
        images: [tail.data],
      };
      const target = {
        model: selectedModel,
        body,
        tailImage: { mimeType: tail.mimeType, byteLength: tail.byteLength },
        tailPath: context.previousTail,
      };
      if (typeof request !== "function" && typeof ollamaCoordinator?.generate !== "function") {
        const error = new Error("A vision finalizer request transport is unavailable.");
        error.code = "VISION_FINALIZER_UNAVAILABLE";
        throw error;
      }
      const usesCoordinator = typeof request !== "function" && typeof ollamaCoordinator?.generate === "function";
      const response = typeof request === "function"
        ? await request({
            ...target,
            ollamaUrl: optionValue(getOllamaUrl, context) || optionValue(ollamaUrl, context),
            comfyUrl: optionValue(getComfyUrl, context) || optionValue(comfyUrl, context),
            remoteComfy: optionValue(getRemoteComfy, context) ?? optionValue(remoteComfy, context),
            timeoutMs,
          })
        : await ollamaCoordinator?.generate({
            ollamaUrl: optionValue(getOllamaUrl, context) || optionValue(ollamaUrl, context),
            comfyUrl: optionValue(getComfyUrl, context) || optionValue(comfyUrl, context),
            remoteComfy: optionValue(getRemoteComfy, context) ?? optionValue(remoteComfy, context),
            model: selectedModel,
            body,
            timeoutMs,
          });
      const candidate = normalizeCandidate(responseText(response));
      if (!candidate) {
        const error = new Error("Vision finalizer returned an empty prompt.");
        error.code = "VISION_FINALIZER_EMPTY";
        return fallback(error.code, error);
      }
      if (candidate.length > 7000) {
        const error = new Error("Vision finalizer returned a prompt over the H3 size limit.");
        error.code = "VISION_FINALIZER_PROMPT_TOO_LONG";
        return fallback(error.code, error);
      }
      try {
        validate(candidate, { mode: context.mode });
        if (context.mode === "ref2v" && !/<Picture\s+1>/i.test(candidate)) throw new Error("Ref2VA prompt must declare ordered picture labels.");
      } catch (error) {
        error.code ||= "VISION_FINALIZER_PROMPT_INVALID";
        return fallback(error.code, error);
      }
      return {
        prompt: candidate,
        provenance: provenance({ provider, model: selectedModel, fallback: false, reason: "vision_success", skill: skillPolicy }),
        ...(usesCoordinator ? { ollamaPromptBarrier: Promise.resolve({ ok: true, scope: "continuation-prompt" }) } : {}),
      };
    } catch (error) {
      if (isOllamaUnloadFailure(error)) throw error;
      return fallback(errorReason(error), error);
    }
  };
}
