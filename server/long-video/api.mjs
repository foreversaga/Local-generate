import { planSequence as defaultPlan } from "./planner.mjs";
import { allocateSequenceOutputPath, outputRoot, validateOutputFolderName } from "./paths.mjs";
import { appendEvent, createJob, getJob, listJobs, readEvents, saveJob, writeSequenceManifest } from "./store.mjs";
import { LongVideoError, validateSequenceInput, validateTimeline } from "./schema.mjs";
import { validatePrompt } from "./prompt-validator.mjs";
import { recoverInterruptedJobs } from "./recovery.mjs";
import { runSequence } from "./runner.mjs";

const controls = new Map();
let recoveryReady;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  if (res.headersSent) return true;
  res.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
  return true;
}

async function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw new LongVideoError("JSON_INVALID", "Request body must be valid JSON.", 400); }
}

async function recoverOnce() {
  if (!recoveryReady) recoveryReady = recoverInterruptedJobs().catch((error) => {
    console.error("[long-video] recovery failure", error);
    return [];
  });
  return recoveryReady;
}

function errorPayload(error) {
  if (error instanceof LongVideoError) return { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } };
  return { error: { code: "LONG_VIDEO_INTERNAL", message: error?.message || String(error) } };
}

function segmentFromPath(pathname) {
  const match = pathname.match(/^\/api\/sequences\/([^/]+)\/segments\/(\d+)(?:\/prompt|\/retry)?$/);
  if (!match) return null;
  return { id: decodeURIComponent(match[1]), index: Number(match[2]), suffix: pathname.endsWith("/prompt") ? "prompt" : pathname.endsWith("/retry") ? "retry" : "" };
}

const SEQUENCE_SERVER_FIELDS = new Set(["id", "schemaVersion", "revision", "createdAt", "updatedAt", "status", "recoverable", "outputAllocated", "outputPath", "finalAsset", "assembly", "progress", "stage", "activeSegmentIndex", "segmentProgress", "segmentStage", "generationJobId", "progressSource", "nativeCurrent", "nativeMaximum", "error"]);
const SEQUENCE_EDITABLE_FIELDS = new Set(["title", "inputType", "inputText", "inputAsset", "imagePurpose", "referenceMode", "referenceAssets", "continuityBible", "timeline", "segments", "duration", "outputFolder", "width", "height", "steps", "seed", "negativePrompt", "modelProfile", "promptProvider", "ollamaModel", "codexModel", "codexReasoningEffort", "seam", "planMeta", "planningSettings"]);
const SEGMENT_EDITABLE_FIELDS = new Set(["start", "end", "description", "prompt", "negativePrompt", "endingState"]);

function removeServerOwnedSequenceFields(patch) {
  for (const field of SEQUENCE_SERVER_FIELDS) delete patch[field];
  for (const field of Object.keys(patch)) {
    if (!SEQUENCE_EDITABLE_FIELDS.has(field)) delete patch[field];
  }
  return patch;
}

function assertSegmentPatchFields(patch) {
  const invalid = Object.keys(patch).filter((field) => !SEGMENT_EDITABLE_FIELDS.has(field));
  if (invalid.length) throw new LongVideoError("SEGMENT_PATCH_INVALID", `Unsupported segment fields: ${invalid.join(", ")}.`, 400, { fields: invalid });
}

function semanticSegmentChanged(previous, next) {
  return ["start", "end", "duration", "description", "prompt", "negativePrompt", "mode", "endingState"].some((field) => JSON.stringify(previous?.[field] ?? null) !== JSON.stringify(next?.[field] ?? null));
}

function invalidateFromSegment(segments, changedIndex, targetStatus = "pending") {
  return segments.map((segment, index) => {
    if (index < changedIndex) return segment;
    if (index === changedIndex) return { ...segment, status: targetStatus, error: null, recoverable: false };
    if (segment.status === "pending" || segment.status === "stale") return { ...segment, error: null, recoverable: true };
    return { ...segment, status: "stale", error: null, recoverable: true };
  });
}

function normalizedPlanningSettings(source, segments, duration) {
  const rawHint = Number(source?.planningSettings?.segmentDurationHint ?? source?.planMeta?.segmentDurationHint ?? 5);
  const segmentDurationHint = Number(Math.min(60, Math.max(0.5, Number.isFinite(rawHint) ? rawHint : 5)).toFixed(3));
  return {
    timelineMode: ["ollama", "codex"].includes(source?.planMeta?.timelineSource) || source?.planningSettings?.timelineMode === "auto" ? "auto" : "manual",
    targetDuration: duration,
    segmentDurationHint,
    segmentCount: segments.length,
  };
}

