"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { assetUrl, uploadAssets, type StudioAsset } from "../library/asset-client";
import {
    fetchImg2ImgHealth,
    fetchImg2ImgJob,
    isImg2ImgActive,
    submitImg2Img,
    type Img2ImgHealth,
    type Img2ImgJob,
} from "./img2img-client";
import styles from "./PoseToImageWorkspace.module.css";

const SDXL_MODEL = "sd_xl_turbo_1.0_fp16.safetensors";
const DEFAULT_NEGATIVE_PROMPT = "blurry, low quality, low resolution, bad anatomy, deformed body, extra limbs, missing limbs, malformed hands, malformed feet, extra fingers, fused fingers, distorted face, watermark, text, logo";
const DEFAULT_STEPS = 4;
const DEFAULT_CFG = 1;
const DEFAULT_DENOISE = 1;
const DEFAULT_POSE_CONTROL_STRENGTH = 1.2;
const DEFAULT_POSE_RESOLUTION = 768;

type PoseAwareHealth = Img2ImgHealth & {
    pose?: {
        available?: boolean;
        configuredModel?: string | null;
        reason?: string;
    };
};

type PromptHealth = {
    ollama?: {
        online?: boolean;
        models?: string[];
    };
};

type PromptPayload = {
    prompt?: string;
    negativePrompt?: string;
    ollamaPromptReceipt?: string | { id?: string };
    error?: string | { code?: string; message?: string };
    code?: string;
};

type PosePreviewPayload = {
    previewDataUrl?: string;
    error?: string | { code?: string; message?: string };
    code?: string;
};

