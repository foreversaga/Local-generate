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
  ["recovery_needs_operator", "error"],
  ["cancelled", "cancelled"],
  ["canceled", "cancelled"],
  ["running", "running"],
  ["cancelling", "running"],
  ["canceling", "running"],
  ["paused", "running"],
  ["assembling", "running"],
  ["planning", "running"],
  ["recovering", "running"],
  ["rendering", "running"],
  ["normalizing", "running"],
  ["extracting_tail", "running"],
  ["captioning", "running"],
  ["training", "running"],
  ["prompting", "running"],
  ["generating", "running"],
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
  const events = Array.isArray(raw?.events) ? raw.events : [];
  const segments = source === "long" ? adaptLongSegments(raw?.segments, events) : Array.isArray(raw?.segments) ? raw.segments : [];
  const completedAt = jobCompletionAt(raw, source, status, events);
  const elapsedMs = jobElapsedMilliseconds(raw, source, status, events, completedAt);
  const createdAt = raw?.createdAt || raw?.queuedAt || raw?.startedAt || raw?.updatedAt || raw?.finishedAt || raw?.completedAt || "";
  const terminal = ["complete", "partial", "error", "cancelled"].includes(status);
  const updatedAt = terminal
    ? firstNonEmptyText(raw?.completedAt, raw?.finishedAt, raw?.timestamps?.completedAt, completedAt, raw?.updatedAt, createdAt)
    : firstNonEmptyText(raw?.updatedAt, raw?.startedAt, createdAt);
  const batchProgress = Number.isFinite(Number(raw?.batchCount)) && Number(raw.batchCount) > 0
    ? ((Number(raw?.completedCount) || 0) + (Number(raw?.failedCount) || 0)) / Number(raw.batchCount) * 100
    : null;
  const progress = source === "lora"
    ? loraTrainingProgress(raw, status)
    : source === "video-character"
      ? videoCharacterProgress(raw, status)
      : source === "text2img-batch"
        ? text2ImgBatchProgress(raw, status)
    : clampProgress(raw?.progress ?? raw?.segmentProgress ?? batchProgress ?? (status === "complete" ? 100 : 0));
  const artifact = artifactRef(raw, source);
  const output = outputRef(raw, source, artifact);
  return {
    id: String(raw?.id || ""),
    source,
    status,
    rawStatus: String(raw?.status || "queued"),
    title: jobTitle(raw, source),
    subtitle: jobSubtitle(raw, source),
    description: jobDescription(raw, source),
    prompt: typeof raw?.prompt === "string"
      ? raw.prompt
      : source === "video-character" && typeof raw?.settings?.prompt === "string"
        ? raw.settings.prompt
      : source === "long" && typeof raw?.inputText === "string"
        ? raw.inputText
        : "",
    negativePrompt: typeof raw?.negativePrompt === "string"
      ? raw.negativePrompt
      : source === "video-character" && typeof raw?.settings?.negativePrompt === "string"
        ? raw.settings.negativePrompt
        : "",
    modelProfile: source === "text2img" && typeof raw?.modelLabel === "string"
      ? raw.modelLabel
      : typeof raw?.modelProfile === "string" ? raw.modelProfile : typeof raw?.model === "string" ? raw.model : "",
    width: numericOrNull(raw?.width ?? (source === "video-character" ? raw?.settings?.width : null)),
    height: numericOrNull(raw?.height ?? (source === "video-character" ? raw?.settings?.height : null)),
    duration: numericOrNull(raw?.duration),
    steps: numericOrNull(raw?.steps ?? (source === "video-character" ? raw?.settings?.steps : null)),
    cfg: numericOrNull(raw?.cfg),
    seed: numericOrNull(raw?.seed ?? (source === "video-character" ? raw?.settings?.seed : null)),
    timeoutSeconds: numericOrNull(raw?.timeoutSeconds ?? (source === "video-character" ? raw?.settings?.timeoutSeconds : null)),
    outputName: typeof raw?.outputName === "string" ? raw.outputName : "",
    attempt: numericOrNull(raw?.attempt) || 1,
    inputRefs: raw?.inputRefs && typeof raw.inputRefs === "object" ? raw.inputRefs : {},
    stage: jobStage(raw, source),
    progress,
    progressSource: typeof raw?.progressSource === "string" ? raw.progressSource : "estimated",
    connectionState: typeof raw?.connectionState === "string" ? raw.connectionState : "",
    comfyNode: typeof raw?.comfyNode === "string" ? raw.comfyNode : "",
    comfyNodeId: typeof raw?.comfyNodeId === "string" ? raw.comfyNodeId : "",
    comfyNodeTitle: typeof raw?.comfyNodeTitle === "string" ? raw.comfyNodeTitle : "",
    nativeCurrent: numericOrNull(raw?.nativeCurrent),
    nativeMaximum: numericOrNull(raw?.nativeMaximum),
    chunkIndex: numericOrNull(raw?.chunkIndex),
    chunkCount: numericOrNull(raw?.chunkCount),
    activeSegmentIndex: numericOrNull(raw?.activeSegmentIndex),
    segmentProgress: numericOrNull(raw?.segmentProgress),
    segmentStage: typeof raw?.segmentStage === "string" ? raw.segmentStage : "",
    segments,
    comfyQueueRemaining: numericOrNull(raw?.comfyQueueRemaining),
    createdAt,
    updatedAt,
    completedAt,
    events,
    elapsedMs,
    estimatedDurationMs: nonNegativeNumberOrNull(raw?.estimatedDurationMs),
    etaMs: etaMilliseconds(raw, source),
    etaLowerMs: numericOrNull(raw?.etaLowerMs),
    etaUpperMs: numericOrNull(raw?.etaUpperMs),
    etaSource: typeof raw?.etaSource === "string" ? raw.etaSource : "",
    etaConfidence: typeof raw?.etaConfidence === "string" ? raw.etaConfidence : "",
    timingSampleCount: nonNegativeInteger(raw?.timingSampleCount),
    error: jobError(raw, source),
    output,
    outputAvailable: outputAvailability(output),
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

function videoCharacterProgress(raw, status) {
  if (status === "complete") return 100;
  const current = Number(raw?.nativeCurrent);
  const maximum = Number(raw?.nativeMaximum);
  if (!Number.isFinite(current) || !Number.isFinite(maximum) || maximum <= 0) {
    return clampProgress(raw?.progress);
  }
  const phaseProgress = Math.max(0, Math.min(1, current / maximum));
  const chunkIndex = Number(raw?.chunkIndex);
  const chunkCount = Number(raw?.chunkCount);
  if (String(raw?.phase || "") === "generation" && Number.isInteger(chunkIndex) && Number.isInteger(chunkCount) && chunkCount > 0) {
    return clampProgress((chunkIndex + phaseProgress) / chunkCount * 100);
  }
  return clampProgress(phaseProgress * 100);
}

function text2ImgBatchProgress(raw, status) {
  if (status === "complete") return 100;
  const total = Number(raw?.total);
  if (!Number.isFinite(total) || total <= 0) return 0;
  const prompted = Math.max(0, Number(raw?.prompted) || 0);
  const terminal = Math.max(0, Number(raw?.completed) || 0)
    + Math.max(0, Number(raw?.failed) || 0)
    + Math.max(0, Number(raw?.cancelled) || 0);
  return clampProgress((prompted + terminal) / (total * 2) * 100);
}

function nonNegativeInteger(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : 0;
}

function positiveInteger(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function numericOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function eventTimestamp(events, predicate) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (predicate(event) && typeof event?.timestamp === "string" && event.timestamp) return event.timestamp;
  }
  return "";
}

