const STATUS_MAP = new Map([
  ["completed", "complete"],
  ["complete", "complete"],
  ["success", "complete"],
  ["succeeded", "complete"],
  ["partial", "partial"],
  ["failed", "error"],
  ["preflight_failed", "error"],
  ["caption_failed", "error"],
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
  ["captioning", "running"],
  ["training", "running"],
  ["installing", "running"],
  ["queued", "queued"],
  ["pending", "queued"],
  ["draft", "queued"],
  ["ready", "queued"],
  ["captions_ready", "queued"],
  ["caption_review", "queued"],
  ["preflight", "queued"],
  ["preflight_ready", "queued"],
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
  const progress = source === "lora"
    ? loraTrainingProgress(raw, status)
    : clampProgress(raw?.progress ?? raw?.segmentProgress ?? batchProgress ?? (status === "complete" ? 100 : 0));
  const artifact = artifactRef(raw, source);
  return {
    id: String(raw?.id || ""),
    source,
    status,
    rawStatus: String(raw?.status || "queued"),
    title: jobTitle(raw, source),
    subtitle: jobSubtitle(raw, source),
    stage: jobStage(raw, source),
    progress,
    createdAt,
    updatedAt: raw?.updatedAt || raw?.finishedAt || raw?.completedAt || createdAt,
    etaMs: etaMilliseconds(raw, source),
    error: typeof raw?.error === "string" ? raw.error : raw?.error?.message || "",
    output: outputRef(raw, source, artifact),
    artifact,
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
  if (source === "long") return raw?.title || "長影片";
  if (source === "upscale") return `影片升頻 · ${raw?.sourceName || "影片"}`;
  if (source === "img2img") return `以圖生圖 · ${raw?.sourceName || "圖片"}`;
  if (source === "lora") {
    const name = raw?.displayName || raw?.outputName || raw?.config?.outputName || raw?.slug;
    return name ? String(name) : "LoRA 訓練";
  }
  const mode = String(raw?.mode || "video").toUpperCase();
  const prompt = String(raw?.prompt || "").trim();
  return prompt ? `${mode} · ${prompt.slice(0, 58)}${prompt.length > 58 ? "…" : ""}` : `${mode} 影片生成`;
}

function jobSubtitle(raw, source) {
  if (source === "long") return `${raw?.segments?.length || 0} 個片段 · ${raw?.duration || 0} 秒`;
  if (source === "upscale") return `${raw?.scale || 2}× 影片升頻`;
  if (source === "img2img") {
    const count = positiveInteger(raw?.batchCount);
    const completed = nonNegativeInteger(raw?.completedCount);
    const failed = nonNegativeInteger(raw?.failedCount);
    const summary = count && count > 1 ? `${completed}/${count} 項完成${failed ? `，${failed} 項失敗` : ""}` : "";
    return [raw?.model || "圖片生成", summary].filter(Boolean).join(" 繚 ");
  }
  if (source === "lora") {
    const family = raw?.family || raw?.training?.family || raw?.config?.family || "LoRA";
    const imageCount = Number(raw?.dataset?.imageCount ?? raw?.imageCount);
    return [`${String(family).toLocaleUpperCase()} LoRA`, Number.isFinite(imageCount) && imageCount > 0 ? `${imageCount} 張圖片` : ""].filter(Boolean).join(" · ");
  }
  return [raw?.modelProfile, raw?.width && raw?.height ? `${raw.width}×${raw.height}` : "", raw?.duration ? `${raw.duration} 秒` : ""].filter(Boolean).join(" · ");
}

function outputRef(raw, source, artifact = null) {
  if (source === "long") return raw?.finalAsset || null;
  if (source === "lora") return artifact;
  return raw?.output || null;
}

function canCancel(raw, source) {
  const status = String(raw?.status || "").toLowerCase();
  if (source === "video") return ["queued", "running", "cancelling"].includes(status);
  if (source === "long") return ["queued", "running", "paused", "assembling"].includes(status);
  if (source === "upscale") return ["queued", "running", "cancelling"].includes(status);
  if (source === "img2img") return ["queued", "running", "cancelling"].includes(status);
  if (source === "lora") return ["captioning", "queued", "training", "installing"].includes(status);
  return false;
}

function retryable(raw, source) {
  const status = normalizeJobStatus(raw?.status);
  if (!["error", "partial", "cancelled"].includes(status)) return false;
  if (source === "video") return ["failed", "interrupted", "canceled", "cancelled", "error"].includes(String(raw?.status || "").toLowerCase());
  if (source === "lora") return ["failed", "preflight_failed", "caption_failed", "canceled", "cancelled", "interrupted", "error"].includes(String(raw?.status || "").toLowerCase());
  if (source === "long" || source === "upscale" || source === "img2img") return true;
  return false;
}

const LORA_STAGE_LABELS = {
  draft: "草稿",
  ready: "準備完成",
  captioning: "產生說明文字（Caption）",
  captions_ready: "說明文字已完成",
  caption_review: "等待確認說明文字",
  caption_failed: "說明文字產生失敗",
  preflight: "訓練前檢查",
  preflight_ready: "訓練前檢查完成",
  preflight_failed: "訓練前檢查失敗",
  queued: "已排入佇列",
  training: "訓練中",
  installing: "安裝模型",
  cancelling: "正在取消",
  succeeded: "已完成",
  completed: "已完成",
  failed: "訓練失敗",
  canceled: "已取消",
  cancelled: "已取消",
  interrupted: "訓練中斷",
};

function jobStage(raw, source) {
  let value = raw?.stage || raw?.segmentStage;
  if (!value && source === "lora") {
    const rawStatus = String(raw?.status || "").toLowerCase();
    const trainingStage = String(raw?.training?.stage || "").toLowerCase();
    const installedStage = ["installed", "complete", "completed"].includes(trainingStage);
    value = installedStage && ["training", "running", "installing", "succeeded", "completed"].includes(rawStatus)
      ? trainingStage
      : rawStatus || trainingStage;
  }
  value = String(value || raw?.status || "queued");
  if (source !== "lora") return value;
  return LORA_STAGE_LABELS[value.toLowerCase()] || value;
}

export function loraTrainingProgress(raw, status = normalizeJobStatus(raw?.status)) {
  const rawStatus = String(raw?.status || raw?.stage || "").toLowerCase();
  if (status === "complete" || ["succeeded", "completed"].includes(rawStatus)) return 100;
  const training = raw?.training && typeof raw.training === "object" ? raw.training : {};
  const activeTraining = ["training", "installing", "running", "cancelling"].includes(rawStatus);
  if (["installed", "complete", "completed"].includes(String(training.stage || "").toLowerCase())) return activeTraining ? 99 : 100;
  const trainingStep = Number(training.step);
  const totalSteps = Number(training.totalSteps);
  if (activeTraining && Number.isFinite(trainingStep) && Number.isFinite(totalSteps) && totalSteps > 0) {
    return clampProgress(Math.min(99, trainingStep / totalSteps * 100));
  }
  if (rawStatus === "captioning") {
    const completed = Number(raw?.orchestration?.progress?.completed ?? raw?.progress?.completed ?? training.completed);
    const total = Number(raw?.orchestration?.progress?.total ?? raw?.progress?.total ?? training.total);
    if (Number.isFinite(completed) && Number.isFinite(total) && total > 0) return clampProgress(completed / total * 100);
  }
  return 0;
}

function etaMilliseconds(raw, source) {
  if (source !== "lora") return Number.isFinite(raw?.etaMs) ? raw.etaMs : null;
  const training = raw?.training && typeof raw.training === "object" ? raw.training : {};
  const seconds = Number(training.etaSeconds ?? raw?.etaSeconds);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  return parseEta(training.eta ?? raw?.eta);
}

function parseEta(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.round(value * 1000);
  if (typeof value !== "string") return null;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Math.round(Number(value) * 1000);
  const parts = value.trim().split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part) || part < 0) || parts.length < 2 || parts.length > 3) return null;
  const seconds = parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0] * 3600 + parts[1] * 60 + parts[2];
  return Math.round(seconds * 1000);
}

function artifactRef(raw, source) {
  if (source !== "lora" || !raw?.artifact || typeof raw.artifact !== "object") return null;
  const artifact = raw.artifact;
  const downloadUrl = typeof artifact.downloadUrl === "string" && artifact.downloadUrl.startsWith("/") ? artifact.downloadUrl : "";
  const fileName = [artifact.fileName, artifact.name].find((value) => typeof value === "string" && value.trim());
  return {
    registryId: typeof artifact.registryId === "string" ? artifact.registryId : typeof artifact.id === "string" ? artifact.id : "",
    displayName: typeof artifact.displayName === "string" ? artifact.displayName : "",
    fileName: typeof fileName === "string" ? fileName.split(/[\\/]/).pop() || "" : "",
    downloadUrl,
    sha256: typeof artifact.sha256 === "string" ? artifact.sha256 : typeof artifact.hash === "string" ? artifact.hash : "",
    sizeBytes: Number.isFinite(Number(artifact.sizeBytes ?? artifact.size)) ? Number(artifact.sizeBytes ?? artifact.size) : null,
  };
}