export function PoseToImageWorkspace() {
    const inputRef = useRef<HTMLInputElement>(null);
    const [source, setSource] = useState<StudioAsset | null>(null);
    const [posePreview, setPosePreview] = useState("");
    const [description, setDescription] = useState("");
    const [prompt, setPrompt] = useState("");
    const [negativePrompt, setNegativePrompt] = useState(DEFAULT_NEGATIVE_PROMPT);
    const [promptReceipt, setPromptReceipt] = useState("");
    const [promptHealth, setPromptHealth] = useState<PromptHealth | null>(null);
    const [health, setHealth] = useState<PoseAwareHealth | null>(null);
    const [seed, setSeed] = useState(() => String(randomSeed()));
    const [denoise, setDenoise] = useState(DEFAULT_DENOISE);
    const [poseControlStrength, setPoseControlStrength] = useState(DEFAULT_POSE_CONTROL_STRENGTH);
    const [poseResolution, setPoseResolution] = useState(DEFAULT_POSE_RESOLUTION);
    const [uploading, setUploading] = useState(false);
    const [extracting, setExtracting] = useState(false);
    const [promptBusy, setPromptBusy] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [job, setJob] = useState<Img2ImgJob | null>(null);
    const [error, setError] = useState("");

    const ollamaModel = useMemo(() => choosePromptModel(promptHealth?.ollama?.models || []), [promptHealth]);
    const active = isImg2ImgActive(job);
    const ready = Boolean(health?.models?.[SDXL_MODEL] && health?.pose?.available);

    useEffect(() => {
        let cancelled = false;
        void Promise.all([
            fetchImg2ImgHealth(),
            fetch("/app/api/health", { cache: "no-store" }).then(async (response) => response.ok ? await response.json() as PromptHealth : null),
        ]).then(([nextHealth, nextPromptHealth]) => {
            if (cancelled) return;
            setHealth(nextHealth as PoseAwareHealth);
            setPromptHealth(nextPromptHealth);
        }).catch((reason) => {
            if (!cancelled) setError(errorMessage(reason, "無法取得生圖服務狀態。"));
        });
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        if (!job?.id || terminal(job.status)) return;
        let cancelled = false;
        const refresh = async () => {
            try {
                const next = await fetchImg2ImgJob(job.id);
                if (!cancelled) setJob(next);
            } catch (reason) {
                if (!cancelled) setError(errorMessage(reason, "無法更新生圖進度。"));
            }
        };
        const timer = window.setInterval(() => { void refresh(); }, 900);
        void refresh();
        return () => {
            cancelled = true;
            window.clearInterval(timer);
        };
    }, [job?.id, job?.status]);

    async function uploadAndExtract(event: ChangeEvent<HTMLInputElement>) {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) {
            setError("請上傳 PNG、JPG 或 WEBP 圖片。");
            return;
        }
        setUploading(true);
        setExtracting(true);
        setError("");
        setJob(null);
        setPosePreview("");
        try {
            const [asset] = await uploadAssets([file], "pose-to-image");
            if (!asset || asset.kind !== "image") throw new Error("圖片上傳失敗。");
            setSource(asset);
            setPosePreview(await requestPosePreview(file, poseResolution));
        } catch (reason) {
            setSource(null);
            setPosePreview("");
            setError(errorMessage(reason, "無法上傳圖片並擷取骨架。"));
        } finally {
            setUploading(false);
            setExtracting(false);
        }
    }

    async function regeneratePose() {
        if (!source) return;
        setExtracting(true);
        setError("");
        try {
            const response = await fetch(assetUrl(source));
            if (!response.ok) throw new Error("無法讀取來源圖片。");
            const blob = await response.blob();
            const file = new File([blob], source.name.split("/").pop() || "pose-source.png", { type: blob.type || source.mime || "image/png" });
            setPosePreview(await requestPosePreview(file, poseResolution));
        } catch (reason) {
            setError(errorMessage(reason, "無法重新擷取骨架。"));
        } finally {
            setExtracting(false);
        }
    }

    async function generatePrompt() {
        if (!source || !description.trim()) {
            setError("請先上傳圖片並輸入描述。");
            return;
        }
        if (!ollamaModel) {
            setError("沒有可用的 Ollama 視覺模型。");
            return;
        }
        setPromptBusy(true);
        setError("");
        setPromptReceipt("");
        try {
            const response = await fetch("/app/api/prompt", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    provider: "ollama",
                    model: ollamaModel,
                    mode: "img2img",
                    brief: `${description.trim()}\n\nUse the reference image only to understand the body pose and camera framing. Do not copy identity, face, clothing, colors, or background unless the description explicitly asks for them.`,
                    images: [{ role: "source_image", data: await assetToPromptImage(source) }],
                }),
            });
            const payload = await response.json().catch(() => ({})) as PromptPayload;
            if (!response.ok) throw new Error(apiError(payload, "Ollama 沒有回傳提示詞。"));
            setPrompt(typeof payload.prompt === "string" ? payload.prompt.trim() : "");
            setNegativePrompt(typeof payload.negativePrompt === "string" && payload.negativePrompt.trim()
                ? payload.negativePrompt.trim()
                : DEFAULT_NEGATIVE_PROMPT);
            setPromptReceipt(typeof payload.ollamaPromptReceipt === "string"
                ? payload.ollamaPromptReceipt
                : payload.ollamaPromptReceipt?.id || "");
        } catch (reason) {
            setError(errorMessage(reason, "無法產生提示詞。"));
        } finally {
            setPromptBusy(false);
        }
    }

    async function generateImage() {
        if (!source || !posePreview) {
            setError("請先上傳圖片並完成骨架擷取。");
            return;
        }
        if (!prompt.trim()) {
            setError("請先產生或輸入提示詞。");
            return;
        }
        if (!ready) {
            setError(poseReadinessMessage(health));
            return;
        }
        setSubmitting(true);
        setError("");
        try {
            const next = await submitImg2Img({
                sourceName: source.name,
                sourceRoot: source.root === "output" ? "output" : "input",
                poseName: source.name,
                poseRoot: source.root === "output" ? "output" : "input",
                poseControlStrength,
                poseResolution,
                prompt: prompt.trim(),
                negativePrompt: negativePrompt.trim(),
                ...(promptReceipt ? { ollamaPromptReceipt: promptReceipt } : {}),
                model: SDXL_MODEL,
                denoise,
                steps: DEFAULT_STEPS,
                cfg: DEFAULT_CFG,
                seed: normalizeSeed(seed),
                batchCount: 1,
                randomRanges: {
                    denoise: { min: denoise, max: denoise },
                    steps: { min: DEFAULT_STEPS, max: DEFAULT_STEPS },
                    cfg: { min: DEFAULT_CFG, max: DEFAULT_CFG },
                },
            });
            setJob(next);
        } catch (reason) {
            setError(errorMessage(reason, "無法啟動骨架生圖。"));
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <div className={styles.workspace}>
            <section className={styles.hero}>
                <div>
                    <span className={styles.eyebrow}>POSE → IMAGE</span>
                    <h2>上傳人物圖，擷取骨架，再依姿勢生圖</h2>
                    <p>來源圖只提供姿勢與構圖；生圖內容由描述與提示詞決定。</p>
                </div>
                <div className={styles.statusGroup}>
                    <span className={`${styles.statusChip} ${health?.comfyUi ? styles.ready : styles.blocked}`}>
                        ComfyUI {health?.comfyUi ? "已連線" : "未連線"}
                    </span>
                    <span className={`${styles.statusChip} ${health?.pose?.available ? styles.ready : styles.blocked}`}>
                        OpenPose {health?.pose?.available ? "已就緒" : "未就緒"}
                    </span>
                </div>
            </section>

            <div className={styles.previewGrid}>
                <section className={styles.panel}>
                    <div className={styles.sectionHeader}>
                        <div><span className={styles.eyebrow}>01</span><h3>來源圖片</h3></div>
                        <button type="button" className={styles.secondaryButton} onClick={() => inputRef.current?.click()} disabled={uploading || extracting || active}>
                            {uploading ? "上傳中…" : source ? "更換圖片" : "上傳圖片"}
                        </button>
                    </div>
                    <input ref={inputRef} className={styles.hiddenInput} type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void uploadAndExtract(event)} />
                    {source ? (
                        <div className={styles.imageFrame}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={assetUrl(source)} alt={`姿勢來源：${source.name}`} />
                        </div>
                    ) : <EmptyState title="尚未上傳圖片" note="選擇一張人物姿勢清楚的圖片。" />}
                </section>

                <section className={styles.panel}>
                    <div className={styles.sectionHeader}>
                        <div><span className={styles.eyebrow}>02</span><h3>目前骨架</h3></div>
                        <button type="button" className={styles.secondaryButton} onClick={() => void regeneratePose()} disabled={!source || extracting || active}>
                            {extracting ? "擷取中…" : "重新擷取"}
                        </button>
                    </div>
                    {posePreview ? (
                        <div className={`${styles.imageFrame} ${styles.poseFrame}`}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={posePreview} alt="DWPose 骨架預覽" />
                        </div>
                    ) : <EmptyState title={extracting ? "正在擷取骨架" : "尚無骨架"} note="上傳圖片後會自動使用 DWPose 擷取。" />}
                </section>
            </div>

            <section className={styles.panel}>
                <div className={styles.sectionHeader}>
                    <div><span className={styles.eyebrow}>03</span><h3>描述與提示詞</h3></div>
                    <span className={styles.modelNote}>{ollamaModel ? `Ollama · ${ollamaModel}` : "Ollama 未就緒"}</span>
                </div>
                <label className={styles.field}>
                    <span>圖片描述</span>
                    <textarea rows={3} value={description} placeholder="例如：成年東亞女性，白色運動服，在明亮客廳做伸展，真實手機攝影感。" onChange={(event) => setDescription(event.target.value)} />
                </label>
                <button type="button" className={styles.secondaryButton} onClick={() => void generatePrompt()} disabled={!source || !description.trim() || !ollamaModel || promptBusy || active}>
                    {promptBusy ? "產生提示詞中…" : "產生提示詞"}
                </button>
                <label className={styles.field}>
                    <span>Prompt</span>
                    <textarea rows={5} value={prompt} placeholder="AI 產生後可直接修改" onChange={(event) => setPrompt(event.target.value)} />
                </label>
                <details className={styles.optional}>
                    <summary>負面提示詞</summary>
                    <div className={styles.field}>
                        <textarea aria-label="負面提示詞" rows={3} value={negativePrompt} onChange={(event) => setNegativePrompt(event.target.value)} />
                    </div>
                </details>
            </section>

            <section className={styles.panel}>
                <div className={styles.generateRow}>
                    <div>
                        <span className={styles.eyebrow}>04 / SDXL</span>
                        <h3>依骨架姿勢生成圖片</h3>
                        <p className={styles.helper}>SDXL Turbo 1.0 FP16 · 4 steps · CFG 1</p>
                    </div>
                    <label className={styles.denoiseField} htmlFor="pose-to-image-denoise">
                        <span>重繪強度 {denoise.toFixed(2)}</span>
                        <input
                            id="pose-to-image-denoise"
                            type="range"
                            min="0.55"
                            max="1"
                            step="0.05"
                            value={denoise}
                            onChange={(event) => setDenoise(Number(event.target.value))}
                        />
                        <small>0.55 保留較多原圖 · 1.0 只取骨架</small>
                    </label>
                    <div className={styles.poseSettings}>
                        <label className={styles.denoiseField} htmlFor="pose-to-image-control-strength">
                            <span>骨架控制強度 {poseControlStrength.toFixed(1)}</span>
                            <input
                                id="pose-to-image-control-strength"
                                type="range"
                                min="0.5"
                                max="2"
                                step="0.1"
                                value={poseControlStrength}
                                onChange={(event) => setPoseControlStrength(Number(event.target.value))}
                            />
                            <small>越高越貼近骨架；過高可能讓肢體僵硬</small>
                        </label>
                        <label className={styles.resolutionField} htmlFor="pose-to-image-pose-resolution">
                            <span>DWPose 解析度：{poseResolution} px</span>
                            <input
                                id="pose-to-image-pose-resolution"
                                type="range"
                                min={512}
                                max={1024}
                                step={256}
                                value={poseResolution}
                                aria-label="DWPose 解析度滑桿"
                                onInput={(event) => setPoseResolution(Number(event.currentTarget.value))}
                            />
                            <span className={styles.resolutionTicks} aria-hidden="true"><span>512 · 快速</span><span>768 · 建議</span><span>1024 · 精細</span></span>
                            <small>調整後按「重新擷取骨架」套用到預覽。</small>
                        </label>
                    </div>
                    <div className={styles.seedField}>
                        <label htmlFor="pose-to-image-seed">Seed</label>
                        <div>
                            <input id="pose-to-image-seed" value={seed} inputMode="numeric" onChange={(event) => setSeed(event.target.value)} />
                            <button type="button" className={styles.textButton} onClick={() => setSeed(String(randomSeed()))}>隨機</button>
                        </div>
                    </div>
                    <button type="button" className={styles.primaryButton} onClick={() => void generateImage()} disabled={!source || !posePreview || !prompt.trim() || !ready || submitting || active}>
                        {submitting ? "送出中…" : active ? "生成中…" : "生成圖片"}
                    </button>
                </div>
                {!ready && health && <p className={styles.warning}>{poseReadinessMessage(health)}</p>}
                {job && (
                    <div className={styles.progressRow}>
                        <span>{job.stage || job.status}</span>
                        <strong>{Math.round(job.progress || 0)}%</strong>
                    </div>
                )}
                {job?.output && (
                    <div className={styles.result}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={assetUrl(job.output)} alt="骨架姿勢生圖結果" />
                        <a href={assetUrl(job.output)} target="_blank" rel="noreferrer">開啟原圖</a>
                    </div>
                )}
            </section>

            {error && <p className={styles.error} role="alert">{error}</p>}
        </div>
    );
}

