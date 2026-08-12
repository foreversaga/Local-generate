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
  img2img: "以圖生圖",
  lora: "LoRA 訓練",
  training: "訓練資料",
  input: "素材",
  output: "生成結果",
});

const STATUS_LABELS = Object.freeze({
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

const DOMAIN_RUNNING_LABELS = Object.freeze({
  video: "生成中",
  long: "生成中",
  img2img: "生成中",
  upscale: "升頻中",
  lora: "訓練中",
});

/**
 * @param {string | undefined | null} status
 * @param {string | undefined | null} [source]
 */
export function jobStatusLabel(status, source) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "running" && source && DOMAIN_RUNNING_LABELS[source]) {
    return DOMAIN_RUNNING_LABELS[source];
  }
  return STATUS_LABELS[normalized] || String(status || "未知狀態");
}

/** @param {string | undefined | null} source */
export function sourceLabel(source) {
  const normalized = String(source || "").toLowerCase();
  return SOURCE_LABELS[normalized] || String(source || "未知來源");
}

/** @param {string | undefined | null} value */
export function readinessLabel(value) {
  const normalized = String(value || "").toLowerCase();
  return STATUS_LABELS[normalized] || String(value || "檢查中");
}
