"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";

const BRIDGE_URL = "/app";
const VIDEO_PAGE_SIZE = 10;

type Mode = "t2v" | "i2v" | "fl2v" | "l2v" | "ref2v" | "replace";
type AssetKind = "image" | "video";
type Asset = {
  name: string;
  root: "input" | "output";
  kind: AssetKind;
  mime: string;
  size: number;
  modified: string;
  url: string;
};

type LongReferenceMode = "continuity" | "multi_reference";

const MAX_REF2V_IMAGES = 9;
const MAX_LONG_REFERENCE_IMAGES = 8;
const H3_PROMPT_MAX_CHARS = 7000;
const H3_PROMPT_WARNING_THRESHOLD = 6500;
const H3_IMAGE_PROMPT_MODES = new Set<Mode>(["i2v", "fl2v", "l2v", "ref2v"]);

type UpscaleJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
type UpscaleJob = {
  id: string;
  status: UpscaleJobStatus;
  progress: number;
  stage: string;
  sourceName: string;
  sourceRoot?: "input" | "output";
  scale: number;
  output?: Asset;
  error?: string;
};

const UPSCALE_POLL_STATUSES = new Set<UpscaleJobStatus>(["queued", "running"]);
const UPSCALE_TERMINAL_STATUSES = new Set<UpscaleJobStatus>(["completed", "failed", "cancelled"]);

type Img2ImgJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
type Img2ImgJob = {
  id: string;
  status: Img2ImgJobStatus;
  progress: number;
  stage: string;
  sourceName: string;
  sourceRoot: "input" | "output";
  prompt: string;
  negativePrompt: string;
  model: string;
  denoise: number;
  steps: number;
  cfg: number;
  seed: number;
  output?: Asset;
  error?: string;
};

const IMG2IMG_POLL_STATUSES = new Set<Img2ImgJobStatus>(["queued", "running"]);
const IMG2IMG_TERMINAL_STATUSES = new Set<Img2ImgJobStatus>(["completed", "failed", "cancelled"]);
const IMG2IMG_MODELS = [
  {
    value: "sd_xl_turbo_1.0_fp16.safetensors",
    label: "SDXL Turbo 1.0 FP16",
    note: "快速預覽 · 建議 4 steps / CFG 1",
  },
  {
    value: "v1-5-pruned-emaonly-fp16.safetensors",
    label: "Stable Diffusion 1.5 FP16",
    note: "細節調整 · 建議 20 steps / CFG 7",
  },
] as const;

type Health = {
  bridge: boolean;
  h3Root: boolean;
  ollama: {
    online: boolean;
    url?: string;
    models: string[];
  };
  codex: {
    online: boolean;
    version?: string;
    skill: boolean;
    models?: Array<{
      value: string;
      label: string;
      note?: string;
      reasoningEfforts?: string[];
    }>;
  };
  comfy: {
    online: boolean;
    url: string;
    remote?: boolean;
    devices: Array<{ name?: string; vram_total?: number; vram_free?: number }>;
  };
  runtime?: {
    mode: "local" | "remote";
    switching: boolean;
    activeOperations: number;
    local: { comfyUrl: string; ollamaUrl: string };
    remote: { comfyUrl: string; ollamaUrl: string };
  };
  paths: {
    h3Root: string;
    comfyRoot: string;
    input: string;
    output: string;
  };
};

type Job = {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "cancelling";
  mode: Mode;
  progress: number;
  stage: string;
  prompt: string;
  seed?: number;
  batchId?: string;
  batchIndex?: number;
  batchTotal?: number;
  width?: number;
  height?: number;
  duration?: number;
  modelProfile: string;
  output?: Asset;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  elapsedMs?: number;
  estimatedDurationMs?: number | null;
  etaMs?: number | null;
  timingSampleCount?: number;
  progressSource?: "estimated" | "native";
  estimatedProgress?: number;
  nativeCurrent?: number;
  nativeMaximum?: number;
  comfyNode?: string;
  connectionState?: "starting" | "queued" | "connected" | "reconnecting" | "polling";
  updatedAt?: string;
  lastNativeProgressAt?: string;
};

type Toast = {
  message: string;
  tone: "info" | "success" | "error";
};

type ApiErrorPayload = {
  error?: string | { code?: string; message?: string };
  code?: string;
  candidatePrompt?: string;
  details?: {
    candidatePrompt?: string;
    repairAttempts?: number;
    finalValidation?: { code?: string; message?: string };
    secondValidation?: { code?: string; message?: string };
  };
};

function apiErrorMessage(payload: ApiErrorPayload, fallback: string) {
  const message = typeof payload.error === "string"
    ? payload.error
    : payload.error?.message || fallback;
  const code = payload.code || (typeof payload.error === "object" ? payload.error?.code : "");
  return code ? `${code}: ${message}` : message;
}

type LongErrorDialog = {
  title: string;
  code: string;
  message: string;
  hint: string;
};

type LongSegment = {
  id?: string;
  start: number;
  end: number;
  duration?: number;
  description: string;
  prompt?: string;
  negativePrompt?: string;
  mode?: "t2v" | "i2v" | "ref2v";
  promptSource?: "ollama" | "ollama_structured" | "codex" | "codex_structured" | "manual";
  endingState?: string;
  status?: string;
  progress?: number;
  stage?: string;
  error?: string | { code?: string; message?: string };
};

type LongPlan = {
  title?: string;
  inputType: "text" | "image";
  imagePurpose?: "first_frame";
  inputText?: string;
  inputAsset?: Asset;
  referenceMode?: LongReferenceMode;
  referenceAssets?: Asset[];
  duration?: number;
  promptProvider?: PromptProvider;
  ollamaModel?: string;
  codexModel?: string;
  codexReasoningEffort?: string;
  negativePrompt?: string;
  planningSettings?: {
    timelineMode?: "auto" | "manual";
    targetDuration?: number;
    segmentDurationHint?: number;
    segmentCount?: number;
  };
  planMeta?: {
    model?: string;
    generatedAt?: string;
    timelineSource?: "ollama" | "codex" | "author";
    promptSource?: "ollama" | "ollama_structured" | "codex" | "codex_structured";
    segmentDurationHint?: number;
    repairAttempts?: number;
    [key: string]: unknown;
  };
  continuityBible?: Record<string, unknown>;
  segments: LongSegment[];
  timeline?: LongSegment[];
};

type LongJob = LongPlan & {
  id: string;
  status: string;
  revision: number;
  outputFolder?: string;
  outputPath?: string;
  finalPath?: string;
  finalAsset?: { root: "output"; name: string; kind: "video" };
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
  modelProfile?: string;
  ollamaModel?: string;
  seam?: "keep_duplicate_frame" | "drop_next_first_frame";
  progress?: number;
  stage?: string;
  activeSegmentIndex?: number | null;
  segmentProgress?: number;
  segmentStage?: string;
  generationJobId?: string | null;
  progressSource?: "estimated" | "native";
  nativeCurrent?: number;
  nativeMaximum?: number;
  error?: { code?: string; message?: string } | string;
  updatedAt?: string;
};

const LONG_VIDEO_POLL_STATUSES = new Set(["queued", "running", "paused", "assembling", "planning"]);
const LONG_VIDEO_TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

type PromptModelOption = {
  value: string;
  label: string;
  note: string;
  vision?: boolean;
};

type PromptProvider = "ollama" | "codex";

type CodexModelOption = {
  value: string;
  label: string;
  note: string;
  reasoningEfforts?: readonly string[];
};

const navItems = [
  { label: "工作台", icon: "grid", target: "workspace" },
  { label: "生成紀錄", icon: "clock", target: "render-queue" },
  { label: "影片升頻", icon: "spark", target: "video-upscale" },
  { label: "圖片重繪", icon: "image", target: "image-to-image" },
  { label: "資源庫", icon: "folder", target: "asset-library" },
  { label: "系統設定", icon: "sliders", target: "render-settings" },
];

const GEMMA4_OLLAMA_MODEL = "hf.co/HauhauCS/Gemma4-26B-A4B-QAT-Uncensored-HauhauCS-Balanced-MTP:Q4_K_M";
const QWEN_OLLAMA_MODEL = "huihui_ai/qwen3-vl-abliterated:32b-instruct-q4_K_M";
const DEFAULT_OLLAMA_MODEL = GEMMA4_OLLAMA_MODEL;

const promptModelCatalog: PromptModelOption[] = [
  {
    value: GEMMA4_OLLAMA_MODEL,
    label: "Gemma 4 26B-A4B Uncensored",
    note: "Remote RTX 5090 · Balanced Q4_K_M · text + image",
    vision: true,
  },
  {
    value: QWEN_OLLAMA_MODEL,
    label: "Qwen3-VL Abliterated 32B",
    note: "Remote RTX 5090 · text + image",
    vision: true,
  },
];

