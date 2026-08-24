/**
 * Shared zh-TW labels for user-facing Studio UI.
 * Backend status/source values remain English internally; only their
 * presentation belongs in this module.
 */

export const NAV_LABELS = Object.freeze({
  create: "建立",
  jobs: "工作",
  library: "素材庫",
  tools: "工具",
  settings: "設定",
});

export const ACTION_LABELS = Object.freeze({
  openTool: "開啟工具",
  details: "查看詳情",
  viewAll: "查看全部",
  retry: "重試",
  cancel: "取消工作",
  pause: "暫停",
  resume: "繼續",
  openOutput: "查看結果",
  downloadResult: "下載結果",
  browseLibrary: "從素材庫選擇",
  clearSource: "移除來源",
  refresh: "重新檢查",
  close: "關閉",
  back: "返回",
  preview: "預覽",
  select: "選取",
  useSelected: "使用選取項目",
});

export const FIELD_LABELS = Object.freeze({
  prompt: "提示詞（Prompt）",
  negativePrompt: "負面提示詞",
  seed: "隨機種子（Seed）",
  steps: "採樣步數（Steps）",
  modelProfile: "模型設定檔",
  runtime: "執行環境",
  reasoning: "推理強度",
  resolution: "解析度",
  model: "模型設定檔",
  cfg: "引導強度（CFG）",
  denoise: "重繪強度",
  lora: "LoRA",
  loraStrength: "LoRA 強度",
  batchCount: "生成張數",
  width: "寬度",
  height: "高度",
  source: "來源素材",
  output: "生成結果",
  validation: "檢查結果",
  review: "生成摘要",
});

export const SOURCE_LABELS = Object.freeze({
  all: "全部",
  video: "單次影片",
  long: "長影片",
  upscale: "影片升頻",
  text2img: "文字生圖",
  img2img: "以圖生圖",
  lora: "LoRA 訓練",
  training: "訓練資料",
  input: "素材",
  output: "生成結果",
});

const EN_NAV_LABELS = Object.freeze({ create: "Create", jobs: "Jobs", library: "Library", tools: "Tools", settings: "Settings" });
const EN_ACTION_LABELS = Object.freeze({ openTool: "Open tool", details: "View details", viewAll: "View all", retry: "Retry", cancel: "Cancel job", pause: "Pause", resume: "Resume", openOutput: "Open output", downloadResult: "Download result", browseLibrary: "Browse Library", clearSource: "Clear source", refresh: "Refresh", close: "Close", back: "Back", preview: "Preview", select: "Select", useSelected: "Use selected" });
const EN_FIELD_LABELS = Object.freeze({ prompt: "Prompt", negativePrompt: "Negative prompt", seed: "Seed", steps: "Steps", modelProfile: "Model profile", runtime: "Runtime", reasoning: "Reasoning", resolution: "Resolution", model: "Model", cfg: "CFG", denoise: "Denoise", lora: "LoRA", loraStrength: "LoRA strength", batchCount: "Batch count", width: "Width", height: "Height", source: "Source asset", output: "Generated output", validation: "Validation", review: "Generation review" });
const EN_SOURCE_LABELS = Object.freeze({ all: "All", video: "Single video", long: "Long video", upscale: "Video upscale", text2img: "Text to Image", img2img: "Image to Image", lora: "LoRA training", training: "Training data", input: "Input", output: "Generated output" });

const STATUS_LABELS = Object.freeze({
  all: "全部",
  queued: "排隊中",
  running: "執行中",
  processing: "處理中",
  complete: "已完成",
  completed: "已完成",
  partial: "部分完成",
  failed: "失敗",
  error: "失敗",
  cancelled: "已取消",
  canceled: "已取消",
  paused: "已暫停",
  checking: "檢查中",
  ready: "已就緒",
  unavailable: "無法使用",
  needs_attention: "需要處理",
  cancelling: "取消中",
  interrupted: "已中斷",
  draft: "草稿",
  captioning: "產生圖片描述中",
  caption_review: "等待確認",
  caption_failed: "圖片描述失敗",
  preflight_failed: "檢查未通過",
  training: "訓練中",
  installing: "安裝中",
  warning: "需要處理",
  blocked: "需要處理",
});

const EN_STATUS_LABELS = Object.freeze({ all: "All", queued: "Queued", running: "Running", processing: "Processing", complete: "Complete", completed: "Complete", partial: "Partially complete", failed: "Failed", error: "Failed", cancelled: "Cancelled", canceled: "Cancelled", paused: "Paused", checking: "Checking", ready: "Ready", unavailable: "Unavailable", needs_attention: "Needs attention", cancelling: "Cancelling", interrupted: "Interrupted", draft: "Draft", captioning: "Captioning", caption_review: "Caption review", caption_failed: "Caption failed", preflight_failed: "Preflight failed", training: "Training", installing: "Installing", warning: "Needs attention", blocked: "Needs attention" });

const DOMAIN_RUNNING_LABELS = Object.freeze({
  video: "生成中",
  long: "生成中",
  text2img: "生成中",
  img2img: "生成中",
  upscale: "升頻中",
  lora: "訓練中",
});
const EN_DOMAIN_RUNNING_LABELS = Object.freeze({ video: "Generating", long: "Generating", text2img: "Generating", img2img: "Generating", upscale: "Upscaling", lora: "Training" });

function isEnglish(locale) { return locale === "en"; }

export function localizedCopy(locale) {
  return isEnglish(locale)
    ? { NAV_LABELS: EN_NAV_LABELS, ACTION_LABELS: EN_ACTION_LABELS, FIELD_LABELS: EN_FIELD_LABELS, SOURCE_LABELS: EN_SOURCE_LABELS }
    : { NAV_LABELS, ACTION_LABELS, FIELD_LABELS, SOURCE_LABELS };
}

/**
 * @param {string | undefined | null} status
 * @param {string | undefined | null} [source]
 * @param {string | undefined | null} [locale]
 */
export function jobStatusLabel(status, source, locale) {
  const normalized = String(status || "").toLowerCase();
  const domainLabels = isEnglish(locale) ? EN_DOMAIN_RUNNING_LABELS : DOMAIN_RUNNING_LABELS;
  const statusLabels = isEnglish(locale) ? EN_STATUS_LABELS : STATUS_LABELS;
  if (normalized === "running" && source && domainLabels[source]) {
    return domainLabels[source];
  }
  return statusLabels[normalized] || String(status || (isEnglish(locale) ? "Unknown status" : "未知狀態"));
}

/** @param {string | undefined | null} source @param {string | undefined | null} [locale] */
export function sourceLabel(source, locale) {
  const normalized = String(source || "").toLowerCase();
  const labels = isEnglish(locale) ? EN_SOURCE_LABELS : SOURCE_LABELS;
  return labels[normalized] || String(source || (isEnglish(locale) ? "Unknown source" : "未知來源"));
}

/** @param {string | undefined | null} value @param {string | undefined | null} [locale] */
export function readinessLabel(value, locale) {
  const normalized = String(value || "").toLowerCase();
  const labels = isEnglish(locale) ? EN_STATUS_LABELS : STATUS_LABELS;
  return labels[normalized] || String(value || (isEnglish(locale) ? "Checking" : "檢查中"));
}