function adaptLongSegments(value, events) {
  if (!Array.isArray(value)) return [];
  return value.map((segment, index) => {
    const completedAt = firstNonEmptyText(
      segment?.completedAt,
      segment?.finishedAt,
      eventTimestamp(events, (event) => event?.event === "segment.completed" && Number(event?.segmentIndex) === index),
    );
    const startedAt = firstNonEmptyText(
      segment?.startedAt,
      eventTimestamp(events, (event) => event?.event === "generation.start" && Number(event?.segmentIndex) === index),
    );
    const explicitElapsed = nonNegativeNumberOrNull(segment?.elapsedMs);
    const elapsedMs = explicitElapsed ?? elapsedBetween(startedAt, completedAt);
    const childElapsedMs = nonNegativeNumberOrNull(segment?.childElapsedMs);
    const timing = {
      ...(startedAt ? { startedAt } : {}),
      ...(completedAt ? { completedAt } : {}),
      ...(elapsedMs !== null ? { elapsedMs } : {}),
      ...(childElapsedMs !== null ? { childElapsedMs } : {}),
    };
    return Object.keys(timing).length ? { ...segment, ...timing } : segment;
  });
}

function elapsedBetween(startedAt, completedAt) {
  const startedMs = Date.parse(String(startedAt || ""));
  const completedMs = Date.parse(String(completedAt || ""));
  return Number.isFinite(startedMs) && Number.isFinite(completedMs) && completedMs >= startedMs
    ? completedMs - startedMs
    : null;
}

