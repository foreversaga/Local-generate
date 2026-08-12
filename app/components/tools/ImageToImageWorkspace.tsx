"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AssetPickerButton } from "../library/AssetPickerButton";
import { assetKey, assetUrl, deleteAsset, type StudioAsset, uploadAssets } from "../library/asset-client";
import {
    STUDIO_SETTINGS_DEFAULTS,
    loadStudioSettings,
    reconcileStudioSettings,
} from "../../lib/studio-settings.mjs";
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
        loraHint: "SDXL LoRA only. 真人起始 0.55–0.75；動漫 0.7–0.9。",
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
        loraHint: "SD1.5 LoRA only. 真人起始 0.55–0.75；動漫 0.7–0.9。",
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
        loraHint: "Z-Image-trained LoRA only；真人起始 0.55–0.75，動漫 0.7–0.9。",
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
        loraHint: "SDXL LoRA only. 真人起始 0.55–0.75；動漫 0.7–0.9。",
        localOnly: true,
    },
] as const;

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
    switch (status) {
        case "completed":
        case "complete":
            return "Completed";
        case "failed":
        case "error":
            return "Failed";
        case "running":
            return "Running";
        case "queued":
            return "Queued";
        default:
            return status || "Unknown";
    }
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

function modelSupportsPromptImages(model: string) {
    const normalized = model.toLowerCase();
    if (normalized === "gemma3:1b") return false;
    return normalized.includes("-vl") || normalized.includes("gemma3") || normalized.includes("gemma4") || normalized.includes("gemma3n");
}

const LOCAL_ONLY_MODEL_MESSAGE = "Z-Image Turbo 與 WAI Illustrious SDXL 僅限本機 runtime。";

