"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AssetPickerButton } from "../library/AssetPickerButton";
import { assetKey, assetUrl, deleteAsset, type StudioAsset, uploadAssets } from "../library/asset-client";
import {
    fetchImg2ImgHealth,
    fetchImg2ImgJob,
    fetchImg2ImgJobs,
    cancelImg2ImgJob,
    fetchImg2ImgLoras,
    fetchImg2ImgRuntime,
    img2ImgReadinessMessage,
    isImg2ImgActive,
    isImg2ImgRetryable,
    Img2ImgApiError,
    submitImg2Img,
    retryImg2ImgJob,
    type Img2ImgHealth,
    type Img2ImgItem,
    type Img2ImgJob,
    type Img2ImgRandomRanges,
    type Img2ImgRuntimeMode,
    type Img2ImgSubmitInput,
} from "./img2img-client";
import { ACTION_LABELS, FIELD_LABELS, jobStatusLabel, readinessLabel, sourceLabel } from "../../lib/ui-copy.mjs";
import styles from "./ImageToImageWorkspace.module.css";

const IMG2IMG_MODELS = [
    {
        value: "sd_xl_turbo_1.0_fp16.safetensors",
        label: "SDXL Turbo 1.0 FP16",
        note: "快速預覽 · 建議 4 steps / CFG 1",
        steps: "4",
        cfg: "1",
        denoise: 0.65,
        loraFamily: "SDXL",
        loraHint: "僅支援 SDXL LoRA；真人起始 0.55–0.75，動漫 0.7–0.9。",
        localOnly: false,
    },
    {
        value: "v1-5-pruned-emaonly-fp16.safetensors",
        label: "Stable Diffusion 1.5 FP16",
        note: "細節調整 · 建議 20 steps / CFG 7",
        steps: "20",
        cfg: "7",
        denoise: 0.65,
        loraFamily: "SD1.5",
        loraHint: "僅支援 SD1.5 LoRA；真人起始 0.55–0.75，動漫 0.7–0.9。",
        localOnly: false,
    },
    {
        value: "z_image_turbo_bf16.safetensors",
        label: "Z-Image Turbo／真人",
        note: "真人寫實 · 建議 9 steps / CFG 1 · 僅限本機",
        steps: "9",
        cfg: "1",
        denoise: 0.33,
        loraFamily: "Z-Image",
        loraHint: "僅支援以 Z-Image 訓練的 LoRA；真人起始 0.55–0.75，動漫 0.7–0.9。",
        localOnly: true,
    },
    {
        value: "waiIllustriousSDXL_v170.safetensors",
        label: "WAI Illustrious SDXL／動漫",
        note: "動漫插畫 · 建議 20 steps / CFG 7 · 僅限本機",
        steps: "20",
        cfg: "7",
        denoise: 0.65,
        loraFamily: "SDXL",
        loraHint: "僅支援 SDXL LoRA；真人起始 0.55–0.75，動漫 0.7–0.9。",
        localOnly: true,
    },
] as const;

const IMG2IMG_PROMPT_MODEL_STORAGE_KEY = "h3-studio.img2img-prompt-model";

type ModelValue = typeof IMG2IMG_MODELS[number]["value"];

type PromptHealth = {
    ollama?: {
        online?: boolean;
        models?: string[];
    };
};

type PromptApiPayload = {
    prompt?: string;
    negativePrompt?: string;
    error?: string | { code?: string; message?: string };
    code?: string;
};

const DEFAULT_IMG2IMG_MODEL = IMG2IMG_MODELS[0];

type RandomRangeKey = "denoise" | "steps" | "cfg";
type BaseValueKey = RandomRangeKey | "seed";
type RangeDraft = Record<RandomRangeKey, { min: string; max: string }>;
type RangeTouched = Record<RandomRangeKey, boolean>;

const RANGE_BOUNDS: Record<RandomRangeKey, { min: number; max: number; step: number; integer?: boolean }> = {
    denoise: { min: 0.01, max: 1, step: 0.01 },
    steps: { min: 1, max: 50, step: 1, integer: true },
    cfg: { min: 0, max: 20, step: 0.5 },
};

function baseRangeDraft(denoise: number, steps: string, cfg: string): RangeDraft {
    return {
        denoise: { min: String(denoise), max: String(denoise) },
        steps: { min: steps, max: steps },
        cfg: { min: cfg, max: cfg },
    };
}

function toRandomRanges(draft: RangeDraft): Img2ImgRandomRanges {
    return {
        denoise: { min: Number(draft.denoise.min), max: Number(draft.denoise.max) },
        steps: { min: Number(draft.steps.min), max: Number(draft.steps.max) },
        cfg: { min: Number(draft.cfg.min), max: Number(draft.cfg.max) },
    };
}

function itemParameter(item: Img2ImgItem, key: BaseValueKey, fallback: number) {
    const value = item.parameters?.[key];
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function itemStatusLabel(status: string) {
    return jobStatusLabel(status, "img2img");
}

function modelOption(value: string) {
    return IMG2IMG_MODELS.find((item) => item.value === value);
}

function modelAllowedForRuntime(value: string, runtimeMode: Img2ImgRuntimeMode | null) {
    const option = modelOption(value);
    return !option?.localOnly || runtimeMode === "local";
}

async function fetchPromptHealth(): Promise<PromptHealth | null> {
    try {
        const response = await fetch("/app/api/health", { cache: "no-store" });
        if (!response.ok) return null;
        return await response.json() as PromptHealth;
    } catch {
        return null;
    }
}

function explicitStoredPromptModel(availableModels: readonly string[]) {
    if (!availableModels.length || typeof window === "undefined") return "";
    try {
        const model = window.localStorage.getItem(IMG2IMG_PROMPT_MODEL_STORAGE_KEY)?.trim() || "";
        return availableModels.includes(model) ? model : "";
    } catch {
        return "";
    }
}

function persistExplicitPromptModel(model: string) {
    if (typeof window === "undefined") return;
    try {
        if (model) window.localStorage.setItem(IMG2IMG_PROMPT_MODEL_STORAGE_KEY, model);
        else window.localStorage.removeItem(IMG2IMG_PROMPT_MODEL_STORAGE_KEY);
    } catch {
        // Keep the current selection in memory when storage is unavailable.
    }
}

function modelSupportsPromptImages(model: string) {
    const normalized = model.toLowerCase();
    if (normalized === "gemma3:1b") return false;
    return normalized.includes("-vl") || normalized.includes("gemma3") || normalized.includes("gemma4") || normalized.includes("gemma3n");
}

const LOCAL_ONLY_MODEL_MESSAGE = "Z-Image Turbo 與 WAI Illustrious SDXL 僅限本機執行環境。";

function parseNumberDraft(raw: string, label: string, min: number, max: number, integer = false, step?: number) {
    if (!raw.trim()) return `${label} 必須填寫。`;
    const value = Number(raw);
    const aligned = step === undefined || Math.abs((value - min) / step - Math.round((value - min) / step)) <= 1e-8;
    if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max || !aligned) {
        if (Number.isFinite(value) && aligned === false && value >= min && value <= max) return `${label} 必須符合步進值 ${step}。`;
        return `${label} 必須介於 ${min} 與 ${max}${integer ? " 的整數" : ""}。`;
    }
    return null;
}