function EmptyState({ title, note }: { title: string; note: string }) {
    return <div className={styles.empty}><strong>{title}</strong><span>{note}</span></div>;
}

async function requestPosePreview(file: File, resolution: number) {
    const imageData = await imageFileToDataUrl(file, 1536);
    const response = await fetch("/app/api/img2img/pose-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageData, resolution }),
    });
    const payload = await response.json().catch(() => ({})) as PosePreviewPayload;
    if (!response.ok || !payload.previewDataUrl) throw new Error(apiError(payload, "骨架擷取失敗。"));
    return payload.previewDataUrl;
}

async function imageFileToDataUrl(file: Blob, maxDimension: number) {
    const objectUrl = URL.createObjectURL(file);
    try {
        const image = new Image();
        image.src = objectUrl;
        await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error("無法解碼來源圖片。"));
        });
        const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("無法建立圖片畫布。");
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/jpeg", 0.9);
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

async function assetToPromptImage(asset: StudioAsset) {
    const response = await fetch(assetUrl(asset));
    if (!response.ok) throw new Error("無法讀取來源圖片。");
    const dataUrl = await imageFileToDataUrl(await response.blob(), 1024);
    return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

function choosePromptModel(models: readonly string[]) {
    const normalized = models.filter((model) => typeof model === "string" && model.trim());
    return normalized.find((model) => /qwen.*vl|vision|gemma/i.test(model)) || normalized[0] || "";
}

function poseReadinessMessage(health: PoseAwareHealth | null) {
    if (!health?.comfyUi) return "ComfyUI 未連線。";
    if (!health.models?.[SDXL_MODEL]) return `缺少或無法使用 SDXL checkpoint：${SDXL_MODEL}`;
    const reason = health.pose?.reason;
    if (reason === "POSE_CONTROLNET_NOT_CONFIGURED") return "尚未設定 H3_IMG2IMG_POSE_CONTROLNET。";
    if (reason === "POSE_REQUIRED_NODE_MISSING") return "ComfyUI 缺少 DWPose / ControlNet 必要節點。";
    if (reason === "POSE_CONTROLNET_MODEL_MISSING") return "設定的 OpenPose ControlNet 模型不存在。";
    return "OpenPose ControlNet 尚未就緒。";
}

function normalizeSeed(value: string) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) return randomSeed();
    return parsed;
}

function randomSeed() {
    const values = new Uint32Array(1);
    crypto.getRandomValues(values);
    return values[0] & 0x7fffffff;
}

function terminal(status?: string) {
    return ["completed", "failed", "cancelled", "partial", "interrupted"].includes(String(status || ""));
}

function apiError(payload: PromptPayload | PosePreviewPayload, fallback: string) {
    const detail = typeof payload.error === "string" ? payload.error : payload.error?.message;
    const code = payload.code || (typeof payload.error === "object" ? payload.error?.code : "");
    return code ? `${code}: ${detail || fallback}` : detail || fallback;
}

function errorMessage(reason: unknown, fallback: string) {
    return reason instanceof Error ? reason.message : fallback;
}