function parseNumberDraft(raw: string, label: string, min: number, max: number, integer = false, step?: number) {
    if (!raw.trim()) return `${label} 必須填寫。`;
    const value = Number(raw);
    const aligned = step === undefined || Math.abs((value - min) / step - Math.round((value - min) / step)) <= 1e-8;
    if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max || !aligned) {
        if (Number.isFinite(value) && aligned === false && value >= min && value <= max) return `${label} must align to step ${step}.`;
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
        return "Character LoRA must be a safe relative path under ComfyUI/models/loras.";
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

function statusLabel(job: Img2ImgJob | null) {
    if (job?.status === "cancelling") return job.stage ? `Cancelling · ${job.stage}` : "Cancelling";
    if (job?.status === "interrupted") return job.stage ? `Interrupted · ${job.stage}` : "Interrupted";
    if (!job) return "尚未開始生成";
    const label = job.status === "partial"
        ? "Partial"
        : job.status === "completed"
        ? "已完成"
        : job.status === "failed"
            ? "生成失敗"
            : job.status === "cancelled"
                ? "已取消"
                : job.status === "running"
                    ? "正在生成"
                    : "等待處理";
    return job.stage ? `${label} · ${job.stage}` : label;
}

export function ImageToImageWorkspace() {
    const [source, setSource] = useState<StudioAsset | null>(null);
    const [promptDescription, setPromptDescription] = useState("");
    const [prompt, setPrompt] = useState("");
    const [negativePrompt, setNegativePrompt] = useState("");
    const [promptModel, setPromptModel] = useState(STUDIO_SETTINGS_DEFAULTS.ollamaModel);
    const [promptHealth, setPromptHealth] = useState<PromptHealth | null>(null);
    const [promptBusy, setPromptBusy] = useState(false);
    const [model, setModel] = useState<ModelValue>(IMG2IMG_MODELS[0].value);
    const [denoise, setDenoise] = useState(0.65);
    const [steps, setSteps] = useState("4");
    const [cfg, setCfg] = useState("1");
    const [seed, setSeed] = useState("12345");
    const [characterLoraName, setCharacterLoraName] = useState("");
    const [characterLoraStrength, setCharacterLoraStrength] = useState("0.75");
    const [characterLoraRegistry, setCharacterLoraRegistry] = useState<{ model: ModelValue; values: string[] }>(() => ({
        model: IMG2IMG_MODELS[0].value,
        values: [],
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
    const inputRef = useRef<HTMLInputElement>(null);
    const loraRequestIdRef = useRef(0);
    const registryLoraSelectionRef = useRef(false);

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
            setHealthError(errorMessage(readinessResult.reason, "無法取得 ComfyUI readiness。"));
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
        const timer = window.setTimeout(() => {
            const stored = reconcileStudioSettings(loadStudioSettings());
            setPromptModel(stored.ollamaModel);
        }, 0);
        return () => window.clearTimeout(timer);
    }, []);

    useEffect(() => {
        const requestId = ++loraRequestIdRef.current;
        let active = true;
        void fetchImg2ImgLoras(model)
            .then((values) => {
                if (active && loraRequestIdRef.current === requestId) setCharacterLoraRegistry({ model, values });
            })
            .catch(() => {
                if (active && loraRequestIdRef.current === requestId) setCharacterLoraRegistry({ model, values: [] });
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
            setHistoryError(errorMessage(reason, "Unable to load image-to-image history."));
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
                    if (next.status === "partial") setError(next.error || "Some batch images failed.");
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
    const visibleModels = runtimeMode === "local"
        ? IMG2IMG_MODELS
        : IMG2IMG_MODELS.filter((item) => !item.localOnly);
    const selectedModel = modelOption(model);
    const characterLoraOptions = characterLoraRegistry.model === model ? characterLoraRegistry.values : [];
    const characterLoraNameIssue = characterLoraNameError(characterLoraName);
    const characterLoraStrengthIssue = characterLoraName.trim()
        ? parseNumberDraft(characterLoraStrength, "LoRA strength", 0, 2, false, 0.05)
        : null;
    const visiblePromptModels = promptHealth?.ollama?.models || [];
    const effectivePromptModel = visiblePromptModels.includes(promptModel)
        ? promptModel
        : visiblePromptModels[0] || promptModel;
    const promptProviderReady = Boolean(promptHealth?.ollama?.online && visiblePromptModels.includes(effectivePromptModel));
    const modelRuntimeReady = modelAllowedForRuntime(model, runtimeMode);
    const characterLoraRequested = Boolean(characterLoraName.trim());
    const characterLoraReady = !characterLoraRequested || Boolean(health?.profiles?.[model]?.loraAvailable);
    const characterLoraReadinessMessage = characterLoraRequested && health && !characterLoraReady
        ? `ComfyUI does not expose ${health.profiles?.[model]?.loraLoader || "the required LoRA loader"} for this model.`
        : "";
    const optionAvailable = (value: string) => {
        if (healthLoading) return true;
        return health?.models?.[value] === true;
    };
    const readinessBlockingMessage = !modelRuntimeReady
        ? LOCAL_ONLY_MODEL_MESSAGE
        : characterLoraReadinessMessage || (health ? img2ImgReadinessMessage(health, model) : "");
    const readinessMessage = readinessBlockingMessage || (health ? "ComfyUI、必要節點與所選 checkpoint 均可用。" : "尚未取得 ComfyUI readiness；提交時會再次檢查。 ");
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
                return `denoise ${itemDenoise} steps ${itemSteps} cfg ${itemCfg} seed ${itemSeed}`;
            }).join(" ");
            const baseParameters = `denoise ${record.denoise} steps ${record.steps} cfg ${record.cfg} seed ${record.seed}`;
            return `${record.id} ${record.prompt} ${record.model} ${record.characterLoraName || ""} ${record.characterLoraStrength ?? ""} ${baseParameters} ${itemParameters}`.toLowerCase().includes(needle);
        });
    }, [history, historyQuery]);
    const canRetry = isImg2ImgRetryable(job) && !retrying && modelAllowedForRuntime(model, runtimeMode);
    const sourceReady = Boolean(source && source.kind === "image");
    const promptReady = Boolean(prompt.trim());
    const readinessReady = !healthLoading && health?.ready === true && modelReady && characterLoraReady;
    const canStart = !active && !submitting && !retrying && !uploading && sourceReady && promptReady && modelRuntimeReady && readinessReady;

    function selectSource(assets: StudioAsset[]) {
        const next = assets.find((asset) => asset.kind === "image");
        if (!next) return;
        setSource(next);
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

    function updateModel(value: ModelValue) {
        const next = modelOption(value) || DEFAULT_IMG2IMG_MODEL;
        if (next.value !== model && registryLoraSelectionRef.current) {
            registryLoraSelectionRef.current = false;
            setCharacterLoraName("");
        }
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
            setError("Please choose a source image first.");
            return;
        }
        if (!promptDescription.trim()) {
            setError("Enter an image transformation description first.");
            return;
        }
        if (!promptProviderReady) {
            setError("Ollama is unavailable or has no installed prompt model.");
            return;
        }
        if (!modelSupportsPromptImages(effectivePromptModel)) {
            setError(`Prompt model ${effectivePromptModel} does not support image understanding; choose a vision model.`);
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
            if (!response.ok) throw new Error(apiErrorMessage(payload, "Ollama did not return a prompt."));
            if (!payload.prompt?.trim() || !payload.negativePrompt?.trim()) {
                throw new Error("Ollama returned an invalid response; both positive and negative prompts are required.");
            }
            setPrompt(payload.prompt.trim());
            setNegativePrompt(payload.negativePrompt.trim());
        } catch (reason) {
            setError(errorMessage(reason, "Unable to generate an image-to-image prompt."));
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
        if (!prompt.trim()) return "請輸入希望圖片呈現的內容。";
        if (prompt.trim().length > 4000 || negativePrompt.length > 4000) return "提示詞不可超過 4000 字元。";
        if (characterLoraNameIssue) return characterLoraNameIssue;
        if (characterLoraStrengthIssue) return characterLoraStrengthIssue;
        if (!modelRuntimeReady) return LOCAL_ONLY_MODEL_MESSAGE;
        if (!readinessReady) return readinessBlockingMessage || "尚未取得可用的 ComfyUI readiness 或所選 checkpoint。";
        if (readinessBlockingMessage) return readinessBlockingMessage;
        const batchError = parseNumberDraft(batchCount, "生成張數", 1, 20, true);
        if (batchError) return batchError;
        for (const key of Object.keys(RANGE_BOUNDS) as RandomRangeKey[]) {
            const bounds = RANGE_BOUNDS[key];
            const draft = randomRanges[key];
            const minError = parseNumberDraft(draft.min, `${key} range min`, bounds.min, bounds.max, bounds.integer, bounds.step);
            if (minError) return minError;
            const maxError = parseNumberDraft(draft.max, `${key} range max`, bounds.min, bounds.max, bounds.integer, bounds.step);
            if (maxError) return maxError;
            if (Number(draft.min) > Number(draft.max)) return `${key} range min must be less than or equal to max.`;
        }
        const denoiseError = parseNumberDraft(String(denoise), "重繪強度", 0.01, 1);
        if (denoiseError) return denoiseError;
        const stepsError = parseNumberDraft(steps, "Steps", 1, 50, true);
        if (stepsError) return stepsError;
        const cfgError = parseNumberDraft(cfg, "CFG", 0, 20);
        if (cfgError) return cfgError;
        return parseNumberDraft(seed, "Seed", 0, 2147483647, true);
    }

    function requestBody(): Img2ImgSubmitInput {
        const sourceRoot = source?.root;
        if (sourceRoot && !isImg2ImgAssetRoot(sourceRoot)) {
            throw new Error("Image-to-image only supports input or output assets.");
        }
        return {
            sourceName: source?.name || "",
            sourceRoot: sourceRoot || "input",
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
        if (validationError || submitting || retrying || uploading || active) {
            if (validationError) setError(validationError);
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
            setError(errorMessage(reason, "Unable to cancel image-to-image job."));
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
            setError(errorMessage(reason, "Unable to delete the image-to-image result."));
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
            setError(errorMessage(reason, "Unable to delete the image-to-image result."));
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
                            <span className={styles.eyebrow}>SOURCE IMAGE</span>
                            <h2 id="img2img-source-title">來源圖片</h2>
                        </div>
                        <span className={styles.sectionCode}>PNG · JPG · WEBP</span>
                    </div>
                    {source ? (
                        <div className={styles.sourcePreview}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={assetUrl(source)} alt={`以圖生圖來源：${source.name}`} />
                            <div className={styles.sourceMeta}>
                                <strong title={source.name}>{source.name}</strong>
                                <span>{source.root} · {source.mime || "image"}</span>
                                <button type="button" className={styles.secondaryButton} onClick={() => { setSource(null); setJob(null); setError(""); }}>移除來源</button>
                            </div>
                        </div>
                    ) : (
                        <div className={styles.emptySource}>
                            <strong>選擇或上傳一張圖片</strong>
                            <span>可使用 input 或 output 素材。</span>
                        </div>
                    )}
                    <div className={styles.sourceActions}>
                        <AssetPickerButton kind="image" selectedKeys={selectedKey} label="從 Library 選取" onSelect={selectSource} />
                        <button type="button" className={styles.secondaryButton} onClick={() => inputRef.current?.click()} disabled={uploading}>
                            {uploading ? "上傳中…" : "上傳圖片"}
                        </button>
                        <input ref={inputRef} className={styles.hiddenInput} type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void uploadSource(event)} />
                    </div>
                </section>

                <section className={styles.panel} aria-labelledby="img2img-readiness-title">
                    <div className={styles.sectionHeader}>
                        <div>
                            <span className={styles.eyebrow}>COMFYUI READINESS</span>
                            <h2 id="img2img-readiness-title">執行環境</h2>
                        </div>
                        <span className={`${styles.statusChip} ${styles[readinessState]}`}>{readinessState === "ready" ? "Ready" : readinessState === "checking" ? "Checking" : "Needs attention"}</span>
                    </div>
                    <p className={styles.helper} aria-live="polite" aria-atomic="true">{readinessMessage || "ComfyUI、必要節點與所選 checkpoint 均可用。"}</p>
                    {healthError && <p className={styles.error} role="alert">{healthError}</p>}
                    <dl className={styles.readinessList}>
                        <div><dt>ComfyUI</dt><dd>{health?.comfyUi === false ? "Offline" : health?.comfyUi ? "Online" : "—"}</dd></div>
                        <div><dt>Model</dt><dd>{modelReady ? "Available" : "Missing"}</dd></div>
                        <div><dt>Nodes</dt><dd>{Object.values(health?.nodes || {}).filter(Boolean).length}/{Object.keys(health?.nodes || {}).length || "—"}</dd></div>
                    </dl>
                    <button type="button" className={styles.textButton} onClick={() => void refreshHealth()} disabled={healthLoading}>{healthLoading ? "檢查中…" : "重新檢查"}</button>
                </section>
            </div>

            <section className={styles.panel} aria-labelledby="img2img-prompt-title">
                <div className={styles.sectionHeader}>
                    <div>
                        <span className={styles.eyebrow}>PROMPT</span>
                        <h2 id="img2img-prompt-title">提示詞與設定</h2>
                    </div>
                    <span className={styles.sectionCode}>IMAGE TO IMAGE</span>
                </div>
                <div className={styles.formGrid}>
                    <label className={styles.fieldWide}>
                        <span>Prompt description for Ollama</span>
                        <textarea
                            id="img2img-description"
                            value={promptDescription}
                            maxLength={4000}
                            rows={3}
                            placeholder="Describe how the source image should be transformed."
                            aria-describedby="img2img-description-help"
                            onChange={(event) => { setPromptDescription(event.target.value); if (error) setError(""); }}
                        />
                        <small id="img2img-description-help">
                            Ollama will inspect the source image and write positive and negative prompts.
                            {promptProviderReady ? ` Model: ${effectivePromptModel}` : " Vision model unavailable."}
                        </small>
                    </label>
                    <button
                        type="button"
                        className={styles.secondaryButton}
                        onClick={() => void generatePrompt()}
                        disabled={promptBusy || uploading || submitting || retrying || active}
                        aria-busy={promptBusy}
                    >
                        {promptBusy ? "Generating prompt…" : "Use Ollama to generate prompt"}
                    </button>
                    <label className={styles.fieldWide}>
                        <span>正向提示詞 <em>*</em></span>
                        <textarea value={prompt} maxLength={4000} rows={5} placeholder="描述希望結果呈現的主體、風格、光線與細節" onChange={(event) => { setPrompt(event.target.value); if (error) setError(""); }} />
                        <small>{prompt.length}/4000</small>
                    </label>
                    <label className={styles.fieldWide}>
                        <span>負向提示詞（可選）</span>
                        <textarea value={negativePrompt} maxLength={4000} rows={3} placeholder="blurry, low quality, artifacts" onChange={(event) => setNegativePrompt(event.target.value)} />
                    </label>
                    <label className={styles.field}>
                        <span>模型</span>
                        <select value={model} disabled={active} onChange={(event) => updateModel(event.target.value as ModelValue)}>
                            {visibleModels.map((item) => {
                                const available = optionAvailable(item.value);
                                return <option key={item.value} value={item.value} disabled={!available}>{item.label}{available ? "" : " · Unavailable"}</option>;
                            })}
                        </select>
                        <small>{selectedModel?.note || "尚未選擇可用模型。"}</small>
                        {runtimeMode !== "local" && <small>本機限定模型會在 local runtime 就緒後顯示。</small>}
                    </label>
                    <label className={styles.field}>
                        <span>角色 LoRA <em>optional</em></span>
                        <input
                            id="img2img-character-lora"
                            type="text"
                            list="img2img-character-lora-options"
                            value={characterLoraName}
                            disabled={active}
                            aria-describedby={`img2img-character-lora-help${characterLoraNameIssue ? " img2img-character-lora-error" : ""}`}
                            aria-invalid={Boolean(characterLoraNameIssue)}
                            onChange={(event) => {
                                registryLoraSelectionRef.current = characterLoraOptions.includes(event.target.value);
                                setCharacterLoraName(event.target.value);
                            }}
                        />
                        <datalist id="img2img-character-lora-options">
                            {characterLoraOptions.map((name) => <option key={name} value={name} />)}
                        </datalist>
                        <small id="img2img-character-lora-help">
                            {selectedModel?.loraHint || "Choose a LoRA trained for this model family; Wan2.2 Animate LoRA is not compatible."}
                            {characterLoraOptions.length ? " Discovered LoRAs are suggestions; manual relative paths are also accepted." : " LoRA discovery unavailable; enter a models/loras relative path manually."}
                        </small>
                        {characterLoraNameIssue && <small id="img2img-character-lora-error" className={styles.error} role="alert">{characterLoraNameIssue}</small>}
                    </label>
                    <label className={styles.field}>
                        <span>LoRA strength <strong>{characterLoraStrength.trim() ? Number(characterLoraStrength).toFixed(2) : "—"}</strong></span>
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
                            Range 0–2, default 0.75; clear the LoRA name to omit both fields.
                        </small>
                        {characterLoraStrengthIssue && <small id="img2img-character-lora-strength-error" className={styles.error} role="alert">{characterLoraStrengthIssue}</small>}
                    </label>
                    <label className={styles.field}>
                        <span>重繪強度 <strong>{denoise.toFixed(2)}</strong></span>
                        <input type="range" min="0.01" max="1" step="0.01" value={denoise} disabled={active} onChange={(event) => updateBaseValue("denoise", event.target.value)} />
                        <small>越高越偏離原圖；0.45–0.70 通常較平衡。</small>
                    </label>
                    <label className={styles.field}>
                        <span>Steps</span>
                        <input type="number" min="1" max="50" step="1" value={steps} disabled={active} onChange={(event) => updateBaseValue("steps", event.target.value)} />
                    </label>
                    <label className={styles.field}>
                        <span>CFG</span>
                        <input type="number" min="0" max="20" step="0.5" value={cfg} disabled={active} onChange={(event) => updateBaseValue("cfg", event.target.value)} />
                    </label>
                    <label className={styles.field}>
                        <span>Seed</span>
                        <input type="number" min="0" max="2147483647" step="1" value={seed} disabled={active || Number(batchCount) > 1} onChange={(event) => updateBaseValue("seed", event.target.value)} aria-describedby="img2img-seed-help" />
                        <button
                            type="button"
                            className={styles.secondaryButton}
                            onClick={randomizeSeed}
                            disabled={active || Number(batchCount) > 1}
                            aria-label="Randomize Seed"
                            title="Randomize Seed"
                        >
                            ↻ Random Seed
                        </button>
                        <small id="img2img-seed-help">{Number(batchCount) > 1 ? "批次模式會為每張圖片自動產生隨機 Seed。" : "單張生成時使用此 Seed。"}</small>
                    </label>
                    <label className={styles.field}>
                        <span>生成張數</span>
                        <input
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
                                const label = key === "denoise" ? "Denoise" : key === "cfg" ? "CFG" : key[0].toUpperCase() + key.slice(1);
                                return (
                                    <div className={styles.rangeRow} key={key}>
                                        <span>{label}</span>
                                        <label>
                                            <span className={styles.srOnly}>最小值</span>
                                            <input
                                                type="number"
                                                min={bounds.min}
                                                max={bounds.max}
                                                step={bounds.step}
                                                value={range.min}
                                                disabled={active}
                                                aria-label={`${label} range minimum`}
                                                onChange={(event) => updateRandomRange(key, "min", event.target.value)}
                                            />
                                        </label>
                                        <span aria-hidden="true">–</span>
                                        <label>
                                            <span className={styles.srOnly}>最大值</span>
                                            <input
                                                type="number"
                                                min={bounds.min}
                                                max={bounds.max}
                                                step={bounds.step}
                                                value={range.max}
                                                disabled={active}
                                                aria-label={`${label} range maximum`}
                                                onChange={(event) => updateRandomRange(key, "max", event.target.value)}
                                            />
                                        </label>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
                <div className={styles.submitRow}>
                    <div>
                        <p className={styles.helper}>提示詞可手動輸入；生成工作會交由 Jobs 追蹤。</p>
                        {error && <p className={styles.error} role="alert">{error}</p>}
                    </div>
                    <button type="button" className={styles.primaryButton} onClick={() => void start()} disabled={!canStart} aria-busy={submitting || retrying || uploading}>
                        {uploading ? "上傳圖片中…" : submitting ? "正在排程…" : active ? "圖片生成中…" : "開始以圖生圖"}
                    </button>
                </div>
            </section>

            {canCancel && <button type="button" className={styles.secondaryButton} onClick={() => void cancel()} disabled={cancelling}>{cancelling ? "Cancelling…" : "Cancel generation"}</button>}
            {job?.status === "cancelling" && <p className={styles.helper}>Stopping the current image generation…</p>}
            <section className={styles.panel} aria-labelledby="img2img-job-title">
                <div className={styles.sectionHeader}>
                    <div>
                        <span className={styles.eyebrow}>JOB STATUS</span>
                        <h2 id="img2img-job-title">生成進度</h2>
                    </div>
                    {job && <span className={styles.sectionCode}>{job.id}</span>}
                </div>
                <div className={styles.statusLine} aria-live="polite">
                    <strong>{statusLabel(job)}</strong>
                    {job && <span>{progress}%</span>}
                </div>
                {job?.characterLoraName && <p className={styles.helper}>LoRA: {job.characterLoraName} · {Number(job.characterLoraStrength ?? 0.75).toFixed(2)}</p>}
                {job && batchTotal > 1 && <p className={styles.batchSummary} aria-live="polite">{completedCount}/{batchTotal} completed{failedCount ? ` · ${failedCount} failed` : ""}</p>}
                {job && <div className={styles.progressTrack} role="progressbar" aria-label="以圖生圖進度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={`${progress}%`}><span style={{ width: `${progress}%` }} /></div>}
                {canRetry && <button type="button" className={styles.secondaryButton} onClick={() => void retry()} disabled={retrying}>{retrying ? "重試中…" : "Retry"}</button>}
            </section>

            {job && isBatchJob && job.items && job.items.length > 0 && (
                <section className={styles.outputCard} aria-labelledby="img2img-batch-output-title">
                    <div className={styles.sectionHeader}>
                        <div>
                            <span className={styles.eyebrow}>BATCH OUTPUT</span>
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
                                        <div><dt>Denoise</dt><dd>{itemDenoise.toFixed(2)}</dd></div>
                                        <div><dt>Steps</dt><dd>{itemSteps}</dd></div>
                                        <div><dt>CFG</dt><dd>{itemCfg}</dd></div>
                                        <div><dt>Seed</dt><dd>{itemSeed}</dd></div>
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
                            <span className={styles.eyebrow}>OUTPUT</span>
                            <h2 id="img2img-output-title">生成結果</h2>
                        </div>
                        <span className={styles.statusChip + " " + styles.ready}>Saved to Library</span>
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
                        <a className={styles.secondaryButton} href={`/app/library`} >開啟 Library</a>
                        <a className={styles.secondaryButton} href={`${assetUrl(job.output)}&download=1`} download={job.output.name.split("/").pop() || job.output.name}>下載圖片</a>
                    </div>
                </section>
            )}

            <section className={styles.panel} aria-labelledby="img2img-history-title">
                <div className={styles.sectionHeader}>
                    <div>
                        <span className={styles.eyebrow}>HISTORY</span>
                        <h2 id="img2img-history-title">圖生圖歷史</h2>
                    </div>
                    <button type="button" className={styles.textButton} onClick={() => void refreshHistory(historyQuery)} disabled={historyLoading} aria-label="重新整理圖生圖歷史">
                        {historyLoading ? "載入中…" : "重新整理"}
                    </button>
                </div>
                <label className={styles.historySearch}>
                    <span>搜尋 job、提示詞、模型或 seed</span>
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
                                    <span><strong>{record.id}</strong><small>{record.model || "Image generation"} · {record.prompt?.slice(0, 80) || "No prompt"}</small></span>
                                    <span>{record.status} · {recordCount} 張</span>
                                </button>
                                {expanded && (
                                    <div className={styles.historyDetails}>
                                        <p>{record.prompt}</p>
                                        <small>Seed: {recordSeeds || record.seed}</small>
                                        {record.characterLoraName && <small>LoRA: {record.characterLoraName} · {Number(record.characterLoraStrength ?? 0.75).toFixed(2)}</small>}
                                        {record.error && <p className={styles.error}>{record.error}</p>}
                                        {recordItems.map((item) => (
                                            <div className={styles.historyItem} key={item.index}>
                                                <span>#{item.index + 1} · {item.status} · seed {item.parameters?.seed ?? record.seed}</span>
                                                {item.output && <a href={assetUrl(item.output)} target="_blank" rel="noreferrer">開啟輸出</a>}
                                                <dl className={styles.itemParameters}>
                                                    <div><dt>Denoise</dt><dd>{itemParameter(item, "denoise", Number(record.denoise)).toFixed(2)}</dd></div>
                                                    <div><dt>Steps</dt><dd>{itemParameter(item, "steps", Number(record.steps))}</dd></div>
                                                    <div><dt>CFG</dt><dd>{itemParameter(item, "cfg", Number(record.cfg))}</dd></div>
                                                    <div><dt>Seed</dt><dd>{itemParameter(item, "seed", Number(record.seed))}</dd></div>
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

async function assetToPromptImage(asset: StudioAsset) {
    const response = await fetch(assetUrl(asset));
    if (!response.ok) throw new Error("Unable to read the source image.");
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    try {
        const image = new Image();
        image.src = objectUrl;
        await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error("Unable to decode the source image."));
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
