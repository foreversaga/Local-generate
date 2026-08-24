import path from "node:path";
import { promises as fs } from "node:fs";
import { assembleSegments as defaultAssemble } from "./assembler.mjs";
import { resolveMultishotContinuity } from "./multishot.mjs";
import { extractTailAvContext as defaultExtractContext, extractTailFrame as defaultExtractTail, normalizeVideo as defaultNormalize, trimLeadingOverlap as defaultTrimOverlap } from "./media.mjs";
import { outputRoot, sequenceAssemblyDir, sequenceOutputFile } from "./paths.mjs";
import { appendEvent, getJob, updateJob, updateSegment, writeAttempt, writeAssemblyJson, writeSequenceManifest } from "./store.mjs";
import { H3_REALISM_PEOPLE_PRESET, LongVideoError, assertLongLoraSupported, newId } from "./schema.mjs";
import { acquireSequenceLease, assertSequenceLease, releaseSequenceLease, renewSequenceLease } from "./lease.mjs";
import { buildSegmentPrompt } from "./prompt-builder.mjs";
import { validatePrompt } from "./prompt-validator.mjs";
import { buildDeterministicContinuationPrompt, ensureRef2vaLatentContinuationPrompt, ensureRef2vaVisualContextPrompt } from "./continuation-finalizer.mjs";
import { mergeLongVideoNegativePrompt } from "./quality-defaults.mjs";
import { buildRef2VCameraPlanContext, mergeNegativePromptTerms } from "../../app/lib/ref2v-camera-plan.mjs";
import { buildWindowedAutoExtendPrompts } from "../../app/lib/multishot-prompt-windows.mjs";

async function logEvent(id, event, deps) {
  if (deps.log) return deps.log(event);
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(id)) return null;
  return appendEvent(id, event).catch(() => null);
}

function fileFor(folder, name) {
  return sequenceOutputFile(folder, name);
}

function combinedNegativePrompt(globalValue, segmentValue) {
  return mergeLongVideoNegativePrompt(globalValue, segmentValue);
}

function outputAssetRef(filePath) {
  return { root: "output", name: path.relative(outputRoot(), filePath).replaceAll("\\", "/"), kind: path.extname(filePath).toLowerCase() === ".png" ? "image" : "video" };
}

function referenceKey(reference) {
  if (!reference?.name) return "";
  return `${reference.root === "output" ? "output" : "input"}:${String(reference.name).replaceAll("\\", "/")}`.toLocaleLowerCase();
}

function staticReferenceAssets(job) {
  if (job?.identityAnchor === false) return [];
  if (job?.referenceMode !== "multi_reference" && !["motion_context", "latent_context", "context_pin", "first_frame"].includes(job?.continuationMode)) return [];
  const assets = [];
  const seen = new Set();
  for (const reference of [job.inputAsset, ...(Array.isArray(job.referenceAssets) ? job.referenceAssets : [])]) {
    if (!reference?.name) continue;
    const normalized = { root: reference.root === "output" ? "output" : "input", name: String(reference.name).replaceAll("\\", "/"), kind: "image" };
    const key = referenceKey(normalized);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    assets.push(normalized);
  }
  return assets;
}

function segmentReferenceAssets(job, previousTail) {
  const references = staticReferenceAssets(job);
  if (previousTail) {
    const tail = outputAssetRef(previousTail);
    const key = referenceKey(tail);
    if (key && !references.some((reference) => referenceKey(reference) === key)) references.push(tail);
  }
  if (references.length > 9) throw new LongVideoError("REFERENCE_ASSETS_LIMIT", "A Ref2VA segment may use at most 9 image references.", 400);
  return references;
}

/**
 * Ensure every multi-reference continuation explicitly labels the generated
 * previous tail.  Custom prompts are allowed, but they must carry the same
 * non-frame-zero continuity semantics as the generated fallback prompt.
 * Keeping this helper pure makes the admission contract easy to test without
 * running a video model.
 */
export function appendMultiReferenceTail(prompt, references = [], previousTail = null) {
  const text = String(prompt || "").trim();
  if (!previousTail || !Array.isArray(references) || references.length < 1) return text;
  const tailLabel = `<Picture ${references.length}>`;
  const instruction = `${tailLabel} is the previous segment's normalized tail frame, used as a normal continuity reference; do not lock it to frame 0.`;
  if (text.toLocaleLowerCase().includes(instruction.toLocaleLowerCase())) return text;
  const definition = `${tailLabel} is the previous segment's normalized tail frame, used only for continuity and not as a frame-zero lock.`;
  const definitionBoundary = /(subject_definitions\s*:[\s\S]*?)(\n\n(?=summary\s*:))/i;
  const escapedTailLabel = tailLabel.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
  const hasTailDefinition = new RegExp(`subject_definitions\\s*:[\\s\\S]*?^\\s*${escapedTailLabel}\\s+`, "im").test(text);
  const withDefinition = hasTailDefinition
    ? text
    : definitionBoundary.test(text)
      ? text.replace(definitionBoundary, `$1\n${definition}$2`)
      : text;
  const detailedBoundary = /(\bdetailed_description\s*:[\s\S]*?)(\n\n(?=overall_soundscape\s*:))/i;
  if (detailedBoundary.test(withDefinition)) {
    return withDefinition.replace(detailedBoundary, `$1\n${instruction}$2`).trim();
  }
  return `${withDefinition}${withDefinition ? "\n\n" : ""}${instruction}`.trim();
}

function appendCameraPlan(prompt, mode, cameraContext) {
  const rawContext = String(cameraContext || "").trim();
  if (!rawContext) return String(prompt || "").trim();
  // The first line is an instruction for prompt compilers.  Runtime already
  // has a compiled H3 prompt, so inject only the concrete camera directives.
  const camera = rawContext.split(/\r?\n/).slice(1).join(" ").trim();
  if (!camera || String(prompt || "").includes(camera)) return String(prompt || "").trim();
  const bodyField = mode === "ref2v" ? "detailed_description" : "integrated_multimodal_description";
  const boundary = new RegExp(`(\\b${bodyField}\\s*:[\\s\\S]*?)(\\n\\n(?=overall_soundscape\\s*:))`, "i");
  if (boundary.test(prompt)) return String(prompt).replace(boundary, `$1\nCamera plan: ${camera}$2`).trim();
  return `${String(prompt || "").trim()}\n\nCamera plan: ${camera}`.trim();
}

