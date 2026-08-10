"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AssetPickerButton } from "../library/AssetPickerButton";
import { assetKey, assetUrl, type StudioAsset, uploadAssets } from "../library/asset-client";
import {
    fetchImg2ImgHealth,
    fetchImg2ImgJob,
    fetchImg2ImgRuntime,
    img2ImgReadinessMessage,
    isImg2ImgActive,
    isImg2ImgRetryable,
    Img2ImgApiError,
    submitImg2Img,
    type Img2ImgHealth,
    type Img2ImgJob,
    type Img2ImgRuntimeMode,
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
        localOnly: false,
    },
    {
        value: "v1-5-pruned-emaonly-fp16.safetensors",
        label: "Stable Diffusion 1.5 FP16",
        note: "細節調整 · 建議 20 steps / CFG 7",
        steps: "20",
        cfg: "7",
        denoise: 0.65,
        localOnly: false,
    },
    {
        value: "z_image_turbo_bf16.safetensors",
        label: "Z-Image Turbo／真人",
        note: "真人寫實 · 建議 9 steps / CFG 1 · 僅限本機",
        steps: "9",
        cfg: "1",
        denoise: 0.33,
        localOnly: true,
    },
    {
        value: "waiIllustriousSDXL_v170.safetensors",
        label: "WAI Illustrious SDXL／動漫",
        note: "動漫插畫 · 建議 20 steps / CFG 7 · 僅限本機",
        steps: "20",
        cfg: "7",
        denoise: 0.65,
        localOnly: true,
    },
] as const;

type ModelValue = typeof IMG2IMG_MODELS[number]["value"];

const DEFAULT_IMG2IMG_MODEL = IMG2IMG_MODELS[0];

function modelOption(value: string) {
    return IMG2IMG_MODELS.find((item) => item.value === value);
}

function modelAllowedForRuntime(value: string, runtimeMode: Img2ImgRuntimeMode | null) {
    const option = modelOption(value);
    return !option?.localOnly || runtimeMode === "local";
}

const LOCAL_ONLY_MODEL_MESSAGE = "Z-Image Turbo 與 WAI Illustrious SDXL 僅限本機 runtime。";

function parseNumberDraft(raw: string, label: string, min: number, max: number, integer = false) {
    if (!raw.trim()) return `${label} 必須填寫。`;
    const value = Number(raw);
    if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) {
        return `${label} 必須介於 ${min} 與 ${max}${integer ? " 的整數" : ""}。`;
    }
    return null;
}

function errorMessage(reason: unknown, fallback: string) {
    return reason instanceof Error ? reason.message : fallback;
}

