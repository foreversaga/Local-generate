const STATUS_MAP = new Map([
  ["completed", "complete"],
  ["complete", "complete"],
  ["success", "complete"],
  ["partial", "partial"],
  ["failed", "error"],
  ["error", "error"],
  ["interrupted", "error"],
  ["cancelled", "cancelled"],
  ["canceled", "cancelled"],
  ["running", "running"],
  ["cancelling", "running"],
  ["canceling", "running"],
  ["paused", "running"],
  ["assembling", "running"],
  ["planning", "running"],
  ["rendering", "running"],
  ["normalizing", "running"],
  ["extracting_tail", "running"],
  ["queued", "queued"],
  ["pending", "queued"],
  ["draft", "queued"],
  ["ready", "queued"],
  ["stale", "queued"],
]);

export function normalizeJobStatus(value) {
  return STATUS_MAP.get(String(value || "").toLowerCase()) || "queued";
}

export function adaptJob(raw, source = "video") {
  const status = normalizeJobStatus(raw?.status);
  const createdAt = raw?.createdAt || raw?.startedAt || raw?.updatedAt || raw?.finishedAt || raw?.completedAt || "";
  const batchProgress = Number.isFinite(Number(raw?.batchCount)) && Number(raw.batchCount) > 0
    ? ((Number(raw?.completedCount) || 0) + (Number(raw?.failedCount) || 0)) / Number(raw.batchCount) * 100
    : null;
  const progress = clampProgress(raw?.progress ?? raw?.segmentProgress ?? batchProgress ?? (status === "complete" ? 100 : 0));
  return {
    id: String(raw?.id || ""),
    source,
    status,
    rawStatus: String(raw?.status || "queued"),
    title: jobTitle(raw, source),
    subtitle: jobSubtitle(raw, source),
    stage: String(raw?.stage || raw?.segmentStage || raw?.status || "queued"),
    progress,
    createdAt,
    updatedAt: raw?.updatedAt || raw?.finishedAt || raw?.completedAt || createdAt,
    etaMs: Number.isFinite(raw?.etaMs) ? raw.etaMs : null,
    error: typeof raw?.error === "string" ? raw.error : raw?.error?.message || "",
    output: outputRef(raw, source),
    batchCount: positiveInteger(raw?.batchCount),
    randomRanges: raw?.randomRanges || null,
    completedCount: nonNegativeInteger(raw?.completedCount),
    failedCount: nonNegativeInteger(raw?.failedCount),
    items: Array.isArray(raw?.items) ? raw.items : [],
    canCancel: canCancel(raw, source),
    canPause: source === "long" && ["running", "queued"].includes(String(raw?.status || "")),
    canResume: source === "long" && String(raw?.status || "") === "paused",
    canRetry: retryable(raw, source),
    raw,
  };
}

export function mergeJobCollections(collections) {
  const jobs = [];
  for (const collection of collections || []) {
    const source = collection?.source || "video";
    for (const raw of collection?.jobs || []) jobs.push(adaptJob(raw, source));
  }
  return jobs.sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
}

export function activeJobCount(jobs) {
  return (jobs || []).filter((job) => job.status === "queued" || job.status === "running").length;
}

function clampProgress(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function nonNegativeInteger(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : 0;
}

function positiveInteger(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function jobTitle(raw, source) {
  if (source === "long") return raw?.title || "Long Video";
  if (source === "upscale") return `Upscale · ${raw?.sourceName || "Video"}`;
  if (source === "img2img") return `Image to Image · ${raw?.sourceName || "Image"}`;
  const mode = String(raw?.mode || "video").toUpperCase();
  const prompt = String(raw?.prompt || "").trim();
  return prompt ? `${mode} · ${prompt.slice(0, 58)}${prompt.length > 58 ? "…" : ""}` : `${mode} generation`;
}

function jobSubtitle(raw, source) {
  if (source === "long") return `${raw?.segments?.length || 0} segments · ${raw?.duration || 0}s`;
  if (source === "upscale") return `${raw?.scale || 2}× video upscale`;
  if (source === "img2img") {
    const count = positiveInteger(raw?.batchCount);
    const completed = nonNegativeInteger(raw?.completedCount);
    const failed = nonNegativeInteger(raw?.failedCount);
    const summary = count && count > 1 ? `${completed}/${count} complete${failed ? `, ${failed} failed` : ""}` : "";
    return [raw?.model || "Image generation", summary].filter(Boolean).join(" 繚 ");
  }
  return [raw?.modelProfile, raw?.width && raw?.height ? `${raw.width}×${raw.height}` : "", raw?.duration ? `${raw.duration}s` : ""].filter(Boolean).join(" · ");
}

function outputRef(raw, source) {
  if (source === "long") return raw?.finalAsset || null;
  return raw?.output || null;
}

function canCancel(raw, source) {
  const status = String(raw?.status || "");
  if (source === "video") return ["queued", "running", "cancelling"].includes(status);
  if (source === "long") return ["queued", "running", "paused", "assembling"].includes(status);
  return false;
}

function retryable(raw, source) {
  const status = normalizeJobStatus(raw?.status);
  if (!["error", "cancelled"].includes(status)) return false;
  if (source === "long" || source === "upscale" || source === "img2img") return true;
  return false;
}