export function appendMultishotContinuityControls(prompt, job, segmentIndex) {
  let next = String(prompt || "").trim();
  if (job?.longVideoEnabled !== true) return next;
  const controls = [
    "Keep this as one continuous take. At the window boundary keep the face readable and the action naturally continuing; avoid occlusion, back-to-camera poses, heavy motion blur, abrupt camera motion, transitions, and dialogue cuts.",
  ];
  if (segmentIndex > 0) controls.push("Continue from the exact prior moment with the same identity, clothing, environment, time, camera, lens, lighting, action direction, and dialogue.");
  if (segmentIndex > 0 && job.chainGainControl === "flatten") controls.push("Match Shot 1 texture energy and micro-contrast; do not progressively sharpen skin, hair, fabric, or background detail.");
  if (segmentIndex > 0 && job.voiceContinuity !== false) controls.push("Preserve the established speaker identity, voice timbre, cadence, ambience, and dialogue continuity.");
  return `${next}${next ? "\n\n" : ""}${controls.join(" ")}`;
}

function persistedAttemptPrompt(prompt, runtimePaths = []) {
  let safe = String(prompt || "");
  for (const runtimePath of runtimePaths) {
    if (runtimePath) safe = safe.replaceAll(String(runtimePath), "[runtime asset]");
  }
  // Finalize dependencies may include a path using a different separator.
  // Keep the useful prompt text but never persist an absolute filesystem path.
  return safe
    .replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, "[runtime image data]")
    .replace(/(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{256,}={0,2}(?![A-Za-z0-9+/])/g, "[runtime image data]")
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>]+/g, "[runtime asset]");
}

function normalizePromptFinalization(value, fallback = {}) {
  const source = value && typeof value === "object" ? value : {};
  const provider = String(source.provider || fallback.provider || "custom").trim() || "custom";
  const model = source.model ?? fallback.model ?? null;
  const result = {
    provider,
    model: model === null || model === undefined || String(model).trim() === "" ? null : String(model).trim(),
    fallback: Boolean(source.fallback ?? fallback.fallback),
  };
  const reason = source.reason || fallback.reason;
  const errorCode = source.errorCode || fallback.errorCode;
  if (reason) result.reason = String(reason).slice(0, 160);
  if (errorCode) result.errorCode = String(errorCode).slice(0, 120);
  const skill = source.skill && typeof source.skill === "object" ? source.skill : fallback.skill;
  if (skill && typeof skill === "object") {
    result.skill = {
      name: String(skill.name || "h3-prompt-writing").slice(0, 120),
      guide: String(skill.guide || "").slice(0, 120),
      contentHash: String(skill.contentHash || "").slice(0, 120),
      source: String(skill.source || "").slice(0, 120),
      ...(skill.warning ? { warning: String(skill.warning).slice(0, 240) } : {}),
    };
  }
  return result;
}

function fallbackPromptFinalization({ model, reason, error } = {}) {
  return normalizePromptFinalization({
    provider: "deterministic",
    model: model || null,
    fallback: true,
    reason,
    errorCode: error?.code,
  }, { provider: "deterministic", fallback: true });
}

function isOllamaUnloadFailure(error) {
  return error?.code === "OLLAMA_UNLOAD_FAILED"
    || error?.details?.unloadError?.code === "OLLAMA_UNLOAD_FAILED"
    || error?.cause?.code === "OLLAMA_UNLOAD_FAILED";
}

async function setJob(job, patch, deps) {
  if (deps.lease) await assertSequenceLease(job.id, deps.lease);
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  if (deps.updateJob) return deps.updateJob(job, patch);
  if (/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(String(job.id || ""))) {
    return updateJob(job.id, patch);
  }
  return job;
}

async function setSegment(job, index, patch, deps) {
  if (deps.lease) await assertSequenceLease(job.id, deps.lease);
  Object.assign(job.segments[index], patch);
  if (deps.updateSegment) return deps.updateSegment(job, index, patch);
  if (/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(String(job.id || ""))) return updateSegment(job.id, index, patch);
  return job.segments[index];
}

function generationResultPath(result, fallback) {
  if (typeof result === "string") return result;
  return result?.rawPath || result?.outputPath || result?.path || fallback;
}

export function sequenceProgressForSegment(segmentIndex, segmentCount, generationProgress) {
  const count = Math.max(1, Number(segmentCount) || 1);
  const index = Math.min(count - 1, Math.max(0, Number(segmentIndex) || 0));
  const percent = Math.min(100, Math.max(0, Number(generationProgress) || 0));
  return Math.min(85, Math.max(1, Math.round(((index + percent / 100) / count) * 85)));
}

export function latentRenderedFrameCount(duration, segmentIndex) {
  const requestedFrames = Math.max(5, Math.round(Number(duration) * 24));
  if (segmentIndex > 0) return Math.max(17, Math.round(requestedFrames / 17) * 17);
  const lowerK = Math.max(0, Math.floor((requestedFrames - 5) / 17));
  const lower = 17 * lowerK + 5;
  const upper = 17 * (lowerK + 1) + 5;
  return Math.abs(requestedFrames - lower) <= Math.abs(upper - requestedFrames) ? lower : upper;
}

export function latentRenderedDuration(duration, segmentIndex) {
  return latentRenderedFrameCount(duration, segmentIndex) / 24;
}

export function contextPinRenderedDuration(secondsPerShot, segmentIndex) {
  const requestedFrames = Math.max(5, Math.round(Number(secondsPerShot) * 24));
  if (segmentIndex === 0) return latentRenderedFrameCount(secondsPerShot, 0) / 24;
  return (Math.ceil(requestedFrames / 17) * 17) / 24;
}

export function h3MotionContextDuration(requestedSeconds = 1.5, segmentSeconds = Number.POSITIVE_INFINITY) {
  // H3 reference videos are truncated to a 17k+5 frame grid.  Choose the
  // nearest useful grid point within the requested 1-2 second range so a
  // nominal 1.5s clip does not collapse to only 22 frames in the node.
  const requested = Math.min(2, Math.max(1, Number(requestedSeconds) || 1.5));
  const candidates = [22 / 24, 39 / 24];
  const aligned = candidates.reduce((best, candidate) => Math.abs(candidate - requested) < Math.abs(best - requested) ? candidate : best, candidates[0]);
  return Number(Math.min(aligned, Math.max(0.25, Number(segmentSeconds) || aligned)).toFixed(3));
}

