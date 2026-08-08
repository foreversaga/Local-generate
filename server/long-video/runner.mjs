import path from "node:path";
import { promises as fs } from "node:fs";
import { assembleSegments as defaultAssemble } from "./assembler.mjs";
import { extractTailFrame as defaultExtractTail, normalizeVideo as defaultNormalize } from "./media.mjs";
import { outputRoot, sequenceAssemblyDir, sequenceOutputFile } from "./paths.mjs";
import { appendEvent, getJob, updateJob, updateSegment, writeAttempt, writeAssemblyJson, writeSequenceManifest } from "./store.mjs";
import { LongVideoError } from "./schema.mjs";
import { buildSegmentPrompt } from "./prompt-builder.mjs";
import { validatePrompt } from "./prompt-validator.mjs";

async function logEvent(id, event, deps) {
  if (deps.log) return deps.log(event);
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(id)) return null;
  return appendEvent(id, event).catch(() => null);
}

function fileFor(folder, name) {
  return sequenceOutputFile(folder, name);
}

function outputAssetRef(filePath) {
  return { root: "output", name: path.relative(outputRoot(), filePath).replaceAll("\\", "/"), kind: path.extname(filePath).toLowerCase() === ".png" ? "image" : "video" };
}

function persistedAttemptPrompt(prompt, runtimePaths = []) {
  let safe = String(prompt || "");
  for (const runtimePath of runtimePaths) {
    if (runtimePath) safe = safe.replaceAll(String(runtimePath), "[runtime asset]");
  }
  // Finalize dependencies may include a path using a different separator.
  // Keep the useful prompt text but never persist an absolute filesystem path.
  return safe.replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>]+/g, "[runtime asset]");
}

async function setJob(job, patch, deps) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  if (deps.updateJob) return deps.updateJob(job, patch);
  if (/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(String(job.id || ""))) {
    return updateJob(job.id, patch);
  }
  return job;
}

async function setSegment(job, index, patch, deps) {
  Object.assign(job.segments[index], patch);
  if (deps.updateSegment) return deps.updateSegment(job, index, patch);
  if (/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(String(job.id || ""))) return updateSegment(job.id, index, patch);
  return job.segments[index];
}

function generationResultPath(result, fallback) {
  if (typeof result === "string") return result;
  return result?.rawPath || result?.outputPath || result?.path || fallback;
}

async function defaultVerifyCompletedSegment(segment) {
  const normalizedPath = segment.normalizedPath || (segment.normalizedAsset?.name ? path.join(outputRoot(), segment.normalizedAsset.name) : null);
  const tailPath = segment.tailPath || (segment.tailAsset?.name ? path.join(outputRoot(), segment.tailAsset.name) : null);
  if (!normalizedPath || !tailPath) return false;
  const [normalized, tail] = await Promise.all([fs.stat(normalizedPath).catch(() => null), fs.stat(tailPath).catch(() => null)]);
  return Boolean(normalized?.isFile() && tail?.isFile());
}

