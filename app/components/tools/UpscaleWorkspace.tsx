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
    upscaleAssetHref,
    UpscaleApiError,
    type UpscaleHealth,
    type UpscaleJob,
} from "./upscale-client";
import styles from "./UpscaleWorkspace.module.css";

const ACTIVE_STATUSES = new Set(["queued", "running", "cancelling"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

export function UpscaleWorkspace() {
    const { locale } = useI18n();
    const { ACTION_LABELS } = localizedCopy(locale);
    const [source, setSource] = useState<StudioAsset | null>(null);
    const [job, setJob] = useState<UpscaleJob | null>(null);
    const [health, setHealth] = useState<UpscaleHealth | null>(null);
    const [healthLoading, setHealthLoading] = useState(true);
    const [healthError, setHealthError] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState<"upload" | "submit" | "cancel" | "retry" | "">("");
    const [outputAvailable, setOutputAvailable] = useState<boolean | null>(null);

    const refreshHealth = useCallback(async () => {
        setHealthLoading(true);
        try {
            const next = await fetchUpscaleHealth();
            setHealth(next);
            setHealthError("");
        } catch (reason) {
            setHealth(null);
            setHealthError(reason instanceof Error ? reason.message : "無法檢查 SeedVR2 是否就緒。");
        } finally {
            setHealthLoading(false);
        }
    }, []);

    useEffect(() => {
        const timer = window.setTimeout(() => void refreshHealth(), 0);
        return () => window.clearTimeout(timer);
    }, [refreshHealth]);

    const active = Boolean(job && ACTIVE_STATUSES.has(job.status));
    const progress = Math.min(100, Math.max(0, Math.round(Number(job?.progress) || 0)));
    const sourceKey = source ? assetKey(source) : "";
    const missingNodes = useMemo(
        () => Object.entries(health?.nodes || {}).filter(([, available]) => !available).map(([name]) => name),
        [health?.nodes],
    );
    const availableModels = useMemo(
        () => Object.values(health?.models || {}).filter((model) => model.available).length,
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
            if (!uploaded || uploaded.kind !== "video") throw new Error("請選擇影片素材。");
            setSource(uploaded);
            setJob(null);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "無法上傳來源影片。");
        } finally {
            setBusy("");
        }
    }

    function handleLibrarySelection(assets: StudioAsset[]) {
        const selected = assets.find((asset) => asset.kind === "video");
        if (!selected || active || busy) return;
        setSource(selected);
        setJob(null);
        setError("");
    }

    async function start() {
        if (!source) {
            setError("開始升頻前請先選擇來源影片。");
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
            const next = await submitUpscale(source);
            setJob(next);
                if (next.status === "failed") setError(next.error || "SeedVR2 影片升頻失敗。" );
        } catch (reason) {
            if (reason instanceof UpscaleApiError && reason.health) setHealth(reason.health);
            setError(reason instanceof Error ? reason.message : "無法開始 SeedVR2 升頻。");
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
            setError(reason instanceof Error ? reason.message : "無法重試 SeedVR2 升頻。");
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
            setError(reason instanceof Error ? reason.message : "無法取消 SeedVR2 升頻。");
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
                        setError(next.error || "SeedVR2 影片升頻失敗。" );
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
    }, [active, job?.id]);

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

    return (
        <div className={styles.workspace}>
            <section className={styles.header}>
                <div>
                    <span className={styles.kicker}>影片升頻 / SEEDVR2</span>
                    <h2>影片升頻</h2>
                    <p>使用原生 SeedVR2 3B Int8 流程，產生清晰的 2× 影片升頻結果。</p>
                </div>
                <span className={styles.scaleBadge}>{UPSCALE_SCALE}×</span>
            </section>

            <section className={styles.grid}>
                <div className={styles.card}>
                    <div className={styles.cardHeading}>
                        <div>
                            <span className={styles.kicker}>來源影片</span>
                            <h3>{source ? source.name : "選擇影片"}</h3>
                        </div>
                        {source && <span className={styles.sourceKind}>{source.root.toUpperCase()}</span>}
                    </div>
                    {source ? (
                        <>
                            <video className={styles.sourcePreview} src={upscaleAssetHref(source)} controls playsInline preload="metadata">
                                <track kind="captions" />
                            </video>
                            <div className={styles.sourceMeta}>
                                <span>{source.kind === "video" ? (locale === "en" ? "Video" : "影片") : source.kind} · {sourceLabel(source.root, locale)}</span>
                                <button type="button" className={styles.textButton} disabled={active || Boolean(busy)} onClick={() => { setSource(null); setJob(null); setError(""); }}>
                                    {ACTION_LABELS.clearSource}
                                </button>
                            </div>
                        </>
                    ) : (
                        <div className={styles.emptySource}>從素材庫選擇影片，或從此裝置上傳影片。</div>
                    )}
                    <div className={styles.sourceActions}>
                        <AssetPickerButton triggerId="upscale-source-picker" kind="video" selectedKeys={sourceKey ? [sourceKey] : []} onSelect={handleLibrarySelection} label={ACTION_LABELS.browseLibrary} />
                        <label className={styles.uploadButton}>
                            上傳影片
                            <input type="file" accept="video/mp4,video/quicktime,video/webm,video/x-matroska,video/x-msvideo" onChange={(event) => void handleUpload(event)} disabled={active || Boolean(busy)} />
                        </label>
                    </div>
                </div>

                <div className={styles.card}>
                    <div className={styles.cardHeading}>
                        <div>
                            <span className={styles.kicker}>升頻設定檔</span>
                            <h3>SeedVR2 3B Int8</h3>
                        </div>
                        <span className={styles.scaleBadge}>{UPSCALE_SCALE}×</span>
                    </div>
                    <div id="upscale-readiness" className={styles.readiness} tabIndex={-1} aria-live="polite">
                        <span className={`${styles.statusDot} ${health?.ready ? styles.online : ""}`} />
                        <div>
                            <strong>{readinessLabel}</strong>
                            <span>{health?.comfyUi === false ? "ComfyUI 未連線。" : `${availableModels}/2 個模型檔案可用 · ${missingNodes.length ? `${missingNodes.length} 個節點缺失` : "原生節點可用"}`}</span>
                        </div>
                        <button type="button" className={styles.textButton} onClick={() => void refreshHealth()} disabled={healthLoading || Boolean(busy)}>{ACTION_LABELS.refresh}</button>
                    </div>
                    {healthError && <p className={styles.inlineError} role="alert">{healthError}</p>}
                    {missingNodes.length > 0 && <p className={styles.helper}>缺少節點：{missingNodes.join(", ")}</p>}
                    <button type="button" className={styles.primaryButton} onClick={() => void start()} disabled={active || Boolean(busy)} aria-busy={busy === "submit" || busy === "upload"} aria-describedby="upscale-readiness">
                        {busy === "submit" ? "建立工作中…" : active ? "升頻中…" : "開始 2× 升頻"}
                    </button>
                    <div className={styles.status} aria-live="polite">
                        <div className={styles.statusLine}>
                            <span className={`${styles.statusDot} ${active ? styles.online : job?.status === "failed" ? styles.failed : ""}`} />
                            <span>{statusLabel}</span>
                            {job && <strong>{progress}%</strong>}
                        </div>
                        {job && <div className={styles.progressTrack} role="progressbar" aria-label="SeedVR2 進度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={`${progress}%`}><span style={{ width: `${progress}%` }} /></div>}
                    </div>
                    {active && job?.status !== "cancelling" && <button type="button" className={styles.secondaryButton} onClick={() => void cancel()} disabled={Boolean(busy)}>{busy === "cancel" ? "取消中…" : ACTION_LABELS.cancel}</button>}
                    {job && (job.status === "failed" || job.status === "cancelled" || job.status === "interrupted") && <button type="button" className={styles.secondaryButton} onClick={() => void retry()} disabled={!canRetry}>{busy === "retry" ? "重試中…" : ACTION_LABELS.retry}</button>}
                    {job?.status === "cancelling" && <p className={styles.helper}>正在停止目前的 SeedVR2 流程…</p>}
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
                        <span className={styles.resultBadge}>{UPSCALE_SCALE}× 已完成</span>
                    </div>
                    <video className={styles.resultPreview} src={upscaleAssetHref(job.output)} controls playsInline preload="metadata">
                        <track kind="captions" />
                    </video>
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
