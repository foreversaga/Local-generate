import path from "node:path";
import { promises as fs } from "node:fs";
import { buildSegmentPrompt } from "./prompt-builder.mjs";
import { validatePrompt } from "./prompt-validator.mjs";

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

function provenance({ provider, model, fallback, reason, error }) {
  return {
    provider: text(provider, "deterministic"),
    model: text(model) || null,
    fallback: Boolean(fallback),
    ...(reason ? { reason: text(reason).slice(0, 160) } : {}),
    ...(errorCode(error) ? { errorCode: errorCode(error) } : {}),
  };
}

function continuationInstruction(previousEndingState) {
  const ending = text(previousEndingState);
  return [
    "Continuation: begin directly from the supplied actual normalized previous-segment tail frame as Picture 1.",
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
  const instruction = continuationInstruction(previousEndingState);
  if (base.toLocaleLowerCase().includes(instruction.toLocaleLowerCase())) return base;
  return appendToPromptBody(base, mode, instruction);
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

function finalizerRequestPrompt({ continuityBible, previousEndingState, draftPrompt }) {
  return [
    "Use the attached image as the actual normalized tail frame from the previous segment.",
    "Finalize only continuity for the next segment.",
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
} = {}) {
  return async function finalizeContinuationPrompt(context = {}) {
    const selectedModel = text(optionValue(getModel, context) || optionValue(model, context) || context.model);
    const provider = "ollama-vision";
    const fallbackPrompt = buildDeterministicContinuationPrompt(context);
    const fallback = (reason, error = undefined) => ({
      prompt: fallbackPrompt,
      provenance: provenance({ provider, model: selectedModel, fallback: true, reason, error }),
    });
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
      const draftPrompt = text(context.draftPrompt || context.segment?.prompt) || buildDeterministicContinuationPrompt(context);
      const body = {
        system: finalizerSystemPrompt(),
        prompt: finalizerRequestPrompt({
          continuityBible: context.continuityBible,
          previousEndingState: context.previousEndingState,
          draftPrompt,
        }),
        think: false,
        options: { temperature: 0.2, top_p: 0.9, num_ctx: 8192 },
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
        provenance: provenance({ provider, model: selectedModel, fallback: false, reason: "vision_success" }),
        ...(usesCoordinator ? { ollamaPromptBarrier: Promise.resolve({ ok: true, scope: "continuation-prompt" }) } : {}),
      };
    } catch (error) {
      if (isOllamaUnloadFailure(error)) throw error;
      return fallback(errorReason(error), error);
    }
  };
}