const codexModelCatalog: CodexModelOption[] = [
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", note: "最高品質", reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra", note: "品質／速度平衡", reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { value: "gpt-5.6-luna", label: "GPT-5.6 Luna", note: "較快、低成本", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
  { value: "gpt-5.5", label: "GPT-5.5", note: "通用 Codex", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
  { value: "gpt-5.4", label: "GPT-5.4", note: "日常 Codex", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
  { value: "gpt-5.4-mini", label: "GPT-5.4 Mini", note: "較快、低成本", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
];

const codexReasoningOptions = [
  { value: "low", label: "Low", note: "最快" },
  { value: "medium", label: "Medium", note: "平衡" },
  { value: "high", label: "High", note: "更完整" },
  { value: "xhigh", label: "XHigh", note: "深度" },
  { value: "max", label: "Max", note: "最高" },
  { value: "ultra", label: "Ultra", note: "自動分工" },
] as const;

const modelOptions = [
  { value: "nvfp4_blackwell", label: "NVFP4 Blackwell", note: "推薦 · 16GB VRAM" },
  { value: "int4_convrot_low_vram", label: "INT4 ConvRot", note: "低顯存 fallback" },
  { value: "official_pruned_int8_convrot", label: "Official INT8", note: "品質比較" },
  { value: "ref2va_pruned_nvfp4", label: "Ref2VA Pruned NVFP4", note: "12.5 GB · Blackwell" },
  { value: "wan22_animate_fp8", label: "Wan2.2 Animate", note: "影片替換模式" },
];

function Icon({ name }: { name: string }) {
  const symbols: Record<string, string> = {
    grid: "▦",
    clock: "◷",
    folder: "▱",
    sliders: "☷",
    bolt: "✦",
    cloud: "◌",
    spark: "✧",
    image: "▧",
    video: "▶",
    upload: "↑",
    arrow: "↗",
    check: "✓",
    pause: "Ⅱ",
    refresh: "↻",
    swap: "⇄",
    plus: "+",
    play: "▶",
    download: "⇩",
    close: "×",
  };
  return (
    <span className="icon" aria-hidden="true">
      {symbols[name] || "·"}
    </span>
  );
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function formatTime(value: string) {
  try {
    return new Intl.DateTimeFormat("zh-TW", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return "剛剛";
  }
}

type NumberDraft = number | "";

function numberInputDraft(value: string): NumberDraft {
  if (value.trim() === "") return "";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : "";
}

function normalizedSteps(value: NumberDraft, fallback = 20) {
  const parsed = value === "" ? fallback : value;
  return Math.min(80, Math.max(1, Math.round(parsed)));
}

function normalizedSeed(value: NumberDraft) {
  const parsed = value === "" ? 12345 : value;
  return Math.min(2147483647, Math.max(0, Math.round(parsed)));
}

function normalizedLongDuration(value: NumberDraft) {
  const parsed = value === "" ? 10 : value;
  return Math.min(3600, Math.max(1, Number(parsed.toFixed(3))));
}

function normalizedSegmentDurationHint(value: NumberDraft) {
  const parsed = value === "" ? 5 : value;
  return Math.min(60, Math.max(0.5, Number(parsed.toFixed(3))));
}

function parseLongTimeValue(value: string) {
  const parts = value.trim().replace(",", ".").split(":").map(Number);
  if (!parts.length || parts.length > 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) return NaN;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function randomSeedValue() {
  const values = new Uint32Array(1);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(values);
    return values[0] % 2147483648;
  }
  return Math.floor(Math.random() * 2147483648);
}

function longErrorDialogFrom(error: LongJob["error"] | Error | string, title = "長影片生成失敗"): LongErrorDialog {
  const value = error instanceof Error ? error.message : error;
  const code = typeof value === "string"
    ? (value.match(/^([A-Z][A-Z0-9_]+):/)?.[1] || "LONG_VIDEO_FAILED")
    : value?.code || "LONG_VIDEO_FAILED";
  const message = typeof value === "string"
    ? value.replace(/^[A-Z][A-Z0-9_]+:\s*/, "")
    : value?.message || "長影片工作失敗。";
  const hints: Record<string, string> = {
    FFMPEG_TAIL_FAILED: "第 1 段影片已保留，但 FFmpeg 無法擷取銜接尾幀。關閉視窗後可重新開始，系統會重試該片段。",
    MEDIA_TOOLS_UNAVAILABLE: "請確認最新版 ffmpeg 與 ffprobe 可由 Web 服務找到，再重新開始。",
    GENERATION_FAILED: "MiniMax H3／ComfyUI 生成程序失敗。詳細 stderr 與 exit code 已寫入該片段的 attempt 紀錄。",
    GENERATION_TIMEOUT: "等待本機生成超過時限。請檢查 ComfyUI 佇列與顯存狀態後再重試。",
    OLLAMA_TIMELINE_INVALID: "請增加故事細節、調整影片總長或更換 Ollama 模型後重新規劃。",
    OLLAMA_INVALID_JSON: "請重新執行規劃或更換 Ollama 模型。",
  };
  return {
    title,
    code,
    message,
    hint: hints[code] || "工作狀態與診斷紀錄已保留。請依錯誤內容調整後重試。",
  };
}

function longStageLabel(job: LongJob) {
  if (job.segmentStage) return job.segmentStage;
  const labels: Record<string, string> = {
    "sequence.start": "準備長影片工作…",
    "segment.rendering": "產生目前片段…",
    "segment.normalizing": "標準化影片格式與音訊…",
    "segment.extracting_tail": "擷取段尾銜接影格…",
    "segment.completed": "片段完成，準備下一段…",
    "assembly.start": "合併所有片段…",
    "assembly.completed": "長影片已完成",
    "sequence.failed": "長影片生成失敗",
    "sequence.cancelled": "長影片生成已取消",
  };
  return labels[job.stage || ""] || job.stage || job.status;
}

function longSegmentStatusLabel(status?: string) {
  const labels: Record<string, string> = {
    pending: "等待中",
    stale: "需要重產",
    queued: "排隊中",
    rendering: "生成中",
    normalizing: "標準化",
    extracting_tail: "擷取尾幀",
    completed: "已完成",
    failed: "失敗",
  };
  return labels[status || ""] || status || "等待中";
}

function batchSeed(baseSeed: NumberDraft, index: number) {
  const normalized = normalizedSeed(baseSeed);
  return (normalized + index) % 2147483648;
}

function batchOutputName(value: string, index: number, total: number) {
  if (total <= 1) return value;
  const stem = value.trim().replace(/\.[^.]+$/, "") || "h3-render";
  const suffix = String(index + 1).padStart(String(total).length, "0");
  return `${stem}-${suffix}`;
}

function formatDurationMs(value?: number | null) {
  if (!Number.isFinite(value)) return "—";
  const seconds = Math.max(0, Math.ceil(Number(value) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function progressUpdateAge(updatedAt?: string) {
  if (!updatedAt) return "尚未收到事件";
  const ageSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(updatedAt)) / 1000));
  return ageSeconds < 2 ? "剛剛更新" : `${ageSeconds} 秒前更新`;
}

function isActiveJob(job: Job) {
  return ["queued", "running", "cancelling"].includes(job.status);
}

function isFinishedJob(job: Job) {
  return ["completed", "failed", "cancelled"].includes(job.status);
}

function assetUrl(asset: Asset) {
  return BRIDGE_URL + asset.url;
}

function isDeletableAsset(asset: Asset) {
  return (asset.root === "input" || asset.root === "output") && (asset.kind === "image" || asset.kind === "video");
}

function assetKey(asset: Asset) {
  return assetKeyFromParts(asset.root, asset.name);
}

function assetKeyFromParts(root: Asset["root"], name: string) {
  return root + ":" + name;
}

type AssetDeletePayload = {
  asset?: { deletedCount?: number };
  code?: string;
  error?: string | { code?: string; message?: string };
  message?: string;
};

function assetDeleteFailureMessage(status: number, payload: AssetDeletePayload) {
  const code = typeof payload.code === "string"
    ? payload.code
    : payload.error && typeof payload.error === "object" && typeof payload.error.code === "string"
      ? payload.error.code
      : "";
  const serverMessage = typeof payload.error === "string"
    ? payload.error
    : payload.error && typeof payload.error === "object" && typeof payload.error.message === "string"
      ? payload.error.message
      : typeof payload.message === "string" ? payload.message : "";
  if (status === 409 || code === "ASSET_IN_USE" || code === "ASSET_USE_UNKNOWN") {
    return "資源使用中，請先停止使用中的工作後再刪除。";
  }
  return serverMessage || `刪除資源失敗（HTTP ${status}）。`;
}

function uniqueAssets(items: Asset[], limit = Number.POSITIVE_INFINITY) {
  const seen = new Set<string>();
  return items.filter((asset) => {
    const key = assetKey(asset);
    if (seen.has(key)) return false;
    seen.add(key);
    return seen.size <= limit;
  });
}

const BULK_DELETE_ASSET_KEY = "__bulk_delete__";

function modelSupportsPromptImages(model: string) {
  const normalized = model.toLowerCase();
  if (normalized === "gemma3:1b") return false;
  return normalized.includes("-vl") ||
    normalized.includes("gemma3") ||
    normalized.includes("gemma4") ||
    normalized.includes("gemma3n");
}

function isH3PromptMode(mode: Mode) {
  return mode !== "replace";
}

async function assetToPromptImage(asset: Asset) {
  const response = await fetch(assetUrl(asset));
  if (!response.ok) throw new Error("無法讀取參考素材。");
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const canvas = document.createElement("canvas");
    const maxDimension = 1024;
    if (asset.kind === "image") {
      const image = new Image();
      image.src = objectUrl;
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("無法解碼參考圖片。"));
      });
      const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
    } else {
      const video = document.createElement("video");
      video.src = objectUrl;
      video.muted = true;
      video.playsInline = true;
      video.preload = "metadata";
      await new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () => reject(new Error("無法讀取來源影片首幀。"));
      });
      const scale = Math.min(1, maxDimension / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
      video.removeAttribute("src");
      video.load();
    }
    const dataUrl = canvas.toDataURL("image/jpeg", 0.86);
    return dataUrl.slice(dataUrl.indexOf(",") + 1);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function assetDownloadUrl(asset: Asset) {
  return assetUrl(asset) + "&download=1";
}

function assetFileName(asset: Asset) {
  return asset.name.split("/").pop() || asset.name;
}

function AssetThumb({
  asset,
  className = "",
}: {
  asset?: Asset | null;
  className?: string;
}) {
  if (!asset) {
    return <div className={"asset-thumb asset-thumb-empty " + className}>尚未選擇</div>;
  }

  if (asset.kind === "video") {
    return (
      <div className={"asset-thumb " + className}>
        <video src={assetUrl(asset)} muted playsInline preload="metadata" />
        <span className="thumb-play">
          <Icon name="play" />
        </span>
      </div>
    );
  }

  return (
    <div className={"asset-thumb " + className}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={assetUrl(asset)} alt={asset.name} />
    </div>
  );
}

export default function Home() {
  const [health, setHealth] = useState<Health | null>(null);
  const [bridgeOnline, setBridgeOnline] = useState(false);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [history, setHistory] = useState<Job[]>([]);
  const [assetFilter, setAssetFilter] = useState<"all" | AssetKind>("all");
  const [videoPage, setVideoPage] = useState(1);
  const [deletingAssetKey, setDeletingAssetKey] = useState<string | null>(null);
  const [selectedAssetKeys, setSelectedAssetKeys] = useState<string[]>([]);
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
  const [assetPreview, setAssetPreview] = useState<Asset | null>(null);
  const [referenceImage, setReferenceImage] = useState<Asset | null>(null);
  const [referenceImages, setReferenceImages] = useState<Asset[]>([]);
  const [longReferenceImage, setLongReferenceImage] = useState<Asset | null>(null);
  const [longReferenceMode, setLongReferenceMode] = useState<LongReferenceMode>("continuity");
  const [longReferenceAssets, setLongReferenceAssets] = useState<Asset[]>([]);
  const [lastFrameImage, setLastFrameImage] = useState<Asset | null>(null);
  const [sourceVideo, setSourceVideo] = useState<Asset | null>(null);
  const [mode, setMode] = useState<Mode>("t2v");
  const [promptBrief, setPromptBrief] = useState("");
  const [prompt, setPrompt] = useState("");
  const [promptGenerationError, setPromptGenerationError] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [promptProvider, setPromptProvider] = useState<PromptProvider>("ollama");
  const [ollamaModel, setOllamaModel] = useState(DEFAULT_OLLAMA_MODEL);
  const [codexModel, setCodexModel] = useState("gpt-5.6-luna");
  const [codexReasoningEffort, setCodexReasoningEffort] = useState("medium");
  const [modelProfile, setModelProfile] = useState("nvfp4_blackwell");
  const [activeNav, setActiveNav] = useState("workspace");
  const [width, setWidth] = useState<number | "">(736);
  const [height, setHeight] = useState<number | "">(416);
  const [duration, setDuration] = useState(5);
  const [steps, setSteps] = useState<NumberDraft>(20);
  const [seed, setSeed] = useState<NumberDraft>(12345);
  const [renderCount, setRenderCount] = useState(1);
  const [outputName, setOutputName] = useState("");
  const [promptBusy, setPromptBusy] = useState(false);
  const [renderBusy, setRenderBusy] = useState(false);
  const [renderJobs, setRenderJobs] = useState<Job[]>([]);
  const [renderBatchSize, setRenderBatchSize] = useState(0);
  const [renderSubmitting, setRenderSubmitting] = useState(false);
  const [runtimeSwitchBusy, setRuntimeSwitchBusy] = useState(false);
  const [studioMode, setStudioMode] = useState<"single" | "long">("single");
  const [longTitle, setLongTitle] = useState("");
  const [longInputType, setLongInputType] = useState<"text" | "image">("text");
  const [longTimelineMode, setLongTimelineMode] = useState<"auto" | "manual">("auto");
  const [longDuration, setLongDuration] = useState<NumberDraft>(10);
  const [longSegmentDurationHint, setLongSegmentDurationHint] = useState<NumberDraft>(5);
  const [longBrief, setLongBrief] = useState("");
  const [longNegativePrompt, setLongNegativePrompt] = useState("");
  const [longTimeline, setLongTimeline] = useState("");
  const [longFolder, setLongFolder] = useState("");
  const [longSeam, setLongSeam] = useState<"keep_duplicate_frame" | "drop_next_first_frame">("keep_duplicate_frame");
  const [longPlan, setLongPlan] = useState<LongPlan | null>(null);
  const [longJob, setLongJob] = useState<LongJob | null>(null);
  const [longBusy, setLongBusy] = useState(false);
  const [longPlanning, setLongPlanning] = useState(false);
  const [longPlanningElapsedMs, setLongPlanningElapsedMs] = useState(0);
  const [longPlannerNotice, setLongPlannerNotice] = useState("");
  const [longPlanDirty, setLongPlanDirty] = useState(false);
  const [longError, setLongError] = useState("");
  const [longErrorDialog, setLongErrorDialog] = useState<LongErrorDialog | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [upscaleSource, setUpscaleSource] = useState<Asset | null>(null);
  const [upscaleJob, setUpscaleJob] = useState<UpscaleJob | null>(null);
  const [upscaleSubmitting, setUpscaleSubmitting] = useState(false);
  const [upscaleUploading, setUpscaleUploading] = useState(false);
  const [upscaleError, setUpscaleError] = useState("");
  const [img2imgSource, setImg2ImgSource] = useState<Asset | null>(null);
  const [img2imgPrompt, setImg2ImgPrompt] = useState("");
  const [img2imgNegativePrompt, setImg2ImgNegativePrompt] = useState("");
  const [img2imgModel, setImg2ImgModel] = useState(IMG2IMG_MODELS[0].value as string);
  const [img2imgDenoise, setImg2ImgDenoise] = useState(0.65);
  const [img2imgSteps, setImg2ImgSteps] = useState(4);
  const [img2imgCfg, setImg2ImgCfg] = useState(1);
  const [img2imgSeed, setImg2ImgSeed] = useState(12345);
  const [img2imgJob, setImg2ImgJob] = useState<Img2ImgJob | null>(null);
  const [img2imgSubmitting, setImg2ImgSubmitting] = useState(false);
  const [img2imgUploading, setImg2ImgUploading] = useState(false);
  const [img2imgError, setImg2ImgError] = useState("");
  const longErrorDialogKeyRef = useRef("");
  const renderJobsRef = useRef<Job[]>([]);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const longImageInputRef = useRef<HTMLInputElement>(null);
  const lastFrameInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const upscaleInputRef = useRef<HTMLInputElement>(null);
  const img2imgInputRef = useRef<HTMLInputElement>(null);

  const filteredAssets = useMemo(
    () =>
      assets.filter((asset) => assetFilter === "all" || asset.kind === assetFilter),
    [assets, assetFilter],
  );

  const activeJob =
    renderJobs.find((item) => item.status === "running") ||
    renderJobs.find(isActiveJob) ||
    null;
  const outputAsset = [...renderJobs]
    .filter((item) => item.output)
    .sort((left, right) => String(right.finishedAt || "").localeCompare(String(left.finishedAt || "")))[0]
    ?.output;
  const latestCompletedJob = [...renderJobs]
    .filter((item) => item.status === "completed" && Number.isFinite(item.elapsedMs))
    .sort((left, right) => String(right.finishedAt || "").localeCompare(String(left.finishedAt || "")))[0];
  const activeRenderJobIds = renderJobs
    .filter(isActiveJob)
    .map((item) => item.id);
  const activeRenderJobKey = activeRenderJobIds.join(",");
  const renderJobIds = renderJobs.map((item) => item.id);
  const renderJobKey = renderJobIds.join(",");
  const inputAssets = assets.filter((asset) => asset.root === "input");
  const outputAssets = assets.filter((asset) => asset.root === "output");
  const filteredInputAssets = filteredAssets.filter((asset) => asset.root === "input");
  const filteredOutputAssets = filteredAssets.filter((asset) => asset.root === "output");
  const videoPageCount = Math.max(1, Math.ceil(filteredOutputAssets.length / VIDEO_PAGE_SIZE));
  const currentVideoPage = Math.min(videoPage, videoPageCount);
  const videoPageNumbers = Array.from({ length: videoPageCount }, (_, index) => index + 1);
  const paginatedOutputAssets = assetFilter === "video"
    ? filteredOutputAssets.slice(
      (currentVideoPage - 1) * VIDEO_PAGE_SIZE,
      currentVideoPage * VIDEO_PAGE_SIZE,
    )
    : filteredOutputAssets;
  const selectedAssetKeySet = new Set(selectedAssetKeys);
  const deletableAssets = assets.filter(isDeletableAsset);
  const selectedDeletableAssets = assets.filter((asset) => isDeletableAsset(asset) && selectedAssetKeySet.has(assetKey(asset)));
  const visibleDeletableAssets = filteredAssets.filter(isDeletableAsset);
  const allVisibleDeletableAssetsSelected = visibleDeletableAssets.length > 0 && visibleDeletableAssets.every((asset) => selectedAssetKeySet.has(assetKey(asset)));
  const assetGroups = [
    {
      root: "input" as const,
      label: "INPUT",
      title: "輸入資源",
      description: "參考圖片與來源影片，可作為生成素材。",
      assets: filteredInputAssets,
      total: filteredInputAssets.length,
    },
    {
      root: "output" as const,
      label: "OUTPUT",
      title: "輸出成果",
      description: "H3 生成的影片與其他媒體成果。",
      assets: paginatedOutputAssets,
      total: filteredOutputAssets.length,
    },
  ];

  useEffect(() => {
    void refreshAll();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    renderJobsRef.current = renderJobs;
  }, [renderJobs]);

  useEffect(() => {
    if (!activeRenderJobKey || !renderJobKey) return;
    const trackedRenderJobIds = renderJobIds;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(BRIDGE_URL + "/api/jobs");
        if (!response.ok) return;
        const payload = (await response.json()) as { jobs?: Job[] };
        // Keep polling every submitted job, including completed ones. The
        // active-only list used to drop finished jobs and under-count batches.
        const tracked = (payload.jobs || []).filter((item) => trackedRenderJobIds.includes(item.id));
        if (!tracked.length) return;

        const previousJobs = renderJobsRef.current;
        const updates = new Map(tracked.map((item) => [item.id, item]));
        setRenderJobs((current) => current.map((item) => updates.get(item.id) || item));
        setHistory((current) => {
          const known = new Set(current.map((item) => item.id));
          const updated = current.map((item) => updates.get(item.id) || item);
          return [...tracked.filter((item) => !known.has(item.id)), ...updated];
        });

        const newlyCompleted = tracked.some(
          (item) => item.status === "completed" && !previousJobs.some((current) => current.id === item.id && current.status === "completed"),
        );
        if (newlyCompleted) void refreshAssets();

        const allSubmitted = !renderSubmitting && renderBatchSize > 0 && trackedRenderJobIds.length >= renderBatchSize;
        const allFinished = allSubmitted && tracked.length >= renderBatchSize && tracked.every(isFinishedJob);
        if (allFinished) {
          const total = renderBatchSize;
          const completedCount = tracked.filter((item) => item.status === "completed").length;
          setRenderBusy(false);
          setRenderSubmitting(false);
          setRenderBatchSize(0);
          showToast(
            `批次完成：${completedCount}/${total} 部影片已完成。`,
            completedCount === total ? "success" : "info",
          );
        }
      } catch {
        // The bridge status indicator remains the source of truth.
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [activeRenderJobKey, renderJobKey, renderBatchSize, renderSubmitting]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const trackedJobId = longJob?.id;
    const trackedStatus = longJob?.status;
    if (!trackedJobId || !LONG_VIDEO_POLL_STATUSES.has(trackedStatus || "")) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`${BRIDGE_URL}/api/sequences/${encodeURIComponent(trackedJobId)}`);
        if (!response.ok) return;
        const payload = (await response.json()) as { job?: LongJob };
        if (payload.job) {
          const nextJob = payload.job;
          const terminalTransition = LONG_VIDEO_TERMINAL_STATUSES.has(nextJob.status) && nextJob.status !== trackedStatus;
          setLongJob(nextJob);
          // Hydrate active progress and the terminal result once.  The effect
          // stops after this response, so terminal state cannot overwrite a
          // later unsaved draft repeatedly.
          if (LONG_VIDEO_POLL_STATUSES.has(nextJob.status) || terminalTransition) setLongPlan(nextJob);
          if (terminalTransition && nextJob.status === "failed" && nextJob.error) {
            const code = typeof nextJob.error === "string" ? nextJob.error : nextJob.error.code || nextJob.error.message || "LONG_VIDEO_FAILED";
            const key = `${nextJob.id}:${nextJob.revision}:${code}`;
            if (longErrorDialogKeyRef.current !== key) {
              longErrorDialogKeyRef.current = key;
              setLongError(typeof nextJob.error === "string" ? nextJob.error : `${nextJob.error.code || "LONG_VIDEO_FAILED"}: ${nextJob.error.message || "長影片工作失敗。"}`);
              setLongErrorDialog(longErrorDialogFrom(nextJob.error));
            }
          }
          if (terminalTransition) void refreshAssets();
        }
      } catch {
        // The next poll or manual refresh can recover the view.
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [longJob?.id, longJob?.status]);

  useEffect(() => {
    const trackedJobId = upscaleJob?.id;
    const trackedStatus = upscaleJob?.status;
    if (!trackedJobId || !UPSCALE_POLL_STATUSES.has(trackedStatus || "queued")) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`${BRIDGE_URL}/api/upscale/jobs/${encodeURIComponent(trackedJobId)}`);
        if (!response.ok) return;
        const payload = (await response.json()) as { job?: UpscaleJob; error?: string };
        if (!payload.job) return;
        const nextJob = payload.job;
        const terminalTransition = UPSCALE_TERMINAL_STATUSES.has(nextJob.status) && nextJob.status !== trackedStatus;
        setUpscaleJob(nextJob);
        if (terminalTransition) {
          if (nextJob.status === "completed") {
            void refreshAssets();
            showToast("影片升頻完成，可預覽或下載。", "success");
          } else if (nextJob.status === "failed") {
            setUpscaleError(nextJob.error || "SeedVR2 升頻失敗，請稍後再試。 ");
          }
        }
      } catch {
        // The next poll or a manual retry can recover the status view.
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [upscaleJob?.id, upscaleJob?.status]);

  useEffect(() => {
    const trackedJobId = img2imgJob?.id;
    const trackedStatus = img2imgJob?.status;
    if (!trackedJobId || !IMG2IMG_POLL_STATUSES.has(trackedStatus || "queued")) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`${BRIDGE_URL}/api/img2img/jobs/${encodeURIComponent(trackedJobId)}`);
        if (!response.ok) return;
        const payload = (await response.json()) as { job?: Img2ImgJob; error?: string };
        if (!payload.job) return;
        const nextJob = payload.job;
        const terminalTransition = IMG2IMG_TERMINAL_STATUSES.has(nextJob.status) && nextJob.status !== trackedStatus;
        setImg2ImgJob(nextJob);
        if (terminalTransition) {
          if (nextJob.status === "completed") {
            void refreshAssets();
            showToast("以圖生圖完成，結果已加入素材庫。", "success");
          } else if (nextJob.status === "failed") {
            setImg2ImgError(nextJob.error || "以圖生圖失敗，請稍後再試。");
          }
        }
      } catch {
        // The next poll or manual refresh can recover the status view.
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [img2imgJob?.id, img2imgJob?.status]);

  useEffect(() => {
    if (!longErrorDialog) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLongErrorDialog(null);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [longErrorDialog]);

  useEffect(() => {
    if (!assetPreview) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAssetPreview(null);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [assetPreview]);

  async function refreshAll() {
    await Promise.all([refreshStatus(), refreshAssets(), refreshHistory(), refreshLongSequences()]);
  }

  async function refreshStatus() {
    try {
      const response = await fetch(BRIDGE_URL + "/api/health");
      if (!response.ok) throw new Error("bridge unavailable");
      const nextHealth = (await response.json()) as Health;
      setHealth(nextHealth);
      setBridgeOnline(true);
      if (nextHealth.ollama.models.length) {
        setOllamaModel((current) => nextHealth.ollama.models.includes(current)
          ? current
          : nextHealth.ollama.models[0]);
      }
    } catch {
      setBridgeOnline(false);
      setHealth(null);
    }
  }

  async function selectRuntimeMode(mode: "local" | "remote") {
    const currentMode = health?.runtime?.mode || (health?.comfy.remote ? "remote" : "local");
    if (runtimeSwitchBusy || mode === currentMode) return;
    setRuntimeSwitchBusy(true);
    try {
      const response = await fetch(BRIDGE_URL + "/api/runtime", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        health?: Health;
        error?: string;
        code?: string;
      };
      if (!response.ok || !payload.health) {
        throw new Error(payload.code ? `${payload.code}: ${payload.error || "Runtime switch failed."}` : payload.error || "Runtime switch failed.");
      }
      setHealth(payload.health);
      setBridgeOnline(true);
      if (payload.health.ollama.models.length) {
        setOllamaModel((current) => mode === "remote" && payload.health!.ollama.models.includes(GEMMA4_OLLAMA_MODEL)
          ? GEMMA4_OLLAMA_MODEL
          : payload.health!.ollama.models.includes(current)
            ? current
            : payload.health!.ollama.models[0]);
      }
      showToast(mode === "remote" ? "已切換到 Vast RTX 5090。" : "已切換到本機模型。", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Runtime switch failed.", "error");
      await refreshStatus();
    } finally {
      setRuntimeSwitchBusy(false);
    }
  }

  async function refreshAssets() {
    try {
      const response = await fetch(BRIDGE_URL + "/api/assets?root=all");
      if (!response.ok) return;
      const payload = (await response.json()) as { assets: Asset[] };
      setAssets(payload.assets || []);
    } catch {
      setAssets([]);
    }
  }

  async function refreshHistory() {
    try {
      const response = await fetch(BRIDGE_URL + "/api/jobs");
      if (!response.ok) return;
      const payload = (await response.json()) as { jobs: Job[] };
      const jobs = payload.jobs || [];
      setHistory(jobs);
      const activeJobs = jobs.filter(isActiveJob);
      if (activeJobs.length) {
        const activeBatchKeys = new Set(activeJobs.map((item) => item.batchId || item.id));
        const trackedJobs = jobs.filter((item) => activeBatchKeys.has(item.batchId || item.id));
        const restoredBatchSize = Math.max(
          trackedJobs.length,
          ...trackedJobs.map((item) => item.batchTotal || 1),
        );
        setRenderJobs(trackedJobs);
        setRenderBatchSize(restoredBatchSize || activeJobs.length);
        setRenderSubmitting(false);
        setRenderBusy(true);
        return;
      }
      const latestJob = jobs
        .filter((item) => item.output)
        .sort((left, right) => String(right.finishedAt || "").localeCompare(String(left.finishedAt || "")))[0];
      setRenderJobs(latestJob ? [latestJob] : []);
      setRenderBatchSize(0);
      setRenderSubmitting(false);
      setRenderBusy(false);
    } catch {
      setHistory([]);
    }
  }

  function resetLongEditorState() {
    setLongTitle("");
    setLongFolder("");
    setLongInputType("text");
    setLongReferenceImage(null);
    setLongReferenceMode("continuity");
    setLongReferenceAssets([]);
    setLongTimelineMode("auto");
    setLongDuration(10);
    setLongSegmentDurationHint(5);
    setLongBrief("");
    setLongNegativePrompt("");
    setLongTimeline("");
    setLongSeam("keep_duplicate_frame");
    setLongPlan(null);
    setLongJob(null);
    setLongPlanning(false);
    setLongPlanningElapsedMs(0);
    setLongPlannerNotice("");
    setLongPlanDirty(false);
    setLongError("");
    setLongErrorDialog(null);
    longErrorDialogKeyRef.current = "";
  }

  async function refreshLongSequences() {
    try {
      const response = await fetch(BRIDGE_URL + "/api/sequences");
      if (!response.ok) return;
      const payload = (await response.json()) as { jobs?: LongJob[] };
      // Completed sequences belong to history, not to the editable long-video
      // form. Only restore a draft, an in-progress job, or another
      // non-terminal sequence into the form.
      const latest = payload.jobs?.find((item) => item.status !== "completed");
      if (!latest) {
        // If the previous UI state came from a completed sequence, remove it
        // when the user refreshes. Preserve a locally edited draft.
        if (longJob?.status === "completed" && !longPlanDirty) resetLongEditorState();
        return;
      }
      if (latest) {
        setLongJob(latest);
        setLongPlan(latest);
        setLongTitle(latest.title || "");
        setLongInputType(latest.inputType || "text");
        setLongBrief(latest.inputText || "");
        const hydrateLongAsset = (candidate?: Asset) => {
          if (!candidate || candidate.kind !== "image") return null;
          return assets.find((asset) => asset.root === candidate.root && asset.name === candidate.name) || candidate;
        };
        const hydratedLongAssets = uniqueAssets([
          hydrateLongAsset(latest.inputAsset),
          ...(Array.isArray(latest.referenceAssets) ? latest.referenceAssets.map(hydrateLongAsset) : []),
        ].filter((asset): asset is Asset => Boolean(asset)), MAX_LONG_REFERENCE_IMAGES);
        setLongReferenceMode(latest.referenceMode === "multi_reference" ? "multi_reference" : "continuity");
        setLongReferenceAssets(hydratedLongAssets);
        setLongReferenceImage(hydratedLongAssets[0] || null);
        setLongFolder(latest.outputFolder || "");
        setLongDuration(latest.duration || 10);
        setLongTimeline((latest.segments || []).map((segment) => `[${segment.start.toFixed(3)} - ${segment.end.toFixed(3)}] ${segment.description}`).join("\n"));
        setLongTimelineMode(["ollama", "codex"].includes(latest.planMeta?.timelineSource || "") ? "auto" : "manual");
        setLongSegmentDurationHint(latest.planningSettings?.segmentDurationHint || latest.planMeta?.segmentDurationHint || 5);
        setLongPlanDirty(false);
        if (latest.width) setWidth(latest.width);
        if (latest.height) setHeight(latest.height);
        if (latest.steps) setSteps(latest.steps);
        if (latest.seed !== undefined) setSeed(latest.seed);
        if (latest.modelProfile) setModelProfile(latest.modelProfile);
        if (latest.promptProvider) setPromptProvider(latest.promptProvider);
        // A saved job may reference a model that is not installed on the
        // currently selected runtime. Health reconciliation owns the live
        // model choice, so restoring a job must not overwrite it.
        if (latest.codexModel) setCodexModel(latest.codexModel);
        if (latest.codexReasoningEffort) setCodexReasoningEffort(latest.codexReasoningEffort);
        setLongNegativePrompt(latest.negativePrompt || "");
        if (latest.seam) setLongSeam(latest.seam);
        if (latest.status === "completed") void refreshAssets();
      }
    } catch {
      // Keep an editable local draft when the bridge is offline.
    }
  }

  function showToast(message: string, tone: Toast["tone"] = "info") {
    setToast({ message, tone });
    window.setTimeout(() => setToast(null), 4200);
  }

  function updateMode(nextMode: Mode) {
    setMode(nextMode);
    if (nextMode === "ref2v" && window.matchMedia("(max-width: 780px)").matches) {
      window.setTimeout(() => {
        document.getElementById("reference-media")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 0);
    }
    if (nextMode === "replace") {
      setModelProfile("wan22_animate_fp8");
      setWidth(832);
      setHeight(480);
      setSteps(6);
    } else if (nextMode === "ref2v") {
      setModelProfile("ref2va_pruned_nvfp4");
      setWidth(736);
      setHeight(416);
      setSteps(20);
    } else if (modelProfile === "wan22_animate_fp8" || modelProfile === "ref2va_pruned_nvfp4") {
      setModelProfile("nvfp4_blackwell");
      setWidth(736);
      setHeight(416);
      setSteps(20);
    }
  }

  function randomizeSeed() {
    setSeed(randomSeedValue());
  }

  function navigateToSection(target: string) {
    setActiveNav(target);
    document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" });

  }
  async function generatePrompt() {
    if (!promptBrief.trim()) {
      showToast("請先輸入提示詞。", "error");
      return;
    }
    if (mode === "i2v" && !referenceImage) {
      showToast("I2VA 提示詞需要參考圖片。", "error");
      return;
    }
    if (mode === "fl2v" && (!referenceImage || !lastFrameImage)) {
      showToast("FL2VA 提示詞需要首幀與尾幀圖片。", "error");
      return;
    }
    if (mode === "l2v" && !lastFrameImage) {
      showToast("L2VA 提示詞需要尾幀圖片。", "error");
      return;
    }
    if (mode === "replace" && (!referenceImage || !sourceVideo)) {
      showToast("影片替換提示詞需要參考圖片與來源影片。", "error");
      return;
    }
    if (mode === "ref2v" && !referenceImages.length && !sourceVideo) {
      showToast("Ref2VA 至少需要一個參考圖片或參考影片。", "error");
      return;
    }
    if (promptProvider === "ollama" && !ollamaOnline) {
      showToast("Ollama 尚未連線。", "error");
      return;
    }
    if (promptProvider === "codex" && !codexOnline) {
      showToast("Codex CLI 尚未安裝或無法執行。", "error");
      return;
    }
    if (promptProvider === "codex" && !codexSkillAvailable) {
      showToast("找不到 h3-prompt-writing skill。", "error");
      return;
    }
    if (promptProvider === "ollama" && !visibleModels.includes(effectiveOllamaModel)) {
      showToast(`模型 ${effectiveOllamaModel} 尚未安裝。`, "error");
      return;
    }
    if (
      promptProvider === "ollama" &&
      H3_IMAGE_PROMPT_MODES.has(mode) &&
      !modelSupportsPromptImages(effectiveOllamaModel)
    ) {
      showToast(`模型 ${effectiveOllamaModel} 不支援圖片理解，無法產生 ${promptFormatLabel} 提示詞。請改用 vision 模型或 Codex CLI。`, "error");
      return;
    }
    setPromptGenerationError("");
    setPromptBusy(true);
    try {
      const promptImages: Array<{ role: string; data: string }> = [];
      if (promptProvider === "codex" || modelSupportsPromptImages(effectiveOllamaModel)) {
        if ((mode === "i2v" || mode === "replace") && referenceImage?.kind === "image") {
          promptImages.push({
            role: "reference_image",
            data: await assetToPromptImage(referenceImage),
          });
        }
        if (mode === "ref2v") {
          for (const [index, asset] of referenceImages.entries()) {
            promptImages.push({
              role: `picture_${index + 1}`,
              data: await assetToPromptImage(asset),
            });
          }
        }
        if (mode === "fl2v" && referenceImage?.kind === "image") {
          promptImages.push({
            role: "first_frame",
            data: await assetToPromptImage(referenceImage),
          });
        }
        if ((mode === "fl2v" || mode === "l2v") && lastFrameImage?.kind === "image") {
          promptImages.push({
            role: "last_frame",
            data: await assetToPromptImage(lastFrameImage),
          });
        }
        if (mode === "replace" && sourceVideo?.kind === "video") {
          promptImages.push({
            role: "source_video_first_frame",
            data: await assetToPromptImage(sourceVideo),
          });
        }
        if (mode === "ref2v" && sourceVideo?.kind === "video") {
          promptImages.push({
            role: "video_1_preview_frame",
            data: await assetToPromptImage(sourceVideo),
          });
        }
      }
      const response = await fetch(BRIDGE_URL + "/api/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: promptProvider,
          model: promptProvider === "codex" ? effectiveCodexModel : effectiveOllamaModel,
          codexModel: effectiveCodexModel,
          reasoningEffort: effectiveCodexReasoningEffort,
          brief: promptBrief,
          negativePrompt,
          mode,
          duration,
          referenceImageName: referenceImage?.kind === "image" ? referenceImage.name : "",
          ...(mode === "ref2v" ? {
            referenceImageNames: referenceImages.map((asset) => asset.name).slice(0, MAX_REF2V_IMAGES),
            referenceImageName: referenceImages[0]?.name || "",
          } : {}),
          firstFrameName: referenceImage?.kind === "image" ? referenceImage.name : "",
          lastFrameName: lastFrameImage?.kind === "image" ? lastFrameImage.name : "",
          sourceVideoName: sourceVideo?.kind === "video" ? sourceVideo.name : "",
          images: promptImages,
        }),
      });
      const payload = (await response.json()) as ApiErrorPayload & {
        prompt?: string;
        negativePrompt?: string;
      };
      if (!response.ok) {
        const candidatePrompt = payload.candidatePrompt || payload.details?.candidatePrompt || "";
        const validation = payload.details?.finalValidation || payload.details?.secondValidation;
        if (candidatePrompt) setPrompt(candidatePrompt);
        if (candidatePrompt || validation) {
          const attempts = payload.details?.repairAttempts;
          const validationMessage = [validation?.code, validation?.message].filter(Boolean).join(": ") || apiErrorMessage(payload, "H3 提示詞格式驗證失敗。");
          setPromptGenerationError(`${validationMessage}${Number.isInteger(attempts) ? `（已自動修正 ${attempts} 次）` : ""}${candidatePrompt ? " 候選提示詞已保留，可直接編輯。" : ""}`);
        }
        throw new Error(apiErrorMessage(payload, `${promptProvider === "codex" ? "Codex CLI" : "Ollama"} 沒有回應`));
      }
      if (payload.prompt) setPrompt(payload.prompt);
      if (payload.negativePrompt) setNegativePrompt(payload.negativePrompt);
      showToast(`${promptProvider === "codex" ? "Codex CLI" : "Ollama"} 已產生 H3 提示詞。`, "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : `${promptProvider === "codex" ? "Codex CLI" : "Ollama"} 連線失敗。`, "error");
    } finally {
      setPromptBusy(false);
    }
  }

  async function fileToBase64(file: File) {
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const value = String(reader.result || "");
        resolve(value.includes(",") ? value.split(",")[1] : value);
      };
      reader.onerror = () => reject(new Error("讀取檔案失敗"));
      reader.readAsDataURL(file);
    });
  }

  function syncGeneralReferenceImages(next: Asset[]) {
    const normalized = uniqueAssets(next.filter((asset) => asset.kind === "image"), MAX_REF2V_IMAGES);
    setReferenceImages(normalized);
    setReferenceImage(normalized[0] || null);
  }

  function syncLongReferenceAssets(next: Asset[], markDirty = true) {
    const normalized = uniqueAssets(next.filter((asset) => asset.kind === "image"), MAX_LONG_REFERENCE_IMAGES);
    setLongReferenceAssets(normalized);
    setLongReferenceImage(normalized[0] || null);
    if (markDirty && longPlan) setLongPlanDirty(true);
  }

  function currentLongReferenceSelection() {
    return uniqueAssets(
      [...longReferenceAssets, ...(longReferenceImage ? [longReferenceImage] : [])],
      MAX_LONG_REFERENCE_IMAGES,
    );
  }

  function updateLongReferenceMode(nextMode: LongReferenceMode) {
    if (nextMode === longReferenceMode) return;
    const current = uniqueAssets(
      [...longReferenceAssets, ...(longReferenceImage ? [longReferenceImage] : [])],
      MAX_LONG_REFERENCE_IMAGES,
    );
    if (nextMode === "continuity") {
      const first = current[0] || null;
      syncLongReferenceAssets(first ? [first] : []);
      if (current.length > 1) showToast("已切回連續首幀，僅保留第一張參考圖。", "info");
    } else {
      syncLongReferenceAssets(current);
    }
    setLongReferenceMode(nextMode);
    if (longPlan) setLongPlanDirty(true);
  }

  function addGeneralReferenceAssets(incoming: Asset[]) {
    if (!incoming.length) return;
    if (mode !== "ref2v") {
      const image = incoming.find((asset) => asset.kind === "image");
      if (!image) return;
      syncGeneralReferenceImages([image]);
      showToast("已套用一張參考圖片。", "success");
      return;
    }
    const inputImages = incoming.filter((asset) => asset.root === "input" && asset.kind === "image");
    if (!inputImages.length) {
      showToast("Ref2V 多參考只接受 ComfyUI/input 圖片。輸出圖片仍可作單圖套用。", "error");
      return;
    }
    const next = uniqueAssets([...referenceImages, ...inputImages], MAX_REF2V_IMAGES);
    syncGeneralReferenceImages(next);
    if (next.length < referenceImages.length + inputImages.length) {
      showToast(`Ref2V 最多保留 ${MAX_REF2V_IMAGES} 張且會自動去重。`, "info");
    } else {
      showToast(`已加入 ${inputImages.length} 張 Ref2V 參考圖片。`, "success");
    }
  }

  function swapResolution() {
    const currentWidth = width;
    const currentHeight = height;
    setWidth(currentHeight);
    setHeight(currentWidth);
  }

  function addLongReferenceAsset(asset: Asset) {
    if (asset.kind !== "image") return;
    if (asset.root !== "input") {
      if (longReferenceMode === "multi_reference") {
        showToast("長片多參考只接受 ComfyUI/input 圖片；輸出圖片僅能作單圖套用。", "error");
        return;
      }
      syncLongReferenceAssets([asset]);
      showToast("已套用輸出圖片作為連續首幀單圖。", "success");
      return;
    }
    const current = uniqueAssets(
      [...longReferenceAssets, ...(longReferenceImage ? [longReferenceImage] : [])],
      MAX_LONG_REFERENCE_IMAGES,
    );
    if (longReferenceMode === "continuity" && current.length && !current.some((item) => assetKey(item) === assetKey(asset))) {
      const next = uniqueAssets([...current, asset], MAX_LONG_REFERENCE_IMAGES);
      setLongReferenceMode("multi_reference");
      syncLongReferenceAssets(next);
      if (longPlan) setLongPlanDirty(true);
      showToast("已切換到多參考模式並加入圖片。", "success");
      return;
    }
    const next = uniqueAssets([...current, asset], MAX_LONG_REFERENCE_IMAGES);
    syncLongReferenceAssets(next);
    const alreadySelected = current.some((item) => assetKey(item) === assetKey(asset));
    if (alreadySelected) {
      showToast("這張圖片已在長片參考清單。", "info");
    } else if (next.length === current.length) {
      showToast(`長片多參考最多保留 ${MAX_LONG_REFERENCE_IMAGES} 張。`, "info");
    } else {
      showToast("已加入長片參考圖片。", "success");
    }
  }

  function removeGeneralReference(asset: Asset) {
    syncGeneralReferenceImages(referenceImages.filter((item) => assetKey(item) !== assetKey(asset)));
  }

  function removeLongReference(asset: Asset) {
    syncLongReferenceAssets(longReferenceAssets.filter((item) => assetKey(item) !== assetKey(asset)));
  }

  async function uploadFiles(files: File[], target: "image" | "lastFrame" | "video" | "upscale" | "img2img") {
    const multiImageTarget = target === "image" && (
      (studioMode === "single" && mode === "ref2v") ||
      (studioMode === "long" && longReferenceMode === "multi_reference")
    );
    const existing = target === "image"
      ? studioMode === "long" ? longReferenceAssets : mode === "ref2v" ? referenceImages : referenceImage ? [referenceImage] : []
      : [];
    const existingKeys = new Set(existing.map(assetKey));
    const seenNames = new Set<string>();
    const candidates = files.filter((file) => {
      if (!multiImageTarget && seenNames.size > 0) return false;
      if (seenNames.has(file.name) || existingKeys.has(`input:${file.name}`)) return false;
      seenNames.add(file.name);
      return true;
    }).slice(0, target === "image" && multiImageTarget
      ? Math.max(0, (studioMode === "long" ? MAX_LONG_REFERENCE_IMAGES : MAX_REF2V_IMAGES) - existing.length)
      : 1);
    const skipped = Math.max(0, files.length - candidates.length);
    if (!candidates.length) {
      const message = target === "image" && multiImageTarget
        ? `已達參考圖片上限（${studioMode === "long" ? MAX_LONG_REFERENCE_IMAGES : MAX_REF2V_IMAGES} 張）或檔案已存在。`
        : "沒有可上傳的檔案。";
      if (target === "upscale") setUpscaleError(message);
      if (target === "img2img") setImg2ImgError(message);
      showToast(message, "error");
      return;
    }
    if (target === "upscale") {
      setUpscaleUploading(true);
      setUpscaleError("");
    }
    if (target === "img2img") {
      setImg2ImgUploading(true);
      setImg2ImgError("");
    }
    const uploaded: Asset[] = [];
    const failures: string[] = [];
    try {
      showToast(`正在上傳 ${candidates.length} 個檔案…`);
      for (const file of candidates) {
        try {
          const response = await fetch(BRIDGE_URL + "/api/assets/upload", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: file.name,
              mimeType: file.type,
              data: await fileToBase64(file),
            }),
          });
          const payload = (await response.json()) as { asset?: Asset; error?: string };
          if (!response.ok || !payload.asset) throw new Error(payload.error || "上傳失敗");
          uploaded.push(payload.asset);
        } catch (error) {
          failures.push(`${file.name}: ${error instanceof Error ? error.message : "上傳失敗"}`);
        }
      }
      if (uploaded.length) {
        if (target === "image") {
          if (studioMode === "long") {
            if (longReferenceMode === "multi_reference") syncLongReferenceAssets([...longReferenceAssets, ...uploaded]);
            else syncLongReferenceAssets([uploaded[0]]);
          }
          else if (mode === "ref2v") syncGeneralReferenceImages([...referenceImages, ...uploaded]);
          else setReferenceImage(uploaded[0]);
        }
        if (target === "lastFrame") setLastFrameImage(uploaded[0]);
        if (target === "video") setSourceVideo(uploaded[0]);
        if (target === "upscale") setUpscaleSource(uploaded[0]);
        if (target === "img2img") {
          setImg2ImgSource(uploaded[0]);
          setImg2ImgJob(null);
        }
        setSelectedAsset(uploaded[uploaded.length - 1]);
        await refreshAssets();
      }
      const skippedNote = skipped ? `，略過 ${skipped} 個重複/超出上限檔案` : "";
      if (failures.length) {
        const message = `成功 ${uploaded.length} 個，失敗 ${failures.length} 個${skippedNote}：${failures[0]}`;
        if (target === "upscale") setUpscaleError(message);
        if (target === "img2img") setImg2ImgError(message);
        showToast(message, "error");
      } else {
        showToast(`資源已加入資源庫${skippedNote}。`, "success");
      }
    } finally {
      if (target === "upscale") setUpscaleUploading(false);
      if (target === "img2img") setImg2ImgUploading(false);
    }
  }

  async function uploadFile(file: File, target: "image" | "lastFrame" | "video" | "upscale" | "img2img") {
    await uploadFiles([file], target);
  }

  function onFileChange(
    event: ChangeEvent<HTMLInputElement>,
    target: "image" | "lastFrame" | "video" | "upscale" | "img2img",
  ) {
    const files = Array.from(event.target.files || []);
    const multiImageTarget = target === "image" && (
      (studioMode === "single" && mode === "ref2v") ||
      (studioMode === "long" && longReferenceMode === "multi_reference")
    );
    if (files.length) {
      if (multiImageTarget) void uploadFiles(files, target);
      else void uploadFile(files[0], target);
    }
    event.target.value = "";
  }

  function selectAssetForUpscale(asset: Asset) {
    if (asset.kind !== "video") return;
    setUpscaleSource(asset);
    setUpscaleError("");
    setAssetPreview(null);
    showToast(`已選取影片升頻來源：${asset.name}`, "info");
    navigateToSection("video-upscale");
  }

  async function startUpscale() {
    if (!upscaleSource || upscaleSource.kind !== "video") {
      setUpscaleError("請先選擇要升頻的影片。 ");
      return;
    }
    if (upscaleSubmitting || upscaleUploading || (upscaleJob && UPSCALE_POLL_STATUSES.has(upscaleJob.status))) return;
    setUpscaleSubmitting(true);
    setUpscaleError("");
    try {
      const response = await fetch(BRIDGE_URL + "/api/upscale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceName: upscaleSource.name, sourceRoot: upscaleSource.root, scale: 2 }),
      });
      const payload = (await response.json().catch(() => ({}))) as { job?: UpscaleJob; error?: string };
      if (!response.ok || !payload.job) {
        throw new Error(payload.error || "無法啟動 SeedVR2 升頻。 ");
      }
      setUpscaleJob(payload.job);
      if (payload.job.status === "completed") void refreshAssets();
      if (payload.job.status === "failed") setUpscaleError(payload.job.error || "SeedVR2 升頻失敗。 ");
    } catch (error) {
      setUpscaleError(error instanceof Error ? error.message : "無法啟動 SeedVR2 升頻。 ");
    } finally {
      setUpscaleSubmitting(false);
    }
  }

  function selectAssetForImg2Img(asset: Asset) {
    if (asset.kind !== "image") return;
    setImg2ImgSource(asset);
    setImg2ImgJob(null);
    setImg2ImgError("");
    setAssetPreview(null);
    showToast(`已選取以圖生圖來源：${asset.name}`, "info");
    navigateToSection("image-to-image");
  }

  function updateImg2ImgModel(value: string) {
    setImg2ImgModel(value);
    if (value === IMG2IMG_MODELS[0].value) {
      setImg2ImgSteps(4);
      setImg2ImgCfg(1);
    } else {
      setImg2ImgSteps(20);
      setImg2ImgCfg(7);
    }
  }

  async function startImg2Img() {
    if (!img2imgSource || img2imgSource.kind !== "image") {
      setImg2ImgError("請先選擇來源圖片。");
      return;
    }
    if (!img2imgPrompt.trim()) {
      setImg2ImgError("請輸入希望圖片呈現的內容。");
      return;
    }
    if (img2imgSubmitting || img2imgUploading || (img2imgJob && IMG2IMG_POLL_STATUSES.has(img2imgJob.status))) return;
    setImg2ImgSubmitting(true);
    setImg2ImgError("");
    try {
      const response = await fetch(BRIDGE_URL + "/api/img2img", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceName: img2imgSource.name,
          sourceRoot: img2imgSource.root,
          prompt: img2imgPrompt.trim(),
          negativePrompt: img2imgNegativePrompt.trim(),
          model: img2imgModel,
          denoise: img2imgDenoise,
          steps: img2imgSteps,
          cfg: img2imgCfg,
          seed: img2imgSeed,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { job?: Img2ImgJob; error?: string; code?: string };
      if (!response.ok || !payload.job) {
        throw new Error(payload.code ? `${payload.code}: ${payload.error || "無法啟動以圖生圖。"}` : payload.error || "無法啟動以圖生圖。");
      }
      setImg2ImgJob(payload.job);
      if (payload.job.status === "completed") void refreshAssets();
      if (payload.job.status === "failed") setImg2ImgError(payload.job.error || "以圖生圖失敗。");
    } catch (error) {
      setImg2ImgError(error instanceof Error ? error.message : "無法啟動以圖生圖。");
    } finally {
      setImg2ImgSubmitting(false);
    }
  }

  function applyAssetToWorkspace(asset: Asset) {
    setSelectedAsset(asset);
    if (asset.kind === "image") {
      if (studioMode === "long") {
        addLongReferenceAsset(asset);
      }
      else if (mode === "l2v") {
        setLastFrameImage(asset);
        showToast("已選取尾幀圖片：" + asset.name);
      }
      else addGeneralReferenceAssets([asset]);
    } else {
      setSourceVideo(asset);
      showToast("已選取來源影片：" + asset.name);
    }
  }

  function openAssetPreview(asset: Asset) {
    setSelectedAsset(asset);
    setAssetPreview(asset);
  }

  function toggleAssetSelection(asset: Asset) {
    if (!isDeletableAsset(asset) || deletingAssetKey) return;
    const key = assetKey(asset);
    setSelectedAssetKeys((current) => current.includes(key)
      ? current.filter((item) => item !== key)
      : [...current, key]);
  }

  function toggleVisibleAssetSelection() {
    if (deletingAssetKey || !visibleDeletableAssets.length) return;
    const visibleKeys = visibleDeletableAssets.map(assetKey);
    const visibleKeySet = new Set(visibleKeys);
    setSelectedAssetKeys((current) => {
      const allSelected = visibleKeys.every((key) => current.includes(key));
      return allSelected
        ? current.filter((key) => !visibleKeySet.has(key))
        : Array.from(new Set([...current, ...visibleKeys]));
    });
  }

  function clearDeletedAssetState(deletedKeys: Set<string>) {
    const nextGeneralReferences = referenceImages.filter((asset) => !deletedKeys.has(assetKey(asset)));
    const nextLongReferences = longReferenceAssets.filter((asset) => !deletedKeys.has(assetKey(asset)));
    setReferenceImages(nextGeneralReferences);
    if (referenceImage && deletedKeys.has(assetKey(referenceImage))) setReferenceImage(nextGeneralReferences[0] || null);
    setLongReferenceAssets(nextLongReferences);
    if (longReferenceImage && deletedKeys.has(assetKey(longReferenceImage))) setLongReferenceImage(nextLongReferences[0] || null);
    if (sourceVideo && deletedKeys.has(assetKey(sourceVideo))) setSourceVideo(null);
    if (lastFrameImage && deletedKeys.has(assetKey(lastFrameImage))) setLastFrameImage(null);
    if (upscaleSource && deletedKeys.has(assetKey(upscaleSource))) setUpscaleSource(null);
    if (img2imgSource && deletedKeys.has(assetKey(img2imgSource))) setImg2ImgSource(null);
    const upscaleSourceDeleted = Boolean(
      upscaleJob?.sourceRoot &&
      upscaleJob.sourceName &&
      deletedKeys.has(assetKeyFromParts(upscaleJob.sourceRoot, upscaleJob.sourceName)),
    );
    const upscaleLegacySourceDeleted = Boolean(
      upscaleJob?.sourceName &&
      !upscaleJob.sourceRoot &&
      (deletedKeys.has(assetKeyFromParts("input", upscaleJob.sourceName)) || deletedKeys.has(assetKeyFromParts("output", upscaleJob.sourceName))),
    );
    const upscaleOutputDeleted = Boolean(upscaleJob?.output && deletedKeys.has(assetKey(upscaleJob.output)));
    if (upscaleSourceDeleted || upscaleLegacySourceDeleted) setUpscaleJob(null);
    else if (upscaleOutputDeleted && upscaleJob) setUpscaleJob({ ...upscaleJob, output: undefined });
    const img2imgSourceDeleted = Boolean(
      img2imgJob?.sourceRoot &&
      img2imgJob.sourceName &&
      deletedKeys.has(assetKeyFromParts(img2imgJob.sourceRoot, img2imgJob.sourceName)),
    );
    const img2imgOutputDeleted = Boolean(img2imgJob?.output && deletedKeys.has(assetKey(img2imgJob.output)));
    if (img2imgSourceDeleted) setImg2ImgJob(null);
    else if (img2imgOutputDeleted && img2imgJob) setImg2ImgJob({ ...img2imgJob, output: undefined });
    if (selectedAsset && deletedKeys.has(assetKey(selectedAsset))) setSelectedAsset(null);
    if (assetPreview && deletedKeys.has(assetKey(assetPreview))) setAssetPreview(null);
    if (longPlan) {
      const nextPlan = {
        ...longPlan,
        inputAsset: longPlan.inputAsset && deletedKeys.has(assetKey(longPlan.inputAsset)) ? undefined : longPlan.inputAsset,
        referenceAssets: longPlan.referenceAssets?.filter((asset) => !deletedKeys.has(assetKey(asset))),
      };
      if (nextPlan.inputAsset !== longPlan.inputAsset || nextPlan.referenceAssets?.length !== longPlan.referenceAssets?.length) {
        setLongPlan(nextPlan);
        setLongPlanDirty(true);
      }
    }
    if (longJob) {
      const nextJob = {
        ...longJob,
        inputAsset: longJob.inputAsset && deletedKeys.has(assetKey(longJob.inputAsset)) ? undefined : longJob.inputAsset,
        referenceAssets: longJob.referenceAssets?.filter((asset) => !deletedKeys.has(assetKey(asset))),
        finalAsset: longJob.finalAsset && deletedKeys.has(assetKeyFromParts(longJob.finalAsset.root, longJob.finalAsset.name)) ? undefined : longJob.finalAsset,
        finalPath: longJob.finalAsset && deletedKeys.has(assetKeyFromParts(longJob.finalAsset.root, longJob.finalAsset.name)) ? undefined : longJob.finalPath,
      };
      if (
        nextJob.inputAsset !== longJob.inputAsset ||
        nextJob.referenceAssets?.length !== longJob.referenceAssets?.length ||
        nextJob.finalAsset !== longJob.finalAsset
      ) setLongJob(nextJob);
    }
  }

  async function deleteOutputAssets(requestedAssets: Asset[], confirmation: string) {
    const candidates = Array.from(new Map(
      requestedAssets
        .filter(isDeletableAsset)
        .map((asset) => [assetKey(asset), asset]),
    ).values());
    if (!candidates.length || deletingAssetKey) return;
    if (!window.confirm(confirmation)) return;

    setDeletingAssetKey(candidates.length > 1 ? BULK_DELETE_ASSET_KEY : assetKey(candidates[0]));
    try {
      const outcomes = await Promise.all(candidates.map(async (asset) => {
        try {
          const response = await fetch(
            BRIDGE_URL + "/api/assets?root=" + encodeURIComponent(asset.root) + "&name=" + encodeURIComponent(asset.name),
            { method: "DELETE" },
          );
          const responseStatus = response.status;
          const payload = (await response.json().catch(() => ({}))) as AssetDeletePayload;
          if (!response.ok || !payload.asset) {
            return { asset, error: assetDeleteFailureMessage(responseStatus, payload) };
          }
          return { asset, deletedCount: Number(payload.asset.deletedCount) || 1 };
        } catch (error) {
          const message = error instanceof Error ? error.message : "刪除資源失敗。";
          return { asset, error: message };
        }
      }));
      const succeeded = outcomes.filter((item) => !item.error);
      const failed = outcomes.filter((item) => item.error);
      const deletedKeys = new Set(succeeded.map((item) => assetKey(item.asset)));

      if (succeeded.length) {
        setAssets((current) => current.filter((item) => !deletedKeys.has(assetKey(item))));
        setRenderJobs((current) => current.map((job) => (
          job.output && deletedKeys.has(assetKey(job.output))
            ? { ...job, output: undefined }
            : job
        )));
        setHistory((current) => current.map((job) => (
          job.output && deletedKeys.has(assetKey(job.output))
            ? { ...job, output: undefined }
            : job
        )));
        setSelectedAssetKeys((current) => current.filter((key) => !deletedKeys.has(key)));
        clearDeletedAssetState(deletedKeys);
        await refreshAssets();
      }

      const deletedFileCount = succeeded.reduce((total, item) => total + (item.deletedCount || 1), 0);
      if (failed.length) {
        showToast(`已刪除 ${succeeded.length} 個資源，${failed.length} 個刪除失敗：${failed[0].error}`, "error");
      } else {
        showToast(`已刪除 ${succeeded.length} 個資源（清除 ${deletedFileCount} 個檔案）。`, "success");
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : "刪除資源失敗。", "error");
    } finally {
      setDeletingAssetKey(null);
    }
  }

  async function deleteOutputAsset(asset: Asset) {
    if (!isDeletableAsset(asset)) return;
    const kindLabel = asset.kind === "image" ? "圖片" : "影片";
    await deleteOutputAssets([asset], `確定要刪除${asset.root === "input" ? "輸入" : "輸出"}${kindLabel}「${asset.name}」嗎？此操作無法復原。`);
  }

  async function deleteSelectedOutputAssets() {
    if (!selectedDeletableAssets.length) return;
    await deleteOutputAssets(
      selectedDeletableAssets,
      `確定要刪除選取的 ${selectedDeletableAssets.length} 個資源嗎？可能包含輸入與輸出檔案，此操作無法復原。`,
    );
  }

  async function startRender() {
    if (!prompt.trim()) {
      showToast("請先填入提示詞。", "error");
      return;
    }
    if (isH3PromptMode(mode) && prompt.length > H3_PROMPT_MAX_CHARS) {
      showToast(`H3 提示詞不可超過 ${H3_PROMPT_MAX_CHARS} 字元，目前為 ${prompt.length} 字元。`, "error");
      return;
    }
    if (mode === "ref2v" && !referenceImages.length && !sourceVideo) {
      showToast("Ref2VA 至少需要一個參考圖片或參考影片。", "error");
      return;
    }
    if (mode === "i2v" && !referenceImage) {
      showToast("I2VA 需要參考圖片。", "error");
      return;
    }
    if (mode === "fl2v" && (!referenceImage || !lastFrameImage)) {
      showToast("FL2VA 需要首幀與尾幀圖片。", "error");
      return;
    }
    if (mode === "l2v" && !lastFrameImage) {
      showToast("L2VA 需要尾幀圖片。", "error");
      return;
    }
    if (mode === "replace" && (!referenceImage || !sourceVideo)) {
      showToast("影片替換需要參考圖片與來源影片。", "error");
      return;
    }
    const dimensionGrid = mode === "replace" ? 16 : 32;
    const validDimension = (value: number | "") =>
      value !== "" &&
      Number.isInteger(value) &&
      value >= 32 &&
      value <= 2048 &&
      value % dimensionGrid === 0;
    if (!validDimension(width) || !validDimension(height)) {
      showToast(`影片寬度與高度必須是 ${dimensionGrid} 的倍數，範圍為 32–2048 px。`, "error");
      return;
    }
    const submittedSteps = normalizedSteps(steps, mode === "replace" ? 6 : 20);
    const submittedSeed = normalizedSeed(seed);
    if (steps !== submittedSteps) setSteps(submittedSteps);
    if (seed !== submittedSeed) setSeed(submittedSeed);
    const count = Math.min(20, Math.max(1, Math.round(renderCount || 1)));
    const firstFrameName = referenceImage?.kind === "image" ? referenceImage.name : "";
    const referenceImageNames = referenceImages.map((asset) => asset.name).slice(0, MAX_REF2V_IMAGES);
    const lastFrameName = lastFrameImage?.kind === "image" ? lastFrameImage.name : "";
    const batchId = count > 1
      ? `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      : "";
    setRenderBusy(true);
    setRenderBatchSize(count);
    setRenderSubmitting(true);
    setRenderJobs([]);

    if (count > 1) {
      try {
        const createdJobs = await Promise.all(
          Array.from({ length: count }, (_, index) =>
            fetch(BRIDGE_URL + "/api/generate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                mode,
                prompt,
                negativePrompt,
                inputImageName: mode === "i2v" || mode === "fl2v" ? firstFrameName : "",
                lastImageName: mode === "fl2v" || mode === "l2v" ? lastFrameName : "",
                inputVideoName: sourceVideo?.kind === "video" ? sourceVideo.name : "",
                referenceImageName: referenceImage?.kind === "image" ? referenceImage.name : "",
                ...(mode === "ref2v" ? { referenceImageNames } : {}),
                modelProfile,
                width,
                height,
                duration,
                steps: submittedSteps,
                seed: batchSeed(seed, index),
                outputName: batchOutputName(outputName, index, count),
                batchId,
                batchIndex: index + 1,
                batchTotal: count,
              }),
            }).then(async (response) => {
              const payload = (await response.json()) as ApiErrorPayload & { job?: Job };
              if (!response.ok || !payload.job) {
                throw new Error(apiErrorMessage(payload, "無法建立生成工作"));
              }
              const createdJob = payload.job;
              setRenderJobs((current) =>
                current.some((item) => item.id === createdJob.id)
                  ? current
                  : [...current, createdJob],
              );
              setHistory((items) => [createdJob, ...items.filter((item) => item.id !== createdJob.id)]);
              return createdJob;
            }),
          ),
        );
        setRenderSubmitting(false);
        showToast(`已加入 ${createdJobs.length} 部影片生成佇列，每部使用不同 seed。`, "success");
      } catch (error) {
        setRenderBusy(false);
        setRenderSubmitting(false);
        setRenderBatchSize(0);
        showToast(error instanceof Error ? error.message : "生成服務未連線。", "error");
      }
      return;
    }

    try {
      const response = await fetch(BRIDGE_URL + "/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          prompt,
          negativePrompt,
          inputImageName: mode === "i2v" || mode === "fl2v" ? firstFrameName : "",
          lastImageName: mode === "fl2v" || mode === "l2v" ? lastFrameName : "",
          inputVideoName: sourceVideo?.kind === "video" ? sourceVideo.name : "",
          referenceImageName: referenceImage?.kind === "image" ? referenceImage.name : "",
          ...(mode === "ref2v" ? { referenceImageNames } : {}),
          modelProfile,
          width,
          height,
          duration,
          steps: submittedSteps,
          seed: submittedSeed,
          outputName,
          batchId,
          batchIndex: 1,
          batchTotal: 1,
        }),
      });
      const payload = (await response.json()) as ApiErrorPayload & { job?: Job };
      if (!response.ok || !payload.job) throw new Error(apiErrorMessage(payload, "無法建立生成工作"));
      setRenderJobs([payload.job]);
      setRenderSubmitting(false);
      setHistory((items) => [payload.job as Job, ...items.filter((item) => item.id !== payload.job?.id)]);
      showToast("已加入生成佇列。", "success");
    } catch (error) {
      setRenderBusy(false);
      setRenderSubmitting(false);
      showToast(error instanceof Error ? error.message : "生成服務未連線。", "error");
    }
  }

  async function cancelRender() {
    if (!activeJob) return;
    try {
      await fetch(BRIDGE_URL + "/api/jobs/" + activeJob.id + "/cancel", {
        method: "POST",
      });
      showToast("已送出停止要求。");
    } catch {
      showToast("無法停止這個工作。", "error");
    }
  }

  function parseLongTimelineDraft(source: string, fallback: LongSegment[]) {
    const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return fallback;
    let cursor = 0;
    const parsed: LongSegment[] = [];
    for (const line of lines) {
      const range = line.match(/^\[?\s*([0-9:.]+)\s*(?:-|–|—|to)\s*([0-9:.]+)\s*\]?\s*(?::|：)?\s*(.*)$/i);
      if (range) {
        const start = parseLongTimeValue(range[1]);
        const end = parseLongTimeValue(range[2]);
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
        parsed.push({ start, end, duration: end - start, description: range[3].trim() });
        cursor = end;
        continue;
      }
      const durationLine = line.match(/^(\d+(?:\.\d+)?)\s*(?:秒|s|sec(?:ond)?s?)\s*(?:-|:|：)?\s*(.*)$/i);
      if (durationLine) {
        const durationValue = Number(durationLine[1]);
        parsed.push({ start: cursor, end: cursor + durationValue, duration: durationValue, description: durationLine[2].trim() });
        cursor += durationValue;
      }
    }
    return parsed.length >= 2 ? parsed : fallback;
  }

  function updateLongTimelineDraft(value: string) {
    setLongTimeline(value);
    if (!longPlan) return;
    setLongTimelineMode("manual");
    setLongPlanDirty(true);
    const parsed = parseLongTimelineDraft(value, []);
    if (parsed.length < 2) return;
    setLongDuration(parsed[parsed.length - 1].end);
    setLongPlan((current) => current ? {
      ...current,
      duration: parsed[parsed.length - 1].end,
      segments: parsed.map((segment, index) => ({
        ...(current.segments[index] || {}),
        ...segment,
        description: segment.description || current.segments[index]?.description || `Segment ${index + 1}`,
      })),
    } : current);
  }

  async function requestLongPlan() {
    setLongError("");
    setLongPlannerNotice("");
    if (!longBrief.trim()) throw new Error("請先輸入長影片的整體提示詞／故事描述。");
    const selectedLongReferences = currentLongReferenceSelection();
    if (longInputType === "image" && !selectedLongReferences.length) throw new Error("圖片起點需要 first_frame 參考圖。");
    const plannerLabel = promptProvider === "codex" ? "Codex CLI" : "Ollama";
    if (promptProvider === "codex") {
      if (!codexOnline) throw new Error("Codex CLI 尚未可用。");
      if (!codexSkillAvailable) throw new Error("找不到 h3-prompt-writing skill。");
    } else {
      if (!ollamaOnline) throw new Error("Ollama 尚未連線。");
      if (!visibleModels.includes(effectiveOllamaModel)) throw new Error(`模型 ${effectiveOllamaModel} 尚未安裝。`);
    }
    if (longTimelineMode === "manual" && !longTimeline.trim()) throw new Error("手動時間軸模式需要至少兩段分鏡。");
    const submittedDuration = normalizedLongDuration(longDuration);
    const submittedSegmentDurationHint = normalizedSegmentDurationHint(longSegmentDurationHint);
    if (longDuration !== submittedDuration) setLongDuration(submittedDuration);
    if (longSegmentDurationHint !== submittedSegmentDurationHint) setLongSegmentDurationHint(submittedSegmentDurationHint);
    setLongPlanningElapsedMs(0);
    setLongPlanning(true);
    setLongPlannerNotice(`已送出規劃要求，正在等待本機 ${plannerLabel} 回應…`);
    try {
      const response = await fetch(BRIDGE_URL + "/api/sequences/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: longTitle || "Untitled long video",
          inputType: longInputType,
          inputText: longBrief,
          inputAsset: longInputType === "image" ? selectedLongReferences[0] : undefined,
          imagePurpose: longInputType === "image" ? "first_frame" : undefined,
          referenceMode: longInputType === "image" ? longReferenceMode : "continuity",
          referenceAssets: longInputType === "image" && longReferenceMode === "multi_reference"
            ? selectedLongReferences.slice(1, MAX_LONG_REFERENCE_IMAGES)
            : [],
          timelineMode: longTimelineMode,
          duration: longTimelineMode === "auto" ? submittedDuration : undefined,
          segmentDurationHint: submittedSegmentDurationHint,
          timelineText: longTimelineMode === "manual" ? longTimeline : undefined,
          promptProvider,
          ollamaModel: effectiveOllamaModel,
          codexModel: effectiveCodexModel,
          reasoningEffort: effectiveCodexReasoningEffort,
          negativePrompt: longNegativePrompt,
        }),
      });
      let payload: { plan?: LongPlan; error?: { code?: string; message?: string } | string };
      try {
        payload = (await response.json()) as typeof payload;
      } catch {
        throw new Error(`PLAN_RESPONSE_INVALID: 規劃 API 回傳了無法解析的內容（HTTP ${response.status}）。`);
      }
      if (!response.ok || !payload.plan) {
        const code = typeof payload.error === "string" ? "PLAN_FAILED" : payload.error?.code || "PLAN_FAILED";
        const detail = typeof payload.error === "string" ? payload.error : payload.error?.message || "Long-video plan failed.";
        if (code === "OLLAMA_TIMELINE_INVALID" || code === "CODEX_TIMELINE_INVALID") throw new Error(`${code}: ${plannerLabel} 連續兩次都未產生有效的分鏡時間；請增加故事細節、調整總長或更換模型。`);
        if (code === "OLLAMA_INVALID_JSON" || code === "CODEX_INVALID_JSON") throw new Error(`${code}: ${plannerLabel} 連續兩次都未回傳有效 JSON；請重試或更換模型。`);
        throw new Error(`${code}: ${detail}`);
      }
      const plan = payload.plan;
      setLongPlan(plan);
      const plannedReferences = uniqueAssets([
        plan.inputAsset,
        ...(Array.isArray(plan.referenceAssets) ? plan.referenceAssets : []),
      ].filter((asset): asset is Asset => Boolean(asset) && asset.kind === "image"), MAX_LONG_REFERENCE_IMAGES);
      setLongReferenceMode(plan.referenceMode === "multi_reference" ? "multi_reference" : longReferenceMode);
      setLongReferenceAssets(plannedReferences);
      setLongReferenceImage(plannedReferences[0] || null);
      setLongTimeline(plan.segments.map((segment) => `[${segment.start.toFixed(3)} - ${segment.end.toFixed(3)}] ${segment.description}`).join("\n"));
      setLongDuration(plan.duration || submittedDuration);
      setLongSegmentDurationHint(plan.planningSettings?.segmentDurationHint || submittedSegmentDurationHint);
      setLongNegativePrompt(plan.negativePrompt || longNegativePrompt);
      setLongPlanDirty(false);
      setLongPlannerNotice(plan.planMeta?.repairAttempts
        ? `${plannerLabel} 第一次回覆格式不完整，系統已自動修正並完成規劃。`
        : `${plannerLabel} 已完成分鏡時間與逐段 H3 提示詞規劃。`);
      return plan;
    } catch (error) {
      setLongPlannerNotice("");
      throw error;
    } finally {
      setLongPlanning(false);
    }
  }

  async function planLongVideo() {
    setLongBusy(true);
    try {
      await requestLongPlan();
      showToast(`${promptProvider === "codex" ? "Codex CLI" : "Ollama"} 已產生分鏡時間、逐段 H3 提示詞與連續性設定。`, "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Long-video planning failed.";
      setLongError(message);
      setLongErrorDialog(longErrorDialogFrom(error instanceof Error ? error : message, "長影片規劃失敗"));
      showToast(message, "error");
    } finally {
      setLongBusy(false);
    }
  }

  async function saveLongVideo(planOverride?: LongPlan) {
    const plan = planOverride || longPlan;
    if (!plan) throw new Error("Plan the sequence before saving.");
    if (longPlanDirty && !planOverride) throw new Error(`規劃輸入已變更，請先重新執行 ${promptProvider === "codex" ? "Codex CLI" : "Ollama"} 規劃。`);
    if (!longFolder.trim()) throw new Error("Output folder is required.");
    const parsedTimes = parseLongTimelineDraft(longTimeline, plan.segments);
    const segments = parsedTimes.map((item, index) => ({
      ...(plan.segments[index] || {}),
      ...item,
      start: item.start,
      end: item.end,
      duration: item.end - item.start,
      description: item.description || plan.segments[index]?.description,
    }));
    const submittedSteps = normalizedSteps(steps);
    const submittedSeed = normalizedSeed(seed);
    if (steps !== submittedSteps) setSteps(submittedSteps);
    if (seed !== submittedSeed) setSeed(submittedSeed);
    const selectedLongReferences = currentLongReferenceSelection();
    const existing = longJob && ["draft", "ready", "interrupted", "failed"].includes(longJob.status) ? longJob : null;
    const response = await fetch(existing ? `${BRIDGE_URL}/api/sequences/${encodeURIComponent(existing.id)}` : BRIDGE_URL + "/api/sequences", {
      method: existing ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: longTitle || plan.title || "Untitled long video",
        inputType: longInputType,
        inputText: longBrief,
        inputAsset: longInputType === "image" ? selectedLongReferences[0] : undefined,
        imagePurpose: longInputType === "image" ? "first_frame" : undefined,
        referenceMode: longInputType === "image" ? longReferenceMode : "continuity",
        referenceAssets: longInputType === "image" && longReferenceMode === "multi_reference"
          ? selectedLongReferences.slice(1, MAX_LONG_REFERENCE_IMAGES)
          : [],
        continuityBible: plan.continuityBible,
        planMeta: plan.planMeta,
        planningSettings: plan.planningSettings,
        segments,
        duration: segments[segments.length - 1].end,
        outputFolder: longFolder.trim(),
        modelProfile,
        width: width === "" ? 736 : width,
        height: height === "" ? 416 : height,
        steps: submittedSteps,
        seed: submittedSeed,
        ollamaModel: effectiveOllamaModel,
        promptProvider,
        codexModel: effectiveCodexModel,
        codexReasoningEffort: effectiveCodexReasoningEffort,
        negativePrompt: longNegativePrompt,
        seam: longSeam,
        ...(existing ? { revision: existing.revision } : {}),
      }),
    });
    const payload = (await response.json()) as { job?: LongJob; error?: { code?: string; message?: string } | string };
    if (!response.ok || !payload.job) throw new Error(typeof payload.error === "string" ? payload.error : `${payload.error?.code || "SAVE_FAILED"}: ${payload.error?.message || "Unable to save long-video job."}`);
    setLongJob(payload.job);
    return payload.job;
  }

  async function startLongVideo() {
    setLongBusy(true);
    setLongError("");
    setLongErrorDialog(null);
    try {
      const plan = !longPlan || longPlanDirty ? await requestLongPlan() : longPlan;
      const saved = await saveLongVideo(plan);
      const response = await fetch(`${BRIDGE_URL}/api/sequences/${encodeURIComponent(saved.id)}/start`, { method: "POST" });
      const payload = (await response.json()) as { job?: LongJob; error?: { code?: string; message?: string } | string };
      if (!response.ok || !payload.job) throw new Error(typeof payload.error === "string" ? payload.error : `${payload.error?.code || "START_FAILED"}: ${payload.error?.message || "Unable to start long-video job."}`);
      setLongJob(payload.job);
      showToast("Long-video generation queued.", "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Long-video start failed.";
      setLongError(message);
      setLongErrorDialog(longErrorDialogFrom(error instanceof Error ? error : message, "無法開始長影片生成"));
      showToast(message, "error");
    } finally {
      setLongBusy(false);
    }
  }

  async function saveLongVideoDraft() {
    setLongBusy(true);
    setLongError("");
    try {
      await saveLongVideo();
      showToast("Long-video draft saved.", "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to save long-video draft.";
      setLongError(message);
      setLongErrorDialog(longErrorDialogFrom(error instanceof Error ? error : message, "無法保存長影片草稿"));
      showToast(message, "error");
    } finally {
      setLongBusy(false);
    }
  }

  function clearLongSettings() {
    if (longBusy || longJobActive) return;
    resetLongEditorState();
    showToast("已清除目前長影片設定。已生成的檔案與歷史工作未被刪除。", "success");
  }

  const modeLabel =
    mode === "t2v" ? "文字生片" :
        mode === "i2v" ? "參考圖生片" :
          mode === "fl2v" ? "首尾幀生片" :
          mode === "l2v" ? "尾幀生片" :
            mode === "ref2v" ? "完整參考生片" : "影片替換";
  const promptFormatLabel =
    mode === "t2v" ? "T2VA" :
      mode === "i2v" ? "I2VA" :
        mode === "fl2v" ? "FL2VA" :
          mode === "l2v" ? "L2VA" :
            mode === "ref2v" ? "Ref2VA" : "Wan Animate";
  const ollamaOnline = Boolean(health?.ollama.online);
  const codexOnline = Boolean(health?.codex?.online);
  const codexSkillAvailable = Boolean(health?.codex?.skill);
  const comfyOnline = Boolean(health?.comfy.online);
  const visibleModels = health?.ollama.models || [];
  const effectiveOllamaModel = visibleModels.includes(ollamaModel)
    ? ollamaModel
    : visibleModels[0] || ollamaModel;
  const catalogValues = new Set(promptModelCatalog.map((model) => model.value));
  const installedCatalogModels = promptModelCatalog.filter((model) => visibleModels.includes(model.value));
  const installedExtras = visibleModels
    .filter((model) => !catalogValues.has(model))
    .map((model) => ({
      value: model,
      label: model,
      note: modelSupportsPromptImages(model) ? "已安裝＋圖片" : "已安裝",
      vision: modelSupportsPromptImages(model),
    }));
  const promptModels = [...installedCatalogModels, ...installedExtras];
  const codexModelsFromHealth = health?.codex?.models || [];
  const availableCodexModels: CodexModelOption[] = codexModelsFromHealth.length
    ? codexModelsFromHealth.map((model) => ({
      value: model.value,
      label: model.label || model.value,
      note: model.note || "Codex model",
      reasoningEfforts: model.reasoningEfforts,
    }))
    : codexModelCatalog;
  const selectedCodexModel = availableCodexModels.find((model) => model.value === codexModel) || availableCodexModels[0];
  const selectedCodexReasoningEfforts = selectedCodexModel?.reasoningEfforts?.length
    ? selectedCodexModel.reasoningEfforts
    : codexReasoningOptions.map((option) => option.value);
  const availableCodexReasoningOptions = codexReasoningOptions.filter((option) => selectedCodexReasoningEfforts.includes(option.value));
  const effectiveCodexModel = selectedCodexModel?.value || codexModel;
  const effectiveCodexReasoningEffort = selectedCodexReasoningEfforts.includes(codexReasoningEffort)
    ? codexReasoningEffort
    : selectedCodexReasoningEfforts.includes("medium")
      ? "medium"
      : selectedCodexReasoningEfforts[0] || "medium";
  const longPlanningWaitHint = promptProvider === "codex" && ["max", "ultra"].includes(effectiveCodexReasoningEffort)
    ? "高推理模式可能需要數分鐘"
    : "首次載入模型可能需要 1–2 分鐘";

  useEffect(() => {
    if (!longPlanning) return undefined;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setLongPlanningElapsedMs(Date.now() - startedAt);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [longPlanning]);

  function selectCodexModel(value: string) {
    const nextModel = availableCodexModels.find((model) => model.value === value);
    setCodexModel(value);
    const supportedEfforts = nextModel?.reasoningEfforts?.length
      ? nextModel.reasoningEfforts
      : codexReasoningOptions.map((option) => option.value);
    if (!supportedEfforts.includes(effectiveCodexReasoningEffort)) {
      setCodexReasoningEffort(supportedEfforts.includes("medium") ? "medium" : supportedEfforts[0] || "medium");
    }
    if (longPlan) setLongPlanDirty(true);
  }
  const completedRenderCount = renderJobs.filter((item) =>
    ["completed", "failed", "cancelled"].includes(item.status),
  ).length;
  const progressBatchTotal = activeJob?.batchTotal || renderBatchSize;
  const progressBatchLabel = activeJob && progressBatchTotal > 1
    ? `第 ${activeJob.batchIndex || Math.min(completedRenderCount + 1, progressBatchTotal)} / ${progressBatchTotal} 部影片 · `
    : "";
  const nativeProgressLabel = activeJob?.progressSource === "native" && activeJob.nativeMaximum
    ? ` · 原生步數 ${activeJob.nativeCurrent ?? 0}/${activeJob.nativeMaximum}`
    : " · 尚未收到原生步數（目前為估算）";
  const connectionLabel = activeJob?.connectionState === "reconnecting"
    ? " · 進度連線重連中"
    : activeJob?.connectionState === "polling"
      ? " · 使用完成狀態輪詢"
      : "";
  const updateLabel = activeJob ? ` · ${progressUpdateAge(activeJob.updatedAt)}` : "";
  const progressStage = activeJob
    ? `${progressBatchLabel}Seed ${activeJob.seed ?? "—"} · ${activeJob.stage}${nativeProgressLabel}${connectionLabel}${updateLabel}`
    : outputAsset ? "完成，可在資源庫預覽" : "尚未開始生成";
  const currentStages = [
    { label: "準備輸入", done: Boolean(activeJob && activeJob.progress > 4) },
    { label: "送入 ComfyUI", done: Boolean(activeJob && activeJob.progress > 18) },
    { label: mode === "replace" ? "逐段生成與接續" : "生成影格", done: Boolean(activeJob && activeJob.progress > 48) },
    { label: "封裝 MP4", done: Boolean(activeJob && activeJob.progress > 88) },
  ];
  const longOverallProgress = Math.min(100, Math.max(0, Math.round(Number(longJob?.progress) || 0)));
  const longJobActive = Boolean(longJob && LONG_VIDEO_POLL_STATUSES.has(longJob.status));
  const inferredLongSegmentIndex = longJob?.segments.findIndex((segment) => ["queued", "rendering", "normalizing", "extracting_tail", "failed"].includes(segment.status || "")) ?? -1;
  const longActiveSegmentIndex = typeof longJob?.activeSegmentIndex === "number" ? longJob.activeSegmentIndex : inferredLongSegmentIndex;
  const longStatusLabels: Record<string, string> = {
    ready: "準備完成",
    queued: "等待執行",
    running: "生成中",
    paused: "已暫停",
    assembling: "合併片段中",
    completed: "已完成",
    failed: "生成失敗",
    cancelled: "已取消",
    interrupted: "已中斷",
  };
  const longStatusLabel = longJob ? longStatusLabels[longJob.status] || longJob.status : "尚未開始";
  const longNativeProgressLabel = longJob?.progressSource === "native" && longJob.nativeMaximum
    ? `原生步數 ${longJob.nativeCurrent ?? 0}/${longJob.nativeMaximum}`
    : "等待原生步數";
  const primaryFrameAsset = mode === "ref2v" ? referenceImages[0] || null : mode === "l2v" ? lastFrameImage : referenceImage;
  const primaryFrameInputRef = mode === "l2v" ? lastFrameInputRef : imageInputRef;
  const primaryFrameTarget = mode === "l2v" ? "lastFrame" : "image";
  const primaryFrameLabel = mode === "l2v"
      ? "尾幀圖片"
      : mode === "fl2v"
        ? "首幀圖片"
        : mode === "ref2v"
          ? `參考圖片（Picture 1 · 最多 ${MAX_REF2V_IMAGES} 張）`
        : mode === "replace"
          ? "替換人物參考圖"
        : "參考圖片（可選）";

  const upscaleActive = Boolean(upscaleJob && UPSCALE_POLL_STATUSES.has(upscaleJob.status));
  const upscaleProgress = Math.min(100, Math.max(0, Math.round(Number(upscaleJob?.progress) || 0)));
  const upscaleStatusLabel = upscaleJob
    ? `${upscaleJob.status === "completed" ? "已完成" : upscaleJob.status === "failed" ? "升頻失敗" : upscaleJob.status === "cancelled" ? "已取消" : upscaleJob.status === "running" ? "正在升頻" : "等待處理"}${upscaleJob.stage ? ` · ${upscaleJob.stage}` : ""}`
    : "尚未開始升頻";
  const upscaleSubmitDisabled = !upscaleSource || upscaleUploading || upscaleSubmitting || upscaleActive;
  const img2imgActive = Boolean(img2imgJob && IMG2IMG_POLL_STATUSES.has(img2imgJob.status));
  const img2imgProgress = Math.min(100, Math.max(0, Math.round(Number(img2imgJob?.progress) || 0)));
  const img2imgStatusLabel = img2imgJob
    ? `${img2imgJob.status === "completed" ? "已完成" : img2imgJob.status === "failed" ? "生成失敗" : img2imgJob.status === "cancelled" ? "已取消" : img2imgJob.status === "running" ? "正在生成" : "等待處理"}${img2imgJob.stage ? ` · ${img2imgJob.stage}` : ""}`
    : "尚未開始生成";
  const img2imgSubmitDisabled = !img2imgSource || !img2imgPrompt.trim() || img2imgUploading || img2imgSubmitting || img2imgActive;
  const runtimeMode = health?.runtime?.mode || (health?.comfy.remote ? "remote" : "local");
  const runtimeSwitchDisabled = runtimeSwitchBusy || renderBusy || renderSubmitting || longBusy || longJobActive || upscaleSubmitting || upscaleActive || img2imgSubmitting || img2imgActive;

  return (
    <main className="studio-shell">
      <aside className="side-nav">
        <div className="brand-lockup">
          <div className="brand-mark">
            <span />
            <span />
            <span />
          </div>
          <div>
            <div className="brand-name">H3 STUDIO</div>
          </div>
        </div>

        <div className="nav-block">
          <div className="nav-heading">工作區</div>
          <nav aria-label="主選單">
            {navItems.map((item) => (
              <button
                type="button"
                className={"nav-item " + (activeNav === item.target ? "is-active" : "")}
                key={item.label}
                onClick={() => navigateToSection(item.target)}
              >
                <Icon name={item.icon} />
                <span>{item.label}</span>
                {activeNav === item.target && <span className="nav-active-dot" />}
              </button>
            ))}
          </nav>
        </div>

        <div className="side-note">
          <div className="side-note-icon">
            <Icon name="bolt" />
          </div>
          <div>
            <strong>本機儲存</strong>
            <p>提示詞、輸入檔與輸出影片都保留在本機。</p>
          </div>
        </div>

        <div className="side-footer">
          <div className="system-mini">
            <span className={"status-dot " + (bridgeOnline ? "is-on" : "is-off")} />
            <span>{bridgeOnline ? "API ready" : "API offline"}</span>
          </div>
          <div className="version-label">H3 Studio / 0.1</div>
        </div>
      </aside>

      <section className="app-main">
        <header className="top-bar">
          <div className="breadcrumb">
            <span className="muted">LOCAL /</span>
            <span>工作台</span>
          </div>
          <div className="top-actions">
            <div className="studio-mode-toggle" role="group" aria-label="Render mode">
              <button type="button" className={studioMode === "single" ? "is-active" : ""} onClick={() => setStudioMode("single")}>單片</button>
              <button type="button" className={studioMode === "long" ? "is-active" : ""} onClick={() => setStudioMode("long")}>長影片</button>
            </div>
            <button
              type="button"
              className="top-link"
              onClick={() => void refreshAll()}
              title="重新整理本機服務狀態"
            >
              <Icon name="refresh" /> 重新整理
            </button>
            <div className="connection-pill">
              <span className={"status-dot " + (ollamaOnline ? "is-on" : "is-off")} />
              <span>Ollama</span>
              <span className="connection-state">{ollamaOnline ? "online" : "offline"}</span>
            </div>
            <div className="connection-pill">
              <span className={"status-dot " + (codexOnline && codexSkillAvailable ? "is-on" : "is-off")} />
              <span>Codex CLI</span>
              <span className="connection-state">{codexOnline && codexSkillAvailable ? "ready" : "offline"}</span>
            </div>
            <div className="connection-pill">
              <span className={"status-dot " + (comfyOnline ? "is-on" : "is-off")} />
              <span>ComfyUI</span>
              <span className="connection-state">{comfyOnline ? "online" : "offline"}</span>
            </div>
          </div>
        </header>

        <div className={"workspace " + (studioMode === "long" ? "is-long-mode" : "")} id="workspace">
          <section className="hero-row">
            <div>
              <div className="eyebrow">
                <span className="eyebrow-line" />
              </div>
              <h1>
                輸入提示詞，
                <br />
                生成影片<span className="lime-dot">。</span>
              </h1>
              <p className="hero-copy">
                Ollama 可協助整理提示詞；影片由本機 MiniMax H3 生成。
              </p>
            </div>
            <div className="system-card">
              <div className="system-card-top">
                <span className="section-code">SYSTEM STATUS / 01</span>
                <span className={"live-label " + (bridgeOnline ? "is-live" : "")}>
                  <span className="status-dot" />
                  {bridgeOnline ? "LIVE" : "WAITING"}
                </span>
              </div>
              <div className="system-stat-row">
                <div>
                  <span className="stat-label">PROMPT ENGINE</span>
                  <strong>{promptProvider === "codex"
                    ? (codexOnline && codexSkillAvailable ? "Codex CLI ready" : "等待 Codex CLI")
                    : (ollamaOnline ? "Ollama ready" : "等待 Ollama")}</strong>
                </div>
                <div>
                  <span className="stat-label">VIDEO ENGINE</span>
                  <strong>{comfyOnline ? "ComfyUI ready" : "等待 ComfyUI"}</strong>
                </div>
              </div>
              <div className="system-path">
                <span className="status-dot is-on" />
                <span>{health?.paths.comfyRoot || "ComfyUI"}</span>
              </div>
            </div>
          </section>

          <section className="panel upscale-panel" id="video-upscale" aria-labelledby="video-upscale-title">
            <div className="panel-heading upscale-heading">
              <div>
                <span className="section-code">VIDEO UPSCALE / SEEDVR2</span>
                <h2 id="video-upscale-title">影片升頻</h2>
                <p className="upscale-intro">選擇影片後，以 SeedVR2 3B Int8 執行 2× 解析度提升。</p>
              </div>
              <span className="panel-mark panel-mark-number">2×</span>
            </div>

            <div className="upscale-grid">
              <div className="upscale-source-card">
                <div className="slot-topline">
                  <span className="field-label">來源影片</span>
                  <span className="slot-hint">VIDEO</span>
                </div>
                {upscaleSource ? (
                  <div className="upscale-selected-media">
                    <video src={assetUrl(upscaleSource)} controls playsInline preload="metadata">
                      <track kind="captions" />
                    </video>
                    <div className="upscale-selected-info">
                      <strong title={upscaleSource.name}>{upscaleSource.name}</strong>
                      <span>{formatBytes(upscaleSource.size)} · {upscaleSource.root.toUpperCase()}</span>
                      <button type="button" className="upscale-clear-button" onClick={() => { setUpscaleSource(null); setUpscaleError(""); }}>
                        移除來源
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="upscale-upload-zone">
                    <Icon name="video" />
                    <strong>選擇或上傳影片</strong>
                    <span>MP4、MOV、WEBM 等影片格式</span>
                    <button
                      type="button"
                      className="upscale-file-label"
                      onClick={() => upscaleInputRef.current?.click()}
                      disabled={upscaleUploading}
                      aria-label="選擇影片檔案"
                      aria-controls="upscale-video-input"
                      aria-describedby="upscale-source-help"
                    >
                      <Icon name="upload" /> 選擇影片
                    </button>
                    <input
                      id="upscale-video-input"
                      ref={upscaleInputRef}
                      type="file"
                      accept="video/*"
                      hidden
                      onChange={(event) => onFileChange(event, "upscale")}
                    />
                    <small id="upscale-source-help">也可以從下方資產庫影片的預覽視窗選取。</small>
                  </div>
                )}
              </div>

              <div className="upscale-control-card">
                <div className="upscale-model-summary">
                  <div>
                    <span className="section-code">UPSCALE PROFILE</span>
                    <strong>SeedVR2 3B Int8</strong>
                  </div>
                  <span className="upscale-scale-badge">2×</span>
                </div>
                <p className="upscale-model-copy">保留原始影片時間軸與音訊，將畫面提升至 2× 解析度。</p>
                <button
                  type="button"
                  className="upscale-submit-button"
                  onClick={() => void startUpscale()}
                  disabled={upscaleSubmitDisabled}
                  aria-busy={upscaleSubmitting || upscaleUploading}
                >
                  <Icon name="spark" />
                  {upscaleUploading ? "上傳影片中…" : upscaleSubmitting ? "正在排程…" : upscaleActive ? "升頻處理中…" : "開始 2× 升頻"}
                </button>
                <div className="upscale-status" aria-live="polite">
                  <div className="upscale-status-line">
                    <span className={"status-dot " + (upscaleActive ? "is-on" : upscaleJob?.status === "failed" ? "is-error" : "")} />
                    <span>{upscaleStatusLabel}</span>
                    {upscaleJob && <strong>{upscaleProgress}%</strong>}
                  </div>
                  {upscaleJob && (
                    <div
                      className="upscale-progress-track"
                      role="progressbar"
                      aria-label="SeedVR2 升頻進度"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={upscaleProgress}
                      aria-valuetext={`${upscaleProgress}%`}
                    >
                      <span style={{ width: `${upscaleProgress}%` }} />
                    </div>
                  )}
                </div>
                {upscaleError && <p className="upscale-error" role="alert">{upscaleError}</p>}
              </div>
            </div>

            {upscaleJob?.status === "completed" && upscaleJob.output && (
              <div className="upscale-result-card" aria-live="polite">
                <div className="upscale-result-heading">
                  <div>
                    <span className="section-code">UPSCALE RESULT</span>
                    <strong>{upscaleJob.output.name}</strong>
                  </div>
                  <span className="upscale-result-status">完成 · 2×</span>
                </div>
                <video className="upscale-result-video" src={assetUrl(upscaleJob.output)} controls playsInline preload="metadata">
                  <track kind="captions" />
                </video>
                <div className="upscale-result-actions">
                  <button type="button" className="preview-use-button" onClick={() => openAssetPreview(upscaleJob.output as Asset)}>
                    <Icon name="play" /> 預覽結果
                  </button>
                  <a className="outline-button preview-download-button" href={assetDownloadUrl(upscaleJob.output)} download={assetFileName(upscaleJob.output)}>
                    <Icon name="download" /> 下載升頻結果
                  </a>
                </div>
              </div>
            )}
          </section>

          <section className="panel upscale-panel img2img-panel" id="image-to-image" aria-labelledby="image-to-image-title">
            <div className="panel-heading upscale-heading">
              <div>
                <span className="section-code">IMAGE TO IMAGE / COMFYUI</span>
                <h2 id="image-to-image-title">以圖生圖</h2>
                <p className="upscale-intro">使用目前選擇的本機或 Vast ComfyUI，保留來源構圖並依提示詞重新繪製。</p>
              </div>
              <span className="panel-mark panel-mark-number">I2I</span>
            </div>

            <div className="upscale-grid img2img-grid">
              <div className="upscale-source-card">
                <div className="slot-topline">
                  <span className="field-label">來源圖片</span>
                  <span className="slot-hint">IMAGE</span>
                </div>
                {img2imgSource ? (
                  <div className="upscale-selected-media img2img-selected-media">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={assetUrl(img2imgSource)} alt={`以圖生圖來源：${img2imgSource.name}`} />
                    <div className="upscale-selected-info">
                      <strong title={img2imgSource.name}>{img2imgSource.name}</strong>
                      <span>{formatBytes(img2imgSource.size)} · {img2imgSource.root.toUpperCase()}</span>
                      <button
                        type="button"
                        className="upscale-clear-button"
                        onClick={() => { setImg2ImgSource(null); setImg2ImgJob(null); setImg2ImgError(""); }}
                      >
                        移除來源
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="upscale-upload-zone">
                    <Icon name="image" />
                    <strong>選擇或上傳圖片</strong>
                    <span>PNG、JPG、WEBP</span>
                    <button
                      type="button"
                      className="upscale-file-label"
                      onClick={() => img2imgInputRef.current?.click()}
                      disabled={img2imgUploading}
                      aria-label="選擇以圖生圖來源圖片"
                      aria-controls="img2img-image-input"
                      aria-describedby="img2img-source-help"
                    >
                      <Icon name="upload" /> {img2imgUploading ? "上傳中…" : "選擇圖片"}
                    </button>
                    <input
                      id="img2img-image-input"
                      ref={img2imgInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      hidden
                      onChange={(event) => onFileChange(event, "img2img")}
                    />
                    <small id="img2img-source-help">也能從下方素材庫選取輸入或輸出圖片。</small>
                  </div>
                )}
              </div>

              <div className="upscale-control-card img2img-control-card">
                <div className="upscale-model-summary">
                  <div>
                    <span className="section-code">COMFYUI CHECKPOINT</span>
                    <strong>{runtimeMode === "remote" ? "Vast RTX 5090" : "本機 GPU"}</strong>
                  </div>
                  <span className="upscale-scale-badge">{runtimeMode === "remote" ? "REMOTE" : "LOCAL"}</span>
                </div>

                <div className="img2img-form">
                  <label className="img2img-field" htmlFor="img2img-model">
                    <span>模型</span>
                    <select id="img2img-model" value={img2imgModel} onChange={(event) => updateImg2ImgModel(event.target.value)} disabled={img2imgActive}>
                      {IMG2IMG_MODELS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                    <small>{IMG2IMG_MODELS.find((option) => option.value === img2imgModel)?.note}</small>
                  </label>

                  <label className="img2img-field" htmlFor="img2img-prompt">
                    <span>正向提示詞</span>
                    <textarea
                      id="img2img-prompt"
                      value={img2imgPrompt}
                      onChange={(event) => { setImg2ImgPrompt(event.target.value); if (img2imgError) setImg2ImgError(""); }}
                      placeholder="例如：cinematic portrait, soft window light, detailed skin texture"
                      maxLength={4000}
                      rows={4}
                      aria-invalid={Boolean(img2imgError && !img2imgPrompt.trim())}
                      aria-describedby="img2img-prompt-help"
                    />
                    <small id="img2img-prompt-help">描述希望結果呈現的主體、風格、光線與細節。</small>
                  </label>

                  <label className="img2img-field" htmlFor="img2img-negative-prompt">
                    <span>負向提示詞（可選）</span>
                    <textarea
                      id="img2img-negative-prompt"
                      value={img2imgNegativePrompt}
                      onChange={(event) => setImg2ImgNegativePrompt(event.target.value)}
                      placeholder="例如：blurry, low quality, artifacts"
                      maxLength={4000}
                      rows={2}
                    />
                  </label>

                  <div className="img2img-settings-grid">
                    <label className="img2img-field" htmlFor="img2img-denoise">
                      <span>重繪強度 <strong>{img2imgDenoise.toFixed(2)}</strong></span>
                      <input
                        id="img2img-denoise"
                        type="range"
                        min="0.01"
                        max="1"
                        step="0.01"
                        value={img2imgDenoise}
                        onChange={(event) => setImg2ImgDenoise(Number(event.target.value))}
                      />
                      <small>越高越偏離原圖；0.45–0.70 通常較平衡。</small>
                    </label>
                    <label className="img2img-field" htmlFor="img2img-steps">
                      <span>Steps</span>
                      <input id="img2img-steps" type="number" min="1" max="50" value={img2imgSteps} onChange={(event) => setImg2ImgSteps(Math.min(50, Math.max(1, Number(event.target.value) || 1)))} />
                    </label>
                    <label className="img2img-field" htmlFor="img2img-cfg">
                      <span>CFG</span>
                      <input id="img2img-cfg" type="number" min="0" max="20" step="0.5" value={img2imgCfg} onChange={(event) => setImg2ImgCfg(Math.min(20, Math.max(0, Number(event.target.value) || 0)))} />
                    </label>
                    <label className="img2img-field" htmlFor="img2img-seed">
                      <span>Seed</span>
                      <input id="img2img-seed" type="number" min="0" max="2147483647" value={img2imgSeed} onChange={(event) => setImg2ImgSeed(Math.min(2147483647, Math.max(0, Number(event.target.value) || 0)))} />
                    </label>
                  </div>

                  <div className="img2img-seed-actions">
                    <button type="button" className="outline-button small-button" onClick={() => setImg2ImgSeed(Math.floor(Math.random() * 2147483648))} disabled={img2imgActive}>
                      隨機 Seed
                    </button>
                  </div>
                </div>

                <button
                  type="button"
                  className="upscale-submit-button"
                  onClick={() => void startImg2Img()}
                  disabled={img2imgSubmitDisabled}
                  aria-busy={img2imgSubmitting || img2imgUploading}
                >
                  <Icon name="spark" />
                  {img2imgUploading ? "上傳圖片中…" : img2imgSubmitting ? "正在排程…" : img2imgActive ? "圖片生成中…" : "開始以圖生圖"}
                </button>

                <div className="upscale-status" aria-live="polite">
                  <div className="upscale-status-line">
                    <span className={`status-dot ${img2imgActive ? "is-on" : img2imgJob?.status === "failed" ? "is-error" : ""}`} />
                    <span>{img2imgStatusLabel}</span>
                    {img2imgJob && <strong>{img2imgProgress}%</strong>}
                  </div>
                  {img2imgJob && (
                    <div
                      className="upscale-progress-track"
                      role="progressbar"
                      aria-label="以圖生圖進度"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={img2imgProgress}
                      aria-valuetext={`${img2imgProgress}%`}
                    >
                      <span style={{ width: `${img2imgProgress}%` }} />
                    </div>
                  )}
                </div>
                {img2imgError && <p className="upscale-error" role="alert">{img2imgError}</p>}
              </div>
            </div>

            {img2imgJob?.status === "completed" && img2imgJob.output && (
              <div className="upscale-result-card img2img-result-card" aria-live="polite">
                <div className="upscale-result-heading">
                  <div>
                    <span className="section-code">IMAGE RESULT</span>
                    <strong>{img2imgJob.output.name}</strong>
                  </div>
                  <span className="upscale-result-status">完成 · {img2imgJob.model.startsWith("sd_xl") ? "SDXL" : "SD 1.5"}</span>
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="img2img-result-image" src={assetUrl(img2imgJob.output)} alt={`以圖生圖結果：${img2imgJob.output.name}`} />
                <div className="upscale-result-actions">
                  <button type="button" className="preview-use-button" onClick={() => openAssetPreview(img2imgJob.output as Asset)}>
                    <Icon name="image" /> 預覽結果
                  </button>
                  <button type="button" className="preview-reference-button" onClick={() => selectAssetForImg2Img(img2imgJob.output as Asset)}>
                    再次重繪
                  </button>
                  <a className="outline-button preview-download-button" href={assetDownloadUrl(img2imgJob.output)} download={assetFileName(img2imgJob.output)}>
                    <Icon name="download" /> 下載圖片
                  </a>
                </div>
              </div>
            )}
          </section>

          <section className={"panel long-video-panel " + (studioMode === "long" ? "is-visible" : "is-hidden")} id="long-video" aria-labelledby="long-video-title">
            <div className="panel-heading">
              <div>
                <span className="section-code">LONG / PROMPT STORYBOARD LAB</span>
                <h2 id="long-video-title">長片提示詞與分鏡規劃</h2>
              </div>
              <div className="long-heading-actions">
                <button type="button" className="outline-button small-button long-clear-button" onClick={clearLongSettings} disabled={longBusy || longJobActive} aria-label="清除目前長影片設定">清除目前設定</button>
                <span className="panel-mark panel-mark-number">SEQ</span>
              </div>
            </div>
            <p className="long-intro">輸入完整故事方向後，{promptProvider === "codex" ? "Codex CLI" : "Ollama"} 會一次產生全片負面提示詞、連續性設定、分鏡時間，以及首段 T2VA／續段 I2VA 的 H3 提示詞。所有輸出都能在生成前修改。</p>
            <div className="long-video-grid">
              <label className="setting-field"><span className="field-label">標題</span><input className="text-input long-title-input" value={longTitle} onChange={(event) => setLongTitle(event.target.value)} placeholder="兩段式故事" /></label>
              <label className="setting-field"><span className="field-label">輸出資料夾</span><input className="text-input long-title-input" value={longFolder} onChange={(event) => setLongFolder(event.target.value)} placeholder="my-sequence-001" /></label>
            </div>
            <div className="long-input-switch" role="group" aria-label="Long-video input type">
              <button type="button" className={longInputType === "text" ? "is-active" : ""} onClick={() => { if (longInputType !== "text" && longPlan) setLongPlanDirty(true); setLongInputType("text"); }}>文字起點</button>
              <button type="button" className={longInputType === "image" ? "is-active" : ""} onClick={() => { if (longInputType !== "image" && longPlan) setLongPlanDirty(true); setLongInputType("image"); }}>圖片起點 / first_frame</button>
            </div>
            {longInputType === "image" && (
              <div className="long-reference-settings">
                <fieldset className="long-reference-mode-fieldset">
                  <legend>參考模式</legend>
                  <label htmlFor="long-reference-continuity">
                    <input
                      id="long-reference-continuity"
                      type="radio"
                      name="long-reference-mode"
                      value="continuity"
                      checked={longReferenceMode === "continuity"}
                      onChange={() => updateLongReferenceMode("continuity")}
                    />
                    連續首幀（單圖）
                    <span><small>第 0.00 秒鎖定這張圖片。</small></span>
                  </label>
                  <label htmlFor="long-reference-multi">
                    <input
                      id="long-reference-multi"
                      type="radio"
                      name="long-reference-mode"
                      value="multi_reference"
                      checked={longReferenceMode === "multi_reference"}
                      onChange={() => updateLongReferenceMode("multi_reference")}
                    />
                    多參考（最多 {MAX_LONG_REFERENCE_IMAGES} 張）
                    <span><small>用於角色、服裝與風格一致性。</small></span>
                  </label>
                </fieldset>
                {longReferenceMode === "multi_reference" ? (
                  <div className="long-multi-reference-picker">
                    {longReferenceAssets.length > 0 && (
                      <div className="multi-reference-grid" aria-label="已選取的長片參考圖片">
                        {longReferenceAssets.map((asset, index) => (
                          <div className="multi-reference-item" key={assetKey(asset)}>
                            <AssetThumb asset={asset} />
                            <span className="multi-reference-index">{index + 1}</span>
                            <button
                              type="button"
                              className="multi-reference-remove"
                              onClick={() => removeLongReference(asset)}
                              aria-label={`從長片參考選取移除 ${asset.name}`}
                            >
                              <Icon name="close" />
                            </button>
                            <small title={asset.name}>{asset.name}</small>
                          </div>
                        ))}
                      </div>
                    )}
                    <button
                      type="button"
                      className="outline-button small-button"
                      onClick={() => longImageInputRef.current?.click()}
                      disabled={longReferenceAssets.length >= MAX_LONG_REFERENCE_IMAGES}
                    >
                      <Icon name="image" /> 新增長片參考圖片
                    </button>
                    <p className="long-reference-warning" aria-live="polite">多參考會將前段尾幀作下一段 reference，能維持人物／風格但不保證 frame0 鎖定。已選 {longReferenceAssets.length} / {MAX_LONG_REFERENCE_IMAGES} 張。</p>
                  </div>
                ) : (
                  <div className="long-first-frame-row">
                    <span className="field-label">first_frame 參考圖</span>
                    {longReferenceImage?.kind === "image" ? <><span className="long-reference-name">{longReferenceImage.name}</span><button type="button" className="outline-button small-button" onClick={() => longImageInputRef.current?.click()}>更換圖片</button></> : <button type="button" className="outline-button small-button" onClick={() => longImageInputRef.current?.click()}>選擇圖片資產</button>}
                    <small>圖片是第 0.00 秒首幀；下方文字會送給目前選擇的 {promptProvider === "codex" ? "Codex CLI" : "Ollama"} 作為故事與動作方向。</small>
                  </div>
                )}
                <input
                  ref={longImageInputRef}
                  type="file"
                  accept="image/*"
                  multiple={longReferenceMode === "multi_reference"}
                  hidden
                  onChange={(event) => onFileChange(event, "image")}
                />
              </div>
            )}
            <div className="long-prompt-grid">
              <label className="setting-field long-prompt-field" htmlFor="long-video-prompt">
                <span className="field-label">整體提示詞／故事描述 <span>輸入給 {promptProvider === "codex" ? "Codex CLI" : "Ollama"}</span></span>
                <textarea id="long-video-prompt" className="text-input long-brief-input" value={longBrief} onChange={(event) => { setLongBrief(event.target.value); if (longPlan) setLongPlanDirty(true); }} placeholder="例如：一名紅衣女子在雨夜追逐最後一班列車；描述角色、場景、情節、鏡頭、對話與聲音方向。" />
              </label>
              <label className="setting-field long-prompt-field" htmlFor="long-video-negative-prompt">
                <span className="field-label">負面提示詞／限制 <span>空白時由 {promptProvider === "codex" ? "Codex CLI" : "Ollama"} 補齊</span></span>
                <textarea id="long-video-negative-prompt" className="text-input long-negative-input" value={longNegativePrompt} onChange={(event) => setLongNegativePrompt(event.target.value)} placeholder="例如：角色漂移、服裝改變、閃爍、文字、浮水印…" />
              </label>
            </div>
            <div className="long-planner-toolbar">
              <div className="prompt-provider-switch long-provider-switch" role="group" aria-label="長影片規劃生成來源">
                <button type="button" className={promptProvider === "ollama" ? "is-active" : ""} onClick={() => { setPromptProvider("ollama"); if (longPlan) setLongPlanDirty(true); }}><span className="ollama-badge">O</span> Ollama</button>
                <button type="button" className={promptProvider === "codex" ? "is-active" : ""} onClick={() => { setPromptProvider("codex"); if (longPlan) setLongPlanDirty(true); }}><span className="codex-badge">C</span> Codex CLI</button>
              </div>
              {promptProvider === "codex" ? (
                <div className="prompt-provider-fields long-codex-fields">
                  <span className="codex-badge">C</span>
                  <select className="select-input codex-model-select" value={effectiveCodexModel} onChange={(event) => selectCodexModel(event.target.value)} aria-label="長影片 Codex CLI 模型">
                    {availableCodexModels.map((model) => <option key={model.value} value={model.value}>{model.label} · {model.note}</option>)}
                  </select>
                  <label className="codex-reasoning-select"><span>Reasoning</span><select className="select-input" value={effectiveCodexReasoningEffort} onChange={(event) => { setCodexReasoningEffort(event.target.value); if (longPlan) setLongPlanDirty(true); }} aria-label="長影片 Codex CLI 推理程度">
                    {availableCodexReasoningOptions.map((option) => <option key={option.value} value={option.value}>{option.label} · {option.note}</option>)}
                  </select></label>
                </div>
              ) : (
                <div className="ollama-select long-ollama-select">
                  <span className="ollama-badge">O</span>
                  <select value={effectiveOllamaModel} onChange={(event) => { setOllamaModel(event.target.value); if (longPlan) setLongPlanDirty(true); }} aria-label="長影片 Ollama 模型">
                    {promptModels.map((model) => {
                      const isInstalled = visibleModels.includes(model.value);
                      const status = ollamaOnline ? (isInstalled ? "已安裝" : "未安裝") : "待檢查";
                      return <option key={model.value} value={model.value}>{model.label} · {model.note} · {status}</option>;
                    })}
                  </select>
                </div>
              )}
              <button type="button" className="outline-button long-plan-button" onClick={() => void planLongVideo()} disabled={longBusy}>
                <Icon name="spark" />
                {longPlanning ? `${promptProvider === "codex" ? "Codex CLI" : "Ollama"} 規劃中…` : longBusy ? "處理中…" : `用 ${promptProvider === "codex" ? "Codex CLI" : "Ollama"} 產生分鏡時間與 H3 提示詞`}
              </button>
            </div>
            <div
              className={`long-planner-feedback ${longPlanning ? "is-working" : longError ? "is-error" : longPlanDirty && longPlan ? "is-stale" : longPlannerNotice ? "is-ready" : "is-idle"}`}
              role={longError ? "alert" : "status"}
              aria-live="polite"
            >
              <span className="long-planner-feedback-dot" aria-hidden="true" />
              <span>{longPlanning
                ? `正在等待本機 ${promptProvider === "codex" ? "Codex CLI" : "Ollama"}；${longPlanningWaitHint}（已等待 ${Math.floor(longPlanningElapsedMs / 1000)} 秒），完成前請不要重複點擊。若第一次格式不合規，系統會自動修正一次。`
                : longError
                  ? longError
                  : longPlanDirty && longPlan
                    ? `規劃輸入已變更，請重新執行 ${promptProvider === "codex" ? "Codex CLI" : "Ollama"} 規劃。`
                    : longPlannerNotice || "填寫整體提示詞後按下規劃；進度、成功或錯誤會持續顯示在這裡。"}</span>
            </div>

            <div className="long-subsection-heading">
              <div><span className="section-code">01 / STORYBOARD TIMING</span><h3>分鏡時間產生方式</h3></div>
              <div className="long-input-switch" role="group" aria-label="分鏡時間產生方式">
                <button type="button" className={longTimelineMode === "auto" ? "is-active" : ""} onClick={() => { if (longTimelineMode !== "auto" && longPlan) setLongPlanDirty(true); setLongTimelineMode("auto"); }}>{promptProvider === "codex" ? "Codex CLI" : "Ollama"} 自動分鏡</button>
                <button type="button" className={longTimelineMode === "manual" ? "is-active" : ""} onClick={() => { if (longTimelineMode !== "manual" && longPlan) setLongPlanDirty(true); setLongTimelineMode("manual"); }}>手動鎖定時間</button>
              </div>
            </div>
            <p className="long-source-note">{longTimelineMode === "auto" ? `${promptProvider === "codex" ? "Codex CLI" : "Ollama"} 會決定敘事切點；後端仍會驗證從 0 秒開始、無空白、無重疊，且結束時間等於總長。` : `你提供的時間軸是權威資料；${promptProvider === "codex" ? "Codex CLI" : "Ollama"} 只補足每段語意與 H3 提示詞，不會改寫時間。`}</p>
            {longTimelineMode === "auto" && (
              <div className="long-planning-settings">
                <label className="setting-field"><span className="field-label">目標總長（秒）</span><input className="number-input" type="number" min="1" max="3600" step="0.5" value={longDuration} onChange={(event) => { setLongDuration(numberInputDraft(event.target.value)); if (longPlan) setLongPlanDirty(true); }} /></label>
                <label className="setting-field"><span className="field-label">目標單段長度（秒） <span>模型可依劇情微調</span></span><input className="number-input" type="number" min="0.5" max="60" step="0.5" value={longSegmentDurationHint} onChange={(event) => { setLongSegmentDurationHint(numberInputDraft(event.target.value)); if (longPlan) setLongPlanDirty(true); }} /></label>
              </div>
            )}
            <div className="long-timeline-grid">
              <label className="setting-field" htmlFor="long-video-timeline"><span className="field-label">{longTimelineMode === "auto" ? `${promptProvider === "codex" ? "Codex CLI" : "Ollama"} 分鏡時間輸出` : "手動分鏡時間"} <span>產出後可編輯</span></span><textarea id="long-video-timeline" className="text-input long-timeline-input" value={longTimeline} onChange={(event) => updateLongTimelineDraft(event.target.value)} placeholder={longTimelineMode === "auto" ? `按上方按鈕後，${promptProvider === "codex" ? "Codex CLI" : "Ollama"} 產出的全片分鏡時間會顯示在這裡。` : '[00:00.000 - 00:05.000] 開場\n[00:05.000 - 00:10.000] 延續'} /></label>
              <div className="long-bible-card"><span className="field-label">Continuity bible <span>{promptProvider === "codex" ? "Codex CLI" : "Ollama"} 輸出</span></span>{longPlan?.continuityBible ? <pre>{JSON.stringify(longPlan.continuityBible, null, 2)}</pre> : <p>尚未規劃。產出後會列出風格、角色、環境、燈光、鏡頭、聲音與必須維持／避免的項目。</p>}</div>
            </div>
            <div className={"long-plan-status " + (longPlanDirty ? "is-stale" : longPlan ? "is-ready" : "is-empty")}>
              {longPlan ? (
                <>
                  <strong>{longPlanDirty ? "規劃輸入已變更，請重新產生" : `${promptProvider === "codex" ? "Codex CLI" : "Ollama"} 規劃已完成`}</strong>
                  <span>時間來源：{longPlan.planMeta?.timelineSource === "author" ? "手動鎖定" : longPlan.planMeta?.timelineSource === "codex" ? "Codex CLI" : "Ollama"}</span>
                  <span>{longPlan.segments.length} 段 · {(longPlan.duration || 0).toFixed(2)} 秒</span>
                  <span>提示詞：{longPlan.planMeta?.promptSource === "ollama" || longPlan.planMeta?.promptSource === "codex" ? `${longPlan.planMeta?.promptSource === "codex" ? "Codex CLI" : "Ollama"} 完整格式` : `${longPlan.planMeta?.promptSource?.startsWith("codex") ? "Codex CLI" : "Ollama"} 內容＋伺服器格式化`}</span>
                  {longPlan.planMeta?.generatedAt && <span>{formatTime(longPlan.planMeta.generatedAt)}</span>}
                </>
              ) : <span>尚未呼叫 {promptProvider === "codex" ? "Codex CLI" : "Ollama"}；下方不會用預設文字假裝成模型輸出。</span>}
            </div>

            <div className="long-subsection-heading long-render-heading">
              <div><span className="section-code">02 / H3 RENDER SETUP</span><h3>本機生成設定</h3></div>
              <p>Profile、解析度、Steps、Seed 與接縫是執行參數，不由 Ollama 擅自覆寫。</p>
            </div>
            <div className="long-settings-row">
              <label className="setting-field"><span className="field-label">H3 profile</span><select className="select-input" value={modelProfile} onChange={(event) => setModelProfile(event.target.value)}>{modelOptions.filter((item) => item.value !== "wan22_animate_fp8").map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label>
              <label className="setting-field"><span className="field-label">寬度</span><input className="number-input" type="number" min="32" max="2048" step="32" value={width} onChange={(event) => setWidth(event.target.value === "" ? "" : Number(event.target.value))} /></label>
              <label className="setting-field"><span className="field-label">高度</span><input className="number-input" type="number" min="32" max="2048" step="32" value={height} onChange={(event) => setHeight(event.target.value === "" ? "" : Number(event.target.value))} /></label>
              <label className="setting-field"><span className="field-label">Steps</span><input className="number-input" type="number" min="1" max="80" value={steps} onChange={(event) => setSteps(numberInputDraft(event.target.value))} /></label>
              <label className="setting-field seed-field"><span className="field-label">Seed</span><div className="seed-input"><input className="number-input" type="number" min="0" max="2147483647" value={seed} onChange={(event) => setSeed(numberInputDraft(event.target.value))} /><button type="button" onClick={randomizeSeed} aria-label="隨機產生 Seed" title="隨機產生 Seed">隨機</button></div></label>
              <label className="setting-field"><span className="field-label">Seam</span><select className="select-input" value={longSeam} onChange={(event) => setLongSeam(event.target.value as typeof longSeam)}><option value="keep_duplicate_frame">Keep duplicate frame</option><option value="drop_next_first_frame" disabled>Drop next first frame (unsupported)</option></select></label>
            </div>

            {longJob && (
              <section className={`long-render-progress is-${longJob.status}`} aria-label="長影片生成進度">
                <div className="long-render-progress-heading">
                  <div>
                    <span className="section-code">LONG RENDER PROGRESS</span>
                    <h3>{longStatusLabel}</h3>
                  </div>
                  <strong>{longOverallProgress}%</strong>
                </div>
                <div
                  className="long-progress-track"
                  role="progressbar"
                  aria-label="長影片整體生成進度"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={longOverallProgress}
                >
                  <span style={{ width: `${longOverallProgress}%` }} />
                </div>
                <div className="long-progress-current" aria-live="polite">
                  <span>{longActiveSegmentIndex >= 0 ? `第 ${longActiveSegmentIndex + 1} / ${longJob.segments.length} 段` : "全片處理"}</span>
                  <strong>{longStageLabel(longJob)}</strong>
                  <small>{longNativeProgressLabel} · {progressUpdateAge(longJob.updatedAt)}</small>
                </div>
                <div className="long-progress-segments">
                  {longJob.segments.map((segment, index) => {
                    const segmentProgress = segment.status === "completed"
                      ? 100
                      : index === longActiveSegmentIndex
                        ? Math.min(100, Math.max(0, Math.round(Number(segment.progress ?? longJob.segmentProgress) || 0)))
                        : 0;
                    return (
                      <div className={`long-progress-segment is-${segment.status || "pending"}`} key={segment.id || index}>
                        <div className="long-progress-segment-label">
                          <span>第 {index + 1} 段</span>
                          <strong>{longSegmentStatusLabel(segment.status)}</strong>
                          <small>{segmentProgress}%</small>
                        </div>
                        <div className="long-progress-segment-track"><span style={{ width: `${segmentProgress}%` }} /></div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            <div className="long-segment-summary">
              <div className="long-segment-summary-heading"><span className="field-label">{promptProvider === "codex" ? "Codex CLI" : "Ollama"} 逐段規劃輸出 <span>可直接編輯</span></span><strong>{longPlan?.segments.length || 0} 段</strong></div>
              {!longPlan && <div className="long-empty-output">尚無分段提示詞。請先輸入故事描述並按「用 {promptProvider === "codex" ? "Codex CLI" : "Ollama"} 產生分鏡時間與 H3 提示詞」。</div>}
              {longPlan?.segments.map((segment, index) => (
                <div className="long-segment-card" key={segment.id || index}>
                  <div className="long-segment-card-heading">
                    <span>第 {index + 1} 段 · {segment.start.toFixed(2)}–{segment.end.toFixed(2)} 秒 <b>{(segment.mode || (index === 0 && longInputType === "text" ? "t2v" : "i2v")).toUpperCase()}</b></span>
                    <small>{segment.promptSource === "manual" ? "手動提示詞" : segment.promptSource?.startsWith("codex") ? "Codex CLI 產出" : "Ollama 產出"}{segment.error ? ` · ${typeof segment.error === "string" ? segment.error : segment.error.message || segment.error.code || "error"}` : ""}</small>
                  </div>
                  <div className="long-segment-meta-grid">
                    <label className="setting-field"><span className="field-label">分鏡描述</span><textarea className="text-input long-segment-description" value={segment.description} onChange={(event) => setLongPlan((current) => current ? { ...current, segments: current.segments.map((item, itemIndex) => itemIndex === index ? { ...item, description: event.target.value } : item) } : current)} aria-label={`第 ${index + 1} 段描述`} /></label>
                    <label className="setting-field"><span className="field-label">段尾狀態 <span>供下一段延續</span></span><textarea className="text-input long-segment-ending" value={segment.endingState || ""} onChange={(event) => setLongPlan((current) => current ? { ...current, segments: current.segments.map((item, itemIndex) => itemIndex === index ? { ...item, endingState: event.target.value } : item) } : current)} aria-label={`第 ${index + 1} 段段尾狀態`} /></label>
                  </div>
                  <label className="setting-field"><span className="field-label">{segment.mode === "t2v" ? "T2VA" : "I2VA"} H3 prompt <span>{segment.promptSource?.startsWith("codex") ? "Codex CLI" : "Ollama"} 內容，可直接編輯</span></span><textarea className="text-input long-segment-prompt" value={segment.prompt || ""} onChange={(event) => setLongPlan((current) => current ? { ...current, segments: current.segments.map((item, itemIndex) => itemIndex === index ? { ...item, prompt: event.target.value, promptSource: "manual" } : item) } : current)} placeholder={`${segment.promptSource?.startsWith("codex") ? "Codex CLI" : "Ollama"} 產出的 H3 prompt 會顯示在這裡`} aria-label={`第 ${index + 1} 段 prompt`} /></label>
                  <label className="setting-field"><span className="field-label">此段負面提示詞 <span>空白則使用全片設定</span></span><textarea className="text-input long-segment-negative" value={segment.negativePrompt || ""} onChange={(event) => setLongPlan((current) => current ? { ...current, segments: current.segments.map((item, itemIndex) => itemIndex === index ? { ...item, negativePrompt: event.target.value } : item) } : current)} aria-label={`第 ${index + 1} 段負面提示詞`} /></label>
                </div>
              ))}
            </div>
            {longJob?.error && <div className="long-validation-error" role="alert">{typeof longJob.error === "string" ? longJob.error : `${longJob.error.code || "error"}: ${longJob.error.message || ""}`}</div>}
            <div className="long-actions"><button type="button" className="outline-button" onClick={() => void saveLongVideoDraft()} disabled={longBusy || longJobActive || !longPlan || longPlanDirty}>保存草稿</button><button type="button" className="generate-button long-start-button" onClick={() => void startLongVideo()} disabled={longBusy || longJobActive}><span>{longJobActive ? `長影片生成中 ${longOverallProgress}%` : longBusy ? "處理中…" : longPlanDirty || !longPlan ? "先規劃並開始生成" : "開始長影片生成"}</span><span className="generate-arrow"><Icon name="arrow" /></span></button></div>
            {longJob && <div className="long-job-status">工作 {longJob.id} · {longJob.status} · revision {longJob.revision}{longJob.updatedAt ? ` · ${formatTime(longJob.updatedAt)}` : ""}{longJob.status === "completed" && longJob.finalAsset ? <a className="open-output-button long-open-output" href={`${BRIDGE_URL}/media?root=output&name=${encodeURIComponent(longJob.finalAsset.name)}`} target="_blank" rel="noreferrer">開啟最終 MP4</a> : null}</div>}
          </section>

          <section className="studio-grid single-mode-only">
            <div className="panel prompt-panel">
              <div className="panel-heading">
                <div>
                  <span className="section-code">01 / PROMPT LAB</span>
                  <h2>提示詞</h2>
                </div>
                <span className="panel-mark"><Icon name="spark" /></span>
              </div>

              <label className="field-label" htmlFor="prompt-brief">
                提示詞描述 <span>可用中文輸入</span>
              </label>
              <textarea
                id="prompt-brief"
                className="text-input brief-input"
                value={promptBrief}
                onChange={(event) => setPromptBrief(event.target.value)}
                placeholder="例如：一個人在月台等待，風吹動他的外套…"
              />
              <div className="prompt-tool-row">
                <div className="prompt-provider-switch" role="group" aria-label="提示詞生成來源">
                  <button
                    type="button"
                    className={promptProvider === "ollama" ? "is-active" : ""}
                    onClick={() => { setPromptProvider("ollama"); if (longPlan) setLongPlanDirty(true); }}
                  >
                    <span className="ollama-badge">O</span> Ollama
                  </button>
                  <button
                    type="button"
                    className={promptProvider === "codex" ? "is-active" : ""}
                    onClick={() => { setPromptProvider("codex"); if (longPlan) setLongPlanDirty(true); }}
                  >
                    <span className="codex-badge">C</span> Codex CLI
                  </button>
                </div>
                <div className="ollama-select" hidden={promptProvider !== "ollama"}>
                  <span className="ollama-badge">O</span>
                  <select
                    value={effectiveOllamaModel}
                    onChange={(event) => { setOllamaModel(event.target.value); if (longPlan) setLongPlanDirty(true); }}
                    aria-label="Ollama 模型"
                  >
                    {promptModels.map((model) => {
                      const isInstalled = visibleModels.includes(model.value);
                      const status = ollamaOnline ? (isInstalled ? "已安裝" : "未安裝") : "待檢查";
                      return (
                        <option key={model.value} value={model.value}>
                          {model.label} · {model.note} · {status}
                        </option>
                      );
                    })}
                  </select>
                </div>
                <div className="prompt-provider-fields" hidden={promptProvider !== "codex"}>
                  <div className="ollama-select codex-model-select">
                    <span className="codex-badge">C</span>
                    <select
                      value={effectiveCodexModel}
                      onChange={(event) => selectCodexModel(event.target.value)}
                      aria-label="Codex CLI 模型"
                    >
                      {availableCodexModels.map((model) => (
                        <option key={model.value} value={model.value}>
                          {model.label} · {model.note}
                        </option>
                      ))}
                    </select>
                  </div>
                  <label className="codex-reasoning-select">
                    <span>Reasoning</span>
                    <select
                      value={effectiveCodexReasoningEffort}
                    onChange={(event) => { setCodexReasoningEffort(event.target.value); if (longPlan) setLongPlanDirty(true); }}
                      aria-label="Codex CLI 推理程度"
                    >
                      {availableCodexReasoningOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label} · {option.note}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <button
                  type="button"
                  className="outline-button"
                  onClick={() => void generatePrompt()}
                  disabled={promptBusy}
                >
                  <Icon name="spark" />
                  {promptBusy ? `${promptProvider === "codex" ? "Codex CLI" : "Ollama"} 生成中…` : `產生 ${promptFormatLabel} 提示詞`}
                </button>
              </div>

              <div className="divider-label">
                <span>H3 PROMPT / 可直接編輯</span>
                <span aria-live="polite">
                  {isH3PromptMode(mode)
                    ? `${prompt.length} / ${H3_PROMPT_MAX_CHARS} chars${prompt.length >= H3_PROMPT_WARNING_THRESHOLD ? " · 接近上限" : ""}`
                    : `${prompt.length} chars`}
                </span>
              </div>
              <textarea
                id="prompt"
                className="text-input prompt-input"
                value={prompt}
                onChange={(event) => { setPrompt(event.target.value); setPromptGenerationError(""); }}
                maxLength={isH3PromptMode(mode) ? H3_PROMPT_MAX_CHARS : undefined}
                placeholder="輸入要送給 MiniMax H3 的提示詞…"
              />
              {promptGenerationError && (
                <div className="prompt-validation-error" role="alert">
                  <strong>提示詞格式仍需修正</strong>
                  <span>{promptGenerationError}</span>
                </div>
              )}
              <div className="prompt-footer">
                <label className="field-label compact-label" htmlFor="negative-prompt">
                  負面提示詞
                </label>
                <textarea
                  id="negative-prompt"
                  className="text-input negative-input"
                  value={negativePrompt}
                  onChange={(event) => setNegativePrompt(event.target.value)}
                  placeholder="blurry, flicker, watermark…"
                />
              </div>
            </div>

            <div className="panel settings-panel" id="render-settings">
              <div className="panel-heading">
                <div>
                  <span className="section-code">02 / RENDER SETUP</span>
                  <h2>生成設定</h2>
                </div>
                <span className="panel-mark panel-mark-number">H3</span>
              </div>

              <div className="runtime-mode-card" aria-live="polite">
                <div className="runtime-mode-copy">
                  <span className="section-code">MODEL RUNTIME</span>
                  <strong>{runtimeMode === "remote" ? "Vast RTX 5090" : "本機 GPU"}</strong>
                  <small>
                    {runtimeMode === "remote"
                      ? "ComfyUI 18188 · Ollama 11435 · SSH loopback"
                      : "ComfyUI 8188 · Ollama 11434"}
                  </small>
                </div>
                <div className="runtime-mode-switch" role="group" aria-label="模型執行位置">
                  <button
                    type="button"
                    className={runtimeMode === "local" ? "is-active" : ""}
                    onClick={() => void selectRuntimeMode("local")}
                    disabled={runtimeSwitchDisabled}
                    aria-pressed={runtimeMode === "local"}
                  >
                    本機
                  </button>
                  <button
                    type="button"
                    className={runtimeMode === "remote" ? "is-active" : ""}
                    onClick={() => void selectRuntimeMode("remote")}
                    disabled={runtimeSwitchDisabled}
                    aria-pressed={runtimeMode === "remote"}
                  >
                    {runtimeSwitchBusy ? "切換中…" : "Vast 5090"}
                  </button>
                </div>
                <span className={"runtime-mode-health " + (comfyOnline && ollamaOnline ? "is-online" : "is-offline")}>
                  <span className="status-dot" />
                  {comfyOnline && ollamaOnline ? "ComfyUI／Ollama 在線" : "目標服務未就緒"}
                </span>
              </div>

              <div className="field-label">生成模式</div>
              <div className="mode-grid">
                <button
                  type="button"
                  className={"mode-button " + (mode === "t2v" ? "is-selected" : "")}
                  onClick={() => updateMode("t2v")}
                >
                  <span className="mode-icon"><Icon name="spark" /></span>
                  <span><strong>文字生片</strong><small>Text → Video</small></span>
                </button>
                <button
                  type="button"
                  className={"mode-button " + (mode === "i2v" ? "is-selected" : "")}
                  onClick={() => updateMode("i2v")}
                >
                  <span className="mode-icon"><Icon name="image" /></span>
                  <span><strong>參考圖生片</strong><small>Image → Video</small></span>
                </button>
                <button
                  type="button"
                  className={"mode-button " + (mode === "fl2v" ? "is-selected" : "")}
                  onClick={() => updateMode("fl2v")}
                >
                  <span className="mode-icon"><Icon name="image" /></span>
                  <span><strong>首尾幀生片</strong><small>First + Last Frame</small></span>
                </button>
                <button
                  type="button"
                  className={"mode-button " + (mode === "l2v" ? "is-selected" : "")}
                  onClick={() => updateMode("l2v")}
                >
                  <span className="mode-icon"><Icon name="image" /></span>
                  <span><strong>尾幀生片</strong><small>Last Frame → Video</small></span>
                </button>
                <button
                  type="button"
                  className={"mode-button " + (mode === "ref2v" ? "is-selected" : "")}
                  onClick={() => updateMode("ref2v")}
                >
                  <span className="mode-icon"><Icon name="folder" /></span>
                  <span><strong>多圖參考生片</strong><small>Ref2VA · 最多 9 張</small></span>
                </button>
                <button
                  type="button"
                  className={"mode-button " + (mode === "replace" ? "is-selected" : "")}
                  onClick={() => updateMode("replace")}
                >
                  <span className="mode-icon"><Icon name="video" /></span>
                  <span><strong>影片替換</strong><small>Wan Animate</small></span>
                </button>
              </div>

              <div className="setting-grid">
                <label className="setting-field">
                  <span className="field-label">模型 profile</span>
                  <select
                    className="select-input"
                    value={modelProfile}
                    onChange={(event) => setModelProfile(event.target.value)}
                  >
                    {modelOptions
                      .filter((option) =>
                        mode === "replace"
                          ? option.value === "wan22_animate_fp8"
                          : mode === "ref2v"
                            ? option.value === "ref2va_pruned_nvfp4"
                            : option.value !== "wan22_animate_fp8" && option.value !== "ref2va_pruned_nvfp4",
                      )
                      .map((option) => (
                        <option value={option.value} key={option.value}>
                          {option.label} · {option.note}
                        </option>
                      ))}
                  </select>
                </label>
                <div className="setting-field">
                  <span className="field-label">影片尺寸 <span>寬 × 高（px）</span></span>
                  <div className="resolution-inputs">
                    <label className="resolution-input">
                      <span>寬</span>
                      <input
                        className="number-input"
                        type="number"
                        min="32"
                        max="2048"
                        step={mode === "replace" ? 16 : 32}
                        inputMode="numeric"
                        value={width}
                        aria-label="影片寬度（px）"
                        onChange={(event) => {
                          const value = event.target.value;
                          setWidth(value === "" ? "" : Number(value));
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      className="resolution-swap-button"
                      onClick={swapResolution}
                      aria-label="交換影片寬度與高度"
                      title="交換寬度與高度"
                    >
                      <Icon name="swap" />
                    </button>
                    <label className="resolution-input">
                      <span>高</span>
                      <input
                        className="number-input"
                        type="number"
                        min="32"
                        max="2048"
                        step={mode === "replace" ? 16 : 32}
                        inputMode="numeric"
                        value={height}
                        aria-label="影片高度（px）"
                        onChange={(event) => {
                          const value = event.target.value;
                          setHeight(value === "" ? "" : Number(value));
                        }}
                      />
                    </label>
                  </div>
                  <select
                    className="select-input resolution-preset"
                    value=""
                    aria-label="套用常用影片尺寸"
                    onChange={(event) => {
                      if (!event.target.value) return;
                      const parts = event.target.value.split("x").map(Number);
                      setWidth(parts[0]);
                      setHeight(parts[1]);
                    }}
                  >
                    <option value="">套用常用尺寸</option>
                    <option value="736x416">16:9 · 736 × 416</option>
                    <option value="832x480">16:9 · 832 × 480</option>
                    <option value="608x352">16:9 · 608 × 352</option>
                    <option value="512x512">1:1 · 512 × 512</option>
                  </select>
                  <span className="dimension-hint">
                    {mode === "replace" ? "影片替換：16 的倍數" : "H3：32 的倍數"}，範圍 32–2048 px
                  </span>
                </div>
              </div>

              <div className="range-field">
                <div className="range-heading">
                  <span className="field-label">片段長度</span>
                  <strong>{duration}.0 <small>sec</small></strong>
                </div>
                <input
                  type="range"
                  min="2"
                  max="10"
                  step="0.5"
                  value={duration}
                  onChange={(event) => setDuration(Number(event.target.value))}
                />
                  <div className="range-scale"><span>2s</span><span>建議 5 秒</span><span>10s</span></div>
              </div>

              <div className="setting-grid compact-settings">
                <label className="setting-field">
                  <span className="field-label">Steps</span>
                  <input
                    className="number-input"
                    type="number"
                    min="1"
                    max="80"
                    value={steps}
                    onChange={(event) => setSteps(numberInputDraft(event.target.value))}
                  />
                </label>
                <label className="setting-field seed-field">
                  <span className="field-label">Seed</span>
                  <div className="seed-input">
                    <input
                      className="number-input"
                      type="number"
                      min="0"
                      max="2147483647"
                      value={seed}
                      onChange={(event) => setSeed(numberInputDraft(event.target.value))}
                    />
                    <button type="button" onClick={randomizeSeed} aria-label="隨機產生 Seed" title="隨機產生 Seed">隨機</button>
                  </div>
                </label>
                <label className="setting-field">
                  <span className="field-label">影片數量</span>
                  <input
                    className="number-input"
                    type="number"
                    min="1"
                    max="20"
                    value={renderCount}
                    onChange={(event) => setRenderCount(Math.min(20, Math.max(1, Number(event.target.value) || 1)))}
                  />
                </label>
              </div>

              <div className="output-name-field">
                <label className="field-label" htmlFor="output-name">輸出檔名</label>
                <div className="filename-input">
                  <input
                    id="output-name"
                    value={outputName}
                    onChange={(event) => setOutputName(event.target.value)}
                    placeholder="例如：h3-render"
                  />
                  <span>.mp4</span>
                </div>
              </div>

              <button
                type="button"
                className="generate-button"
                onClick={() => void startRender()}
                disabled={renderBusy}
              >
                <span>{renderBusy ? "正在排隊…" : "開始生成影片"}</span>
                <span className="generate-arrow"><Icon name="arrow" /></span>
              </button>
              <div className="render-note">
                <span className={"status-dot " + (bridgeOnline && comfyOnline ? "is-on" : "is-off")} />
                {bridgeOnline && comfyOnline ? "本機生成服務已就緒" : "等待 ComfyUI"}
              </div>
            </div>
          </section>

          <section id="reference-media" className="media-grid single-mode-only">
            <div className="panel media-panel">
              <div className="panel-heading media-heading">
                <div>
                  <span className="section-code">03 / REFERENCE MEDIA</span>
                  <h2>參考素材</h2>
                </div>
                <span className="media-mode-label">{modeLabel}</span>
              </div>
              <div className={"reference-grid " + (mode === "replace" || mode === "ref2v" || mode === "fl2v" ? "is-replace" : "")}>
                <div className="reference-slot">
                  <div className="slot-topline">
                    <span className="field-label">{primaryFrameLabel}</span>
                    <span className="slot-hint">IMAGE</span>
                  </div>
                  {mode === "ref2v" ? (
                    <div className="multi-reference-picker">
                      {referenceImages.length > 0 && (
                        <div className="multi-reference-grid" aria-label="已選取的 Ref2V 參考圖片">
                          {referenceImages.map((asset, index) => (
                            <div className="multi-reference-item" key={assetKey(asset)}>
                              <AssetThumb asset={asset} />
                              <span className="multi-reference-index">{index + 1}</span>
                              <button
                                type="button"
                                className="multi-reference-remove"
                                onClick={() => removeGeneralReference(asset)}
                                aria-label={`從 Ref2V 參考選取移除 ${asset.name}`}
                              >
                                <Icon name="close" />
                              </button>
                              <small title={asset.name}>{asset.name}</small>
                            </div>
                          ))}
                        </div>
                      )}
                      <button
                        type="button"
                        className="drop-zone multi-reference-add"
                        onClick={() => imageInputRef.current?.click()}
                        disabled={referenceImages.length >= MAX_REF2V_IMAGES}
                        aria-label="新增 Ref2V 參考圖片，可多選"
                      >
                        <span className="drop-icon"><Icon name="image" /></span>
                        <span><strong>{referenceImages.length ? "新增參考圖片" : "拖曳或選擇多張圖片"}</strong><small>PNG, JPG, WEBP · 最多 {MAX_REF2V_IMAGES} 張</small></span>
                        <span className="drop-plus"><Icon name="plus" /></span>
                      </button>
                      <input
                        key="ref2v-multi-image-input"
                        ref={imageInputRef}
                        type="file"
                        accept="image/*"
                        multiple
                        hidden
                        onChange={(event) => onFileChange(event, "image")}
                      />
                      <small className="multi-reference-count" aria-live="polite">已選 {referenceImages.length} / {MAX_REF2V_IMAGES} 張；可逐張移除選取，不會刪除資源檔案。</small>
                    </div>
                  ) : (
                    <>
                      {primaryFrameAsset ? (
                        <div className="selected-media">
                          <AssetThumb asset={primaryFrameAsset} />
                          <div className="selected-media-info">
                            <strong>{primaryFrameAsset.name}</strong>
                            <span>{formatBytes(primaryFrameAsset.size)} · input</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => mode === "l2v" ? setLastFrameImage(null) : setReferenceImage(null)}
                            aria-label="移除參考圖片"
                          >
                            <Icon name="close" />
                          </button>
                        </div>
                      ) : (
                        <button type="button" className="drop-zone" onClick={() => primaryFrameInputRef.current?.click()}>
                          <span className="drop-icon"><Icon name="image" /></span>
                          <span><strong>拖曳或選擇圖片</strong><small>PNG, JPG, WEBP</small></span>
                          <span className="drop-plus"><Icon name="plus" /></span>
                        </button>
                      )}
                      <input
                        key={`primary-frame-image-input-${mode}`}
                        ref={primaryFrameInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        multiple={studioMode === "long" && longReferenceMode === "multi_reference"}
                        hidden
                        onChange={(event) => onFileChange(event, primaryFrameTarget)}
                      />
                    </>
                  )}
                </div>
                {(mode === "replace" || mode === "ref2v") && (
                  <div className="reference-slot">
                    <div className="slot-topline">
                      <span className="field-label">{mode === "ref2v" ? "參考影片（Video 1）" : "來源動作影片"}</span>
                      <span className="slot-hint">VIDEO</span>
                    </div>
                    {sourceVideo ? (
                      <div className="selected-media">
                        <AssetThumb asset={sourceVideo} />
                        <div className="selected-media-info">
                          <strong>{sourceVideo.name}</strong>
                          <span>{formatBytes(sourceVideo.size)} · input</span>
                        </div>
                        <button type="button" onClick={() => setSourceVideo(null)} aria-label="移除來源影片"><Icon name="close" /></button>
                      </div>
                    ) : (
                      <button type="button" className="drop-zone" onClick={() => videoInputRef.current?.click()}>
                        <span className="drop-icon"><Icon name="video" /></span>
                        <span><strong>放入一段動作影片</strong><small>MP4, MOV, WEBM</small></span>
                        <span className="drop-plus"><Icon name="plus" /></span>
                      </button>
                    )}
                    <input ref={videoInputRef} type="file" accept="video/mp4,video/quicktime,video/webm" hidden onChange={(event) => onFileChange(event, "video")} />
                  </div>
                )}
                {mode === "fl2v" && (
                  <div className="reference-slot">
                    <div className="slot-topline">
                      <span className="field-label">尾幀圖片</span>
                      <span className="slot-hint">IMAGE</span>
                    </div>
                    {lastFrameImage ? (
                      <div className="selected-media">
                        <AssetThumb asset={lastFrameImage} />
                        <div className="selected-media-info">
                          <strong>{lastFrameImage.name}</strong>
                          <span>{formatBytes(lastFrameImage.size)} · input</span>
                        </div>
                        <button type="button" onClick={() => setLastFrameImage(null)} aria-label="移除尾幀圖片"><Icon name="close" /></button>
                      </div>
                    ) : (
                      <button type="button" className="drop-zone" onClick={() => lastFrameInputRef.current?.click()}>
                        <span className="drop-icon"><Icon name="image" /></span>
                        <span><strong>選擇尾幀圖片</strong><small>PNG, JPG, WEBP</small></span>
                        <span className="drop-plus"><Icon name="plus" /></span>
                      </button>
                    )}
                    <input ref={lastFrameInputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => onFileChange(event, "lastFrame")} />
                  </div>
                )}
              </div>
              <div className="media-footnote">
                <Icon name="folder" />
                <span>可從資源庫選取檔案。輸入檔會直接放在 <code>ComfyUI/input</code>。</span>
              </div>
            </div>

            <div className="panel progress-panel" id="render-queue">
              <div className="panel-heading">
                <div>
                  <span className="section-code">RENDER QUEUE</span>
                  <h2>{activeJob ? "生成處理中" : outputAsset ? "最近輸出" : "生成進度"}</h2>
                </div>
                {activeJob && <span className="progress-number">{Math.round(activeJob.progress)}%</span>}
              </div>
              <div className="progress-track">
                <span style={{ width: (activeJob ? activeJob.progress : outputAsset ? 100 : 0) + "%" }} />
              </div>
              <div className="progress-stage">{progressStage}</div>
              {(activeJob || latestCompletedJob) && (
                <div className="progress-timing" aria-label="生成時間資訊">
                  {activeJob ? (
                    <>
                      <div className="progress-timing-item">
                        <span>已耗時</span>
                        <strong>{formatDurationMs(activeJob.elapsedMs)}</strong>
                      </div>
                      <div className="progress-timing-item">
                        <span>預估總耗時</span>
                        <strong>{formatDurationMs(activeJob.estimatedDurationMs)}</strong>
                      </div>
                      <div className="progress-timing-item">
                        <span>預估剩餘</span>
                        <strong>{formatDurationMs(activeJob.etaMs)}</strong>
                      </div>
                    </>
                  ) : latestCompletedJob ? (
                    <div className="progress-timing-item progress-timing-complete">
                      <span>實際生成總時間</span>
                      <strong>{formatDurationMs(latestCompletedJob.elapsedMs)}</strong>
                    </div>
                  ) : null}
                </div>
              )}
              <div className="stage-list">
                {currentStages.map((stage, index) => (
                  <div className={"stage-item " + (stage.done ? "is-done" : "") + (activeJob && !stage.done && index === currentStages.findIndex((item) => !item.done) ? " is-current" : "")} key={stage.label}>
                    <span className="stage-check">{stage.done ? <Icon name="check" /> : index + 1}</span>
                    <span>{stage.label}</span>
                  </div>
                ))}
              </div>
              {activeJob ? (
                <button type="button" className="cancel-button" onClick={() => void cancelRender()}>
                  <Icon name="pause" /> 停止目前工作
                </button>
              ) : outputAsset ? (
                <a className="open-output-button" href={assetUrl(outputAsset)} target="_blank" rel="noreferrer">
                  <Icon name="play" /> 開啟最新影片
                </a>
              ) : (
                <div className="queue-placeholder"><span>H3</span><p>本機工作佇列是空的。</p></div>
              )}
            </div>
          </section>

          <section className="panel library-panel" id="asset-library">
            <div className="library-heading">
              <div>
                <span className="section-code">04 / ASSET LIBRARY</span>
                <h2>本機資源庫</h2>
                <p>輸入與輸出資源會分區顯示。點選資源可預覽、下載或套用到工作台。</p>
              </div>
              <div className="library-stats">
                <span><strong>{inputAssets.length}</strong> input</span>
                <span><strong>{outputAssets.length}</strong> output</span>
              </div>
            </div>
            <div className="library-toolbar">
              <div className="filter-tabs">
                {(["all", "image", "video"] as const).map((filter) => (
                  <button
                    type="button"
                    className={assetFilter === filter ? "is-active" : ""}
                    key={filter}
                    onClick={() => {
                      setAssetFilter(filter);
                      setVideoPage(1);
                    }}
                  >
                    {filter === "all" ? "全部" : filter === "image" ? "圖片" : "影片"}
                  </button>
                ))}
              </div>
              {deletableAssets.length > 0 && (
                <div className="asset-bulk-actions">
                  <span className="asset-selection-status">
                    {selectedDeletableAssets.length ? `已選 ${selectedDeletableAssets.length} 個` : "可多選輸入／輸出資源"}
                  </span>
                  <button
                    type="button"
                    className="outline-button small-button"
                    onClick={toggleVisibleAssetSelection}
                    disabled={Boolean(deletingAssetKey) || !visibleDeletableAssets.length}
                  >
                    {allVisibleDeletableAssetsSelected ? "取消全選" : "全選目前篩選"}
                  </button>
                  {selectedDeletableAssets.length > 0 && (
                    <>
                      <button
                        type="button"
                        className="outline-button small-button"
                        onClick={() => setSelectedAssetKeys([])}
                        disabled={Boolean(deletingAssetKey)}
                      >
                        清除選取
                      </button>
                      <button
                        type="button"
                        className="asset-bulk-delete-button"
                        onClick={() => void deleteSelectedOutputAssets()}
                        disabled={Boolean(deletingAssetKey)}
                      >
                        <Icon name="close" /> 刪除選取 ({selectedDeletableAssets.length})
                      </button>
                    </>
                  )}
                </div>
              )}
              <button type="button" className="outline-button small-button" onClick={() => void refreshAssets()}>
                <Icon name="refresh" /> 重新掃描
              </button>
            </div>
            {filteredAssets.length ? (
              <div className="asset-source-groups">
                {assetGroups.map((group) => (
                  <section className="asset-source-group" key={group.root} aria-labelledby={group.root + "-assets-title"}>
                    <div className="asset-source-heading">
                      <div>
                        <div className="asset-source-title-line">
                          <span className={"asset-source-badge " + group.root}>{group.label}</span>
                          <h3 id={group.root + "-assets-title"}>{group.title}</h3>
                        </div>
                        <p>{group.description}</p>
                      </div>
                      <span className="asset-source-count">{group.assets.length} / {group.total}</span>
                    </div>
                    {group.assets.length ? (
                      <>
                        <div className="asset-grid">
                        {group.assets.slice(0, 12).map((asset) => (
                          <article
                            className={"asset-card " + (selectedAsset?.root === asset.root && selectedAsset.name === asset.name ? "is-selected " : "") + (selectedAssetKeySet.has(assetKey(asset)) ? "is-bulk-selected" : "")}
                            key={assetKey(asset)}
                          >
                            {isDeletableAsset(asset) && (
                              <label className="asset-select-control">
                                <input
                                  type="checkbox"
                                  checked={selectedAssetKeySet.has(assetKey(asset))}
                                  onChange={() => toggleAssetSelection(asset)}
                                  aria-label={`選取刪除資源 ${asset.name}`}
                                />
                                <span aria-hidden="true" />
                              </label>
                            )}
                            <button
                              type="button"
                              className="asset-card-main"
                              onClick={() => openAssetPreview(asset)}
                              aria-label={`預覽資源 ${asset.name}`}
                            >
                              <AssetThumb asset={asset} />
                              <span className="asset-card-info">
                                <strong title={asset.name}>{asset.name}</strong>
                                <small>{formatBytes(asset.size)} · {formatTime(asset.modified)}</small>
                              </span>
                            </button>
                            <div className="asset-card-footer">
                              <span className="asset-kind">{asset.kind === "video" ? "VIDEO" : "IMAGE"}</span>
                              <div className="asset-card-actions">
                                <a
                                  className="asset-download-button"
                                  href={assetDownloadUrl(asset)}
                                  download={assetFileName(asset)}
                                  aria-label={`下載資源 ${asset.name}`}
                                  title="下載資源"
                                >
                                  <Icon name="download" />
                                  <span>下載</span>
                                </a>
                                {asset.root === "input" && asset.kind === "image" && (
                                  <>
                                    <button
                                      type="button"
                                      className="asset-reference-button"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        addGeneralReferenceAssets([asset]);
                                      }}
                                      aria-label={`加入一般參考 ${asset.name}`}
                                      title="加入一般參考"
                                    >
                                      一般參考
                                    </button>
                                    <button
                                      type="button"
                                      className="asset-reference-button"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        addLongReferenceAsset(asset);
                                      }}
                                      aria-label={`加入長片參考 ${asset.name}`}
                                      title="加入長片參考"
                                    >
                                      長片參考
                                    </button>
                                  </>
                                )}
                                {asset.kind === "image" && (
                                  <button
                                    type="button"
                                    className="asset-reference-button"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      selectAssetForImg2Img(asset);
                                    }}
                                    aria-label={`用於以圖生圖 ${asset.name}`}
                                    title="用於以圖生圖"
                                  >
                                    以圖生圖
                                  </button>
                                )}
                                {isDeletableAsset(asset) && (
                                  <button
                                    type="button"
                                    className="asset-delete-button"
                                    disabled={Boolean(deletingAssetKey)}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void deleteOutputAsset(asset);
                                    }}
                                    aria-label={`刪除${asset.root === "input" ? "輸入" : "輸出"}${asset.kind === "image" ? "圖片" : "影片"} ${asset.name}`}
                                    title={`刪除${asset.root === "input" ? "輸入" : "輸出"}資源`}
                                  >
                                    <Icon name="close" />
                                    <span>{deletingAssetKey === assetKey(asset) ? "刪除中" : "刪除"}</span>
                                  </button>
                                )}
                              </div>
                            </div>
                          </article>
                        ))}
                        </div>
                        {group.root === "output" && assetFilter === "video" && (
                          <nav className="asset-pagination" aria-label="影片分頁">
                            <button
                              type="button"
                              className="asset-pagination-button"
                              disabled={currentVideoPage <= 1}
                              onClick={() => setVideoPage((page) => Math.max(1, page - 1))}
                              aria-label="上一頁影片"
                            >
                              上一頁
                            </button>
                            <span className="asset-pagination-label">切換頁面</span>
                            <div className="asset-page-buttons" role="group" aria-label="選擇影片頁面">
                              {videoPageNumbers.map((page) => (
                                <button
                                  type="button"
                                  className={"asset-pagination-button asset-pagination-number " + (currentVideoPage === page ? "is-current" : "")}
                                  key={page}
                                  onClick={() => setVideoPage(page)}
                                  aria-current={currentVideoPage === page ? "page" : undefined}
                                  aria-label={`前往影片第 ${page} 頁`}
                                >
                                  {page}
                                </button>
                              ))}
                            </div>
                            <button
                              type="button"
                              className="asset-pagination-button"
                              disabled={currentVideoPage >= videoPageCount}
                              onClick={() => setVideoPage((page) => Math.min(videoPageCount, page + 1))}
                              aria-label="下一頁影片"
                            >
                              下一頁
                            </button>
                            <span className="asset-pagination-summary">第 {currentVideoPage} / {videoPageCount} 頁 · 共 {filteredOutputAssets.length} 部影片</span>
                          </nav>
                        )}
                      </>
                    ) : (
                      <div className="asset-group-empty">
                        <span className="asset-group-empty-icon"><Icon name="folder" /></span>
                        <span>目前沒有符合篩選條件的資源。</span>
                      </div>
                    )}
                  </section>
                ))}
              </div>
            ) : (
              <div className="empty-library">
                <div className="empty-library-mark"><Icon name="folder" /></div>
                <div><strong>尚無資源</strong><p>上傳參考圖或生成影片後，檔案會顯示在這裡。</p></div>
              </div>
            )}
          </section>

          <section className="bottom-row">
            <div className="local-path-card">
              <span className="section-code">LOCAL STORAGE</span>
              <div className="path-row"><span className="path-dot" /><span>{health?.paths.output || "ComfyUI/output"}</span><Icon name="folder" /></div>
            </div>
            <div className="history-card">
              <span className="section-code">RECENT JOBS</span>
              {history.length ? (
                <div className="history-list">
                  {history.slice(0, 3).map((item) => (
                    <div className="history-item" key={item.id}>
                      <span className={"history-status " + item.status} />
                      <span className="history-main"><strong>{item.output?.name || modeLabel}</strong><small>{formatTime(item.startedAt || new Date().toISOString())}</small></span>
                      <span className="history-percent">{item.status === "completed" ? "100%" : item.status === "running" ? Math.round(item.progress) + "%" : item.status}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="history-empty">尚無完成的工作。</p>
              )}
            </div>
          </section>
        </div>
      </section>

      {assetPreview && (
        <div className="asset-preview-backdrop">
          <section
            className="asset-preview-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="asset-preview-title"
          >
            <div className="asset-preview-header">
              <div>
                <div className="asset-preview-kicker">
                  <span className={"asset-source-badge " + assetPreview.root}>{assetPreview.root.toUpperCase()}</span>
                  <span>{assetPreview.kind === "video" ? "VIDEO" : "IMAGE"} PREVIEW</span>
                </div>
                <h2 id="asset-preview-title" title={assetPreview.name}>{assetPreview.name}</h2>
              </div>
              <button
                type="button"
                className="asset-preview-close"
                onClick={() => setAssetPreview(null)}
                aria-label="關閉資源預覽"
              >
                <Icon name="close" />
              </button>
            </div>
            <div className="asset-preview-stage">
              {assetPreview.kind === "video" ? (
                <video src={assetUrl(assetPreview)} controls playsInline preload="metadata">
                  <track kind="captions" />
                </video>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={assetUrl(assetPreview)} alt={assetPreview.name} />
              )}
            </div>
            <div className="asset-preview-footer">
              <div className="asset-preview-meta">
                <div>
                  <span className="asset-preview-meta-label">資料夾</span>
                  <strong>ComfyUI/{assetPreview.root}</strong>
                </div>
                <div>
                  <span className="asset-preview-meta-label">檔案資訊</span>
                  <strong>{formatBytes(assetPreview.size)} · {formatTime(assetPreview.modified)}</strong>
                </div>
              </div>
              <div className="asset-preview-actions">
                <a
                  className="outline-button preview-download-button"
                  href={assetDownloadUrl(assetPreview)}
                  download={assetFileName(assetPreview)}
                >
                  <Icon name="download" /> 下載資源
                </a>
                {assetPreview.kind === "video" && (
                  <button
                    type="button"
                    className="preview-upscale-button"
                    onClick={() => selectAssetForUpscale(assetPreview)}
                  >
                    <Icon name="spark" /> 用於影片升頻
                  </button>
                )}
                {assetPreview.kind === "image" && (
                  <button
                    type="button"
                    className="preview-upscale-button"
                    onClick={() => selectAssetForImg2Img(assetPreview)}
                  >
                    <Icon name="spark" /> 用於以圖生圖
                  </button>
                )}
                {assetPreview.root === "input" && assetPreview.kind === "image" && (
                  <>
                    <button
                      type="button"
                      className="preview-reference-button"
                      onClick={() => addGeneralReferenceAssets([assetPreview])}
                    >
                      加入一般參考
                    </button>
                    <button
                      type="button"
                      className="preview-reference-button"
                      onClick={() => addLongReferenceAsset(assetPreview)}
                    >
                      加入長片參考
                    </button>
                  </>
                )}
                {isDeletableAsset(assetPreview) && (
                  <button
                    type="button"
                    className="preview-delete-button"
                    disabled={Boolean(deletingAssetKey)}
                    onClick={() => void deleteOutputAsset(assetPreview)}
                  >
                    <Icon name="close" />
                    {deletingAssetKey === assetKey(assetPreview)
                      ? "刪除中"
                      : `刪除${assetPreview.root === "input" ? "輸入" : "輸出"}${assetPreview.kind === "image" ? "圖片" : "影片"}`}
                  </button>
                )}
                <button
                  type="button"
                  className="preview-use-button"
                  onClick={() => {
                    applyAssetToWorkspace(assetPreview);
                    setAssetPreview(null);
                  }}
                >
                  <Icon name="check" /> 套用到工作台
                </button>
              </div>
            </div>
            <p className="asset-preview-hint">
              按 Esc 或右上角的關閉按鈕即可關閉預覽。
              {assetPreview.root === "output" && assetPreview.kind === "image" && " 多參考選取只接受 ComfyUI/input 圖片；此輸出可作單圖套用。"}
            </p>
          </section>
        </div>
      )}

      {longErrorDialog && (
        <div className="long-error-dialog-backdrop">
          <section
            className="long-error-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="long-error-dialog-title"
            aria-describedby="long-error-dialog-message"
          >
            <div className="long-error-dialog-mark" aria-hidden="true">!</div>
            <div className="long-error-dialog-copy">
              <span className="section-code">LONG VIDEO ERROR</span>
              <h2 id="long-error-dialog-title">{longErrorDialog.title}</h2>
              <code>{longErrorDialog.code}</code>
              <p id="long-error-dialog-message">{longErrorDialog.message}</p>
              <small>{longErrorDialog.hint}</small>
            </div>
            <button type="button" className="long-error-dialog-close" onClick={() => setLongErrorDialog(null)}>我知道了</button>
          </section>
        </div>
      )}

      {toast && (
        <div className={"toast toast-" + toast.tone} role={toast.tone === "error" ? "alert" : "status"}>
          <span className="toast-mark">{toast.tone === "success" ? "✓" : toast.tone === "error" ? "!" : "·"}</span>
          {toast.message}
        </div>
      )}
    </main>
  );
}