async function defaultVerifyCompletedSegment(segment) {
  const normalizedPath = segment.normalizedPath || (segment.normalizedAsset?.name ? path.join(outputRoot(), segment.normalizedAsset.name) : null);
  const tailPath = segment.tailPath || (segment.tailAsset?.name ? path.join(outputRoot(), segment.tailAsset.name) : null);
  if (!normalizedPath || !tailPath) return false;
  const [normalized, tail] = await Promise.all([fs.stat(normalizedPath).catch(() => null), fs.stat(tailPath).catch(() => null)]);
  return Boolean(normalized?.isFile() && tail?.isFile());
}

export function repairLegacyAutoExtendPrompts(job) {
  if (job?.longVideoEnabled !== true || job?.promptMode !== "auto_extend" || job?.planMeta?.promptSource !== "auto_extend" || !Array.isArray(job?.segments) || job.segments.length < 2) return null;
  const firstPrompt = String(job.segments[0]?.prompt || "");
  const source = firstPrompt.split(/\n\nEnd this window on a stable readable face[\s\S]*$/i)[0].trim();
  const timedHeadings = source.match(/^\s*(?:\[)?\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:–|—|-|~|to)\s*\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?/gmi) || [];
  if (timedHeadings.length < 2) return null;
  const anchor = source.slice(0, Math.min(160, source.length));
  const duplicated = job.segments.filter((segment) => String(segment?.prompt || "").includes(anchor)).length;
  if (duplicated < 2) return null;
  return buildWindowedAutoExtendPrompts(source, job.segments.map((segment) => ({ start: segment.start, end: segment.end })));
}

