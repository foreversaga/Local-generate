"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useState } from "react";
import { AssetPickerButton } from "../library/AssetPickerButton";
import { assetKey, uploadAssets, type StudioAsset } from "../library/asset-client";
import {
    fetchUpscaleHealth,
    fetchUpscaleJob,
    submitUpscale,
    UPSCALE_SCALE,
    upscaleAssetHref,
    UpscaleApiError,
    type UpscaleHealth,
    type UpscaleJob,
} from "./upscale-client";
import styles from "./UpscaleWorkspace.module.css";

const ACTIVE_STATUSES = new Set(["queued", "running"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function UpscaleWorkspace() {
    const [source, setSource] = useState<StudioAsset | null>(null);
    const [job, setJob] = useState<UpscaleJob | null>(null);
    const [health, setHealth] = useState<UpscaleHealth | null>(null);
    const [healthLoading, setHealthLoading] = useState(true);
    const [healthError, setHealthError] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState<"upload" | "submit" | "retry" | "">("");

    const refreshHealth = useCallback(async () => {
        setHealthLoading(true);
        try {
            const next = await fetchUpscaleHealth();
            setHealth(next);
            setHealthError("");
        } catch (reason) {
            setHealth(null);
            setHealthError(reason instanceof Error ? reason.message : "Unable to check SeedVR2 readiness.");
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
    const canSubmit = Boolean(source) && !active && !busy && health?.ready !== false;
    const canRetry = Boolean(job && TERMINAL_STATUSES.has(job.status) && !busy && !active);

    async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file || busy || active) return;
        setBusy("upload");
        setError("");
        try {
            const [uploaded] = await uploadAssets([file]);
            if (!uploaded || uploaded.kind !== "video") throw new Error("Please choose a video asset.");
            setSource(uploaded);
            setJob(null);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "Unable to upload the source video.");
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
        if (!source || !canSubmit) return;
        setBusy("submit");
        setError("");
        try {
            const next = await submitUpscale(source);
            setJob(next);
            if (next.status === "failed") setError(next.error || "SeedVR2 upscale failed.");
        } catch (reason) {
            if (reason instanceof UpscaleApiError && reason.health) setHealth(reason.health);
            setError(reason instanceof Error ? reason.message : "Unable to start SeedVR2 upscale.");
        } finally {
            setBusy("");
        }
    }

    async function retry() {
        if (!job || !canRetry) return;
        setBusy("retry");
        setError("");
        try {
            const next = await submitUpscale({ name: job.sourceName, root: job.sourceRoot || "input" });
            setJob(next);
        } catch (reason) {
            if (reason instanceof UpscaleApiError && reason.health) setHealth(reason.health);
            setError(reason instanceof Error ? reason.message : "Unable to retry SeedVR2 upscale.");
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
                    setError(next.error || "SeedVR2 upscale failed.");
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

    const statusLabel = job
        ? `${job.status === "completed" ? "Complete" : job.status === "failed" ? "Failed" : job.status === "cancelled" ? "Cancelled" : job.status === "running" ? "Processing" : "Queued"}${job.stage ? ` · ${job.stage}` : ""}`
        : "Ready to upscale";
    const readinessLabel = healthLoading ? "Checking readiness…" : health?.ready ? "Ready" : "Unavailable";

    return (
        <div className={styles.workspace}>
            <section className={styles.header}>
                <div>
                    <span className={styles.kicker}>VIDEO UPSCALE / SEEDVR2</span>
                    <h2>Upscale a video</h2>
                    <p>Use the native SeedVR2 3B Int8 workflow to create a clean 2× video upscale.</p>
                </div>
                <span className={styles.scaleBadge}>{UPSCALE_SCALE}×</span>
            </section>

            <section className={styles.grid}>
                <div className={styles.card}>
                    <div className={styles.cardHeading}>
                        <div>
                            <span className={styles.kicker}>SOURCE VIDEO</span>
                            <h3>{source ? source.name : "Choose a video"}</h3>
                        </div>
                        {source && <span className={styles.sourceKind}>{source.root.toUpperCase()}</span>}
                    </div>
                    {source ? (
                        <>
                            <video className={styles.sourcePreview} src={upscaleAssetHref(source)} controls playsInline preload="metadata">
                                <track kind="captions" />
                            </video>
                            <div className={styles.sourceMeta}>
                                <span>{source.kind.toUpperCase()} · {source.root}</span>
                                <button type="button" className={styles.textButton} disabled={active || Boolean(busy)} onClick={() => { setSource(null); setJob(null); setError(""); }}>
                                    Clear source
                                </button>
                            </div>
                        </>
                    ) : (
                        <div className={styles.emptySource}>Select a video from the library or upload one from this device.</div>
                    )}
                    <div className={styles.sourceActions}>
                        <AssetPickerButton kind="video" selectedKeys={sourceKey ? [sourceKey] : []} onSelect={handleLibrarySelection} label="Browse library" />
                        <label className={styles.uploadButton}>
                            Upload video
                            <input type="file" accept="video/mp4,video/quicktime,video/webm,video/x-matroska,video/x-msvideo" onChange={(event) => void handleUpload(event)} disabled={active || Boolean(busy)} />
                        </label>
                    </div>
                </div>

                <div className={styles.card}>
                    <div className={styles.cardHeading}>
                        <div>
                            <span className={styles.kicker}>UPSCALE PROFILE</span>
                            <h3>SeedVR2 3B Int8</h3>
                        </div>
                        <span className={styles.scaleBadge}>{UPSCALE_SCALE}×</span>
                    </div>
                    <div className={styles.readiness} aria-live="polite">
                        <span className={`${styles.statusDot} ${health?.ready ? styles.online : ""}`} />
                        <div>
                            <strong>{readinessLabel}</strong>
                            <span>{health?.comfyUi === false ? "ComfyUI is offline." : `${availableModels}/2 model files available · ${missingNodes.length ? `${missingNodes.length} nodes missing` : "native nodes available"}`}</span>
                        </div>
                        <button type="button" className={styles.textButton} onClick={() => void refreshHealth()} disabled={healthLoading || Boolean(busy)}>Refresh</button>
                    </div>
                    {healthError && <p className={styles.inlineError} role="alert">{healthError}</p>}
                    {missingNodes.length > 0 && <p className={styles.helper}>Missing nodes: {missingNodes.join(", ")}</p>}
                    <button type="button" className={styles.primaryButton} onClick={() => void start()} disabled={!canSubmit} aria-busy={busy === "submit" || busy === "upload"}>
                        {busy === "submit" ? "Submitting…" : active ? "Upscaling…" : "Start 2× upscale"}
                    </button>
                    <div className={styles.status} aria-live="polite">
                        <div className={styles.statusLine}>
                            <span className={`${styles.statusDot} ${active ? styles.online : job?.status === "failed" ? styles.failed : ""}`} />
                            <span>{statusLabel}</span>
                            {job && <strong>{progress}%</strong>}
                        </div>
                        {job && <div className={styles.progressTrack} role="progressbar" aria-label="SeedVR2 progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={`${progress}%`}><span style={{ width: `${progress}%` }} /></div>}
                    </div>
                    {job && (job.status === "failed" || job.status === "cancelled") && <button type="button" className={styles.secondaryButton} onClick={() => void retry()} disabled={!canRetry}>{busy === "retry" ? "Retrying…" : "Retry upscale"}</button>}
                    {active && <p className={styles.helper}>The existing SeedVR2 API does not expose cancellation; this workspace leaves the active job intact.</p>}
                </div>
            </section>

            {error && <p className={styles.error} role="alert">{error}</p>}

            {job?.status === "completed" && job.output && (
                <section className={styles.result} aria-live="polite">
                    <div className={styles.cardHeading}>
                        <div>
                            <span className={styles.kicker}>UPSCALE RESULT</span>
                            <h3>{job.output.name}</h3>
                        </div>
                        <span className={styles.resultBadge}>{UPSCALE_SCALE}× complete</span>
                    </div>
                    <video className={styles.resultPreview} src={upscaleAssetHref(job.output)} controls playsInline preload="metadata">
                        <track kind="captions" />
                    </video>
                    <div className={styles.resultActions}>
                        <a className={styles.secondaryButton} href={upscaleAssetHref(job.output)} target="_blank" rel="noreferrer">Open preview</a>
                        <a className={styles.secondaryButton} href={`${upscaleAssetHref(job.output)}${upscaleAssetHref(job.output).includes("?") ? "&" : "?"}download=1`} download>Download result</a>
                        <a className={styles.textLink} href={`/app/jobs/${encodeURIComponent(job.id)}?source=upscale`}>View job details</a>
                    </div>
                </section>
            )}
        </div>
    );
}