function jobElapsedMilliseconds(raw, source, status, events, completedAt) {
  const explicit = nonNegativeNumberOrNull(raw?.elapsedMs);
  if (explicit !== null) return explicit;
  if (source !== "long" || status !== "complete") return null;
  const startedAt = firstNonEmptyText(
    raw?.startedAt,
    events.find((event) => event?.event === "runner.start" && typeof event?.timestamp === "string")?.timestamp,
  );
  return elapsedBetween(startedAt, completedAt);
}

function jobCompletionAt(raw, source, status, events) {
  const explicit = firstNonEmptyText(raw?.completedAt, raw?.finishedAt, raw?.timestamps?.completedAt);
  if (explicit) return explicit;
  if (source === "long") {
    const eventTime = eventTimestamp(events, (event) => event?.event === "runner.success" || event?.event === "assembly.completed");
    if (eventTime) return eventTime;
  }
  return status === "complete" || status === "partial" ? firstNonEmptyText(raw?.updatedAt) : "";
}

function firstNonEmptyText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function jobDescription(raw, source) {
  const request = raw?.provenance?.request && typeof raw.provenance.request === "object"
    ? raw.provenance.request
    : {};
  if (source === "long") {
    return firstNonEmptyText(raw?.description, raw?.inputText, request.description, request.inputText);
  }
  if (source === "img2img") {
    return firstNonEmptyText(raw?.promptDescription, request.promptDescription, raw?.description, request.description);
  }
  return firstNonEmptyText(
    raw?.initialDescription,
    request.initialDescription,
    raw?.promptDescription,
    request.promptDescription,
    raw?.description,
    request.description,
  );
}

function jobTitle(raw, source) {
  if (source === "video-character") return raw?.mode === "dwpose" ? "DWPose 動作生成" : "原場景換人物";
  if (source === "text2img-batch") return `文字生圖批次 · ${positiveInteger(raw?.total) || 0} 張`;
  if (source === "long") return raw?.title || "長影片";
  if (source === "upscale") {
    const sourceName = String(raw?.sourceName || "");
    const image = /\.(?:png|jpe?g|webp)$/i.test(sourceName);
    return `${image ? "圖片" : "影片"}升頻 · ${sourceName || (image ? "圖片" : "影片")}`;
  }
  if (source === "text2img") {
    const prompt = String(raw?.prompt || "").trim();
    return prompt ? `文字生圖 · ${prompt.slice(0, 58)}${prompt.length > 58 ? "…" : ""}` : "文字生圖";
  }
  if (source === "img2img") return `${raw?.poseName ? "OpenPose 骨架生圖" : "以圖生圖"} · ${raw?.sourceName || "圖片"}`;
  if (source === "lora") {
    const name = raw?.displayName || raw?.outputName || raw?.config?.outputName || raw?.slug;
    return name ? String(name) : "LoRA 訓練";
  }
  const mode = String(raw?.mode || "video").toUpperCase();
  const prompt = String(raw?.prompt || "").trim();
  return prompt ? `${mode} · ${prompt.slice(0, 58)}${prompt.length > 58 ? "…" : ""}` : `${mode} 影片生成`;
}

function jobSubtitle(raw, source) {
  if (source === "video-character") {
    const settings = raw?.settings && typeof raw.settings === "object" ? raw.settings : {};
    const resolution = settings.width && settings.height ? `${settings.width}×${settings.height}` : "";
    const fps = settings.fps ? `${settings.fps} FPS` : "";
    const references = Array.isArray(raw?.references) && raw.references.length ? `${raw.references.length} 張參考圖` : "";
    return [resolution, fps, references].filter(Boolean).join(" · ");
  }
  if (source === "text2img-batch") {
    const completed = nonNegativeInteger(raw?.completed);
    const failed = nonNegativeInteger(raw?.failed);
    const cancelled = nonNegativeInteger(raw?.cancelled);
    const total = positiveInteger(raw?.total) || 0;
    return [`${completed}/${total} 張完成`, failed ? `${failed} 張失敗` : "", cancelled ? `${cancelled} 張取消` : "", raw?.promptModel || ""].filter(Boolean).join(" · ");
  }
  if (source === "long") {
    const segments = Array.isArray(raw?.segments) ? raw.segments : [];
    const total = Number(raw?.segmentCount ?? segments.length) || 0;
    const completed = segments.filter((segment) => segment?.status === "completed").length;
    return `${completed}/${total} 段完成 · 目標 ${raw?.duration || raw?.targetDurationSeconds || 0} 秒`;
  }
  if (source === "upscale") return `${raw?.scale || 2}× 影片升頻`;
  if (source === "text2img") return [raw?.modelLabel || raw?.model, raw?.width && raw?.height ? `${raw.width}×${raw.height}` : "", raw?.steps ? `${raw.steps} steps` : ""].filter(Boolean).join(" · ");
  if (source === "img2img") {
    const count = positiveInteger(raw?.batchCount);
    const completed = nonNegativeInteger(raw?.completedCount);
    const failed = nonNegativeInteger(raw?.failedCount);
    const summary = count && count > 1 ? `${completed}/${count} 項完成${failed ? `，${failed} 項失敗` : ""}` : "";
    return [raw?.poseName ? "OpenPose ControlNet" : raw?.model || "圖片生成", summary].filter(Boolean).join(" · ");
  }
  if (source === "lora") {
    const family = raw?.family || raw?.training?.family || raw?.config?.family || "LoRA";
    const imageCount = Number(raw?.dataset?.imageCount ?? raw?.imageCount);
    return [`${String(family).toLocaleUpperCase()} LoRA`, Number.isFinite(imageCount) && imageCount > 0 ? `${imageCount} 張圖片` : ""].filter(Boolean).join(" · ");
  }
  return [raw?.modelProfile, raw?.width && raw?.height ? `${raw.width}×${raw.height}` : "", raw?.duration ? `${raw.duration} 秒` : ""].filter(Boolean).join(" · ");
}

