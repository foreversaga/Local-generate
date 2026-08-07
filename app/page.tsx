"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";

const BRIDGE_URL = "/app";

type Mode = "t2v" | "i2v" | "replace";
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

type Health = {
  bridge: boolean;
  h3Root: boolean;
  ollama: {
    online: boolean;
    models: string[];
  };
  comfy: {
    online: boolean;
    url: string;
    devices: Array<{ name?: string; vram_total?: number; vram_free?: number }>;
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
};

type Toast = {
  message: string;
  tone: "info" | "success" | "error";
};

type PromptModelOption = {
  value: string;
  label: string;
  note: string;
};

const navItems = [
  { label: "工作台", icon: "grid", target: "workspace" },
  { label: "生成紀錄", icon: "clock", target: "render-queue" },
  { label: "資源庫", icon: "folder", target: "asset-library" },
  { label: "系統設定", icon: "sliders", target: "render-settings" },
];

const promptModelCatalog: PromptModelOption[] = [
  { value: "gemma4:12b", label: "Gemma 4 12B", note: "文字＋圖片" },
  { value: "qwen3-vl:8b-instruct", label: "Qwen3 VL 8B", note: "文字＋圖片" },
  { value: "gemma3:1b", label: "Gemma 3 1B", note: "文字" },
  { value: "gemma3:4b", label: "Gemma 3 4B", note: "文字＋圖片" },
  { value: "gemma3:12b", label: "Gemma 3 12B", note: "文字＋圖片" },
  { value: "gemma3:27b", label: "Gemma 3 27B", note: "文字＋圖片" },
  { value: "gemma3n:e2b", label: "Gemma 3n E2B", note: "低資源" },
  { value: "gemma3n:e4b", label: "Gemma 3n E4B", note: "低資源" },
  { value: "gemma2:2b", label: "Gemma 2 2B", note: "文字" },
  { value: "gemma2:9b", label: "Gemma 2 9B", note: "文字" },
  { value: "gemma2:27b", label: "Gemma 2 27B", note: "文字" },
  { value: "gemma:2b", label: "Gemma 1 2B", note: "舊版" },
  { value: "gemma:7b", label: "Gemma 1 7B", note: "舊版" },
];

const modelOptions = [
  { value: "nvfp4_blackwell", label: "NVFP4 Blackwell", note: "推薦 · 16GB VRAM" },
  { value: "int4_convrot_low_vram", label: "INT4 ConvRot", note: "低顯存 fallback" },
  { value: "official_pruned_int8_convrot", label: "Official INT8", note: "品質比較" },
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

function batchSeed(baseSeed: number, index: number) {
  const normalized = Number.isFinite(baseSeed)
    ? Math.min(2147483647, Math.max(0, Math.round(baseSeed)))
    : 12345;
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

function isActiveJob(job: Job) {
  return ["queued", "running", "cancelling"].includes(job.status);
}

function isFinishedJob(job: Job) {
  return ["completed", "failed", "cancelled"].includes(job.status);
}

function assetUrl(asset: Asset) {
  return BRIDGE_URL + asset.url;
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
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
  const [assetPreview, setAssetPreview] = useState<Asset | null>(null);
  const [referenceImage, setReferenceImage] = useState<Asset | null>(null);
  const [sourceVideo, setSourceVideo] = useState<Asset | null>(null);
  const [mode, setMode] = useState<Mode>("t2v");
  const [promptBrief, setPromptBrief] = useState("");
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [ollamaModel, setOllamaModel] = useState("gemma4:12b");
  const [modelProfile, setModelProfile] = useState("nvfp4_blackwell");
  const [activeNav, setActiveNav] = useState("workspace");
  const [width, setWidth] = useState<number | "">(736);
  const [height, setHeight] = useState<number | "">(416);
  const [duration, setDuration] = useState(5);
  const [steps, setSteps] = useState(20);
  const [seed, setSeed] = useState(12345);
  const [renderCount, setRenderCount] = useState(1);
  const [outputName, setOutputName] = useState("");
  const [ollamaBusy, setOllamaBusy] = useState(false);
  const [renderBusy, setRenderBusy] = useState(false);
  const [renderJobs, setRenderJobs] = useState<Job[]>([]);
  const [renderBatchSize, setRenderBatchSize] = useState(0);
  const [renderSubmitting, setRenderSubmitting] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const renderJobsRef = useRef<Job[]>([]);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);

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
  const assetGroups = [
    {
      root: "input" as const,
      label: "INPUT",
      title: "輸入資源",
      description: "參考圖片與來源影片，可作為生成素材。",
      assets: filteredInputAssets,
      total: inputAssets.length,
    },
    {
      root: "output" as const,
      label: "OUTPUT",
      title: "輸出成果",
      description: "H3 生成的影片與其他媒體成果。",
      assets: filteredOutputAssets,
      total: outputAssets.length,
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
    await Promise.all([refreshStatus(), refreshAssets(), refreshHistory()]);
  }

  async function refreshStatus() {
    try {
      const response = await fetch(BRIDGE_URL + "/api/health");
      if (!response.ok) throw new Error("bridge unavailable");
      const nextHealth = (await response.json()) as Health;
      setHealth(nextHealth);
      setBridgeOnline(true);
      if (
        nextHealth.ollama.models.length &&
        !nextHealth.ollama.models.includes(ollamaModel)
      ) {
        setOllamaModel(nextHealth.ollama.models[0]);
      }
    } catch {
      setBridgeOnline(false);
      setHealth(null);
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

  function showToast(message: string, tone: Toast["tone"] = "info") {
    setToast({ message, tone });
    window.setTimeout(() => setToast(null), 4200);
  }

  function updateMode(nextMode: Mode) {
    setMode(nextMode);
    if (nextMode === "replace") {
      setModelProfile("wan22_animate_fp8");
      setWidth(832);
      setHeight(480);
      setSteps(6);
    } else if (modelProfile === "wan22_animate_fp8") {
      setModelProfile("nvfp4_blackwell");
      setWidth(736);
      setHeight(416);
      setSteps(20);
    }
  }

  function randomizeSeed() {
    setSeed(Math.floor(Math.random() * 900000000) + 100000000);
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
    if (!ollamaOnline) {
      showToast("Ollama 尚未連線。", "error");
      return;
    }
    if (!visibleModels.includes(ollamaModel)) {
      showToast(`模型 ${ollamaModel} 尚未安裝。`, "error");
      return;
    }
    setOllamaBusy(true);
    try {
      const response = await fetch(BRIDGE_URL + "/api/ollama/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: ollamaModel,
          brief: promptBrief,
          negativePrompt,
        }),
      });
      const payload = (await response.json()) as {
        prompt?: string;
        negativePrompt?: string;
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || "Ollama 沒有回應");
      if (payload.prompt) setPrompt(payload.prompt);
      if (payload.negativePrompt) setNegativePrompt(payload.negativePrompt);
      showToast("H3 提示詞已更新。", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Ollama 連線失敗。", "error");
    } finally {
      setOllamaBusy(false);
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

  async function uploadFile(file: File, target: "image" | "video") {
    try {
        showToast("正在上傳 " + file.name + "…");
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
      if (!response.ok || !payload.asset) {
        throw new Error(payload.error || "上傳失敗");
      }
      if (target === "image") setReferenceImage(payload.asset);
      if (target === "video") setSourceVideo(payload.asset);
      setSelectedAsset(payload.asset);
      await refreshAssets();
      showToast("檔案已上傳。", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "檔案上傳失敗。", "error");
    }
  }

  function onFileChange(
    event: ChangeEvent<HTMLInputElement>,
    target: "image" | "video",
  ) {
    const file = event.target.files?.[0];
    if (file) void uploadFile(file, target);
    event.target.value = "";
  }

  function applyAssetToWorkspace(asset: Asset) {
    setSelectedAsset(asset);
    if (asset.kind === "image") {
      setReferenceImage(asset);
      showToast("已選取參考圖片：" + asset.name);
    } else {
      setSourceVideo(asset);
      showToast("已選取來源影片：" + asset.name);
    }
  }

  function openAssetPreview(asset: Asset) {
    setSelectedAsset(asset);
    setAssetPreview(asset);
  }

  async function startRender() {
    if (!prompt.trim()) {
      showToast("請先填入提示詞。", "error");
      return;
    }
    if (mode === "i2v" && !referenceImage) {
      showToast("參考圖生片需要一張圖片。", "error");
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
    const count = Math.min(20, Math.max(1, Math.round(renderCount || 1)));
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
                inputImageName: referenceImage?.kind === "image" ? referenceImage.name : "",
                inputVideoName: sourceVideo?.kind === "video" ? sourceVideo.name : "",
                referenceImageName: referenceImage?.kind === "image" ? referenceImage.name : "",
                modelProfile,
                width,
                height,
                duration,
                steps,
                seed: batchSeed(seed, index),
                outputName: batchOutputName(outputName, index, count),
                batchId,
                batchIndex: index + 1,
                batchTotal: count,
              }),
            }).then(async (response) => {
              const payload = (await response.json()) as { job?: Job; error?: string };
              if (!response.ok || !payload.job) {
                throw new Error(payload.error || "無法建立生成工作");
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
          inputImageName: referenceImage?.kind === "image" ? referenceImage.name : "",
          inputVideoName: sourceVideo?.kind === "video" ? sourceVideo.name : "",
          referenceImageName: referenceImage?.kind === "image" ? referenceImage.name : "",
          modelProfile,
          width,
          height,
          duration,
          steps,
          seed,
          outputName,
          batchId,
          batchIndex: 1,
          batchTotal: 1,
        }),
      });
      const payload = (await response.json()) as { job?: Job; error?: string };
      if (!response.ok || !payload.job) throw new Error(payload.error || "無法建立生成工作");
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

  const modeLabel =
    mode === "t2v" ? "文字生片" : mode === "i2v" ? "參考圖生片" : "影片替換";
  const ollamaOnline = Boolean(health?.ollama.online);
  const comfyOnline = Boolean(health?.comfy.online);
  const visibleModels = health?.ollama.models || [];
  const catalogValues = new Set(promptModelCatalog.map((model) => model.value));
  const installedCatalogModels = promptModelCatalog.filter((model) => visibleModels.includes(model.value));
  const installedExtras = visibleModels
    .filter((model) => !catalogValues.has(model))
    .map((model) => ({ value: model, label: model, note: "已安裝" }));
  const promptModels = [...installedCatalogModels, ...installedExtras];
  const completedRenderCount = renderJobs.filter((item) =>
    ["completed", "failed", "cancelled"].includes(item.status),
  ).length;
  const progressBatchTotal = activeJob?.batchTotal || renderBatchSize;
  const progressBatchLabel = activeJob && progressBatchTotal > 1
    ? `第 ${activeJob.batchIndex || Math.min(completedRenderCount + 1, progressBatchTotal)} / ${progressBatchTotal} 部影片 · `
    : "";
  const timingLabel = activeJob?.estimatedDurationMs
    ? ` · 預估剩餘 ${formatDurationMs(activeJob.etaMs)}（最近 ${activeJob.timingSampleCount || 0}/5）`
    : "";
  const progressStage = activeJob
    ? `${progressBatchLabel}Seed ${activeJob.seed ?? "—"} · ${activeJob.stage}${timingLabel}`
    : outputAsset ? "完成，可在資源庫預覽" : "尚未開始生成";
  const currentStages = [
    { label: "準備輸入", done: Boolean(activeJob && activeJob.progress > 4) },
    { label: "送入 ComfyUI", done: Boolean(activeJob && activeJob.progress > 18) },
    { label: mode === "replace" ? "逐段生成與接續" : "生成影格", done: Boolean(activeJob && activeJob.progress > 48) },
    { label: "封裝 MP4", done: Boolean(activeJob && activeJob.progress > 88) },
  ];

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
              <span className={"status-dot " + (comfyOnline ? "is-on" : "is-off")} />
              <span>ComfyUI</span>
              <span className="connection-state">{comfyOnline ? "online" : "offline"}</span>
            </div>
          </div>
        </header>

        <div className="workspace" id="workspace">
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
                  <strong>{ollamaOnline ? "Ollama ready" : "等待 Ollama"}</strong>
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

          <section className="studio-grid">
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
                <div className="ollama-select">
                  <span className="ollama-badge">O</span>
                  <select
                    value={ollamaModel}
                    onChange={(event) => setOllamaModel(event.target.value)}
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
                <button
                  type="button"
                  className="outline-button"
                  onClick={() => void generatePrompt()}
                  disabled={ollamaBusy}
                >
                  <Icon name="spark" />
                  {ollamaBusy ? "整理中…" : "產生 H3 提示詞"}
                </button>
              </div>

              <div className="divider-label">
                <span>H3 PROMPT / 可直接編輯</span>
                <span>{prompt.length} chars</span>
              </div>
              <textarea
                id="prompt"
                className="text-input prompt-input"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="輸入要送給 MiniMax H3 的提示詞…"
              />
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
                          : option.value !== "wan22_animate_fp8",
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
                    <span className="resolution-separator" aria-hidden="true">×</span>
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
                    max="60"
                    value={steps}
                    onChange={(event) => setSteps(Number(event.target.value))}
                  />
                </label>
                <label className="setting-field seed-field">
                  <span className="field-label">Seed</span>
                  <div className="seed-input">
                    <input
                      className="number-input"
                      type="number"
                      min="0"
                      value={seed}
                      onChange={(event) => setSeed(Number(event.target.value))}
                    />
                    <button type="button" onClick={randomizeSeed} aria-label="隨機 seed">↻</button>
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

          <section className="media-grid">
            <div className="panel media-panel">
              <div className="panel-heading media-heading">
                <div>
                  <span className="section-code">03 / REFERENCE MEDIA</span>
                  <h2>參考素材</h2>
                </div>
                <span className="media-mode-label">{modeLabel}</span>
              </div>
              <div className={"reference-grid " + (mode === "replace" ? "is-replace" : "")}>
                <div className="reference-slot">
                  <div className="slot-topline">
                    <span className="field-label">{mode === "replace" ? "替換人物參考圖" : "參考圖片（可選）"}</span>
                    <span className="slot-hint">IMAGE</span>
                  </div>
                  {referenceImage ? (
                    <div className="selected-media">
                      <AssetThumb asset={referenceImage} />
                      <div className="selected-media-info">
                        <strong>{referenceImage.name}</strong>
                        <span>{formatBytes(referenceImage.size)} · input</span>
                      </div>
                      <button type="button" onClick={() => setReferenceImage(null)} aria-label="移除參考圖片"><Icon name="close" /></button>
                    </div>
                  ) : (
                    <button type="button" className="drop-zone" onClick={() => imageInputRef.current?.click()}>
                      <span className="drop-icon"><Icon name="image" /></span>
                      <span><strong>拖曳或選擇圖片</strong><small>PNG, JPG, WEBP</small></span>
                      <span className="drop-plus"><Icon name="plus" /></span>
                    </button>
                  )}
                  <input ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => onFileChange(event, "image")} />
                </div>
                {mode === "replace" && (
                  <div className="reference-slot">
                    <div className="slot-topline">
                      <span className="field-label">來源動作影片</span>
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
                    onClick={() => setAssetFilter(filter)}
                  >
                    {filter === "all" ? "全部" : filter === "image" ? "圖片" : "影片"}
                  </button>
                ))}
              </div>
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
                      <div className="asset-grid">
                        {group.assets.slice(0, 12).map((asset) => (
                          <article
                            className={"asset-card " + (selectedAsset?.root === asset.root && selectedAsset.name === asset.name ? "is-selected" : "")}
                            key={asset.root + ":" + asset.name}
                          >
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
                            </div>
                          </article>
                        ))}
                      </div>
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
            <p className="asset-preview-hint">按 Esc 或右上角的關閉按鈕即可關閉預覽。</p>
          </section>
        </div>
      )}

      {toast && (
        <div className={"toast toast-" + toast.tone} role="status">
          <span className="toast-mark">{toast.tone === "success" ? "✓" : toast.tone === "error" ? "!" : "·"}</span>
          {toast.message}
        </div>
      )}
    </main>
  );
}