function statusLabel(job: Img2ImgJob | null) {
    if (!job) return "尚未開始生成";
    const label = job.status === "completed"
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
    const [prompt, setPrompt] = useState("");
    const [negativePrompt, setNegativePrompt] = useState("");
    const [model, setModel] = useState<ModelValue>(IMG2IMG_MODELS[0].value);
    const [denoise, setDenoise] = useState(0.65);
    const [steps, setSteps] = useState("4");
    const [cfg, setCfg] = useState("1");
    const [seed, setSeed] = useState("12345");
    const [job, setJob] = useState<Img2ImgJob | null>(null);
    const [health, setHealth] = useState<Img2ImgHealth | null>(null);
    const [runtimeMode, setRuntimeMode] = useState<Img2ImgRuntimeMode | null>(null);
    const [healthLoading, setHealthLoading] = useState(true);
    const [healthError, setHealthError] = useState("");
    const [uploading, setUploading] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [retrying, setRetrying] = useState(false);
    const [error, setError] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);

    const refreshHealth = useCallback(async () => {
        setHealthLoading(true);
        const [readinessResult, runtimeResult] = await Promise.allSettled([fetchImg2ImgHealth(), fetchImg2ImgRuntime()]);
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
                setDenoise(DEFAULT_IMG2IMG_MODEL.denoise);
                setSteps(DEFAULT_IMG2IMG_MODEL.steps);
                setCfg(DEFAULT_IMG2IMG_MODEL.cfg);
            }
        } else {
            // Keep local-only checkpoints hidden until runtime can be proven local.
            setRuntimeMode(null);
            if (modelOption(model)?.localOnly) {
                setModel(DEFAULT_IMG2IMG_MODEL.value);
                setDenoise(DEFAULT_IMG2IMG_MODEL.denoise);
                setSteps(DEFAULT_IMG2IMG_MODEL.steps);
                setCfg(DEFAULT_IMG2IMG_MODEL.cfg);
            }
        }
        setHealthLoading(false);
    }, [model]);

    useEffect(() => {
        const initialTimer = window.setTimeout(() => void refreshHealth(), 0);
        const timer = window.setInterval(() => void refreshHealth(), 10000);
        return () => {
            window.clearTimeout(initialTimer);
            window.clearInterval(timer);
        };
    }, [refreshHealth]);

    const trackedJobId = job?.id;
    const trackedJobStatus = job?.status;
    useEffect(() => {
        if (!trackedJobId || !["queued", "running"].includes(trackedJobStatus || "")) return;
        let active = true;
        const poll = async () => {
            try {
                const next = await fetchImg2ImgJob(trackedJobId);
                if (active) {
                    setJob(next);
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

    const selectedKey = useMemo(() => (source ? [assetKey(source)] : []), [source]);
    const visibleModels = runtimeMode === "local"
        ? IMG2IMG_MODELS
        : IMG2IMG_MODELS.filter((item) => !item.localOnly);
    const selectedModel = modelOption(model);
    const modelRuntimeReady = modelAllowedForRuntime(model, runtimeMode);
    const readinessBlockingMessage = !modelRuntimeReady
        ? LOCAL_ONLY_MODEL_MESSAGE
        : health ? img2ImgReadinessMessage(health, model) : "";
    const readinessMessage = readinessBlockingMessage || (health ? "ComfyUI、必要節點與所選 checkpoint 均可用。" : "尚未取得 ComfyUI readiness；提交時會再次檢查。 ");
    const modelReady = modelRuntimeReady && (health ? (health.models ? health.models[model] === true : false) : true);
    const readinessState = healthLoading ? "checking" : health?.ready && modelReady ? "ready" : "blocked";
    const active = isImg2ImgActive(job);
    const progress = Math.min(100, Math.max(0, Math.round(Number(job?.progress) || 0)));
    const canRetry = isImg2ImgRetryable(job) && !retrying && modelAllowedForRuntime(job?.model || "", runtimeMode);

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
        setModel(next.value);
        setDenoise(next.denoise);
        setSteps(next.steps);
        setCfg(next.cfg);
    }

    function validateForm() {
        if (!source || source.kind !== "image") return "請先選擇來源圖片。";
        if (!prompt.trim()) return "請輸入希望圖片呈現的內容。";
        if (prompt.trim().length > 4000 || negativePrompt.length > 4000) return "提示詞不可超過 4000 字元。";
        if (!modelRuntimeReady) return LOCAL_ONLY_MODEL_MESSAGE;
        if (readinessBlockingMessage) return readinessBlockingMessage;
        const denoiseError = parseNumberDraft(String(denoise), "重繪強度", 0.01, 1);
        if (denoiseError) return denoiseError;
        const stepsError = parseNumberDraft(steps, "Steps", 1, 50, true);
        if (stepsError) return stepsError;
        const cfgError = parseNumberDraft(cfg, "CFG", 0, 20);
        if (cfgError) return cfgError;
        return parseNumberDraft(seed, "Seed", 0, 2147483647, true);
    }

    function requestBody(jobOverride?: Img2ImgJob) {
        const current = jobOverride || job;
        return {
            sourceName: current?.sourceName || source?.name || "",
            sourceRoot: current?.sourceRoot || source?.root || "input",
            prompt: current?.prompt || prompt.trim(),
            negativePrompt: current?.negativePrompt ?? negativePrompt.trim(),
            model: current?.model ?? model,
            denoise: current?.denoise ?? Number(denoise),
            steps: current?.steps ?? Number(steps),
            cfg: current?.cfg ?? Number(cfg),
            seed: current?.seed ?? Number(seed),
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

    async function retry() {
        if (!job || !canRetry) return;
        if (!modelAllowedForRuntime(job.model, runtimeMode)) {
            setError(LOCAL_ONLY_MODEL_MESSAGE);
            return;
        }
        setRetrying(true);
        setError("");
        try {
            const next = await submitImg2Img(requestBody(job));
            setJob(next);
            if (next.status === "failed") setError(next.error || "以圖生圖失敗。 ");
        } catch (reason) {
            if (reason instanceof Img2ImgApiError && reason.payload.health) setHealth(reason.payload.health);
            setError(errorMessage(reason, "無法重試以圖生圖。"));
        } finally {
            setRetrying(false);
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
                            {visibleModels.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                        </select>
                        <small>{selectedModel?.note || "尚未選擇可用模型。"}</small>
                        {runtimeMode !== "local" && <small>本機限定模型會在 local runtime 就緒後顯示。</small>}
                    </label>
                    <label className={styles.field}>
                        <span>重繪強度 <strong>{denoise.toFixed(2)}</strong></span>
                        <input type="range" min="0.01" max="1" step="0.01" value={denoise} disabled={active} onChange={(event) => setDenoise(Number(event.target.value))} />
                        <small>越高越偏離原圖；0.45–0.70 通常較平衡。</small>
                    </label>
                    <label className={styles.field}>
                        <span>Steps</span>
                        <input type="number" min="1" max="50" value={steps} disabled={active} onChange={(event) => setSteps(event.target.value)} />
                    </label>
                    <label className={styles.field}>
                        <span>CFG</span>
                        <input type="number" min="0" max="20" step="0.5" value={cfg} disabled={active} onChange={(event) => setCfg(event.target.value)} />
                    </label>
                    <label className={styles.field}>
                        <span>Seed</span>
                        <input type="number" min="0" max="2147483647" value={seed} disabled={active} onChange={(event) => setSeed(event.target.value)} />
                    </label>
                </div>
                <div className={styles.submitRow}>
                    <div>
                        <p className={styles.helper}>提示詞可手動輸入；生成工作會交由 Jobs 追蹤。</p>
                        {error && <p className={styles.error} role="alert">{error}</p>}
                    </div>
                    <button type="button" className={styles.primaryButton} onClick={() => void start()} disabled={submitting || retrying || uploading || active || !modelRuntimeReady} aria-busy={submitting || retrying || uploading}>
                        {uploading ? "上傳圖片中…" : submitting ? "正在排程…" : active ? "圖片生成中…" : "開始以圖生圖"}
                    </button>
                </div>
            </section>

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
                {job && <div className={styles.progressTrack} role="progressbar" aria-label="以圖生圖進度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={`${progress}%`}><span style={{ width: `${progress}%` }} /></div>}
                {job && (job.status === "queued" || job.status === "running") && <p className={styles.helper}>目前 API 沒有取消 endpoint；此頁不會偽造取消操作。</p>}
                {canRetry && <button type="button" className={styles.secondaryButton} onClick={() => void retry()} disabled={retrying}>{retrying ? "重試中…" : "Retry"}</button>}
            </section>

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
                        <a className={styles.secondaryButton} href={`/app/library`} >開啟 Library</a>
                        <a className={styles.secondaryButton} href={`${assetUrl(job.output)}&download=1`} download={job.output.name.split("/").pop() || job.output.name}>下載圖片</a>
                    </div>
                </section>
            )}
        </div>
    );
}
