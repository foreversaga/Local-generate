const DEFAULT_MAX_LIMIT = 100;

export function jobListLimit(url, { fallback = null, max = DEFAULT_MAX_LIMIT } = {}) {
  const value = new URL(String(url || "/"), "http://localhost").searchParams.get("limit");
  if (value === null || value === "") return fallback;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) return fallback;
  return Math.min(max, numeric);
}

export function wantsJobSummary(url) {
  const value = new URL(String(url || "/"), "http://localhost").searchParams.get("summary");
  return value === "1" || value === "true";
}

export function summarizeJobRecord(job) {
  if (!job || typeof job !== "object") return job;
  const summary = {};
  for (const key of [
    "id", "status", "mode", "title", "sourceName", "displayName", "slug", "family",
    "model", "modelProfile", "width", "height", "duration", "steps", "seed", "attempt",
    "longVideoEnabled", "targetDurationSeconds", "framesPerShot", "shotCount", "continuityMode", "effectiveContinuityMode", "continuityFallback", "continuityWarning", "promptMode", "identityAnchor", "voiceContinuity", "contextFrames", "chainGainControl", "masterNormalize",
    "stage", "progress", "segmentProgress", "progressSource", "connectionState",
    "comfyNode", "comfyNodeId", "comfyNodeTitle", "nativeCurrent", "nativeMaximum",
    "etaMs", "etaLowerMs", "etaUpperMs", "etaSource", "etaConfidence", "timingSampleCount",
    "comfyQueueRemaining", "batchCount", "completedCount", "failedCount", "timeoutSeconds",
    "createdAt", "startedAt", "updatedAt", "finishedAt", "completedAt", "error",
    "output", "finalAsset", "artifact", "outputName", "recoverable",
  ]) {
    if (Object.prototype.hasOwnProperty.call(job, key)) summary[key] = job[key];
  }
  if (typeof job.prompt === "string") summary.prompt = job.prompt.slice(0, 240);
  if (Array.isArray(job.segments)) summary.segmentCount = job.segments.length;
  if (job.config && typeof job.config === "object" && typeof job.config.outputName === "string") {
    summary.config = { outputName: job.config.outputName };
  }
  if (job.dataset && typeof job.dataset === "object" && Number.isFinite(Number(job.dataset.imageCount))) {
    summary.dataset = { imageCount: Number(job.dataset.imageCount) };
  }
  if (job.training && typeof job.training === "object") {
    summary.training = Object.fromEntries(["stage", "step", "totalSteps", "eta", "progress"]
      .filter((key) => Object.prototype.hasOwnProperty.call(job.training, key))
      .map((key) => [key, job.training[key]]));
  }
  if (job.orchestration?.progress && typeof job.orchestration.progress === "object") {
    summary.orchestration = { progress: job.orchestration.progress };
  }
  return summary;
}