function mergeCanonicalTimeline(current, canonicalTimeline, incomingSegments) {
  const merged = canonicalTimeline.map((canonical, index) => {
    const previous = current.segments?.[index] || {};
    const incoming = incomingSegments?.[index] || {};
    return {
      ...previous,
      ...canonical,
      id: previous.id || canonical.id,
      status: previous.status || "pending",
      attempt: previous.attempt || 0,
      prompt: Object.prototype.hasOwnProperty.call(incoming, "prompt") ? String(incoming.prompt || "") : (previous.prompt || canonical.prompt || ""),
      negativePrompt: Object.prototype.hasOwnProperty.call(incoming, "negativePrompt") ? String(incoming.negativePrompt || "") : (previous.negativePrompt || canonical.negativePrompt || ""),
      endingState: Object.prototype.hasOwnProperty.call(incoming, "endingState") ? incoming.endingState : previous.endingState,
    };
  });
  const firstChanged = merged.findIndex((segment, index) => semanticSegmentChanged(current.segments?.[index], segment) || !current.segments?.[index]);
  return firstChanged >= 0 ? invalidateFromSegment(merged, firstChanged) : merged;
}

export async function handleLongVideoRoute(req, res, context = {}) {
  const pathname = new URL(req.url || "/", "http://localhost").pathname.replace(/^\/app(?=\/)/, "") || "/";
  if (!pathname.startsWith("/api/sequences")) return false;
  await recoverOnce();
  try {
    if (req.method === "POST" && pathname === "/api/sequences/plan") {
      const input = await body(req);
      console.info("[long-video] plan.request", JSON.stringify({
        inputType: input.inputType || "text",
        timelineMode: input.timelineMode || (input.timelineText || input.storyboard ? "manual" : "auto"),
        duration: input.duration,
        segmentDurationHint: input.segmentDurationHint,
        model: input.promptProvider === "codex" || input.provider === "codex"
          ? input.codexModel || input.model || "gpt-5.6-luna"
          : input.ollamaModel || input.model || "gemma4:12b",
        reasoningEffort: input.promptProvider === "codex" || input.provider === "codex"
          ? input.reasoningEffort || input.codexReasoningEffort || "medium"
          : undefined,
        hasNegativeConstraints: Boolean(String(input.negativePrompt || "").trim()),
      }));
      const plan = await (context.plan || defaultPlan)(input, context.planOptions || {});
      console.info("[long-video] plan.success", JSON.stringify({
        model: plan.planMeta?.model,
        timelineSource: plan.planMeta?.timelineSource,
        promptSource: plan.planMeta?.promptSource,
        repairAttempts: plan.planMeta?.repairAttempts || 0,
        retryAttempts: plan.planMeta?.retryAttempts || 0,
        retryCodes: plan.planMeta?.retryCodes,
        timelineRepair: plan.planMeta?.timelineRepair,
        duration: plan.duration,
        segments: plan.segments?.length || 0,
      }));
      return json(res, 200, { plan, continuityBible: plan.continuityBible, segments: plan.segments, timeline: plan.timeline });
    }
    if (req.method === "POST" && pathname === "/api/sequences") {
      const input = await body(req);
      const normalized = validateSequenceInput(input, { requireTimeline: true });
      if (!normalized.outputFolder) throw new LongVideoError("OUTPUT_FOLDER_REQUIRED", "outputFolder is required.", 400);
      // Planning/saving a draft must not touch ComfyUI/output.  Folder
      // allocation is intentionally deferred to the start endpoint.
      const safeFolder = validateOutputFolderName(normalized.outputFolder);
      const job = await createJob({ ...normalized, outputFolder: safeFolder });
      return json(res, 201, { job });
    }
    if (req.method === "GET" && pathname === "/api/sequences") {
      const jobs = await listJobs();
      return json(res, 200, { jobs, sequences: jobs });
    }
    const single = pathname.match(/^\/api\/sequences\/([^/]+)$/);
    if (single && req.method === "GET") {
      const job = await getJob(decodeURIComponent(single[1]));
      return json(res, 200, { job, events: context.includeEvents ? await readEvents(job.id) : undefined });
    }
    if (single && req.method === "PATCH") {
      const id = decodeURIComponent(single[1]);
      const current = await getJob(id);
      const patch = await body(req);
      const expectedRevision = patch.revision ?? current.revision;
      delete patch.revision;
      removeServerOwnedSequenceFields(patch);
      if (Object.prototype.hasOwnProperty.call(patch, "outputFolder") && patch.outputFolder !== current.outputFolder) {
        if (current.outputAllocated || current.outputPath) {
          throw new LongVideoError("OUTPUT_FOLDER_LOCKED", "Output folder cannot be changed after allocation.", 409);
        }
        patch.outputFolder = validateOutputFolderName(patch.outputFolder);
        patch.outputAllocated = false;
        patch.outputPath = undefined;
      }
      if (patch.timeline || patch.segments) {
        const incomingSegments = patch.segments || patch.timeline;
        const timeline = validateTimeline(patch.timeline || patch.segments, patch.duration ?? current.duration);
        patch.timeline = timeline;
        patch.segments = mergeCanonicalTimeline(current, timeline, incomingSegments);
      } else if (patch.duration !== undefined) {
        validateTimeline(current.segments, patch.duration);
      }
      const candidate = {
        ...current,
        ...patch,
        timeline: patch.segments || patch.timeline || current.segments,
        segments: patch.segments || patch.timeline || current.segments,
      };
      // Sequence PATCH uses the same schema as create/plan.  Validate the
      // complete merged payload so image assets, dimensions, seam, duration,
      // and timeline invariants cannot be bypassed by partial updates.
      const normalized = validateSequenceInput(candidate, { requireTimeline: true });
      const criticalFields = ["inputType", "inputAsset", "imagePurpose", "referenceMode", "referenceAssets", "width", "height", "steps", "seed", "negativePrompt", "modelProfile", "continuityBible"];
      const generationCriticalChanged = criticalFields.some((field) => JSON.stringify(current[field] ?? null) !== JSON.stringify(normalized[field] ?? null));
      const editableMetadata = ["title", "inputType", "inputText", "inputAsset", "imagePurpose", "referenceMode", "referenceAssets", "duration", "outputFolder", "width", "height", "steps", "seed", "negativePrompt", "modelProfile", "promptProvider", "ollamaModel", "codexModel", "codexReasoningEffort", "seam", "planMeta", "continuityBible"];
      for (const field of editableMetadata) {
        if (Object.prototype.hasOwnProperty.call(normalized, field)) patch[field] = normalized[field];
      }
      let mergedSegments = patch.segments || patch.timeline || current.segments;
      if (normalized.referenceMode === "multi_reference") mergedSegments = mergedSegments.map((segment) => ({ ...segment, mode: "ref2v" }));
      if (generationCriticalChanged) mergedSegments = invalidateFromSegment(mergedSegments, 0);
      patch.segments = mergedSegments;
      patch.timeline = mergedSegments;
      patch.planningSettings = normalizedPlanningSettings({ ...current, ...patch }, mergedSegments, normalized.duration ?? mergedSegments[mergedSegments.length - 1].end);
      const next = await saveJob({ ...current, ...patch }, { expectedRevision });
      await appendEvent(id, { event: "sequence.updated", from: current.status, to: next.status, revision: next.revision });
      return json(res, 200, { job: next });
    }
    const segmentPath = segmentFromPath(pathname);
    if (segmentPath && req.method === "PATCH" && !segmentPath.suffix) {
      const current = await getJob(segmentPath.id);
      const patch = await body(req);
      const expectedRevision = patch.revision ?? current.revision;
      delete patch.revision;
      if (!current.segments?.[segmentPath.index]) throw new LongVideoError("SEGMENT_NOT_FOUND", `Segment not found: ${segmentPath.index}`, 404);
      assertSegmentPatchFields(patch);
      const currentSegment = current.segments[segmentPath.index];
      let segmentPatch = { ...patch };
      if (patch.start !== undefined || patch.end !== undefined || patch.description !== undefined) {
        const proposed = current.segments.map((segment, index) => index === segmentPath.index ? { ...segment, ...patch } : segment);
        const canonicalTimeline = validateTimeline(proposed, current.duration);
        const canonicalSegment = canonicalTimeline[segmentPath.index];
        // Timeline values are authoritative.  Keep only editable prompt and
        // operational fields from the request; in particular, never persist a
        // stale/raw duration supplied by the client.
        segmentPatch = {
          ...canonicalSegment,
          ...(Object.prototype.hasOwnProperty.call(patch, "prompt") ? { prompt: patch.prompt } : {}),
          ...(Object.prototype.hasOwnProperty.call(patch, "negativePrompt") ? { negativePrompt: patch.negativePrompt } : {}),
          ...(Object.prototype.hasOwnProperty.call(patch, "endingState") ? { endingState: patch.endingState } : {}),
        };
      }
      if (Object.prototype.hasOwnProperty.call(patch, "prompt")) validatePrompt(segmentPatch.prompt, { mode: currentSegment.mode || (current.inputType === "image" || segmentPath.index > 0 ? "i2v" : "t2v") });
      const candidate = { ...currentSegment, ...segmentPatch };
      const changed = semanticSegmentChanged(currentSegment, candidate);
      const segments = changed
        ? invalidateFromSegment(current.segments.map((segment, index) => index === segmentPath.index ? candidate : segment), segmentPath.index)
        : current.segments.map((segment, index) => index === segmentPath.index ? candidate : segment);
      const next = await saveJob({ ...current, segments, timeline: segments }, { expectedRevision });
      await appendEvent(segmentPath.id, { event: "segment.updated", segmentIndex: segmentPath.index, segmentId: next.segments[segmentPath.index]?.id, revision: next.revision });
      return json(res, 200, { job: next });
    }
    if (segmentPath && req.method === "POST" && segmentPath.suffix === "prompt") {
      const current = await getJob(segmentPath.id);
      const patch = await body(req);
      const mode = current.segments?.[segmentPath.index]?.mode || (current.inputType === "image" || segmentPath.index > 0 ? "i2v" : "t2v");
      validatePrompt(patch.prompt, { mode });
      if (!current.segments?.[segmentPath.index]) throw new LongVideoError("SEGMENT_NOT_FOUND", `Segment not found: ${segmentPath.index}`, 404);
      const segments = current.segments.map((segment, index) => {
        if (index === segmentPath.index) return { ...segment, prompt: patch.prompt, status: "ready", error: null, recoverable: false };
        if (index > segmentPath.index && segment.status !== "pending" && segment.status !== "stale") return { ...segment, status: "stale", error: null, recoverable: true };
        return segment;
      });
      const next = await saveJob({ ...current, segments, timeline: segments }, { expectedRevision: patch.revision ?? current.revision });
      return json(res, 200, { job: next });
    }
    if (segmentPath && req.method === "POST" && segmentPath.suffix === "retry") {
      const current = await getJob(segmentPath.id);
      if (!current.segments?.[segmentPath.index]) throw new LongVideoError("SEGMENT_NOT_FOUND", `Segment not found: ${segmentPath.index}`, 404);
      const segments = current.segments.map((segment, index) => {
        if (index === segmentPath.index) return { ...segment, status: "pending", error: null, recoverable: false };
        if (index > segmentPath.index && segment.status !== "pending" && segment.status !== "stale") {
          return { ...segment, status: "stale", error: null, recoverable: true };
        }
        return segment;
      });
      const next = await saveJob({ ...current, segments, timeline: segments }, { expectedRevision: current.revision });
      await appendEvent(segmentPath.id, { event: "segment.retry", segmentIndex: segmentPath.index, segmentId: next.segments[segmentPath.index]?.id, staleAfter: segments.slice(segmentPath.index + 1).filter((segment) => segment.status === "stale").map((segment) => segment.id), revision: next.revision });
      return json(res, 200, { job: next });
    }
    const action = pathname.match(/^\/api\/sequences\/([^/]+)\/(start|pause|resume|cancel|assemble)$/);
    if (action && req.method === "POST") {
      const id = decodeURIComponent(action[1]);
      const operation = action[2];
      const current = await getJob(id);
      if (operation === "start") {
        if (["planning", "running", "queued", "paused", "assembling"].includes(current.status)) throw new LongVideoError("SEQUENCE_ALREADY_RUNNING", "Sequence is already running.", 409);
        const control = controls.get(id) || { cancel: false, pause: false };
        control.cancel = false;
        control.pause = false;
        controls.set(id, control);
        if (context.preflight) {
          try {
            const preflightResult = await context.preflight({ job: current });
            await appendEvent(id, { event: "preflight.media.success", stage: "preflight", tools: preflightResult });
          } catch (error) {
            const preflightError = error instanceof LongVideoError
              ? error
              : new LongVideoError("MEDIA_TOOLS_UNAVAILABLE", `Long-video media preflight failed: ${error?.message || String(error)}`, 503, { error: error?.message || String(error) });
            await appendEvent(id, { level: "error", event: "preflight.media.failure", stage: "preflight", errorCode: preflightError.code, errorMessage: preflightError.message, executables: preflightError.details }).catch(() => {});
            throw preflightError;
          }
        }
        let startJob = current;
        let allocatedPath = null;
        if (!current.outputAllocated && !current.outputPath) {
          const allocated = await allocateSequenceOutputPath(current.outputFolder, context.outputOptions);
          allocatedPath = allocated.path;
          startJob = { ...current, outputFolder: allocated.folderName, outputAllocated: true };
        } else {
          const existingPath = current.outputPath || `${context.outputOptions?.root || outputRoot()}/${current.outputFolder}`;
          const marker = await import("node:fs/promises").then(({ readFile }) => readFile(`${existingPath}/.h3-sequence.json`, "utf8")).then((text) => JSON.parse(text)).catch(() => null);
          if (!marker || marker.id !== id) throw new LongVideoError("OUTPUT_FOLDER_OWNERSHIP", "Output folder marker is missing or belongs to another sequence.", 409);
        }
        const queued = await saveJob({ ...startJob, status: "queued", recoverable: false, error: null }, { expectedRevision: current.revision });
        if (allocatedPath) await writeSequenceManifest(allocatedPath, queued);
        await appendEvent(id, { event: "api.start", from: current.status, to: "queued", stage: "queue" });
        const runJob = context.runJob || ((job, deps) => runSequence(job, deps));
        Promise.resolve().then(() => runJob(queued, {
          ...context.runnerDeps,
          shouldCancel: () => controls.get(id)?.cancel,
          shouldPause: () => controls.get(id)?.pause,
        })).catch((error) => console.error("[long-video] background start failure", id, error));
        return json(res, 202, { job: queued });
      }
      if (operation === "pause") {
        if (!["running", "queued"].includes(current.status)) throw new LongVideoError("INVALID_STATE", `Cannot pause from ${current.status}.`, 409);
        const control = controls.get(id) || { cancel: false, pause: false };
        control.pause = true; controls.set(id, control);
        const next = await saveJob({ ...current, status: "paused", stage: "sequence.paused" }, { expectedRevision: current.revision });
        await appendEvent(id, { event: "api.pause", from: current.status, to: next.status });
        return json(res, 200, { job: next });
      }
      if (operation === "resume") {
        if (current.status !== "paused") throw new LongVideoError("INVALID_STATE", `Cannot resume from ${current.status}.`, 409);
        const control = controls.get(id) || { cancel: false, pause: false };
        control.pause = false; controls.set(id, control);
        const next = await saveJob({ ...current, status: "running", stage: "sequence.resumed" }, { expectedRevision: current.revision });
        await appendEvent(id, { event: "api.resume", from: current.status, to: next.status });
        return json(res, 200, { job: next });
      }
      if (operation === "cancel") {
        if (["completed", "cancelled", "failed"].includes(current.status)) throw new LongVideoError("INVALID_STATE", `Cannot cancel from ${current.status}.`, 409);
        const control = controls.get(id) || { cancel: false, pause: false };
        control.cancel = true; control.pause = false; controls.set(id, control);
        const next = await saveJob({ ...current, status: "cancelled", stage: "sequence.cancelled" }, { expectedRevision: current.revision });
        await appendEvent(id, { event: "api.cancel", from: current.status, to: next.status });
        return json(res, 200, { job: next });
      }
      if (operation === "assemble") throw new LongVideoError("ASSEMBLY_NOT_READY", "Assembly is performed by the runner after all segments complete.", 409);
    }
    return json(res, 404, { error: { code: "SEQUENCE_ROUTE_NOT_FOUND", message: "Long-video endpoint not found." } });
  } catch (error) {
    const status = error instanceof LongVideoError ? error.status : 500;
    console.error("[long-video] api.error", JSON.stringify({ method: req.method, pathname, status, code: error?.code || "LONG_VIDEO_INTERNAL", message: error?.message || String(error) }));
    return json(res, status, errorPayload(error));
  }
}

export { controls };
