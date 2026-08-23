"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useState } from "react";
import { jobStatusLabel, localizedCopy, readinessLabel as localizedReadinessLabel, sourceLabel } from "../../lib/ui-copy.mjs";
import { useI18n } from "../../i18n/I18nProvider";
import { AssetPickerButton } from "../library/AssetPickerButton";
import { assetKey, uploadAssets, verifyAssetAvailable, type StudioAsset } from "../library/asset-client";
import {
    fetchUpscaleHealth,
    fetchUpscaleJob,
    cancelUpscaleJob,
    retryUpscaleJob,
    submitUpscale,
    UPSCALE_SCALE,
    UPSCALE_PROFILES,
    DEFAULT_UPSCALE_PROFILE,
    SEEDVR2_SCALE_MIN,
    SEEDVR2_SCALE_MAX,
    SEEDVR2_RESIZE_METHODS,
    SEEDVR2_COLOR_CORRECTIONS,
    SEEDVR2_SAMPLERS,
    SEEDVR2_SCHEDULERS,
    SEEDVR2_DEFAULT_SAMPLING,
    upscaleAssetHref,
    UpscaleApiError,
    type UpscaleHealth,
    type UpscaleJob,
    type UpscaleProfile,
    type SeedVR2ResizeMethod,
    type SeedVR2ColorCorrection,
    type SeedVR2SamplerName,
    type SeedVR2Scheduler,
} from "./upscale-client";
import styles from "./UpscaleWorkspace.module.css";

