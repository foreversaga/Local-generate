const MAX_LONG_REFERENCE_IMAGES = 8;
const ACTIVE_STATUSES = new Set(["queued", "running", "paused", "assembling", "planning"]);

export function selectHydratableLongJob(jobs) {
  if (!Array.isArray(jobs)) return null;
  return jobs.find((job) => job && job.status !== "completed") || null;
}

export function parseLongTimelineDraft(value, fallback = []) {
  const text = String(value || "");
  const parsed = [];
  let cursor = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const range = line.match(/^\[?\s*(\d+(?:\.\d+)?)\s*(?:-|–|—|~|to)\s*(\d+(?:\.\d+)?)\s*\]?\s*(.*)$/i);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      parsed.push({ start, end, duration: end - start, description: range[3].trim() });
      cursor = end;
      continue;
    }
    const durationLine = line.match(/^(\d+(?:\.\d+)?)\s*(?:sec(?:ond)?s?|秒|s)\s*(?:-|:|：)?\s*(.*)$/i);
    if (durationLine) {
      const duration = Number(durationLine[1]);
      if (!Number.isFinite(duration) || duration <= 0) continue;
      parsed.push({ start: cursor, end: cursor + duration, duration, description: durationLine[2].trim() });
      cursor += duration;
    }
  }
  return parsed.length >= 2 ? parsed : fallback;
}

export function buildLongPlanRequest(input) {
  const refs = (input.referenceAssets || []).slice(0, MAX_LONG_REFERENCE_IMAGES);
  return {
    title: input.title || "Untitled long video",
    inputType: input.inputType,
    inputText: input.inputText,
    inputAsset: input.inputType === "image" ? refs[0] : undefined,
    imagePurpose: input.inputType === "image" ? "first_frame" : undefined,
    referenceMode: input.inputType === "image" ? input.referenceMode : "continuity",
    referenceAssets: input.inputType === "image" && input.referenceMode === "multi_reference" ? refs.slice(1) : [],
    timelineMode: input.timelineMode,
    duration: input.timelineMode === "auto" ? input.duration : undefined,
    segmentDurationHint: input.segmentDurationHint,
    timelineText: input.timelineMode === "manual" ? input.timelineText : undefined,
    promptProvider: input.promptProvider,
    ollamaModel: input.ollamaModel,
    codexModel: input.codexModel,
    reasoningEffort: input.reasoningEffort,
    negativePrompt: input.negativePrompt,
    ...(input.plannerImages?.length ? { plannerImages: input.plannerImages } : {}),
  };
}

export function buildLongSaveRequest(input) {
  const refs = (input.referenceAssets || []).slice(0, MAX_LONG_REFERENCE_IMAGES);
  const parsed = parseLongTimelineDraft(input.timelineText, input.plan.segments || []);
  const segments = parsed.map((segment, index) => ({
    ...(input.plan.segments?.[index] || {}),
    ...segment,
    start: segment.start,
    end: segment.end,
    duration: segment.end - segment.start,
    description: segment.description || input.plan.segments?.[index]?.description || `Segment ${index + 1}`,
  }));
  const duration = segments.length ? segments[segments.length - 1].end : input.plan.duration;
  return {
    title: input.title || input.plan.title || "Untitled long video",
    inputType: input.inputType,
    inputText: input.inputText,
    inputAsset: input.inputType === "image" ? refs[0] : undefined,
    imagePurpose: input.inputType === "image" ? "first_frame" : undefined,
    referenceMode: input.inputType === "image" ? input.referenceMode : "continuity",
    referenceAssets: input.inputType === "image" && input.referenceMode === "multi_reference" ? refs.slice(1) : [],
    continuityBible: input.plan.continuityBible,
    planMeta: input.plan.planMeta,
    planningSettings: input.plan.planningSettings,
    segments,
    duration,
    outputFolder: String(input.outputFolder || "").trim(),
    modelProfile: input.modelProfile,
    width: input.width,
    height: input.height,
    steps: input.steps,
    seed: input.seed,
    ollamaModel: input.ollamaModel,
    promptProvider: input.promptProvider,
    codexModel: input.codexModel,
    codexReasoningEffort: input.reasoningEffort,
    negativePrompt: input.negativePrompt,
    seam: input.seam,
    ...(input.revision !== undefined ? { revision: input.revision } : {}),
  };
}

export function validateLongCreate(input) {
  const issues = [];
  if (!String(input.inputText || "").trim()) issues.push({ field: "inputText", message: "請先輸入長影片的整體提示詞／故事描述。" });
  if (input.inputType === "image" && !(input.referenceAssets || []).length) issues.push({ field: "referenceAssets", message: "從圖片開始時需要至少一張起始參考圖片。" });
  if (input.timelineMode === "manual") {
    if (!String(input.timelineText || "").trim()) issues.push({ field: "timelineText", message: "手動時間軸模式需要至少兩段分鏡。" });
    else if (parseLongTimelineDraft(input.timelineText, []).length < 2) issues.push({ field: "timelineText", message: "手動時間軸至少需要兩段有效時間範圍。" });
  } else {
    issues.push(...numberIssue(input.duration, "duration", "目標總長", 1, 3600, false));
  }
  issues.push(...numberIssue(input.segmentDurationHint, "segmentDurationHint", "目標單段長度", 0.5, 60, false));
  issues.push(...dimensionIssue(input.width, "width", "長影片寬度"));
  issues.push(...dimensionIssue(input.height, "height", "長影片高度"));
  issues.push(...numberIssue(input.steps, "steps", "Steps", 1, 80, true));
  issues.push(...numberIssue(input.seed, "seed", "Seed", 0, 2147483647, true));
  if (input.requireSavedPlan) {
    if (!input.plan) issues.push({ field: "plan", message: "請先產生分鏡與 H3 提示詞。" });
    else if (input.planDirty) issues.push({ field: "plan", message: "規劃輸入已變更，請重新產生分鏡。" });
    if (!String(input.outputFolder || "").trim()) issues.push({ field: "outputFolder", message: "請輸入輸出資料夾。" });
  }
  return issues;
}

export function longJobIsActive(status) {
  return ACTIVE_STATUSES.has(String(status || ""));
}

function dimensionIssue(value, field, label) {
  const issues = numberIssue(value, field, label, 32, 2048, true);
  if (issues.length) return issues;
  return value % 32 === 0 ? [] : [{ field, message: `${label} 必須是 32 的倍數。` }];
}

function numberIssue(value, field, label, min, max, integer) {
  if (value === "") return [{ field, message: `${label} 必須填寫。` }];
  if (!Number.isFinite(value)) return [{ field, message: `${label} 必須是有效數字。` }];
  if (integer && !Number.isInteger(value)) return [{ field, message: `${label} 必須是整數。` }];
  if (value < min || value > max) return [{ field, message: `${label} 必須介於 ${min}–${max}。` }];
  return [];
}
