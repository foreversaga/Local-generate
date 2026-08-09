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

function combinedNegativePrompt(globalValue, segmentValue) {
  const globalPrompt = String(globalValue || "").trim();
  const segmentPrompt = String(segmentValue || "").trim();
  if (!globalPrompt) return segmentPrompt;
  if (!segmentPrompt || globalPrompt.toLocaleLowerCase().includes(segmentPrompt.toLocaleLowerCase())) return globalPrompt;
  return `${globalPrompt}, ${segmentPrompt}`;
}

function outputAssetRef(filePath) {
  return { root: "output", name: path.relative(outputRoot(), filePath).replaceAll("\\", "/"), kind: path.extname(filePath).toLowerCase() === ".png" ? "image" : "video" };
}

function referenceKey(reference) {
  if (!reference?.name) return "";
  return `${reference.root === "output" ? "output" : "input"}:${String(reference.name).replaceAll("\\", "/")}`.toLocaleLowerCase();
}

function staticReferenceAssets(job) {
  if (job?.referenceMode !== "multi_reference") return [];
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
  const detailedBoundary = /(\bdetailed_description\s*:[\s\S]*?)(\n\n(?=overall_soundscape\s*:))/i;
  if (detailedBoundary.test(text)) {
    return text.replace(detailedBoundary, `$1\n${instruction}$2`).trim();
  }
  return `${text}${text ? "\n\n" : ""}${instruction}`.trim();
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

export function sequenceProgressForSegment(segmentIndex, segmentCount, generationProgress) {
  const count = Math.max(1, Number(segmentCount) || 1);
  const index = Math.min(count - 1, Math.max(0, Number(segmentIndex) || 0));
  const percent = Math.min(100, Math.max(0, Number(generationProgress) || 0));
  return Math.min(85, Math.max(1, Math.round(((index + percent / 100) / count) * 85)));
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
      const attempt = Math.max(1, Number(segment.attempt || 0) + 1);
      const prefix = `segment-${String(index + 1).padStart(3, "0")}-attempt-${String(attempt).padStart(3, "0")}`;
      const rawPath = fileFor(folder, `${prefix}-raw.mp4`);
      const normalizedPath = fileFor(folder, `${prefix}.mp4`);
      const tailPath = fileFor(folder, `${prefix}-tail.png`);
      const multiReference = job.referenceMode === "multi_reference";
      const mode = multiReference ? "ref2v" : index === 0 && job.inputType === "text" ? "t2v" : "i2v";
      const references = multiReference ? segmentReferenceAssets(job, index > 0 ? previousTail : null) : [];
      const continuation = !multiReference && index > 0 && previousTail
        ? "Continue directly from the supplied normalized tail frame as Picture 1; preserve the ending state and motion direction from the previous segment."
        : "";
      let prompt = segment.prompt;
      if (typeof deps.finalizePrompt === "function") {
        prompt = await deps.finalizePrompt({ segment, segmentIndex: index, mode, previousTail, references, continuityBible: job.continuityBible, endingState: segment.endingState });
      }
      try {
        validatePrompt(prompt, { mode });
        if (multiReference && !/<Picture\s+1>/i.test(prompt)) throw new Error("Ref2VA prompt must declare ordered picture labels.");
      } catch {
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
        });
      }
      if (multiReference && index > 0 && previousTail) {
        prompt = appendMultiReferenceTail(prompt, references, previousTail);
      }
      const negativePrompt = combinedNegativePrompt(job.negativePrompt, segment.negativePrompt);
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
        negativePrompt,
      };
      await setSegment(job, index, { status: "queued", attempt, prompt, error: null }, deps);
      if (/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(String(id || ""))) await writeAttempt(id, index, attempt, activeAttemptRecord).catch(() => {});
      await logEvent(id, { event: "generation.start", segmentIndex: index, segmentId: segment.id, attempt, mode, stage: "queued", outputRelative: path.relative(folder, rawPath) }, deps);
      await setSegment(job, index, { status: "rendering" }, deps);
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
      const generated = await generate({
        sequenceId: id,
        segment,
        segmentIndex: index,
        attempt,
        mode,
        prompt,
        negativePrompt,
        width: job.width,
        height: job.height,
        steps: job.steps,
        seed: Number(job.seed || 0) + index,
        modelProfile: job.modelProfile,
        duration: segment.duration,
        inputAsset: index === 0 ? job.inputAsset : null,
        inputImagePath: multiReference ? null : index === 0 ? job.inputAsset?.path || job.inputAsset?.fullPath || job.inputAsset?.name || null : previousTail,
        ...(multiReference ? {
          referenceMode: "multi_reference",
          referenceImageNames: references.map((reference) => reference.name),
          referenceAssets: references,
        } : {}),
        tailImagePath: previousTail,
        outputPath: rawPath,
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
        generationJobId,
        rawAsset: outputAssetRef(producedRawPath),
      };
      if (/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(String(id || ""))) await writeAttempt(id, index, attempt, activeAttemptRecord).catch(() => {});
      await logEvent(id, { event: "generation.success", segmentIndex: index, segmentId: segment.id, attempt, generationJobId, stage: "rendering", outputRelative: path.relative(outputRoot(), producedRawPath).replaceAll("\\", "/") }, deps);
      await setSegment(job, index, { status: "normalizing", rawAsset: outputAssetRef(producedRawPath) }, deps);
      await setJob(job, {
        progress: sequenceProgressForSegment(index, job.segments.length, 100),
        stage: "segment.normalizing",
        activeSegmentIndex: index,
        segmentProgress: 100,
        segmentStage: "標準化影片格式與音訊…",
        generationJobId: generationJobId || job.generationJobId || null,
      }, deps);
      await logEvent(id, { event: "media.normalize.start", segmentIndex: index, segmentId: segment.id, attempt, stage: "normalizing", duration: segment.duration }, deps);
      await normalize({ inputPath: producedRawPath, outputPath: normalizedPath, duration: segment.duration, fps: 24, width: job.width, height: job.height, seam: job.seam, tools: deps.tools, run: deps.run, logger: (event) => logEvent(id, { ...event, segmentIndex: index, segmentId: segment.id, attempt }, deps) });
      await setSegment(job, index, { status: "extracting_tail", normalizedAsset: outputAssetRef(normalizedPath) }, deps);
      await setJob(job, {
        stage: "segment.extracting_tail",
        activeSegmentIndex: index,
        segmentProgress: 100,
        segmentStage: "擷取段尾銜接影格…",
      }, deps);
      await extractTail({ inputPath: normalizedPath, outputPath: tailPath, tools: deps.tools, run: deps.run, logger: (event) => logEvent(id, { ...event, segmentIndex: index, segmentId: segment.id, attempt }, deps) });
      previousTail = tailPath;
      normalizedPaths.push(normalizedPath);
      await setSegment(job, index, { status: "completed", normalizedAsset: outputAssetRef(normalizedPath), tailAsset: outputAssetRef(tailPath), outputRelative: path.relative(outputRoot(), normalizedPath).replaceAll("\\", "/") }, deps);
      if (/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(String(id || ""))) await writeAttempt(id, index, attempt, { ...activeAttemptRecord, attempt, segmentIndex: index, status: "completed", prompt: persistedAttemptPrompt(prompt, [previousTail, producedRawPath, normalizedPath, tailPath]), rawAsset: outputAssetRef(producedRawPath), normalizedAsset: outputAssetRef(normalizedPath), tailAsset: outputAssetRef(tailPath), generationJobId, finishedAt: new Date().toISOString() }).catch(() => {});
      activeAttemptRecord = null;
      await setJob(job, {
        progress: sequenceProgressForSegment(index, job.segments.length, 100),
        stage: "segment.completed",
        activeSegmentIndex: index,
        segmentProgress: 100,
        segmentStage: `第 ${index + 1} 段完成`,
      }, deps);
      await logEvent(id, { event: "segment.completed", segmentIndex: index, segmentId: segment.id, attempt, stage: "completed", duration: segment.duration, outputRelative: path.relative(outputRoot(), normalizedPath).replaceAll("\\", "/") }, deps);
    }
    if (deps.shouldCancel?.(job)) throw new LongVideoError("SEQUENCE_CANCELLED", "Sequence was cancelled.", 409);
    activeSegmentIndex = -1;
    await setJob(job, { status: "assembling", progress: 90, stage: "assembly.start", activeSegmentIndex: null, segmentProgress: 100, segmentStage: "合併所有片段…" }, deps);
    const assemblyRevision = Number(job.assembly?.revision || 0) + 1;
    const assemblyDirectory = deps.assemblyDir || (/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(String(id || "")) ? sequenceAssemblyDir(id) : path.join(folder, "assembly"));
    const assembly = await assemble({ segmentPaths: normalizedPaths, outputFolder: folder, assemblyDir: assemblyDirectory, revision: assemblyRevision, duration: job.segments.reduce((sum, segment) => sum + Number(segment.duration || (segment.end - segment.start)), 0), width: job.width, height: job.height, tools: deps.tools, run: deps.run, logger: (event) => logEvent(id, event, deps) });
    const finalAsset = outputAssetRef(assembly.outputPath);
    if (/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(String(id || ""))) await writeAssemblyJson(id, { revision: assembly.revision, finalAsset, concatFile: "assembly/concat.txt", probe: assembly.probe, completedAt: new Date().toISOString() });
    await setJob(job, { status: "completed", progress: 100, stage: "assembly.completed", activeSegmentIndex: null, segmentProgress: 100, segmentStage: "長影片已完成", finalAsset, assembly: { finalAsset, revision: assembly.revision, probe: assembly.probe } }, deps);
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