export async function runSequence(sequenceOrId, deps = {}) {
  const job = typeof sequenceOrId === "string" ? await getJob(sequenceOrId) : sequenceOrId;
  if (!job || !Array.isArray(job.segments) || job.segments.length < 2) throw new LongVideoError("SEQUENCE_INVALID", "A sequence with at least two segments is required.");
  const id = job.id;
  const folder = job.outputPath || (job.outputFolder ? path.join(outputRoot(), job.outputFolder) : null);
  if (!folder) throw new LongVideoError("OUTPUT_PATH_REQUIRED", "Sequence output folder is not allocated.");
  const generate = deps.generate || deps.generation || deps.generateSegment;
  if (typeof generate !== "function") throw new LongVideoError("GENERATION_DEPENDENCY_REQUIRED", "A generation dependency is required to run a sequence.", 500);
  const normalize = deps.normalize || deps.media?.normalize || defaultNormalize;
  const extractTail = deps.extractTail || deps.media?.extractTail || defaultExtractTail;
  const assemble = deps.assemble || deps.media?.assemble || defaultAssemble;
  const verifyCompletedSegment = deps.verifyCompletedSegment || defaultVerifyCompletedSegment;
  const writeManifest = deps.writeManifest || writeSequenceManifest;
  const normalizedPaths = [];
  let previousTail = null;
  let activeSegmentIndex = -1;
  let activeAttemptRecord = null;
  await setJob(job, { status: "running", progress: 1, stage: "sequence.start", error: null }, deps);
  await logEvent(id, { event: "runner.start", from: "ready", to: "running", stage: "sequence.start", segmentCount: job.segments.length }, deps);
  try {
    for (let index = 0; index < job.segments.length; index += 1) {
      activeSegmentIndex = index;
      if (deps.shouldCancel?.(job)) throw new LongVideoError("SEQUENCE_CANCELLED", "Sequence was cancelled.", 409);
      while (deps.shouldPause?.(job)) await new Promise((resolve) => setTimeout(resolve, 100));
      const segment = job.segments[index];
      activeAttemptRecord = null;
      if (segment.status === "completed") {
        const verified = await verifyCompletedSegment(segment, { sequence: job, segmentIndex: index });
        if (verified) {
          const normalizedPath = verified.normalizedPath || segment.normalizedPath || (segment.normalizedAsset?.name ? path.join(outputRoot(), segment.normalizedAsset.name) : null);
          const tailPath = verified.tailPath || segment.tailPath || (segment.tailAsset?.name ? path.join(outputRoot(), segment.tailAsset.name) : null);
          normalizedPaths.push(normalizedPath);
          previousTail = tailPath;
          await logEvent(id, { event: "runner.resume.skip_completed", segmentIndex: index, segmentId: segment.id, stage: "completed", outputRelative: segment.outputRelative || segment.normalizedAsset?.name }, deps);
          continue;
        }
        await logEvent(id, { level: "warn", event: "runner.resume.artifact_missing", segmentIndex: index, segmentId: segment.id, stage: "rerender" }, deps);
        await setSegment(job, index, { status: "pending", recoverable: true, error: { code: "COMPLETED_ARTIFACT_MISSING", message: "Completed segment artifact is missing; rerendering." } }, deps);
      }
      const attempt = Math.max(1, Number(segment.attempt || 0) + 1);
      const prefix = `segment-${String(index + 1).padStart(3, "0")}-attempt-${String(attempt).padStart(3, "0")}`;
      const rawPath = fileFor(folder, `${prefix}-raw.mp4`);
      const normalizedPath = fileFor(folder, `${prefix}.mp4`);
      const tailPath = fileFor(folder, `${prefix}-tail.png`);
      const mode = index === 0 && job.inputType === "text" ? "t2v" : "i2v";
      const continuation = index > 0 && previousTail
        ? "Continue directly from the supplied normalized tail frame as Picture 1; preserve the ending state and motion direction from the previous segment."
        : "";
      let prompt = segment.prompt;
      if (typeof deps.finalizePrompt === "function") {
        prompt = await deps.finalizePrompt({ segment, segmentIndex: index, mode, previousTail, continuityBible: job.continuityBible, endingState: segment.endingState });
      }
      try {
        validatePrompt(prompt, { mode });
      } catch {
        prompt = buildSegmentPrompt({ ...segment, continuityNote: continuation }, job.continuityBible, { mode, firstFrame: index === 0, pictureLabel: "Picture 1", shotId: "Shot 1" });
      }
      const startedAt = new Date().toISOString();
      activeAttemptRecord = {
        attempt,
        segmentIndex: index,
        status: "queued",
        mode,
        prompt: persistedAttemptPrompt(prompt),
        startedAt,
        duration: segment.duration,
        width: job.width,
        height: job.height,
        steps: job.steps,
        seed: Number(job.seed || 0) + index,
        modelProfile: job.modelProfile,
        negativePrompt: segment.negativePrompt || job.negativePrompt,
      };
      await setSegment(job, index, { status: "queued", attempt, prompt, error: null }, deps);
      if (/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(String(id || ""))) await writeAttempt(id, index, attempt, activeAttemptRecord).catch(() => {});
      await logEvent(id, { event: "generation.start", segmentIndex: index, segmentId: segment.id, attempt, mode, stage: "queued", outputRelative: path.relative(folder, rawPath) }, deps);
      await setSegment(job, index, { status: "rendering" }, deps);
      const generated = await generate({
        sequenceId: id,
        segment,
        segmentIndex: index,
        attempt,
        mode,
        prompt,
        negativePrompt: segment.negativePrompt || job.negativePrompt,
        width: job.width,
        height: job.height,
        steps: job.steps,
        seed: Number(job.seed || 0) + index,
        modelProfile: job.modelProfile,
        duration: segment.duration,
        inputAsset: index === 0 ? job.inputAsset : null,
        inputImagePath: index === 0 ? job.inputAsset?.path || job.inputAsset?.fullPath || job.inputAsset?.name || null : previousTail,
        tailImagePath: previousTail,
        outputPath: rawPath,
        outputRelative: path.relative(outputRoot(), rawPath).replaceAll("\\", "/"),
      });
      const producedRawPath = generationResultPath(generated, rawPath);
      const generationJobId = generated?.id || generated?.job?.id;
      activeAttemptRecord = {
        ...activeAttemptRecord,
        status: "generated",
        generationJobId,
        rawAsset: outputAssetRef(producedRawPath),
      };
      if (/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(String(id || ""))) await writeAttempt(id, index, attempt, activeAttemptRecord).catch(() => {});
      await logEvent(id, { event: "generation.success", segmentIndex: index, segmentId: segment.id, attempt, generationJobId, stage: "rendering", outputRelative: path.relative(outputRoot(), producedRawPath).replaceAll("\\", "/") }, deps);
      await setSegment(job, index, { status: "normalizing", rawAsset: outputAssetRef(producedRawPath) }, deps);
      await logEvent(id, { event: "media.normalize.start", segmentIndex: index, segmentId: segment.id, attempt, stage: "normalizing", duration: segment.duration }, deps);
      await normalize({ inputPath: producedRawPath, outputPath: normalizedPath, duration: segment.duration, fps: 24, width: job.width, height: job.height, seam: job.seam, tools: deps.tools, run: deps.run, logger: (event) => logEvent(id, { ...event, segmentIndex: index, segmentId: segment.id, attempt }, deps) });
      await setSegment(job, index, { status: "extracting_tail", normalizedAsset: outputAssetRef(normalizedPath) }, deps);
      await extractTail({ inputPath: normalizedPath, outputPath: tailPath, tools: deps.tools, run: deps.run, logger: (event) => logEvent(id, { ...event, segmentIndex: index, segmentId: segment.id, attempt }, deps) });
      previousTail = tailPath;
      normalizedPaths.push(normalizedPath);
      await setSegment(job, index, { status: "completed", normalizedAsset: outputAssetRef(normalizedPath), tailAsset: outputAssetRef(tailPath), outputRelative: path.relative(outputRoot(), normalizedPath).replaceAll("\\", "/") }, deps);
      if (/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(String(id || ""))) await writeAttempt(id, index, attempt, { ...activeAttemptRecord, attempt, segmentIndex: index, status: "completed", prompt: persistedAttemptPrompt(prompt, [previousTail, producedRawPath, normalizedPath, tailPath]), rawAsset: outputAssetRef(producedRawPath), normalizedAsset: outputAssetRef(normalizedPath), tailAsset: outputAssetRef(tailPath), generationJobId, finishedAt: new Date().toISOString() }).catch(() => {});
      activeAttemptRecord = null;
      await setJob(job, { progress: Math.round(((index + 1) / job.segments.length) * 85), stage: "segment.completed" }, deps);
      await logEvent(id, { event: "segment.completed", segmentIndex: index, segmentId: segment.id, attempt, stage: "completed", duration: segment.duration, outputRelative: path.relative(outputRoot(), normalizedPath).replaceAll("\\", "/") }, deps);
    }
    if (deps.shouldCancel?.(job)) throw new LongVideoError("SEQUENCE_CANCELLED", "Sequence was cancelled.", 409);
    activeSegmentIndex = -1;
    await setJob(job, { status: "assembling", progress: 90, stage: "assembly.start" }, deps);
    const assemblyRevision = Number(job.assembly?.revision || 0) + 1;
    const assemblyDirectory = deps.assemblyDir || (/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(String(id || "")) ? sequenceAssemblyDir(id) : path.join(folder, "assembly"));
    const assembly = await assemble({ segmentPaths: normalizedPaths, outputFolder: folder, assemblyDir: assemblyDirectory, revision: assemblyRevision, duration: job.segments.reduce((sum, segment) => sum + Number(segment.duration || (segment.end - segment.start)), 0), width: job.width, height: job.height, tools: deps.tools, run: deps.run, logger: (event) => logEvent(id, event, deps) });
    const finalAsset = outputAssetRef(assembly.outputPath);
    if (/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(String(id || ""))) await writeAssemblyJson(id, { revision: assembly.revision, finalAsset, concatFile: "assembly/concat.txt", probe: assembly.probe, completedAt: new Date().toISOString() });
    await setJob(job, { status: "completed", progress: 100, stage: "assembly.completed", finalAsset, assembly: { finalAsset, revision: assembly.revision, probe: assembly.probe } }, deps);
    await writeManifest(folder, job);
    await logEvent(id, { event: "runner.success", from: "assembling", to: "completed", stage: "assembly.completed", outputRelative: finalAsset.name }, deps);
    return { ...job, finalAsset, finalPath: assembly.outputPath, status: "completed" };
  } catch (error) {
    const cancelled = error?.code === "SEQUENCE_CANCELLED";
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