export async function runSequence(sequenceOrId, deps = {}) {
  const job = typeof sequenceOrId === "string" ? await getJob(sequenceOrId) : sequenceOrId;
  const minimumSegments = job?.longVideoEnabled === true ? 1 : 2;
  if (!job || !Array.isArray(job.segments) || job.segments.length < minimumSegments) throw new LongVideoError("SEQUENCE_INVALID", `A sequence with at least ${minimumSegments} segment${minimumSegments === 1 ? "" : "s"} is required.`);
  const id = job.id;
  let releaseLeaseOnExit = Boolean(deps.lease);
  let leaseHeartbeat = null;
  const folder = job.outputPath || (job.outputFolder ? path.join(outputRoot(), job.outputFolder) : null);
  if (!folder) throw new LongVideoError("OUTPUT_PATH_REQUIRED", "Sequence output folder is not allocated.");
  const generate = deps.generate || deps.generation || deps.generateSegment;
  if (typeof generate !== "function") throw new LongVideoError("GENERATION_DEPENDENCY_REQUIRED", "A generation dependency is required to run a sequence.", 500);
  const normalizedLora = assertLongLoraSupported(job);
  const loraPayload = normalizedLora.h3LoraEnabled === true
    ? {
      h3LoraEnabled: true,
      h3LoraPreset: H3_REALISM_PEOPLE_PRESET,
      characterLoraName: H3_REALISM_PEOPLE_PRESET,
      characterLoraStrength: Number(normalizedLora.characterLoraStrength ?? 0.8),
    }
    : normalizedLora.characterLoraName || normalizedLora.characterLoraId
      ? {
        ...(normalizedLora.characterLoraName ? { characterLoraName: normalizedLora.characterLoraName } : {}),
        ...(normalizedLora.characterLoraId ? { characterLoraId: normalizedLora.characterLoraId } : {}),
        characterLoraStrength: Number(normalizedLora.characterLoraStrength ?? 0.75),
      }
      : {};
  const normalize = deps.normalize || deps.media?.normalize || defaultNormalize;
  const extractTail = deps.extractTail || deps.media?.extractTail || defaultExtractTail;
  const extractContext = deps.extractContext || deps.media?.extractContext || defaultExtractContext;
  const trimOverlap = deps.trimOverlap || deps.media?.trimOverlap || defaultTrimOverlap;
  const assemble = deps.assemble || deps.media?.assemble || defaultAssemble;
  const verifyCompletedSegment = deps.verifyCompletedSegment || defaultVerifyCompletedSegment;
  const writeManifest = deps.writeManifest || writeSequenceManifest;
  if (id && /^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(String(id)) && (deps.enforceLease || deps.ownerId) && !deps.lease) {
    deps.lease = await acquireSequenceLease(id, { ownerId: deps.ownerId || `h3-studio-runner-${process.pid}`, ttlMs: deps.leaseTtlMs });
    releaseLeaseOnExit = true;
  }
  if (deps.lease) {
    const heartbeatMs = Math.max(2_000, Math.floor(Number(deps.leaseTtlMs || 30_000) / 3));
    leaseHeartbeat = setInterval(() => {
      renewSequenceLease(id, deps.lease, { ttlMs: deps.leaseTtlMs }).then((renewed) => {
        deps.lease = renewed;
      }).catch(() => {});
    }, heartbeatMs);
    leaseHeartbeat.unref?.();
  }
  const repairedPrompts = repairLegacyAutoExtendPrompts(job);
  if (repairedPrompts) {
    for (let index = 0; index < repairedPrompts.length; index += 1) {
      await setSegment(job, index, {
        prompt: repairedPrompts[index],
        promptSource: "auto_extend",
        status: "pending",
        recoverable: true,
        error: null,
        promptFinalization: null,
      }, deps);
    }
    await logEvent(id, { level: "warn", event: "prompt.auto_extend_legacy_repaired", stage: "sequence.preflight", segmentCount: repairedPrompts.length }, deps);
  }
  const normalizedPaths = [];
  const motionContext = job.continuationMode === "motion_context";
  const legacyLatentContext = job.continuationMode === "latent_context";
  let multishotContinuity = null;
  if (job.longVideoEnabled === true) {
    const capability = job.continuityMode === "context_pin" && typeof deps.motionContextCapability === "function"
      ? await deps.motionContextCapability()
      : { available: job.continuityMode !== "context_pin" };
    multishotContinuity = resolveMultishotContinuity(job.continuityMode, capability);
    await setJob(job, {
      effectiveContinuityMode: multishotContinuity.effective,
      continuityFallback: multishotContinuity.fallback,
      continuityWarning: multishotContinuity.warning,
      motionContextCapability: capability,
    }, deps);
    if (multishotContinuity.warning) await logEvent(id, { level: "warn", event: "continuity.fallback", ...multishotContinuity }, deps);
  }
  const firstFrame = multishotContinuity?.effective === "first_frame";
  const contextPin = multishotContinuity?.effective === "context_pin";
  const latentContext = legacyLatentContext || contextPin;
  let previousTail = null;
  let previousContext = null;
  let activeSegmentIndex = -1;
  let activeAttemptRecord = null;
  await setJob(job, { status: "running", progress: 1, stage: "sequence.start", error: null }, deps);
  await logEvent(id, { event: "runner.start", from: "ready", to: "running", stage: "sequence.start", segmentCount: job.segments.length }, deps);
  try {
    for (let index = 0; index < job.segments.length; index += 1) {
      activeSegmentIndex = index;
      if (deps.shouldCancel?.(job) || job.controlIntent === "cancel_requested") throw new LongVideoError("SEQUENCE_CANCELLED", "Sequence was cancelled.", 409);
      while (deps.shouldPause?.(job) || job.controlIntent === "pause_requested") await new Promise((resolve) => setTimeout(resolve, 100));
      const segment = job.segments[index];
      activeAttemptRecord = null;
      if (segment.status === "completed") {
        const verified = await verifyCompletedSegment(segment, { sequence: job, segmentIndex: index });
        if (verified) {
          const normalizedPath = verified.normalizedPath || segment.normalizedPath || (segment.normalizedAsset?.name ? path.join(outputRoot(), segment.normalizedAsset.name) : null);
          const tailPath = verified.tailPath || segment.tailPath || (segment.tailAsset?.name ? path.join(outputRoot(), segment.tailAsset.name) : null);
          normalizedPaths.push(normalizedPath);
          previousTail = tailPath;
          if (motionContext && index < job.segments.length - 1) {
            const persistedContextPath = segment.contextPath || (segment.contextAsset?.name ? path.join(outputRoot(), segment.contextAsset.name) : null);
            const persistedContext = persistedContextPath ? await fs.stat(persistedContextPath).catch(() => null) : null;
            if (persistedContext?.isFile()) {
              previousContext = persistedContextPath;
            } else {
              previousContext = normalizedPath.replace(/\.mp4$/i, "-context.mp4");
              await extractContext({
                inputPath: normalizedPath,
                outputPath: previousContext,
                duration: h3MotionContextDuration(2, segment.duration),
                fps: 24,
                includeAudio: false,
                tools: deps.tools,
                run: deps.run,
              });
              await setSegment(job, index, { contextAsset: outputAssetRef(previousContext) }, deps);
            }
          }
          await logEvent(id, { event: "runner.resume.skip_completed", segmentIndex: index, segmentId: segment.id, stage: "completed", outputRelative: segment.outputRelative || segment.normalizedAsset?.name }, deps);
          await setJob(job, {
            progress: sequenceProgressForSegment(index, job.segments.length, 100),
            stage: "segment.completed",
            activeSegmentIndex: index,
            segmentProgress: 100,
            segmentStage: "已驗證既有片段，繼續下一段",
          }, deps);
          continue;
        }
        await logEvent(id, { level: "warn", event: "runner.resume.artifact_missing", segmentIndex: index, segmentId: segment.id, stage: "rerender" }, deps);
        await setSegment(job, index, { status: "pending", recoverable: true, error: { code: "COMPLETED_ARTIFACT_MISSING", message: "Completed segment artifact is missing; rerendering." } }, deps);
      }
      const reattachAttempt = Boolean(segment.attemptId && segment.childJobId && deps.recoverChild);
      const attempt = reattachAttempt ? Math.max(1, Number(segment.attempt || 1)) : Math.max(1, Number(segment.attempt || 0) + 1);
      const attemptId = reattachAttempt ? String(segment.attemptId) : newId("attempt");
      const prefix = `segment-${String(index + 1).padStart(3, "0")}-attempt-${String(attempt).padStart(3, "0")}`;
      const rawPath = fileFor(folder, `${prefix}-raw.mp4`);
      const normalizedPath = fileFor(folder, `${prefix}.mp4`);
      const tailPath = fileFor(folder, `${prefix}-tail.png`);
      const contextPath = fileFor(folder, `${prefix}-context.mp4`);
      const multiReference = job.referenceMode === "multi_reference";
      const hasStaticReferences = staticReferenceAssets(job).length > 0;
      const mode = multiReference || index > 0 && (motionContext || legacyLatentContext || (contextPin || firstFrame) && hasStaticReferences)
        ? "ref2v"
        : index === 0 && job.inputType === "text"
          ? "t2v"
          : index > 0 && contextPin ? "t2v" : "i2v";
      // The planner receipt gates the first H3 submission only. Later
      // segments either use their own continuation cleanup barrier or retain
      // the already-admitted prompt state without an unnecessary TTL wait.
      const ollamaPromptReceipt = index === 0 ? job.planMeta?.ollamaPromptReceipt || null : null;
      const hasCharacterLora = Boolean(loraPayload.characterLoraName || loraPayload.characterLoraId || loraPayload.h3LoraEnabled);
      if (hasCharacterLora && mode === "ref2v" && loraPayload.h3LoraEnabled !== true) {
        throw new LongVideoError("CHARACTER_LORA_MODE_UNSUPPORTED", "Character LoRA is not supported for Ref2VA/multi-reference long-video segments.", 422);
      }
      const references = mode === "ref2v" ? segmentReferenceAssets(job, motionContext || latentContext || firstFrame ? null : index > 0 ? previousTail : null) : [];
      const shouldFinalizeContinuation = !motionContext && !latentContext && index > 0 && Boolean(previousTail);
      const previousSegment = index > 0 ? job.segments[index - 1] : null;
      const previousEndingState = String(previousSegment?.endingState || previousSegment?.ending_state || "").trim();
      const continuation = shouldFinalizeContinuation
        ? "Continue directly from the supplied normalized tail frame as Picture 1; preserve the ending state and motion direction from the previous segment."
        : "";
      const draftPrompt = String(segment.prompt || "").trim();
      const finalizerModel = job.ollamaModel || deps.finalizerModel || null;
      let prompt = draftPrompt;
      let promptFinalization = null;
      let ollamaPromptBarrier = null;
      if (shouldFinalizeContinuation) {
        const finalizerContext = {
          job,
          segment,
          segmentIndex: index,
          mode,
          previousTail,
          tailRoot: folder,
          references,
          continuityBible: job.continuityBible,
          previousEndingState,
          // Keep the historical next-segment field available while making the
          // previous segment state explicit for continuation finalization.
          endingState: segment.endingState,
          draftPrompt,
        };
        await setSegment(job, index, { status: "finalizing_prompt", error: null }, deps);
        if (typeof deps.finalizePrompt === "function") {
          try {
            const finalized = await deps.finalizePrompt(finalizerContext);
            const candidate = typeof finalized === "string" ? finalized : finalized?.prompt;
            if (!String(candidate || "").trim()) throw Object.assign(new Error("Continuation finalizer returned an empty prompt."), { code: "FINALIZER_EMPTY" });
            prompt = String(candidate).trim();
            ollamaPromptBarrier = finalized?.ollamaPromptBarrier || null;
            promptFinalization = normalizePromptFinalization(finalized?.provenance || finalized, {
              provider: "custom",
              model: finalizerModel,
              fallback: false,
              reason: "vision_success",
            });
          } catch (error) {
            if (isOllamaUnloadFailure(error)) throw error;
            prompt = buildDeterministicContinuationPrompt(finalizerContext);
            promptFinalization = fallbackPromptFinalization({ model: finalizerModel, reason: "vision_finalizer_failed", error });
          }
        } else {
          prompt = buildDeterministicContinuationPrompt(finalizerContext);
          promptFinalization = fallbackPromptFinalization({ model: finalizerModel, reason: "vision_finalizer_unconfigured" });
        }
      }
      if (motionContext && index > 0) prompt = ensureRef2vaVisualContextPrompt(prompt);
      if (latentContext && index > 0 && mode === "ref2v") prompt = ensureRef2vaLatentContinuationPrompt(prompt);
      try {
        validatePrompt(prompt, { mode });
        if (multiReference && !/<Picture\s+1>/i.test(prompt)) throw new Error("Ref2VA prompt must declare ordered picture labels.");
      } catch (error) {
        if (shouldFinalizeContinuation) {
          prompt = buildDeterministicContinuationPrompt({
            job,
            segment: { ...segment, continuityNote: continuation },
            segmentIndex: index,
            mode,
            previousTail,
            tailRoot: folder,
            references,
            continuityBible: job.continuityBible,
            previousEndingState,
            endingState: segment.endingState,
            draftPrompt,
          });
          promptFinalization = fallbackPromptFinalization({ model: finalizerModel, reason: "prompt_validation_failed", error });
        } else {
          const fallbackSegment = multiReference
            ? {
                ...segment,
                description: `Ordered reference pictures: ${references.map((reference, referenceIndex) => `<Picture ${referenceIndex + 1}> (${reference.name || "reference"})`).join(", ")}.\n${segment.description || ""}`.trim(),
                continuityNote: continuation,
              }
            : { ...segment, continuityNote: continuation };
          prompt = buildSegmentPrompt(fallbackSegment, job.continuityBible, {
            mode,
            firstFrame: index === 0,
            pictureLabel: "Picture 1",
            shotId: "Shot 1",
            references: { assets: references, hasVideo: motionContext && index > 0 },
          });
        }
      }
      if (!motionContext && !firstFrame && !contextPin && mode === "ref2v" && index > 0 && previousTail) {
        prompt = appendMultiReferenceTail(prompt, references, previousTail);
      }
      if (motionContext && index > 0) prompt = ensureRef2vaVisualContextPrompt(prompt);
      if (latentContext && index > 0 && mode === "ref2v") prompt = ensureRef2vaLatentContinuationPrompt(prompt);
      const camera = segment.cameraPlan && typeof segment.cameraPlan === "object"
        ? buildRef2VCameraPlanContext(segment.cameraPlan, {
            duration: segment.duration,
            referenceCount: references.length || (mode === "i2v" ? 1 : 0),
            hasVideo: motionContext && index > 0,
          })
        : null;
      prompt = appendCameraPlan(prompt, mode, camera?.context);
      prompt = appendMultishotContinuityControls(prompt, job, index);
      const negativePrompt = mergeNegativePromptTerms(
        combinedNegativePrompt(job.negativePrompt, segment.negativePrompt),
        camera?.negativeTerms || [],
      );
      const renderedDuration = contextPin
        ? contextPinRenderedDuration(job.secondsPerShot || segment.duration, index)
        : job.longVideoEnabled === true
          ? Number(job.secondsPerShot || segment.duration)
          : latentContext ? latentRenderedDuration(segment.duration, index) : segment.duration;
      const startedAt = new Date().toISOString();
      activeAttemptRecord = {
        sequenceId: id,
        segmentId: segment.id,
        attempt,
        attemptId,
        segmentIndex: index,
        status: reattachAttempt ? "child_running" : "queued",
        checkpoint: reattachAttempt ? "child_running" : "submission_prepared",
        childJobId: reattachAttempt ? String(segment.childJobId) : null,
        mode,
        prompt: persistedAttemptPrompt(prompt),
        startedAt,
        duration: segment.duration,
        width: job.width,
        height: job.height,
        steps: job.steps,
        seed: Number(job.seed || 0) + index,
        modelProfile: job.modelProfile,
        negativePrompt,
        ...loraPayload,
        ...(promptFinalization ? { promptFinalization } : {}),
      };
      await setSegment(job, index, {
        status: "queued",
        attempt,
        attemptId,
        childJobId: reattachAttempt ? segment.childJobId : null,
        childJobProvenance: {
          sequenceId: id,
          segmentId: segment.id,
          segmentIndex: index,
          attempt,
          attemptId,
          ...(reattachAttempt ? { childJobId: segment.childJobId } : {}),
        },
        checkpoint: reattachAttempt ? "child_running" : "submission_prepared",
        prompt,
        error: null,
        ...(promptFinalization ? { promptFinalization } : {}),
      }, deps);
      await setJob(job, {
        activeAttempt: {
          sequenceId: id,
          segmentId: segment.id,
          segmentIndex: index,
          attempt,
          attemptId,
          ...(reattachAttempt ? { childJobId: segment.childJobId } : {}),
          checkpoint: reattachAttempt ? "child_running" : "submission_prepared",
        },
        executionPhase: reattachAttempt ? "waiting_child" : "submission_prepared",
      }, deps);
      if (/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(String(id || ""))) await writeAttempt(id, index, attempt, activeAttemptRecord).catch(() => {});
      await logEvent(id, { event: "generation.start", segmentIndex: index, segmentId: segment.id, attempt, mode, stage: "queued", outputRelative: path.relative(folder, rawPath) }, deps);
      await setSegment(job, index, { status: "rendering", checkpoint: reattachAttempt ? "child_running" : "child_queued" }, deps);
      await setJob(job, {
        stage: "segment.rendering",
        activeSegmentIndex: index,
        segmentProgress: 0,
        segmentStage: "準備本機輸入…",
        generationJobId: null,
      }, deps);
      let lastReportedProgress = -1;
      let lastReportedStage = "";
      let lastLoggedProgressBucket = -1;
      const generated = reattachAttempt && typeof deps.recoverChild === "function"
        ? await deps.recoverChild({ sequenceId: id, segment, segmentIndex: index, attempt, attemptId, childJobId: segment.childJobId, onProgress: async (snapshot) => {
          await setJob(job, { generationJobId: snapshot?.id || segment.childJobId, executionPhase: "waiting_child", segmentProgress: snapshot?.progress, segmentStage: snapshot?.stage }, deps);
        } })
        : await generate({
        sequenceId: id,
        segmentId: segment.id,
        segment,
        segmentIndex: index,
        attempt,
        attemptId,
        mode,
        prompt,
        ...(ollamaPromptReceipt ? { ollamaPromptReceipt } : {}),
        ...(ollamaPromptBarrier ? { ollamaPromptBarrier } : {}),
        negativePrompt,
        width: job.width,
        height: job.height,
        steps: job.steps,
        seed: Number(job.seed || 0) + index,
        modelProfile: job.modelProfile,
        duration: segment.duration,
        renderedDuration,
        ...loraPayload,
        inputAsset: index === 0 ? job.inputAsset : null,
        inputImagePath: mode === "ref2v" || contextPin && index > 0 ? null : index === 0 ? job.inputAsset?.path || job.inputAsset?.fullPath || job.inputAsset?.name || null : previousTail,
        ...(firstFrame && mode === "ref2v" && index > 0 && previousTail ? { continuationFramePath: previousTail } : {}),
        ...(mode === "ref2v" ? {
          referenceMode: multiReference ? "multi_reference" : latentContext ? "latent_context" : "motion_context",
          referenceImageNames: references.map((reference) => reference.name),
          referenceAssets: references,
          ...(motionContext && index > 0 && previousContext ? { inputVideoPath: previousContext } : {}),
        } : {}),
        ...(latentContext ? {
          latentContinuation: true,
          latentContextFrames: contextPin ? Number(job.contextFrames || 22) : 39,
          latentDeliveryPolicy: contextPin ? "ceil" : "nearest",
          voiceContinuity: contextPin ? job.voiceContinuity !== false : true,
          latentCheckpointPrefix: `h3_sequence_checkpoints/${id}/clip`,
          latentClipIndex: index + 1,
          ...(index > 0 ? { latentPreviousClipIndex: index } : {}),
        } : {}),
        tailImagePath: previousTail,
        outputPath: rawPath,
        onChildSubmitted: async (child = {}) => {
          const childJobId = String(child.id || child.jobId || child.generationJobId || "").trim();
          if (!childJobId) throw new LongVideoError("CHILD_BINDING_MISSING", "Generation dependency did not return a child job id.", 502);
          await setSegment(job, index, {
            childJobId,
            childJobProvenance: { sequenceId: id, segmentId: segment.id, segmentIndex: index, attempt, attemptId, childJobId },
            checkpoint: "child_queued",
          }, deps);
          await setJob(job, {
            generationJobId: childJobId,
            activeAttempt: { sequenceId: id, segmentId: segment.id, segmentIndex: index, attempt, attemptId, childJobId, checkpoint: "child_queued" },
            executionPhase: "waiting_child",
          }, deps);
          activeAttemptRecord = { ...activeAttemptRecord, childJobId, checkpoint: "child_queued" };
          if (/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(String(id || ""))) await writeAttempt(id, index, attempt, activeAttemptRecord).catch(() => {});
        },
        outputRelative: path.relative(outputRoot(), rawPath).replaceAll("\\", "/"),
        onInputStage: async (inputStage = {}) => {
          await logEvent(id, {
            event: inputStage.event || "generation.input.stage",
            segmentIndex: index,
            segmentId: segment.id,
            attempt,
            stage: inputStage.stage || "input",
            source: inputStage.source,
            stagedName: inputStage.stagedName,
          }, deps);
        },
        onProgress: async (generationJob = {}) => {
          const segmentProgress = Math.min(100, Math.max(0, Math.round(Number(generationJob.progress) || 0)));
          const segmentStage = String(generationJob.stage || "生成片段中…");
          if (segmentProgress === lastReportedProgress && segmentStage === lastReportedStage) return;
          lastReportedProgress = segmentProgress;
          lastReportedStage = segmentStage;
          Object.assign(job.segments[index], { status: "rendering", progress: segmentProgress, stage: segmentStage });
          await setJob(job, {
            progress: sequenceProgressForSegment(index, job.segments.length, segmentProgress),
            stage: "segment.rendering",
            activeSegmentIndex: index,
            segmentProgress,
            segmentStage,
            generationJobId: generationJob.id || null,
            progressSource: generationJob.progressSource || "estimated",
            nativeCurrent: generationJob.nativeCurrent,
            nativeMaximum: generationJob.nativeMaximum,
            segments: job.segments,
            timeline: job.segments,
          }, deps);
          const progressBucket = Math.min(100, Math.floor(segmentProgress / 10) * 10);
          if (progressBucket > lastLoggedProgressBucket) {
            lastLoggedProgressBucket = progressBucket;
            await logEvent(id, {
              event: "generation.progress",
              segmentIndex: index,
              segmentId: segment.id,
              attempt,
              generationJobId: generationJob.id,
              progress: segmentProgress,
              stage: segmentStage,
              progressSource: generationJob.progressSource,
              nativeCurrent: generationJob.nativeCurrent,
              nativeMaximum: generationJob.nativeMaximum,
            }, deps);
          }
        },
      });
      const producedRawPath = generationResultPath(generated, rawPath);
      const generationJobId = generated?.id || generated?.job?.id;
      activeAttemptRecord = {
        ...activeAttemptRecord,
        status: "generated",
        checkpoint: "raw_verified",
        generationJobId,
        childJobId: generationJobId || activeAttemptRecord?.childJobId || segment.childJobId,
        rawAsset: outputAssetRef(producedRawPath),
      };
      if (/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(String(id || ""))) await writeAttempt(id, index, attempt, activeAttemptRecord).catch(() => {});
      await logEvent(id, { event: "generation.success", segmentIndex: index, segmentId: segment.id, attempt, generationJobId, stage: "rendering", outputRelative: path.relative(outputRoot(), producedRawPath).replaceAll("\\", "/") }, deps);
      await setSegment(job, index, { status: "generated", checkpoint: "raw_verified", childJobId: generationJobId || activeAttemptRecord?.childJobId || segment.childJobId, rawAsset: outputAssetRef(producedRawPath) }, deps);
      await setSegment(job, index, { status: "normalizing", checkpoint: "raw_verified", rawAsset: outputAssetRef(producedRawPath) }, deps);
      await setJob(job, {
        progress: sequenceProgressForSegment(index, job.segments.length, 100),
        stage: "segment.normalizing",
        activeSegmentIndex: index,
        segmentProgress: 100,
        segmentStage: "標準化影片格式與音訊…",
        generationJobId: generationJobId || job.generationJobId || null,
      }, deps);
      const normalizedDuration = job.longVideoEnabled === true
        ? Number(segment.duration) + (firstFrame && index > 0 ? 1 / 24 : 0)
        : renderedDuration;
      await logEvent(id, { event: "media.normalize.start", segmentIndex: index, segmentId: segment.id, attempt, stage: "normalizing", duration: normalizedDuration, renderedDuration, requestedDuration: segment.duration }, deps);
      await normalize({ inputPath: producedRawPath, outputPath: normalizedPath, duration: normalizedDuration, fps: 24, width: job.width, height: job.height, seam: job.seam, tools: deps.tools, run: deps.run, logger: (event) => logEvent(id, { ...event, segmentIndex: index, segmentId: segment.id, attempt }, deps) });
      await setSegment(job, index, { status: "normalized", checkpoint: "normalized_verified", normalizedAsset: outputAssetRef(normalizedPath) }, deps);
      let completedPath = normalizedPath;
      let overlapTrimFrames = 0;
      if (firstFrame && index > 0) {
        completedPath = fileFor(folder, `${prefix}-seam-trimmed.mp4`);
        const trimmed = await trimOverlap({ inputPath: normalizedPath, outputPath: completedPath, frames: 1, fps: 24, tools: deps.tools, run: deps.run, logger: (event) => logEvent(id, { ...event, segmentIndex: index, segmentId: segment.id, attempt }, deps) });
        overlapTrimFrames = Number(trimmed?.trimmedFrames || 1);
      }
      if (motionContext && index < job.segments.length - 1) {
        await setSegment(job, index, { status: "extracting_context", normalizedAsset: outputAssetRef(normalizedPath) }, deps);
        await setJob(job, {
          stage: "segment.extracting_context",
          activeSegmentIndex: index,
          segmentProgress: 100,
          segmentStage: "擷取上一分鏡 2 秒視覺參考",
        }, deps);
        await extractContext({ inputPath: normalizedPath, outputPath: contextPath, duration: h3MotionContextDuration(2, segment.duration), fps: 24, includeAudio: false, tools: deps.tools, run: deps.run, logger: (event) => logEvent(id, { ...event, segmentIndex: index, segmentId: segment.id, attempt }, deps) });
        previousContext = contextPath;
      }
      await setSegment(job, index, { status: "extracting_tail", checkpoint: "normalized_verified", normalizedAsset: outputAssetRef(completedPath) }, deps);
      await setJob(job, {
        stage: "segment.extracting_tail",
        activeSegmentIndex: index,
        segmentProgress: 100,
        segmentStage: "擷取段尾銜接影格…",
      }, deps);
      await extractTail({ inputPath: completedPath, outputPath: tailPath, tools: deps.tools, run: deps.run, logger: (event) => logEvent(id, { ...event, segmentIndex: index, segmentId: segment.id, attempt }, deps) });
      await setSegment(job, index, { checkpoint: "tail_verified", tailAsset: outputAssetRef(tailPath) }, deps);
      previousTail = tailPath;
      normalizedPaths.push(completedPath);
      await setSegment(job, index, { status: "completed", checkpoint: "segment_completed", renderedDuration, overlapTrimFrames, normalizedAsset: outputAssetRef(completedPath), tailAsset: outputAssetRef(tailPath), ...(motionContext && index < job.segments.length - 1 ? { contextAsset: outputAssetRef(contextPath) } : {}), outputRelative: path.relative(outputRoot(), completedPath).replaceAll("\\", "/") }, deps);
      if (/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(String(id || ""))) await writeAttempt(id, index, attempt, { ...activeAttemptRecord, attempt, segmentIndex: index, status: "completed", prompt: persistedAttemptPrompt(prompt, [previousTail, previousContext, producedRawPath, completedPath, tailPath, contextPath]), rawAsset: outputAssetRef(producedRawPath), normalizedAsset: outputAssetRef(completedPath), tailAsset: outputAssetRef(tailPath), overlapTrimFrames, ...(motionContext && index < job.segments.length - 1 ? { contextAsset: outputAssetRef(contextPath) } : {}), generationJobId, finishedAt: new Date().toISOString() }).catch(() => {});
      activeAttemptRecord = null;
      await setJob(job, {
        activeAttempt: null,
        executionPhase: "segment_completed",
        progress: sequenceProgressForSegment(index, job.segments.length, 100),
        stage: "segment.completed",
        activeSegmentIndex: index,
        segmentProgress: 100,
        segmentStage: `第 ${index + 1} 段完成`,
      }, deps);
      await logEvent(id, { event: "segment.completed", segmentIndex: index, segmentId: segment.id, attempt, stage: "completed", duration: renderedDuration, requestedDuration: segment.duration, outputRelative: path.relative(outputRoot(), normalizedPath).replaceAll("\\", "/") }, deps);
    }
    if (deps.shouldCancel?.(job) || job.controlIntent === "cancel_requested") throw new LongVideoError("SEQUENCE_CANCELLED", "Sequence was cancelled.", 409);
    activeSegmentIndex = -1;
    await setJob(job, { status: "assembling", executionPhase: "assembling", progress: 90, stage: "assembly.start", activeSegmentIndex: null, segmentProgress: 100, segmentStage: "合併所有片段…" }, deps);
    if (id && deps.lease) await assertSequenceLease(id, deps.lease);
    const assemblyRevision = Number(job.assembly?.revision || 0) + 1;
    const assemblyDirectory = deps.assemblyDir || (/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(String(id || "")) ? sequenceAssemblyDir(id) : path.join(folder, "assembly"));
    const renderedMasterDuration = job.segments.reduce((sum, segment) => sum + Number(segment.renderedDuration ?? segment.duration ?? (segment.end - segment.start)), 0);
    const assembledDuration = Number(renderedMasterDuration.toFixed(6));
    const assembly = await assemble({ segmentPaths: normalizedPaths, outputFolder: folder, assemblyDir: assemblyDirectory, revision: assemblyRevision, duration: assembledDuration, width: job.width, height: job.height, masterNormalize: job.masterNormalize || "off", allowSingleSegment: job.longVideoEnabled === true, tools: deps.tools, run: deps.run, logger: (event) => logEvent(id, event, deps) });
    const finalAsset = outputAssetRef(assembly.outputPath);
    if (/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(String(id || ""))) await writeAssemblyJson(id, { revision: assembly.revision, checkpoint: "assembly_verified", finalAsset, concatFile: "assembly/concat.txt", probe: assembly.probe, completedAt: new Date().toISOString() });
    await setJob(job, { status: "completed", executionPhase: "completed", progress: 100, stage: "assembly.completed", activeSegmentIndex: null, segmentProgress: 100, segmentStage: "長影片已完成", finalAsset, assembly: { finalAsset, revision: assembly.revision, probe: assembly.probe }, controlIntent: "run" }, deps);
    await writeManifest(folder, job);
    await logEvent(id, { event: "runner.success", from: "assembling", to: "completed", stage: "assembly.completed", outputRelative: finalAsset.name }, deps);
    if (leaseHeartbeat) clearInterval(leaseHeartbeat);
    if (releaseLeaseOnExit && deps.lease) await releaseSequenceLease(id, deps.lease).catch(() => {});
    return { ...job, finalAsset, finalPath: assembly.outputPath, status: "completed" };
  } catch (error) {
    if (leaseHeartbeat) clearInterval(leaseHeartbeat);
    const leaseLost = error?.code === "SEQUENCE_LEASE_LOST" || error?.code === "SEQUENCE_LEASE_HELD";
    if (releaseLeaseOnExit && deps.lease) await releaseSequenceLease(id, deps.lease).catch(() => {});
    if (leaseLost) throw error;
    const durableJob = id && /^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(String(id))
      ? await getJob(id).catch(() => null)
      : null;
    const cancelled = error?.code === "SEQUENCE_CANCELLED"
      || Boolean(deps.shouldCancel?.(job))
      || job.controlIntent === "cancel_requested"
      || durableJob?.status === "cancelled"
      || durableJob?.controlIntent === "cancel_requested";
    if (activeSegmentIndex >= 0 && job.segments?.[activeSegmentIndex]) {
      const failedAttempt = Number(job.segments[activeSegmentIndex].attempt || 0);
      await setSegment(job, activeSegmentIndex, {
        status: cancelled ? "stale" : "failed",
        recoverable: !cancelled,
        error: { code: error?.code || "RUNNER_FAILED", message: error?.message || String(error), details: error?.details },
      }, deps);
      if (failedAttempt > 0 && /^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(String(id || ""))) await writeAttempt(id, activeSegmentIndex, failedAttempt, { ...(activeAttemptRecord || {}), attempt: failedAttempt, segmentIndex: activeSegmentIndex, status: "failed", prompt: persistedAttemptPrompt(activeAttemptRecord?.prompt, [activeAttemptRecord?.previousTail, activeAttemptRecord?.rawPath]), errorCode: error?.code || "RUNNER_FAILED", errorMessage: error?.message || String(error), stderrTail: error?.details?.stderrTail, exitCode: error?.details?.exitCode, finishedAt: new Date().toISOString() }).catch(() => {});
    }
    await setJob(job, { status: cancelled ? "cancelled" : "failed", stage: cancelled ? "sequence.cancelled" : "sequence.failed", error: { code: error?.code || "RUNNER_FAILED", message: error?.message || String(error), stack: error?.stack } }, deps);
    await writeManifest(folder, job).catch(() => {});
    await logEvent(id, { level: cancelled ? "info" : "error", event: cancelled ? "runner.cancelled" : "runner.failure", from: "running", to: cancelled ? "cancelled" : "failed", segmentIndex: activeSegmentIndex >= 0 ? activeSegmentIndex : undefined, errorCode: error?.code || "RUNNER_FAILED", errorMessage: error?.message || String(error), errorDetails: error?.details, stderrTail: error?.details?.stderrTail, exitCode: error?.details?.exitCode, stack: error?.stack }, deps);
    throw error;
  }
}

export function startSequence(sequence, deps = {}) {
  return new Promise((resolve, reject) => {
    setImmediate(() => runSequence(sequence, deps).then(resolve, reject));
  });
}

export const runSequenceJob = runSequence;