const ACTIVE_STATUSES = new Set(["queued", "running", "cancelling"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

export function UpscaleWorkspace() {
    const { locale, t } = useI18n();
    const { ACTION_LABELS } = localizedCopy(locale);
    const [source, setSource] = useState<StudioAsset | null>(null);
    const [job, setJob] = useState<UpscaleJob | null>(null);
    const [profile, setProfile] = useState<UpscaleProfile>(DEFAULT_UPSCALE_PROFILE);
    const [scale, setScale] = useState(String(UPSCALE_SCALE));
    const [seed, setSeed] = useState("");
    const [resizeMethod, setResizeMethod] = useState<SeedVR2ResizeMethod>("lanczos");
    const [colorCorrection, setColorCorrection] = useState<SeedVR2ColorCorrection>("wavelet");
    const [steps, setSteps] = useState(String(SEEDVR2_DEFAULT_SAMPLING.steps));
    const [cfg, setCfg] = useState(String(SEEDVR2_DEFAULT_SAMPLING.cfg));
    const [samplerName, setSamplerName] = useState<SeedVR2SamplerName>(SEEDVR2_DEFAULT_SAMPLING.samplerName);
    const [scheduler, setScheduler] = useState<SeedVR2Scheduler>(SEEDVR2_DEFAULT_SAMPLING.scheduler);
    const [denoise, setDenoise] = useState(String(SEEDVR2_DEFAULT_SAMPLING.denoise));
    const [health, setHealth] = useState<UpscaleHealth | null>(null);
    const [healthLoading, setHealthLoading] = useState(true);
    const [healthError, setHealthError] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState<"upload" | "submit" | "cancel" | "retry" | "">("");
    const [outputAvailable, setOutputAvailable] = useState<boolean | null>(null);
    const sourceKind = source?.kind || "video";
    const isSeedVR2 = profile === "seedvr2_7b_sharp_nvfp4";
    const activeScale = isSeedVR2 ? (scale || "—") : UPSCALE_SCALE;
    const samplingIsDefault = steps.trim() !== ""
        && Number(steps) === SEEDVR2_DEFAULT_SAMPLING.steps
        && cfg.trim() !== ""
        && Number(cfg) === SEEDVR2_DEFAULT_SAMPLING.cfg
        && samplerName === SEEDVR2_DEFAULT_SAMPLING.samplerName
        && scheduler === SEEDVR2_DEFAULT_SAMPLING.scheduler
        && denoise.trim() !== ""
        && Number(denoise) === SEEDVR2_DEFAULT_SAMPLING.denoise;

    const refreshHealth = useCallback(async () => {
        setHealthLoading(true);
        try {
            const next = await fetchUpscaleHealth(profile, sourceKind);
            setHealth(next);
            setHealthError("");
        } catch (reason) {
            setHealth(null);
            setHealthError(reason instanceof Error ? reason.message : `無法檢查 ${profile} 是否就緒。`);
        } finally {
            setHealthLoading(false);
        }
    }, [profile, sourceKind]);

    useEffect(() => {
        const timer = window.setTimeout(() => void refreshHealth(), 0);
        return () => window.clearTimeout(timer);
    }, [refreshHealth]);

    const active = Boolean(job && ACTIVE_STATUSES.has(job.status));
    const progress = Math.min(100, Math.max(0, Math.round(Number(job?.progress) || 0)));
    const sourceKey = source ? assetKey(source) : "";
    const selectedProfile = UPSCALE_PROFILES.find((item) => item.id === profile) || UPSCALE_PROFILES[0];
    const missingNodes = useMemo(
        () => Object.entries(health?.nodes || {}).filter(([, available]) => !available).map(([name]) => name),
        [health?.nodes],
    );
    const availableModels = useMemo(
        () => Object.values(health?.models || {}).filter((model) => model.available).length,
        [health?.models],
    );
    const modelTotal = useMemo(
        () => Object.keys(health?.models || {}).length,
        [health?.models],
    );
    const canRetry = Boolean(job && TERMINAL_STATUSES.has(job.status) && !busy && !active);

    async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file || busy || active) return;
        setBusy("upload");
        setError("");
        try {
            const [uploaded] = await uploadAssets([file]);
            if (!uploaded || !["image", "video"].includes(uploaded.kind)) throw new Error("請選擇圖片或影片素材。");
            if (uploaded.kind === "image") setProfile("seedvr2_7b_sharp_nvfp4");
            setSource(uploaded);
            setJob(null);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "無法上傳來源素材。");
        } finally {
            setBusy("");
        }
    }

    function handleLibrarySelection(assets: StudioAsset[]) {
        const selected = assets.find((asset) => asset.kind === "image" || asset.kind === "video");
        if (!selected || active || busy) return;
        if (selected.kind === "image") setProfile("seedvr2_7b_sharp_nvfp4");
        setSource(selected);
        setJob(null);
        setError("");
    }

    async function start() {
        if (!source) {
            setError("開始升頻前請先選擇來源圖片或影片。");
            document.getElementById("upscale-source-picker")?.focus();
            return;
        }
        if (active || busy) return;
        if (health?.ready === false) {
            setError(readinessLabel);
            document.getElementById("upscale-readiness")?.focus();
            return;
        }
        setBusy("submit");
        setError("");
        try {
            const parsedScale = Number(scale);
            if (isSeedVR2 && (scale.trim() === "" || !Number.isFinite(parsedScale) || parsedScale < SEEDVR2_SCALE_MIN || parsedScale > SEEDVR2_SCALE_MAX)) {
                throw new Error(`SeedVR2 放大倍數必須介於 ${SEEDVR2_SCALE_MIN}× 到 ${SEEDVR2_SCALE_MAX}×。`);
            }
            const parsedSeed = seed.trim() === "" ? undefined : Number(seed);
            if (parsedSeed !== undefined && (!Number.isSafeInteger(parsedSeed) || parsedSeed < 0 || parsedSeed > 2_147_483_647)) {
                throw new Error("隨機種子必須是 0 到 2147483647 的整數，留空則每次隨機。");
            }
            let samplingSettings = {};
            if (isSeedVR2) {
                const parsedSteps = Number(steps);
                const parsedCfg = Number(cfg);
                const parsedDenoise = Number(denoise);
                if (steps.trim() === "" || !Number.isSafeInteger(parsedSteps) || parsedSteps < 1 || parsedSteps > 20) {
                    throw new Error(t("upscale.seedvr2.steps.error"));
                }
                if (cfg.trim() === "" || !Number.isFinite(parsedCfg) || parsedCfg < 0 || parsedCfg > 20) {
                    throw new Error(t("upscale.seedvr2.cfg.error"));
                }
                if (denoise.trim() === "" || !Number.isFinite(parsedDenoise) || parsedDenoise < 0 || parsedDenoise > 1) {
                    throw new Error(t("upscale.seedvr2.denoise.error"));
                }
                samplingSettings = {
                    steps: parsedSteps,
                    cfg: Math.round(parsedCfg * 100) / 100,
                    samplerName,
                    scheduler,
                    denoise: Math.round(parsedDenoise * 100) / 100,
                };
            }
            const next = await submitUpscale(source, profile, {
                scale: isSeedVR2 ? parsedScale : UPSCALE_SCALE,
                seed: parsedSeed,
                resizeMethod,
                colorCorrection,
                ...samplingSettings,
            });
            setJob(next);
            if (next.status === "failed") setError(next.error || `${selectedProfile.label} 升頻失敗。`);
        } catch (reason) {
            if (reason instanceof UpscaleApiError && reason.health) setHealth(reason.health);
            setError(reason instanceof Error ? reason.message : `無法開始 ${selectedProfile.label} 升頻。`);
        } finally {
            setBusy("");
        }
    }

    async function retry() {
        if (!job || !canRetry) return;
        setBusy("retry");
        setError("");
        try {
            const next = await retryUpscaleJob(job.id);
            setJob(next);
        } catch (reason) {
            if (reason instanceof UpscaleApiError && reason.health) setHealth(reason.health);
            setError(reason instanceof Error ? reason.message : `無法重試 ${selectedProfile.label} 升頻。`);
        } finally {
            setBusy("");
        }
    }

    async function cancel() {
        if (!job || !active || busy || job.status === "cancelling") return;
        setBusy("cancel");
        setError("");
        try {
            setJob(await cancelUpscaleJob(job.id));
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : `無法取消 ${selectedProfile.label} 升頻。`);
        } finally {
            setBusy("");
        }
    }

    useEffect(() => {
        if (!job?.id || !active) return;
        let disposed = false;
        const poll = async () => {
            try {
                const next = await fetchUpscaleJob(job.id);
                if (disposed) return;
                setJob(next);
                if (TERMINAL_STATUSES.has(next.status) && next.status === "failed") {
                    setError(next.error || `${selectedProfile.label} 升頻失敗。`);
                }
            } catch (reason) {
                if (!disposed && reason instanceof UpscaleApiError && reason.status === 404) {
                    setJob(null);
                    setError(reason.message);
                }
            }
        };
        void poll();
        const timer = window.setInterval(() => void poll(), 1500);
        return () => {
            disposed = true;
            window.clearInterval(timer);
        };
    }, [active, job?.id, selectedProfile.label]);

    useEffect(() => {
        const output = job?.status === "completed" ? job.output : null;
        let active = true;
        if (!output) {
            queueMicrotask(() => {
                if (active) setOutputAvailable(null);
            });
            return () => {
                active = false;
            };
        }
        queueMicrotask(() => {
            if (active) setOutputAvailable(null);
        });
        void verifyAssetAvailable(output).then((available) => {
            if (active) setOutputAvailable(available);
        });
        return () => {
            active = false;
        };
    }, [job?.id, job?.output, job?.output?.name, job?.output?.root, job?.output?.url, job?.status]);

    const statusLabel = job
        ? `${jobStatusLabel(job.status === "completed" ? "complete" : job.status, "upscale", locale)}${job.stage ? ` · ${job.stage}` : ""}`
        : "已就緒，可開始升頻";
    const readinessLabel = healthLoading ? localizedReadinessLabel("checking", locale) : health?.ready ? localizedReadinessLabel("ready", locale) : localizedReadinessLabel("unavailable", locale);

    function handleProfileChange(event: ChangeEvent<HTMLSelectElement>) {
        if (active || busy) return;
        const next = event.target.value as UpscaleProfile;
        if (!UPSCALE_PROFILES.some((item) => item.id === next)) return;
        setProfile(next);
        setHealth(null);
        setHealthError("");
        setJob(null);
        setError("");
    }

    function resetSeedVR2Sampling() {
        if (active || busy) return;
        setSteps(String(SEEDVR2_DEFAULT_SAMPLING.steps));
        setCfg(String(SEEDVR2_DEFAULT_SAMPLING.cfg));
        setSamplerName(SEEDVR2_DEFAULT_SAMPLING.samplerName);
        setScheduler(SEEDVR2_DEFAULT_SAMPLING.scheduler);
        setDenoise(String(SEEDVR2_DEFAULT_SAMPLING.denoise));
        setError("");
    }

    return (
        <div className={styles.workspace}>
            <section className={styles.header}>
                <div>
                    <span className={styles.kicker}>圖片與影片升頻 / {selectedProfile.label}</span>
                    <h2>圖片與影片升頻</h2>
                    <p>{selectedProfile.description} 產生 {activeScale}× 升頻結果{sourceKind === "video" ? "並保留原始音訊" : ""}。</p>
                </div>
                <span className={styles.scaleBadge}>{activeScale}×</span>
            </section>

            <section className={styles.grid}>
                <div className={styles.card}>
                    <div className={styles.cardHeading}>
                        <div>
                            <span className={styles.kicker}>來源素材</span>
                            <h3>{source ? source.name : "選擇圖片或影片"}</h3>
                        </div>
                        {source && <span className={styles.sourceKind}>{source.root.toUpperCase()}</span>}
                    </div>
                    {source ? (
                        <>
                            {source.kind === "image"
                                ? <img className={styles.sourcePreview} src={upscaleAssetHref(source)} alt={source.name} />
                                : <video className={styles.sourcePreview} src={upscaleAssetHref(source)} controls playsInline preload="metadata"><track kind="captions" /></video>}
                            <div className={styles.sourceMeta}>
                                <span>{source.kind === "video" ? (locale === "en" ? "Video" : "影片") : (locale === "en" ? "Image" : "圖片")} · {sourceLabel(source.root, locale)}</span>
                                <button type="button" className={styles.textButton} disabled={active || Boolean(busy)} onClick={() => { setSource(null); setJob(null); setError(""); }}>
                                    {ACTION_LABELS.clearSource}
                                </button>
                            </div>
                        </>
                    ) : (
                        <div className={styles.emptySource}>從素材庫選擇圖片或影片，或從此裝置上傳。</div>
                    )}
                    <div className={styles.sourceActions}>
                        <AssetPickerButton triggerId="upscale-source-picker" allowedKinds={["image", "video"]} selectedKeys={sourceKey ? [sourceKey] : []} onSelect={handleLibrarySelection} label={ACTION_LABELS.browseLibrary} />
                        <label className={styles.uploadButton}>
                            上傳圖片或影片
                            <input type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm,video/x-matroska,video/x-msvideo" onChange={(event) => void handleUpload(event)} disabled={active || Boolean(busy)} />
                        </label>
                    </div>
                </div>

                <div className={styles.card}>
                    <div className={styles.cardHeading}>
                        <div>
                            <span className={styles.kicker}>升頻設定檔</span>
                            <h3>{selectedProfile.label}</h3>
                        </div>
                        <span className={styles.scaleBadge}>{activeScale}×</span>
                    </div>
                    <label className={styles.profileField}>
                        <span>運算後端</span>
                        <select value={profile} onChange={handleProfileChange} disabled={active || Boolean(busy)} aria-label="選擇升頻後端">
                            {UPSCALE_PROFILES.map((item) => <option key={item.id} value={item.id} disabled={sourceKind === "image" && !item.supportsImages}>{item.label}</option>)}
                        </select>
                    </label>
                    {isSeedVR2 && (
                        <div className={styles.parameterPanel} aria-label="SeedVR2 進階參數">
                            <div className={styles.parameterHeading}>
                                <strong>SeedVR2 參數</strong>
                                <span>{t("upscale.seedvr2.defaultSampling")}</span>
                            </div>
                            <div className={styles.parameterGrid}>
                                <label className={styles.profileField}>
                                    <span>放大倍數</span>
                                    <input type="number" min={SEEDVR2_SCALE_MIN} max={SEEDVR2_SCALE_MAX} step="0.25" value={scale} onChange={(event) => setScale(event.target.value)} disabled={active || Boolean(busy)} />
                                </label>
                                <label className={styles.profileField}>
                                    <span>隨機種子</span>
                                    <input type="number" min="0" max="2147483647" step="1" value={seed} placeholder="留空為隨機" onChange={(event) => setSeed(event.target.value)} disabled={active || Boolean(busy)} />
                                </label>
                                <label className={styles.profileField}>
                                    <span>縮放演算法</span>
                                    <select value={resizeMethod} onChange={(event) => setResizeMethod(event.target.value as SeedVR2ResizeMethod)} disabled={active || Boolean(busy)}>
                                        {SEEDVR2_RESIZE_METHODS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                                    </select>
                                </label>
                                <label className={styles.profileField}>
                                    <span>色彩校正</span>
                                    <select value={colorCorrection} onChange={(event) => setColorCorrection(event.target.value as SeedVR2ColorCorrection)} disabled={active || Boolean(busy)}>
                                        {SEEDVR2_COLOR_CORRECTIONS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                                    </select>
                                </label>
                            </div>
                            <p className={styles.helper}>1–4× 可調；倍數越高會明顯增加統一記憶體用量與處理時間。</p>
                            <details className={styles.advancedSampling}>
                                <summary>
                                    <span>{t("upscale.seedvr2.advancedSampling")}</span>
                                    <small>1 / 1 / euler / simple / 1.0</small>
                                </summary>
                                <div className={styles.advancedSamplingBody}>
                                    <div className={styles.parameterGrid}>
                                        <label className={styles.profileField}>
                                            <span>{t("upscale.seedvr2.steps")}</span>
                                            <input type="number" min="1" max="20" step="1" value={steps} onChange={(event) => setSteps(event.target.value)} disabled={active || Boolean(busy)} />
                                        </label>
                                        <label className={styles.profileField}>
                                            <span>{t("upscale.seedvr2.cfg")}</span>
                                            <input type="number" min="0" max="20" step="0.05" value={cfg} onChange={(event) => setCfg(event.target.value)} disabled={active || Boolean(busy)} />
                                        </label>
                                        <label className={styles.profileField}>
                                            <span>{t("upscale.seedvr2.sampler")}</span>
                                            <select value={samplerName} onChange={(event) => setSamplerName(event.target.value as SeedVR2SamplerName)} disabled={active || Boolean(busy)}>
                                                {SEEDVR2_SAMPLERS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                                            </select>
                                        </label>
                                        <label className={styles.profileField}>
                                            <span>{t("upscale.seedvr2.scheduler")}</span>
                                            <select value={scheduler} onChange={(event) => setScheduler(event.target.value as SeedVR2Scheduler)} disabled={active || Boolean(busy)}>
                                                {SEEDVR2_SCHEDULERS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                                            </select>
                                        </label>
                                        <label className={styles.profileField}>
                                            <span>{t("upscale.seedvr2.denoise")}</span>
                                            <input type="number" min="0" max="1" step="0.05" value={denoise} onChange={(event) => setDenoise(event.target.value)} disabled={active || Boolean(busy)} />
                                        </label>
                                    </div>
                                    <div className={styles.advancedSamplingFooter}>
                                        <button type="button" className={styles.textButton} onClick={resetSeedVR2Sampling} disabled={active || Boolean(busy)}>{t("upscale.seedvr2.resetSampling")}</button>
                                        {!samplingIsDefault && <p className={styles.samplingWarning} role="status">{t("upscale.seedvr2.experimentalWarning")}</p>}
                                    </div>
                                </div>
                            </details>
                        </div>
                    )}
                    <div id="upscale-readiness" className={styles.readiness} tabIndex={-1} aria-live="polite">
                        <span className={`${styles.statusDot} ${health?.ready ? styles.online : ""}`} />
                        <div>
                            <strong>{readinessLabel}</strong>
                            <span>{health?.comfyUi === false ? "ComfyUI 未連線。" : `${availableModels}/${modelTotal || 0} 個模型檔案可用 · ${missingNodes.length ? `${missingNodes.length} 個節點缺失` : "原生節點可用"}`}</span>
                        </div>
                        <button type="button" className={styles.textButton} onClick={() => void refreshHealth()} disabled={healthLoading || Boolean(busy)}>{ACTION_LABELS.refresh}</button>
                    </div>
                    {healthError && <p className={styles.inlineError} role="alert">{healthError}</p>}
                    {missingNodes.length > 0 && <p className={styles.helper}>缺少節點：{missingNodes.join(", ")}</p>}
                    <button type="button" className={styles.primaryButton} onClick={() => void start()} disabled={active || Boolean(busy)} aria-busy={busy === "submit" || busy === "upload"} aria-describedby="upscale-readiness">
                        {busy === "submit" ? "建立工作中…" : active ? "升頻中…" : `開始 ${activeScale}× 升頻`}
                    </button>
                    <div className={styles.status} aria-live="polite">
                        <div className={styles.statusLine}>
                            <span className={`${styles.statusDot} ${active ? styles.online : job?.status === "failed" ? styles.failed : ""}`} />
                            <span>{statusLabel}</span>
                            {job && <strong>{progress}%</strong>}
                        </div>
                        {job && <div className={styles.progressTrack} role="progressbar" aria-label={`${selectedProfile.label} 進度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={`${progress}%`}><span style={{ width: `${progress}%` }} /></div>}
                    </div>
                    {active && job?.status !== "cancelling" && <button type="button" className={styles.secondaryButton} onClick={() => void cancel()} disabled={Boolean(busy)}>{busy === "cancel" ? "取消中…" : ACTION_LABELS.cancel}</button>}
                    {job && (job.status === "failed" || job.status === "cancelled" || job.status === "interrupted") && <button type="button" className={styles.secondaryButton} onClick={() => void retry()} disabled={!canRetry}>{busy === "retry" ? "重試中…" : ACTION_LABELS.retry}</button>}
                    {job?.status === "cancelling" && <p className={styles.helper}>正在停止目前的 {selectedProfile.label} 流程…</p>}
                </div>
            </section>

            {error && <p className={styles.error} role="alert">{error}</p>}

            {job?.status === "completed" && job.output && outputAvailable === false && (
                <p className={styles.error} role="status">輸出檔案不存在或已失效。</p>
            )}

            {job?.status === "completed" && job.output && outputAvailable === true && (
                <section className={styles.result} aria-live="polite">
                    <div className={styles.cardHeading}>
                        <div>
                            <span className={styles.kicker}>升頻結果</span>
                            <h3>{job.output.name}</h3>
                        </div>
                        <span className={styles.resultBadge}>{job.scale || activeScale}× 已完成</span>
                    </div>
                    {job.output.kind === "image"
                        ? <img className={styles.resultPreview} src={upscaleAssetHref(job.output)} alt={job.output.name} />
                        : <video className={styles.resultPreview} src={upscaleAssetHref(job.output)} controls playsInline preload="metadata"><track kind="captions" /></video>}
                    <div className={styles.resultActions}>
                        <a className={styles.secondaryButton} href={upscaleAssetHref(job.output)} target="_blank" rel="noreferrer">{ACTION_LABELS.preview}</a>
                        <a className={styles.secondaryButton} href={`${upscaleAssetHref(job.output)}${upscaleAssetHref(job.output).includes("?") ? "&" : "?"}download=1`} download>{ACTION_LABELS.downloadResult}</a>
                        <a className={styles.textLink} href={`/app/jobs/${encodeURIComponent(job.id)}?source=upscale`}>{ACTION_LABELS.details}</a>
                    </div>
                </section>
            )}
        </div>
    );
}