function characterLoraNameError(raw: string) {
    const normalized = raw.trim().replaceAll("\\", "/");
    if (!normalized) return null;
    const segments = normalized.split("/");
    if (
        normalized.length > 512
        || normalized.startsWith("/")
        || /^[A-Za-z]:/.test(normalized)
        || normalized.includes("\0")
        || segments.some((segment) => !segment || segment === "." || segment === ".." || /[<>:"|?*]/.test(segment))
    ) {
        return "角色 LoRA 必須是 ComfyUI/models/loras 下的安全相對路徑。";
    }
    return null;
}

function errorMessage(reason: unknown, fallback: string) {
    return reason instanceof Error ? reason.message : fallback;
}

function apiErrorMessage(payload: PromptApiPayload, fallback: string) {
    const message = typeof payload.error === "string"
        ? payload.error
        : payload.error?.message || fallback;
    const code = payload.code || (typeof payload.error === "object" ? payload.error?.code : "");
    return code ? `${code}: ${message}` : message;
}

function localizedJobStatusLabel(job: Img2ImgJob | null) {
    if (!job) return "尚未開始生成";
    const label = jobStatusLabel(job.status, "img2img");
    return job.stage ? `${label} · ${job.stage}` : label;
}

export function ImageToImageWorkspace() {
    // `source` is the required character/reference image.  `poseReference`
    // is deliberately independent and optional so legacy source-only jobs
    // keep the exact same request shape.
    const [source, setSource] = useState<StudioAsset | null>(null);
    const [poseReference, setPoseReference] = useState<StudioAsset | null>(null);
    const [promptDescription, setPromptDescription] = useState("");
    const [prompt, setPrompt] = useState("");
    const [negativePrompt, setNegativePrompt] = useState("");
    const [promptModel, setPromptModel] = useState("");
    const [promptHealth, setPromptHealth] = useState<PromptHealth | null>(null);
    const [promptBusy, setPromptBusy] = useState(false);
    const [model, setModel] = useState<ModelValue>(IMG2IMG_MODELS[0].value);
    const [denoise, setDenoise] = useState(0.65);
    const [steps, setSteps] = useState("4");
    const [cfg, setCfg] = useState("1");
    const [seed, setSeed] = useState("12345");
    const [characterLoraName, setCharacterLoraName] = useState("");
    const [characterLoraStrength, setCharacterLoraStrength] = useState("0.75");
    const [characterLoraRegistry, setCharacterLoraRegistry] = useState<{
        model: ModelValue;
        values: string[];
        status: "idle" | "loading" | "ready" | "empty" | "error";
        error?: string;
    }>(() => ({
        model: IMG2IMG_MODELS[0].value,
        values: [],
        status: "idle",
    }));
    const [batchCount, setBatchCount] = useState("1");
    const [randomRanges, setRandomRanges] = useState<RangeDraft>(() => baseRangeDraft(0.65, "4", "1"));
    const [rangeTouched, setRangeTouched] = useState<RangeTouched>({ denoise: false, steps: false, cfg: false });
    const [job, setJob] = useState<Img2ImgJob | null>(null);
    const [history, setHistory] = useState<Img2ImgJob[]>([]);
    const [historyQuery, setHistoryQuery] = useState("");
    const [historyLoading, setHistoryLoading] = useState(false);
    const [historyError, setHistoryError] = useState("");
    const [expandedHistory, setExpandedHistory] = useState<Record<string, boolean>>({});
    const [health, setHealth] = useState<Img2ImgHealth | null>(null);
    const [runtimeMode, setRuntimeMode] = useState<Img2ImgRuntimeMode | null>(null);
    const [healthLoading, setHealthLoading] = useState(true);
    const [healthError, setHealthError] = useState("");
    const [uploading, setUploading] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [retrying, setRetrying] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [error, setError] = useState("");
    const [submitAttempted, setSubmitAttempted] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const poseInputRef = useRef<HTMLInputElement>(null);
    const loraRequestIdRef = useRef(0);

    const updateBaseValue = useCallback((key: BaseValueKey, value: string | number) => {
        const next = String(value);
        if (key === "denoise") setDenoise(Number(value));
        if (key === "steps") setSteps(next);
        if (key === "cfg") setCfg(next);
        if (key === "seed") setSeed(next);
        if (key === "seed") return;
        setRandomRanges((previous) => rangeTouched[key]
            ? previous
            : { ...previous, [key]: { min: next, max: next } });
    }, [rangeTouched]);

    function updateRandomRange(key: RandomRangeKey, side: "min" | "max", value: string) {
        setRangeTouched((previous) => ({ ...previous, [key]: true }));
        setRandomRanges((previous) => ({ ...previous, [key]: { ...previous[key], [side]: value } }));
    }

    const refreshHealth = useCallback(async () => {
        setHealthLoading(true);
        const [readinessResult, runtimeResult, promptResult] = await Promise.allSettled([
            fetchImg2ImgHealth(),
            fetchImg2ImgRuntime(),
            fetchPromptHealth(),
        ]);
        if (readinessResult.status === "fulfilled") {
            setHealth(readinessResult.value);
            setHealthError("");
        } else {
            setHealthError(errorMessage(readinessResult.reason, "無法取得 ComfyUI 檢查結果。"));
        }
        if (runtimeResult.status === "fulfilled") {
            setRuntimeMode(runtimeResult.value);
            if (runtimeResult.value !== "local" && modelOption(model)?.localOnly) {
                setModel(DEFAULT_IMG2IMG_MODEL.value);
                updateBaseValue("denoise", DEFAULT_IMG2IMG_MODEL.denoise);
                updateBaseValue("steps", DEFAULT_IMG2IMG_MODEL.steps);
                updateBaseValue("cfg", DEFAULT_IMG2IMG_MODEL.cfg);
            }
        } else {
            // Keep local-only checkpoints hidden until runtime can be proven local.
            setRuntimeMode(null);
            if (modelOption(model)?.localOnly) {
                setModel(DEFAULT_IMG2IMG_MODEL.value);
                updateBaseValue("denoise", DEFAULT_IMG2IMG_MODEL.denoise);
                updateBaseValue("steps", DEFAULT_IMG2IMG_MODEL.steps);
                updateBaseValue("cfg", DEFAULT_IMG2IMG_MODEL.cfg);
            }
        }
        if (promptResult.status === "fulfilled") setPromptHealth(promptResult.value);
        setHealthLoading(false);
    }, [model, updateBaseValue]);

    useEffect(() => {
        const initialTimer = window.setTimeout(() => void refreshHealth(), 0);
        const timer = window.setInterval(() => void refreshHealth(), 10000);
        return () => {
            window.clearTimeout(initialTimer);
            window.clearInterval(timer);
        };
    }, [refreshHealth]);

    useEffect(() => {
        const availableModels = promptHealth?.ollama?.models || [];
        const storedModel = explicitStoredPromptModel(availableModels);
        const timer = window.setTimeout(() => {
            setPromptModel((current) => {
                if (!availableModels.length) return "";
                if (availableModels.includes(current)) return current;
                return storedModel;
            });
        }, 0);
        return () => window.clearTimeout(timer);
    }, [promptHealth]);

    useEffect(() => {
        const requestId = ++loraRequestIdRef.current;
        let active = true;
        void fetchImg2ImgLoras(model)
            .then((values) => {
                if (!active || loraRequestIdRef.current !== requestId) return;
                setCharacterLoraRegistry({ model, values, status: values.length ? "ready" : "empty" });
                setCharacterLoraName((current) => current && values.includes(current) ? current : "");
            })
            .catch((reason) => {
                if (active && loraRequestIdRef.current === requestId) {
                    setCharacterLoraRegistry({
                        model,
                        values: [],
                        status: "error",
                        error: errorMessage(reason, "Unable to load available character LoRAs."),
                    });
                    setCharacterLoraName("");
                }
            });
        return () => {
            active = false;
        };
    }, [model]);

    const refreshHistory = useCallback(async (query = "") => {
        setHistoryLoading(true);
        try {
            const records = await fetchImg2ImgJobs(query);
            const sorted = records.slice().sort((a, b) => String(b.completedAt || b.createdAt || b.startedAt || "").localeCompare(String(a.completedAt || a.createdAt || a.startedAt || "")));
            setHistory(sorted);
            setHistoryError("");
        } catch (reason) {
            setHistoryError(errorMessage(reason, "無法載入以圖生圖歷史紀錄。"));
        } finally {
            setHistoryLoading(false);
        }
    }, []);

    useEffect(() => {
        const timer = window.setTimeout(() => void refreshHistory(), 0);
        return () => window.clearTimeout(timer);
    }, [refreshHistory]);

    useEffect(() => {
        const timer = window.setTimeout(() => void refreshHistory(historyQuery), 250);
        return () => window.clearTimeout(timer);
    }, [historyQuery, refreshHistory]);

    const trackedJobId = job?.id;
    const trackedJobStatus = job?.status;
    useEffect(() => {
        if (!trackedJobId || !["queued", "running", "cancelling"].includes(trackedJobStatus || "")) return;
        let active = true;
        const poll = async () => {
            try {
                const next = await fetchImg2ImgJob(trackedJobId);
                if (active) {
                    setJob(next);
                    if (next.status === "partial") setError(next.error || "部分批次圖片生成失敗。");
                    if (next.status === "failed") setError(next.error || "以圖生圖失敗。 ");
                }
            } catch (reason) {
                if (active) setError(errorMessage(reason, "無法更新以圖生圖進度。"));
            }
        };
        void poll();
        const timer = window.setInterval(() => void poll(), 1500);
        return () => {
            active = false;
            window.clearInterval(timer);
        };
    }, [trackedJobId, trackedJobStatus]);

    useEffect(() => {
        if (!trackedJobId || !["completed", "failed", "partial", "cancelled", "interrupted"].includes(trackedJobStatus || "")) return;
        const timer = window.setTimeout(() => void refreshHistory(historyQuery), 0);
        return () => window.clearTimeout(timer);
    }, [trackedJobId, trackedJobStatus, historyQuery, refreshHistory]);

    const selectedKey = useMemo(() => (source ? [assetKey(source)] : []), [source]);
    const poseSelectedKey = useMemo(() => (poseReference ? [assetKey(poseReference)] : []), [poseReference]);
    const visibleModels = runtimeMode === "local"
        ? IMG2IMG_MODELS
        : IMG2IMG_MODELS.filter((item) => !item.localOnly);
    const selectedModel = modelOption(model);
    const characterLoraOptions = characterLoraRegistry.model === model ? characterLoraRegistry.values : [];
    const characterLoraDiscoveryStatus = characterLoraRegistry.model === model
        ? characterLoraRegistry.status === "idle" ? "loading" : characterLoraRegistry.status
        : "loading";
    const characterLoraDiscoveryError = characterLoraRegistry.model === model ? characterLoraRegistry.error : undefined;
    const characterLoraNameIssue = characterLoraNameError(characterLoraName);
    const characterLoraStrengthIssue = characterLoraName.trim()
        ? parseNumberDraft(characterLoraStrength, FIELD_LABELS.loraStrength, 0, 2, false, 0.05)
        : null;
    const visiblePromptModels = promptHealth?.ollama?.models || [];
    const effectivePromptModel = visiblePromptModels.includes(promptModel)
        ? promptModel
        : "";
    const promptProviderReady = Boolean(promptHealth?.ollama?.online && visiblePromptModels.includes(effectivePromptModel));
    const promptGenerationReady = Boolean(effectivePromptModel && promptProviderReady && modelSupportsPromptImages(effectivePromptModel));
    const modelRuntimeReady = modelAllowedForRuntime(model, runtimeMode);
    const characterLoraRequested = Boolean(characterLoraName.trim());
    const characterLoraReady = !characterLoraRequested || Boolean(health?.profiles?.[model]?.loraAvailable);
    const characterLoraReadinessMessage = characterLoraRequested && health && !characterLoraReady
        ? `ComfyUI 未提供此模型所需的 LoRA 載入器（${health.profiles?.[model]?.loraLoader || "未指定"}）。`
        : "";
    const optionAvailable = (value: string) => {
        if (healthLoading) return true;
        return health?.models?.[value] === true;
    };
    const readinessBlockingMessage = !modelRuntimeReady
        ? LOCAL_ONLY_MODEL_MESSAGE
        : characterLoraReadinessMessage || (health ? img2ImgReadinessMessage(health, model) : "");
    const readinessMessage = readinessBlockingMessage || (health ? "ComfyUI、必要節點與所選模型設定檔均可用。" : "尚未取得 ComfyUI 檢查結果；提交時會再次檢查。 ");
    const modelReady = modelRuntimeReady && Boolean(health && health.models?.[model] === true);
    const readinessState = healthLoading ? "checking" : health?.ready && modelReady && characterLoraReady ? "ready" : "blocked";
    const active = isImg2ImgActive(job);
    const canCancel = Boolean(job && (job.status === "queued" || job.status === "running") && !cancelling && !retrying);
    const progress = Math.min(100, Math.max(0, Math.round(Number(job?.progress) || 0)));
    const batchTotal = Math.max(1, Math.min(20, Number(job?.batchCount || batchCount) || 1));
    const completedCount = Number.isFinite(Number(job?.completedCount)) ? Number(job?.completedCount) : 0;
    const failedCount = Number.isFinite(Number(job?.failedCount)) ? Number(job?.failedCount) : 0;
    const isBatchJob = Boolean(job?.items?.length || batchTotal > 1 || Number(batchCount) > 1);
    const filteredHistory = useMemo(() => {
        const needle = historyQuery.trim().toLowerCase();
        if (!needle) return history;
        return history.filter((record) => {
            const itemParameters = (record.items || []).map((item) => {
                const itemDenoise = itemParameter(item, "denoise", Number(record.denoise));
                const itemSteps = itemParameter(item, "steps", Number(record.steps));
                const itemCfg = itemParameter(item, "cfg", Number(record.cfg));
                const itemSeed = itemParameter(item, "seed", Number(record.seed));
                return `重繪強度 ${itemDenoise} 採樣步數 ${itemSteps} CFG ${itemCfg} 隨機種子 ${itemSeed}`;
            }).join(" ");
            const baseParameters = `重繪強度 ${record.denoise} 採樣步數 ${record.steps} CFG ${record.cfg} 隨機種子 ${record.seed}`;
            return `${record.id} ${record.prompt} ${record.model} ${record.characterLoraName || ""} ${record.characterLoraStrength ?? ""} ${baseParameters} ${itemParameters}`.toLowerCase().includes(needle);
        });
    }, [history, historyQuery]);
    const canRetry = isImg2ImgRetryable(job) && !retrying && modelAllowedForRuntime(model, runtimeMode);
    const sourceReady = Boolean(source && source.kind === "image");
    const readinessReady = !healthLoading && health?.ready === true && modelReady && characterLoraReady;
    const canInteract = !active && !submitting && !retrying && !uploading;
    const canStart = sourceReady && modelRuntimeReady && readinessReady;

    function selectSource(assets: StudioAsset[]) {
        const next = assets.find((asset) => asset.kind === "image");
        if (!next) return;
        setSource(next);
        setJob(null);
        setError("");
    }

    function selectPoseReference(assets: StudioAsset[]) {
        const next = assets.find((asset) => asset.kind === "image");
        if (!next) return;
        setPoseReference(next);
        setJob(null);
        setError("");
    }

    async function uploadSource(event: ChangeEvent<HTMLInputElement>) {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        setUploading(true);
        setError("");
        try {
            const [asset] = await uploadAssets([file]);
            if (!asset || asset.kind !== "image") throw new Error("請選擇 PNG、JPG 或 WEBP 圖片。 ");
            setSource(asset);
            setJob(null);
        } catch (reason) {
            setError(errorMessage(reason, "圖片上傳失敗。"));
        } finally {
            setUploading(false);
        }
    }

    async function uploadPoseReference(event: ChangeEvent<HTMLInputElement>) {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        setUploading(true);
        setError("");
        try {
            const [asset] = await uploadAssets([file]);
            if (!asset || asset.kind !== "image") throw new Error("Pose reference must be a PNG, JPG, or WEBP image.");
            setPoseReference(asset);
            setJob(null);
        } catch (reason) {
            setError(errorMessage(reason, "Unable to upload pose reference."));
        } finally {
            setUploading(false);
        }
    }

    function updateModel(value: ModelValue) {
        const next = modelOption(value) || DEFAULT_IMG2IMG_MODEL;
        if (next.value !== model) setCharacterLoraName("");
        setModel(next.value);
        setDenoise(next.denoise);
        setSteps(next.steps);
        setCfg(next.cfg);
        updateBaseValue("denoise", next.denoise);
        updateBaseValue("steps", next.steps);
        updateBaseValue("cfg", next.cfg);
    }

    async function generatePrompt() {
        if (!source || source.kind !== "image") {
            setError("請先選擇來源圖片。");
            return;
        }
        if (!promptDescription.trim()) {
            setError("請先輸入圖片轉換描述。");
            return;
        }
        if (!effectivePromptModel) {
            setError("請先選擇 Ollama 視覺模型，再產生提示詞。" );
            return;
        }
        if (!promptProviderReady) {
            setError("Ollama 無法使用，或尚未安裝提示詞模型。");
            return;
        }
        if (!modelSupportsPromptImages(effectivePromptModel)) {
            setError(`提示詞模型 ${effectivePromptModel} 不支援圖片理解，請選擇視覺模型。`);
            return;
        }
        if (promptBusy || uploading || submitting || retrying || active) return;

        setPromptBusy(true);
        setError("");
        try {
            const response = await fetch("/app/api/prompt", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    provider: "ollama",
                    model: effectivePromptModel,
                    mode: "img2img",
                    brief: promptDescription.trim(),
                    images: [{
                        role: "source_image",
                        data: await assetToPromptImage(source),
                    }],
                }),
            });
            const payload = await response.json().catch(() => ({})) as PromptApiPayload;
            if (!response.ok) throw new Error(apiErrorMessage(payload, "Ollama 沒有回傳提示詞。"));
            setPrompt(typeof payload.prompt === "string" ? payload.prompt.trim() : "");
            setNegativePrompt(typeof payload.negativePrompt === "string" ? payload.negativePrompt.trim() : "");
        } catch (reason) {
            setError(errorMessage(reason, "無法產生以圖生圖提示詞。"));
        } finally {
            setPromptBusy(false);
        }
    }

    function randomizeSeed() {
        const values = new Uint32Array(1);
        if (globalThis.crypto?.getRandomValues) {
            globalThis.crypto.getRandomValues(values);
            setSeed(String(values[0] % 2147483648));
            return;
        }
        const next = String(Math.floor(Math.random() * 2147483648));
        setSeed(next);
    }

    function validateForm() {
        if (!source || source.kind !== "image") return "請先選擇來源圖片。";
        if (characterLoraNameIssue) return characterLoraNameIssue;
        if (characterLoraStrengthIssue) return characterLoraStrengthIssue;
        if (!modelRuntimeReady) return LOCAL_ONLY_MODEL_MESSAGE;
        if (!readinessReady) return readinessBlockingMessage || "尚未取得可用的 ComfyUI 檢查結果或所選模型設定檔。";
        if (readinessBlockingMessage) return readinessBlockingMessage;
        const batchError = parseNumberDraft(batchCount, "生成張數", 1, 20, true);
        if (batchError) return batchError;
        for (const key of Object.keys(RANGE_BOUNDS) as RandomRangeKey[]) {
            const bounds = RANGE_BOUNDS[key];
            const draft = randomRanges[key];
            const minError = parseNumberDraft(draft.min, `${FIELD_LABELS[key === "denoise" ? "denoise" : key === "steps" ? "steps" : "cfg"]} 最小值`, bounds.min, bounds.max, bounds.integer, bounds.step);
            if (minError) return minError;
            const maxError = parseNumberDraft(draft.max, `${FIELD_LABELS[key === "denoise" ? "denoise" : key === "steps" ? "steps" : "cfg"]} 最大值`, bounds.min, bounds.max, bounds.integer, bounds.step);
            if (maxError) return maxError;
            if (Number(draft.min) > Number(draft.max)) return `${FIELD_LABELS[key === "denoise" ? "denoise" : key === "steps" ? "steps" : "cfg"]} 的最小值不可大於最大值。`;
        }
        const denoiseError = parseNumberDraft(String(denoise), "重繪強度", 0.01, 1);
        if (denoiseError) return denoiseError;
        const stepsError = parseNumberDraft(steps, FIELD_LABELS.steps, 1, 50, true);
        if (stepsError) return stepsError;
        const cfgError = parseNumberDraft(cfg, "CFG", 0, 20);
        if (cfgError) return cfgError;
        return parseNumberDraft(seed, FIELD_LABELS.seed, 0, 2147483647, true);
    }

    function firstValidationField() {
        if (!source || source.kind !== "image") return "source";
        if (characterLoraNameIssue) return "characterLoraName";
        if (characterLoraStrengthIssue) return "characterLoraStrength";
        if (!modelRuntimeReady || !readinessReady || readinessBlockingMessage) return "readiness";
        if (parseNumberDraft(batchCount, "生成張數", 1, 20, true)) return "batchCount";
        for (const key of Object.keys(RANGE_BOUNDS) as RandomRangeKey[]) {
            const bounds = RANGE_BOUNDS[key];
            const draft = randomRanges[key];
            const fieldLabel = FIELD_LABELS[key === "denoise" ? "denoise" : key === "steps" ? "steps" : "cfg"];
            if (parseNumberDraft(draft.min, `${fieldLabel} 最小值`, bounds.min, bounds.max, bounds.integer, bounds.step)) return `${key}Min`;
            if (parseNumberDraft(draft.max, `${fieldLabel} 最大值`, bounds.min, bounds.max, bounds.integer, bounds.step)) return `${key}Max`;
            if (Number(draft.min) > Number(draft.max)) return `${key}Min`;
        }
        if (parseNumberDraft(String(denoise), "重繪強度", 0.01, 1)) return "denoise";
        if (parseNumberDraft(steps, FIELD_LABELS.steps, 1, 50, true)) return "steps";
        if (parseNumberDraft(cfg, "CFG", 0, 20)) return "cfg";
        if (parseNumberDraft(seed, FIELD_LABELS.seed, 0, 2147483647, true)) return "seed";
        return "";
    }

    function requestBody(): Img2ImgSubmitInput {
        const sourceRoot = source?.root;
        if (sourceRoot && !isImg2ImgAssetRoot(sourceRoot)) {
            throw new Error("以圖生圖只支援素材或生成結果。" );
        }
        return {
            sourceName: source?.name || "",
            sourceRoot: sourceRoot || "input",
            ...(poseReference
                ? { poseName: poseReference.name, poseRoot: isImg2ImgAssetRoot(poseReference.root) ? poseReference.root : "input" }
                : {}),
            prompt: prompt.trim(),
            negativePrompt: negativePrompt.trim(),
            model,
            ...(characterLoraName.trim()
                ? { characterLoraName: characterLoraName.trim(), characterLoraStrength: Number(characterLoraStrength) }
                : {}),
            denoise: Number(denoise),
            steps: Number(steps),
            cfg: Number(cfg),
            seed: Number(seed),
            batchCount: Number(batchCount),
            randomRanges: toRandomRanges(randomRanges),
        } as const;
    }

    async function start() {
        const validationError = validateForm();
        setSubmitAttempted(true);
        if (validationError) {
            setError(validationError);
            focusImg2ImgValidation(firstValidationField());
            return;
        }
        if (submitting || retrying || uploading || active) {
            return;
        }
        setSubmitting(true);
        setError("");
        try {
            const next = await submitImg2Img(requestBody());
            setJob(next);
            if (next.status === "failed") setError(next.error || "以圖生圖失敗。 ");
        } catch (reason) {
            if (reason instanceof Img2ImgApiError && reason.payload.health) setHealth(reason.payload.health);
            setError(errorMessage(reason, "無法啟動以圖生圖。"));
        } finally {
            setSubmitting(false);
        }
    }

    async function cancel() {
        if (!job || !canCancel) return;
        setCancelling(true);
        setError("");
        try {
            setJob(await cancelImg2ImgJob(job.id));
        } catch (reason) {
            setError(errorMessage(reason, "無法取消以圖生圖工作。"));
        } finally {
            setCancelling(false);
        }
    }

    async function retry() {
        if (!job || !canRetry) return;
        setRetrying(true);
        setError("");
        try {
            const next = await retryImg2ImgJob(job.id);
            setJob(next);
            if (next.status === "failed") setError(next.error || "以圖生圖失敗。 ");
        } catch (reason) {
            if (reason instanceof Img2ImgApiError && reason.payload.health) setHealth(reason.payload.health);
            setError(errorMessage(reason, "無法重試以圖生圖。"));
        } finally {
            setRetrying(false);
        }
    }

    async function removeOutput() {
        const output = job?.output;
        if (!output || deleting || active) return;
        setDeleting(true);
        setError("");
        try {
            await deleteAsset(output);
            setJob(null);
        } catch (reason) {
            setError(errorMessage(reason, "無法刪除以圖生圖結果。"));
        } finally {
            setDeleting(false);
        }
    }

    async function removeItemOutput(item: Img2ImgItem) {
        if (!item.output || deleting || active) return;
        setDeleting(true);
        setError("");
        try {
            await deleteAsset(item.output);
            setJob((previous) => previous
                ? { ...previous, items: previous.items?.map((candidate) => candidate.index === item.index ? { ...candidate, output: undefined } : candidate) }
                : previous);
        } catch (reason) {
            setError(errorMessage(reason, "無法刪除以圖生圖結果。"));
        } finally {
            setDeleting(false);
        }
    }

    return (
        <div className={styles.workspace}>
            <div className={styles.layout}>
                <section className={styles.panel} aria-labelledby="img2img-source-title">
                    <div className={styles.sectionHeader}>
                        <div>
                            <span className={styles.eyebrow}>角色參考圖</span>
                            <h2 id="img2img-source-title">角色參考圖（必填）</h2>
                        </div>
                        <span className={styles.sectionCode}>PNG · JPG · WEBP</span>
                    </div>
                    {source ? (
                        <div className={styles.sourcePreview}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={assetUrl(source)} alt={`以圖生圖來源：${source.name}`} />
                            <div className={styles.sourceMeta}>
                                <strong title={source.name}>{source.name}</strong>
                                <span>{sourceLabel(source.root)} · {source.mime || "圖片"}</span>
                                <button type="button" className={styles.secondaryButton} onClick={() => { setSource(null); setJob(null); setError(""); }}>移除來源</button>
                            </div>
                        </div>
                    ) : (
                        <div className={styles.emptySource}>
                            <strong>選擇或上傳角色參考圖</strong>
                            <span>角色參考圖是必要輸入，可從素材庫選擇或上傳圖片。</span>
                        </div>
                    )}
                    <div className={styles.sourceActions}>
                        <AssetPickerButton triggerId="img2img-source-picker" kind="image" selectedKeys={selectedKey} label={ACTION_LABELS.browseLibrary} onSelect={selectSource} />
                        <button type="button" className={styles.secondaryButton} onClick={() => inputRef.current?.click()} disabled={uploading}>
                            {uploading ? "上傳中…" : "上傳圖片"}
                        </button>
                        <input ref={inputRef} className={styles.hiddenInput} type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void uploadSource(event)} />
                    </div>
                    <div className={styles.sourceActions} aria-labelledby="img2img-pose-reference-title">
                        <div>
                            <strong id="img2img-pose-reference-title">姿勢參考圖（選填）</strong>
                            {poseReference && <span className={styles.helper}> {poseReference.name}</span>}
                        </div>
                        {poseReference && (
                            <button
                                type="button"
                                className={styles.secondaryButton}
                                onClick={() => { setPoseReference(null); setJob(null); setError(""); }}
                                disabled={active || uploading}
                            >
                                移除姿勢圖
                            </button>
                        )}
                        <AssetPickerButton
                            triggerId="img2img-pose-reference-picker"
                            kind="image"
                            selectedKeys={poseSelectedKey}
                            label={poseReference ? "替換姿勢參考圖" : "選擇姿勢參考圖"}
                            onSelect={selectPoseReference}
                        />
                        <button type="button" className={styles.secondaryButton} onClick={() => poseInputRef.current?.click()} disabled={uploading || active}>
                            上傳姿勢參考圖
                        </button>
                        <input ref={poseInputRef} className={styles.hiddenInput} type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void uploadPoseReference(event)} />
                    </div>
                </section>

                <section className={styles.panel} aria-labelledby="img2img-readiness-title">
                    <div className={styles.sectionHeader}>
                        <div>
                        <span className={styles.eyebrow}>ComfyUI 狀態</span>
                            <h2 id="img2img-readiness-title">執行環境</h2>
                        </div>
                        <span className={`${styles.statusChip} ${styles[readinessState]}`}>{readinessLabel(readinessState === "blocked" ? "needs_attention" : readinessState)}</span>
                    </div>
                    <p className={styles.helper} aria-live="polite" aria-atomic="true">{readinessMessage || "ComfyUI、必要節點與所選模型設定檔均可用。"}</p>
                    {healthError && <p className={styles.error} role="alert">{healthError}</p>}
                    <dl className={styles.readinessList}>
                        <div><dt>ComfyUI</dt><dd>{health?.comfyUi === false ? "未連線" : health?.comfyUi ? "已連線" : "—"}</dd></div>
                        <div><dt>模型</dt><dd>{modelReady ? "可用" : "缺少"}</dd></div>
                        <div><dt>節點</dt><dd>{Object.values(health?.nodes || {}).filter(Boolean).length}/{Object.keys(health?.nodes || {}).length || "—"}</dd></div>
                    </dl>
                    <button type="button" className={styles.textButton} onClick={() => void refreshHealth()} disabled={healthLoading}>{healthLoading ? "檢查中…" : "重新檢查"}</button>
                </section>
            </div>

            <section className={styles.panel} aria-labelledby="img2img-prompt-title">
                <div className={styles.sectionHeader}>
                    <div>
                        <span className={styles.eyebrow}>提示詞</span>
                        <h2 id="img2img-prompt-title">提示詞與設定</h2>
                    </div>
                    <span className={styles.sectionCode}>以圖生圖</span>
                </div>
                <div className={styles.formGrid}>
                    <label className={styles.fieldWide}>
                        <span>給 Ollama 的提示詞描述</span>
                        <textarea
                            id="img2img-description"
                            value={promptDescription}
                            maxLength={4000}
                            rows={3}
                            placeholder="描述來源圖片要如何轉換。"
                            aria-describedby="img2img-description-help"
                            onChange={(event) => { setPromptDescription(event.target.value); if (error) setError(""); }}
                        />
                        <small id="img2img-description-help">
                            Ollama 會分析來源圖片並產生正面與負面提示詞。
                            {promptProviderReady ? ` 模型：${effectivePromptModel}` : " 視覺模型無法使用。"}
                        </small>
                    </label>
                    <label className={styles.field}>
                        <span>Ollama 提示詞模型</span>
                        <select
                            id="img2img-prompt-model"
                            value={effectivePromptModel}
                            disabled={!visiblePromptModels.length || promptBusy || active}
                            onChange={(event) => {
                                const nextModel = event.target.value;
                                setPromptModel(nextModel);
                                persistExplicitPromptModel(nextModel);
                            }}
                        >
                            {visiblePromptModels.length > 0 && <option value="">請選擇 Ollama 模型</option>}
                            {!visiblePromptModels.length && <option value="">沒有可用模型</option>}
                            {visiblePromptModels.map((modelName) => <option key={modelName} value={modelName}>{modelName}</option>)}
                        </select>
                        {visiblePromptModels.length > 0 && !effectivePromptModel && <small className={styles.error} role="status">請先選擇 Ollama 視覺模型，才能產生提示詞。</small>}
                        <small>產生以圖生圖提示詞時會使用此 Ollama 模型；需支援圖片理解。</small>
                    </label>
                    <button
                        type="button"
                        className={styles.secondaryButton}
                        onClick={() => void generatePrompt()}
                        disabled={!promptGenerationReady || promptBusy || uploading || submitting || retrying || active}
                        aria-busy={promptBusy}
                    >
                        {promptBusy ? "產生提示詞中…" : "使用 Ollama 產生提示詞"}
                    </button>
                    <label className={styles.fieldWide}>
                        <span>{FIELD_LABELS.prompt}（選填）</span>
                        <textarea id="img2img-prompt" value={prompt} rows={5} placeholder="描述希望結果呈現的主體、風格、光線與細節" onChange={(event) => { setPrompt(event.target.value); if (error) setError(""); }} />
                        <small>{prompt.length} 字元</small>
                    </label>
                    <label className={styles.fieldWide}>
                        <span>{FIELD_LABELS.negativePrompt}（選填）</span>
                        <textarea id="img2img-negative-prompt" value={negativePrompt} rows={3} placeholder="模糊、低畫質、瑕疵" onChange={(event) => setNegativePrompt(event.target.value)} />
                    </label>
                    <label className={styles.field}>
                        <span>{FIELD_LABELS.model}</span>
                        <select id="img2img-model" value={model} disabled={active} onChange={(event) => updateModel(event.target.value as ModelValue)}>
                            {visibleModels.map((item) => {
                                const available = optionAvailable(item.value);
                                return <option key={item.value} value={item.value} disabled={!available}>{item.label}{available ? "" : " · 無法使用"}</option>;
                            })}
                        </select>
                        <small>{selectedModel?.note || "尚未選擇可用模型。"}</small>
                        {runtimeMode !== "local" && <small>本機限定模型會在本機執行環境就緒後顯示。</small>}
                    </label>
                    <label className={styles.field}>
                        <span>角色 LoRA <em>（選填）</em></span>
                        <select
                            id="img2img-character-lora"
                            value={characterLoraName}
                            disabled={active || characterLoraDiscoveryStatus === "loading"}
                            aria-describedby={`img2img-character-lora-help${characterLoraDiscoveryError ? " img2img-character-lora-discovery-error" : characterLoraNameIssue ? " img2img-character-lora-error" : ""}`}
                            aria-invalid={Boolean(characterLoraNameIssue)}
                            onChange={(event) => setCharacterLoraName(event.target.value)}
                        >
                            <option value="">不使用角色 LoRA</option>
                            {characterLoraDiscoveryStatus === "loading" && <option value="" disabled>正在載入角色 LoRA…</option>}
                            {characterLoraOptions.map((name) => <option key={name} value={name}>{name}</option>)}
                            {characterLoraDiscoveryStatus === "empty" && <option value="" disabled>目前沒有可用的角色 LoRA</option>}
                            {characterLoraDiscoveryStatus === "error" && <option value="" disabled>無法載入角色 LoRA</option>}
                        </select>
                        <small id="img2img-character-lora-help">
                            {selectedModel?.loraHint || "請選擇以此模型系列訓練的 LoRA；Wan2.2 Animate LoRA 不相容。"}
                            {characterLoraDiscoveryStatus === "loading" ? " 正在探索既有角色 LoRA…" : characterLoraOptions.length ? " 請從既有角色 LoRA 清單選擇。" : "目前沒有可用角色 LoRA；可直接不使用此設定。"}
                        </small>
                        {characterLoraDiscoveryError && <small id="img2img-character-lora-discovery-error" className={styles.error} role="status">{characterLoraDiscoveryError} 可先不使用角色 LoRA，或稍後重試。</small>}
                        {characterLoraNameIssue && <small id="img2img-character-lora-error" className={styles.error} role="alert">{characterLoraNameIssue}</small>}
                    </label>
                    <label className={styles.field}>
                        <span>{FIELD_LABELS.loraStrength} <strong>{characterLoraStrength.trim() ? Number(characterLoraStrength).toFixed(2) : "—"}</strong></span>
                        <input
                            id="img2img-character-lora-strength"
                            type="number"
                            min="0"
                            max="2"
                            step="0.05"
                            value={characterLoraStrength}
                            disabled={active || !characterLoraName.trim()}
                            aria-describedby={`img2img-character-lora-strength-help${characterLoraStrengthIssue ? " img2img-character-lora-strength-error" : ""}`}
                            aria-invalid={Boolean(characterLoraStrengthIssue)}
                            onChange={(event) => setCharacterLoraStrength(event.target.value)}
                        />
                        <small id="img2img-character-lora-strength-help">
                            範圍 0–2，預設 0.75；移除 LoRA 名稱即可不使用此設定。
                        </small>
                        {characterLoraStrengthIssue && <small id="img2img-character-lora-strength-error" className={styles.error} role="alert">{characterLoraStrengthIssue}</small>}
                    </label>
                    <label className={styles.field}>
                        <span>{FIELD_LABELS.denoise} <strong>{denoise.toFixed(2)}</strong></span>
                        <input id="img2img-denoise" type="range" min="0.01" max="1" step="0.01" value={denoise} disabled={active} onChange={(event) => updateBaseValue("denoise", event.target.value)} />
                        <small>越高越偏離原圖；0.45–0.70 通常較平衡。</small>
                    </label>
                    <label className={styles.field}>
                        <span>{FIELD_LABELS.steps}</span>
                        <input id="img2img-steps" type="number" min="1" max="50" step="1" value={steps} disabled={active} onChange={(event) => updateBaseValue("steps", event.target.value)} />
                    </label>
                    <label className={styles.field}>
                        <span>{FIELD_LABELS.cfg}</span>
                        <input id="img2img-cfg" type="number" min="0" max="20" step="0.5" value={cfg} disabled={active} onChange={(event) => updateBaseValue("cfg", event.target.value)} />
                    </label>
                    <label className={styles.field}>
                        <span>{FIELD_LABELS.seed}</span>
                        <input id="img2img-seed" type="number" min="0" max="2147483647" step="1" value={seed} disabled={active || Number(batchCount) > 1} onChange={(event) => updateBaseValue("seed", event.target.value)} aria-describedby="img2img-seed-help" />
                        <button
                            type="button"
                            className={styles.secondaryButton}
                            onClick={randomizeSeed}
                            disabled={active || Number(batchCount) > 1}
                            aria-label="隨機產生種子"
                            title="隨機產生種子"
                        >
                            ↻ 隨機種子
                        </button>
                        <small id="img2img-seed-help">{Number(batchCount) > 1 ? "批次模式會為每張圖片自動產生隨機種子。" : "單張生成時使用此隨機種子。"}</small>
                    </label>
                    <label className={styles.field}>
                        <span>{FIELD_LABELS.batchCount}</span>
                        <input
                            id="img2img-batch-count"
                            type="number"
                            min="1"
                            max="20"
                            step="1"
                            value={batchCount}
                            disabled={active}
                            onChange={(event) => setBatchCount(event.target.value)}
                            aria-describedby="img2img-batch-help"
                        />
                        <small id="img2img-batch-help">1–20 張；第 1 張使用上方設定。</small>
                    </label>
                    <div className={styles.fieldWide}>
                        <span>亂數範圍（每張生成前取值）</span>
                        {Number(batchCount) > 1 && <small id="img2img-random-help">第 1 張使用上方設定；第 2 張起於範圍內亂數。</small>}
                        <div className={styles.rangeGrid} aria-describedby="img2img-random-help">
                            {(Object.keys(RANGE_BOUNDS) as RandomRangeKey[]).map((key) => {
                                const bounds = RANGE_BOUNDS[key];
                                const range = randomRanges[key];
                                const label = FIELD_LABELS[key === "denoise" ? "denoise" : key === "steps" ? "steps" : "cfg"];
                                return (
                                    <div className={styles.rangeRow} key={key}>
                                        <span>{label}</span>
                                        <label>
                                            <span className={styles.srOnly}>最小值</span>
                                            <input
                                                id={`img2img-${key}-min`}
                                                type="number"
                                                min={bounds.min}
                                                max={bounds.max}
                                                step={bounds.step}
                                                value={range.min}
                                                disabled={active}
                                                aria-label={`${label}最小值`}
                                                onChange={(event) => updateRandomRange(key, "min", event.target.value)}
                                            />
                                        </label>
                                        <span aria-hidden="true">–</span>
                                        <label>
                                            <span className={styles.srOnly}>最大值</span>
                                            <input
                                                id={`img2img-${key}-max`}
                                                type="number"
                                                min={bounds.min}
                                                max={bounds.max}
                                                step={bounds.step}
                                                value={range.max}
                                                disabled={active}
                                                aria-label={`${label}最大值`}
                                                onChange={(event) => updateRandomRange(key, "max", event.target.value)}
                                            />
                                        </label>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
                    <div className={styles.submitRow} data-form-valid={canStart}>
                        <div>
                            <p className={styles.helper}>{submitAttempted && !canStart ? "請先修正檢查結果，再開始生成。" : "設定完成後，提交會建立可追蹤的工作。"}</p>
                            {error && <p className={styles.error} role="alert">{error}</p>}
                        </div>
                    <button type="button" className={styles.primaryButton} onClick={() => void start()} disabled={!canInteract} aria-busy={submitting || retrying || uploading} aria-describedby="img2img-readiness-title">
                        {uploading ? "上傳中…" : submitting ? "建立工作中…" : active ? "生成中…" : "開始生成"}
                    </button>
                </div>
            </section>

            {canCancel && <button type="button" className={styles.secondaryButton} onClick={() => void cancel()} disabled={cancelling}>{cancelling ? "取消中…" : ACTION_LABELS.cancel}</button>}
            {job?.status === "cancelling" && <p className={styles.helper}>正在停止目前的圖片生成工作…</p>}
            <section className={styles.panel} aria-labelledby="img2img-job-title">
                <div className={styles.sectionHeader}>
                    <div>
                        <span className={styles.eyebrow}>工作狀態</span>
                        <h2 id="img2img-job-title">生成進度</h2>
                    </div>
                    {job && <span className={styles.sectionCode}>{job.id}</span>}
                </div>
                <div className={styles.statusLine} aria-live="polite">
                    <strong>{localizedJobStatusLabel(job)}</strong>
                    {job && <span>{progress}%</span>}
                </div>
                {job?.characterLoraName && <p className={styles.helper}>LoRA: {job.characterLoraName} · {Number(job.characterLoraStrength ?? 0.75).toFixed(2)}</p>}
                {job && batchTotal > 1 && <p className={styles.batchSummary} aria-live="polite">{completedCount}/{batchTotal} 已完成{failedCount ? ` · ${failedCount} 張失敗` : ""}</p>}
                {job && <div className={styles.progressTrack} role="progressbar" aria-label="以圖生圖進度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={`${progress}%`}><span style={{ width: `${progress}%` }} /></div>}
                {canRetry && <button type="button" className={styles.secondaryButton} onClick={() => void retry()} disabled={retrying}>{retrying ? "重試中…" : ACTION_LABELS.retry}</button>}
            </section>

            {job && isBatchJob && job.items && job.items.length > 0 && (
                <section className={styles.outputCard} aria-labelledby="img2img-batch-output-title">
                    <div className={styles.sectionHeader}>
                        <div>
                        <span className={styles.eyebrow}>批次結果</span>
                            <h2 id="img2img-batch-output-title">每張結果</h2>
                        </div>
                        <span className={styles.sectionCode}>{completedCount}/{batchTotal}</span>
                    </div>
                    <div className={styles.itemGallery}>
                        {job.items.map((item) => {
                            const itemDenoise = itemParameter(item, "denoise", denoise);
                            const itemSteps = itemParameter(item, "steps", Number(steps));
                            const itemCfg = itemParameter(item, "cfg", Number(cfg));
                            const itemSeed = itemParameter(item, "seed", Number(seed));
                            return (
                                <article className={styles.itemCard} key={item.index}>
                                    <div className={styles.itemHeader}>
                                        <strong>第 {item.index + 1} 張</strong>
                                        <span className={styles.statusChip}>{itemStatusLabel(item.status)}</span>
                                    </div>
                                    <dl className={styles.itemParameters}>
                                        <div><dt>{FIELD_LABELS.denoise}</dt><dd>{itemDenoise.toFixed(2)}</dd></div>
                                        <div><dt>{FIELD_LABELS.steps}</dt><dd>{itemSteps}</dd></div>
                                        <div><dt>CFG</dt><dd>{itemCfg}</dd></div>
                                        <div><dt>{FIELD_LABELS.seed}</dt><dd>{itemSeed}</dd></div>
                                    </dl>
                                    {item.output && (
                                        <>
                                            {/* eslint-disable-next-line @next/next/no-img-element */}
                                            <img className={styles.itemImage} src={assetUrl(item.output)} alt={`第 ${item.index + 1} 張輸出`} />
                                            <div className={styles.outputActions}>
                                                <button type="button" className={`${styles.secondaryButton} ${styles.deleteButton}`} onClick={() => void removeItemOutput(item)} disabled={deleting || active} aria-label={`刪除第 ${item.index + 1} 張輸出`}>
                                                    {deleting ? "刪除中…" : "刪除輸出"}
                                                </button>
                                                <a className={styles.secondaryButton} href={assetUrl(item.output)} target="_blank" rel="noreferrer">開啟</a>
                                            </div>
                                        </>
                                    )}
                                    {item.error && <p className={styles.error} role="alert">{item.error}</p>}
                                </article>
                            );
                        })}
                    </div>
                </section>
            )}

            {job?.status === "completed" && job.output && (
                <section className={styles.outputCard} aria-labelledby="img2img-output-title">
                    <div className={styles.sectionHeader}>
                        <div>
                        <span className={styles.eyebrow}>生成結果</span>
                            <h2 id="img2img-output-title">生成結果</h2>
                        </div>
                        <span className={styles.statusChip + " " + styles.ready}>已儲存至素材庫</span>
                    </div>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img className={styles.outputImage} src={assetUrl(job.output)} alt={`以圖生圖結果：${job.output.name}`} />
                    <div className={styles.outputActions}>
                        <button
                            type="button"
                            className={`${styles.secondaryButton} ${styles.deleteButton}`}
                            onClick={() => void removeOutput()}
                            disabled={deleting}
                            aria-busy={deleting}
                            aria-label="刪除以圖生圖結果"
                            title="刪除以圖生圖結果"
                        >
                            {deleting ? "刪除中…" : "刪除結果"}
                        </button>
                        <a className={styles.secondaryButton} href={`/app/library`} >開啟素材庫</a>
                        <a className={styles.secondaryButton} href={`${assetUrl(job.output)}&download=1`} download={job.output.name.split("/").pop() || job.output.name}>下載圖片</a>
                    </div>
                </section>
            )}

            <section className={styles.panel} aria-labelledby="img2img-history-title">
                <div className={styles.sectionHeader}>
                    <div>
                        <span className={styles.eyebrow}>歷史紀錄</span>
                        <h2 id="img2img-history-title">圖生圖歷史</h2>
                    </div>
                    <button type="button" className={styles.textButton} onClick={() => void refreshHistory(historyQuery)} disabled={historyLoading} aria-label="重新整理圖生圖歷史">
                        {historyLoading ? "載入中…" : "重新整理"}
                    </button>
                </div>
                <label className={styles.historySearch}>
                    <span>搜尋工作編號、提示詞、模型或隨機種子</span>
                    <input type="search" value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder="搜尋歷史" aria-label="搜尋圖生圖歷史" />
                </label>
                {historyError && <p className={styles.error} role="alert">{historyError}</p>}
                {!historyLoading && !historyError && filteredHistory.length === 0 && <p className={styles.helper}>尚無符合的圖生圖歷史。</p>}
                <div className={styles.historyList}>
                    {filteredHistory.map((record) => {
                        const expanded = Boolean(expandedHistory[record.id]);
                        const recordItems = record.items || [];
                        const recordCount = record.batchCount || (recordItems.length > 1 ? recordItems.length : 1);
                        const recordSeeds = recordItems.map((item) => item.parameters?.seed).filter((value) => value !== undefined).join(", ");
                        return (
                            <article className={styles.historyCard} key={record.id}>
                                <button type="button" className={styles.historyToggle} onClick={() => setExpandedHistory((previous) => ({ ...previous, [record.id]: !expanded }))} aria-expanded={expanded}>
                                    <span><strong>{record.id}</strong><small>{record.model || "圖片生成"} · {record.prompt?.slice(0, 80) || "沒有提示詞"}</small></span>
                                    <span>{jobStatusLabel(record.status, "img2img")} · {recordCount} 張</span>
                                </button>
                                {expanded && (
                                    <div className={styles.historyDetails}>
                                        <p>{record.prompt}</p>
                                        <small>{FIELD_LABELS.seed}：{recordSeeds || record.seed}</small>
                                        {record.characterLoraName && <small>LoRA: {record.characterLoraName} · {Number(record.characterLoraStrength ?? 0.75).toFixed(2)}</small>}
                                        {record.error && <p className={styles.error}>{record.error}</p>}
                                        {recordItems.map((item) => (
                                            <div className={styles.historyItem} key={item.index}>
                                                <span>第 {item.index + 1} 張 · {itemStatusLabel(item.status)} · {FIELD_LABELS.seed} {item.parameters?.seed ?? record.seed}</span>
                                                {item.output && <a href={assetUrl(item.output)} target="_blank" rel="noreferrer">開啟輸出</a>}
                                                <dl className={styles.itemParameters}>
                                                    <div><dt>{FIELD_LABELS.denoise}</dt><dd>{itemParameter(item, "denoise", Number(record.denoise)).toFixed(2)}</dd></div>
                                                    <div><dt>{FIELD_LABELS.steps}</dt><dd>{itemParameter(item, "steps", Number(record.steps))}</dd></div>
                                                    <div><dt>CFG</dt><dd>{itemParameter(item, "cfg", Number(record.cfg))}</dd></div>
                                                    <div><dt>{FIELD_LABELS.seed}</dt><dd>{itemParameter(item, "seed", Number(record.seed))}</dd></div>
                                                </dl>
                                                {item.error && <span className={styles.error}>{item.error}</span>}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </article>
                        );
                    })}
                </div>
            </section>
        </div>
    );
}

function isImg2ImgAssetRoot(root: StudioAsset["root"]): root is "input" | "output" {
    return root === "input" || root === "output";
}

function focusImg2ImgValidation(field: string) {
    const ids: Record<string, string> = {
        source: "img2img-source-picker",
        prompt: "img2img-prompt",
        negativePrompt: "img2img-negative-prompt",
        model: "img2img-model",
        characterLoraName: "img2img-character-lora",
        characterLoraStrength: "img2img-character-lora-strength",
        batchCount: "img2img-batch-count",
        denoise: "img2img-denoise",
        denoiseMin: "img2img-denoise-min",
        denoiseMax: "img2img-denoise-max",
        steps: "img2img-steps",
        stepsMin: "img2img-steps-min",
        stepsMax: "img2img-steps-max",
        cfg: "img2img-cfg",
        cfgMin: "img2img-cfg-min",
        cfgMax: "img2img-cfg-max",
        seed: "img2img-seed",
        readiness: "img2img-readiness-title",
    };
    const element = document.getElementById(ids[field] || "");
    if (element instanceof HTMLElement) {
        if (field === "readiness") element.tabIndex = -1;
        element.focus();
        element.scrollIntoView({ behavior: "smooth", block: "center" });
    }
}

async function assetToPromptImage(asset: StudioAsset) {
    const response = await fetch(assetUrl(asset));
    if (!response.ok) throw new Error("無法讀取來源圖片。" );
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    try {
        const image = new Image();
        image.src = objectUrl;
        await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error("無法解碼來源圖片。"));
        });
        const maxDimension = 1024;
        const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.86);
        return dataUrl.slice(dataUrl.indexOf(",") + 1);
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}