function jobError(raw, source) {
  const message = typeof raw?.error === "string" ? raw.error : raw?.error?.message || "";
  if (source !== "long" || String(raw?.status || "") !== "failed") return message;
  const segments = Array.isArray(raw?.segments) ? raw.segments : [];
  const total = Number(raw?.segmentCount ?? segments.length) || segments.length;
  const completedSegments = segments.filter((segment) => segment?.status === "completed");
  if (!total || completedSegments.length >= total) return message;
  const completedSeconds = completedSegments.reduce((sum, segment) => sum + (Number(segment?.renderedDuration ?? segment?.duration) || 0), 0);
  const summary = `長影片在第 ${completedSegments.length + 1}/${total} 段失敗；目前僅完成 ${completedSegments.length}/${total} 段（約 ${completedSeconds.toFixed(1)} 秒），尚未合併成最終影片。`;
  return [summary, message].filter(Boolean).join(" ");
}

function outputRef(raw, source, artifact = null) {
  if (source === "long") return raw?.finalAsset || null;
  if (source === "lora") return artifact;
  return raw?.output || null;
}

/**
 * A persisted job may retain an output reference after the media file has
 * been removed. Callers can pass the current asset-key set to distinguish
 * that stale reference from a real file. Without a key set, only an
 * explicit backend URL is considered usable.
 * @param {Record<string, unknown>|null|undefined} output
 * @param {Set<string>|null} [availableKeys]
 * @returns {boolean|null}
 */
export function outputAvailability(output, availableKeys = null) {
  if (!output || typeof output !== "object") return null;
  if (typeof output.available === "boolean") return output.available;
  const root = typeof output.root === "string" ? output.root : "";
  const name = typeof output.name === "string" ? output.name.replaceAll("\\", "/") : "";
  const explicitUrl = typeof output.url === "string" && output.url.trim()
    || typeof output.downloadUrl === "string" && output.downloadUrl.trim();
  if (root && name) {
    if (availableKeys instanceof Set) return availableKeys.has(`${root}:${name}`);
    return Boolean(explicitUrl);
  }
  return Boolean(explicitUrl);
}

function canCancel(raw, source) {
  const status = String(raw?.status || "").toLowerCase();
  if (source === "video") return ["queued", "running", "cancelling"].includes(status);
  if (source === "video-character") return ["queued", "running", "cancelling"].includes(status);
  if (source === "text2img-batch") return ["queued", "prompting", "generating", "cancelling"].includes(status);
  if (source === "long") return ["queued", "running", "paused", "assembling", "recovering"].includes(status);
  if (source === "upscale") return ["queued", "running", "cancelling"].includes(status);
  if (source === "img2img") return ["queued", "running", "cancelling"].includes(status);
  if (source === "lora") return ["captioning", "queued", "training", "installing"].includes(status);
  return false;
}

function retryable(raw, source) {
  const status = normalizeJobStatus(raw?.status);
  if (source === "video") {
    return ["completed", "complete", "success", "succeeded", "failed", "interrupted", "canceled", "cancelled", "error"]
      .includes(String(raw?.status || "").toLowerCase());
  }
  if (!["error", "partial", "cancelled"].includes(status)) return false;
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

function nonNegativeNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
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
