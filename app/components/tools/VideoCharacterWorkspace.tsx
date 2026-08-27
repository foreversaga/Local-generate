"use client";

import { ChangeEvent, useCallback, useEffect, useState } from "react";
import { AssetPickerButton } from "../library/AssetPickerButton";
import { assetKey, assetUrl, uploadAssets, type StudioAsset } from "../library/asset-client";
import {
    cancelVideoCharacterJob,
    clearVideoCharacterWorkspace,
    fetchVideoCharacterHealth,
    fetchVideoCharacterJob,
    fetchVideoCharacterJobs,
    submitVideoCharacter,
    type VideoCharacterHealth,
    type VideoCharacterJob,
    type VideoCharacterMode,
} from "./video-character-client";
import styles from "./VideoCharacterWorkspace.module.css";

const ACTIVE = new Set(["queued", "running"]);
const RESOLUTION_MIN = 256;
const RESOLUTION_MAX = 1536;
const RESOLUTION_STEP = 32;

function statusLabel(status: string) {
    return ({ queued: "等待 GPU", running: "執行中", completed: "已完成", failed: "失敗", cancelled: "已取消", interrupted: "已中斷" } as Record<string, string>)[status] || status;
}

function measuredProgress(job: VideoCharacterJob) {
    const terminal = ["completed", "failed", "cancelled", "interrupted"].includes(job.status);
    const stored = Number(job.progress);
    if (job.status === "completed" && Number.isFinite(stored)) {
        const percent = Math.max(0, Math.min(100, Math.round(stored)));
        return { percent, label: `${percent}%`, detail: "工作已結束" };
    }
    if (terminal) return { percent: null, label: statusLabel(job.status), detail: "工作已結束" };

    const current = Number(job.nativeCurrent);
    const total = Number(job.nativeMaximum);
    const hasSteps = Number.isFinite(current) && Number.isFinite(total) && total > 0;
    if (hasSteps && job.phase === "generation" && Number.isInteger(job.chunkIndex) && Number.isInteger(job.chunkCount) && (job.chunkCount || 0) > 0) {
        const chunkIndex = Math.max(0, job.chunkIndex || 0);
        const chunkCount = Math.max(1, job.chunkCount || 1);
        const fraction = Math.min(1, Math.max(0, current / total));
        const percent = Math.max(0, Math.min(100, Math.round(((chunkIndex + fraction) / chunkCount) * 100)));
        return { percent, label: `${percent}%`, detail: `第 ${chunkIndex + 1} / ${chunkCount} 段 · ComfyUI ${Math.min(total, Math.max(0, current))} / ${total}` };
    }
    if (hasSteps && (job.phase === "mask" || job.phase === "generation")) {
        const percent = Math.max(0, Math.min(100, Math.round((current / total) * 100)));
        return { percent, label: `${percent}%`, detail: `ComfyUI ${Math.min(total, Math.max(0, current))} / ${total}` };
    }
    return { percent: null, label: statusLabel(job.status), detail: job.status === "queued" ? "等待 GPU 資源" : "等待原生進度回報" };
}

function bytes(value: number | null | undefined) {
    if (!Number.isFinite(Number(value)) || Number(value) <= 0) return "—";
    const units = ["B", "KB", "MB", "GB"];
    let number = Number(value);
    let index = 0;
    while (number >= 1024 && index < units.length - 1) { number /= 1024; index += 1; }
    return `${number.toFixed(index ? 1 : 0)} ${units[index]}`;
}

export function VideoCharacterWorkspace() {
    const [mode, setMode] = useState<VideoCharacterMode>("replace");
    const [source, setSource] = useState<StudioAsset | null>(null);
    const [references, setReferences] = useState<StudioAsset[]>([]);
    const [prompt, setPrompt] = useState("一位人物在原影片的場景、鏡頭與動作中自然跳舞，保留完整頭部與四肢，服裝、光線和陰影穩定一致。");
    const [negativePrompt, setNegativePrompt] = useState("blurry, flicker, identity drift, face distortion, deformed hands, extra limbs, cropped head, cropped limbs, warped background");
    const [width, setWidth] = useState("512");
    const [height, setHeight] = useState("896");
    const [aspectLocked, setAspectLocked] = useState(true);
    const [fps, setFps] = useState("24");
    const [steps, setSteps] = useState("40");
    const [targetIndex, setTargetIndex] = useState("0");
    const [health, setHealth] = useState<VideoCharacterHealth | null>(null);
    const [job, setJob] = useState<VideoCharacterJob | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const refreshHealth = useCallback(async () => {
        try { setHealth(await fetchVideoCharacterHealth()); } catch (reason) { setHealth(null); setError(reason instanceof Error ? reason.message : "無法檢查影片人物功能。"); }
    }, []);
    useEffect(() => { const timer = window.setTimeout(() => void refreshHealth(), 0); return () => window.clearTimeout(timer); }, [refreshHealth]);

    useEffect(() => {
        let disposed = false;
        const requestedJob = new URLSearchParams(window.location.search).get("job");
        const load = async () => {
            try {
                const jobs = requestedJob ? null : await fetchVideoCharacterJobs();
                const next = requestedJob
                    ? await fetchVideoCharacterJob(requestedJob)
                    : jobs?.find((item) => ACTIVE.has(item.status)) || jobs?.[0] || null;
                if (!disposed && next) setJob(next);
            } catch (reason) {
                if (!disposed && requestedJob) setError(reason instanceof Error ? reason.message : "無法載入影片人物工作。");
            }
        };
        void load();
        return () => { disposed = true; };
    }, []);

    useEffect(() => {
        if (!job?.id) return;
        const url = new URL(window.location.href);
        if (url.searchParams.get("job") === job.id) return;
        url.searchParams.set("job", job.id);
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }, [job?.id]);

    const active = Boolean(job && ACTIVE.has(job.status));
    useEffect(() => {
        if (!job?.id || !active) return;
        let disposed = false;
        const poll = async () => { try { const next = await fetchVideoCharacterJob(job.id); if (!disposed) setJob(next); } catch { /* keep last visible state */ } };
        void poll();
        const timer = window.setInterval(() => void poll(), 1500);
        return () => { disposed = true; window.clearInterval(timer); };
    }, [active, job?.id]);

    async function uploadSource(event: ChangeEvent<HTMLInputElement>) {
        const file = event.target.files?.[0]; event.target.value = "";
        if (!file || busy || active) return;
        setBusy(true); setError("");
        try { const [asset] = await uploadAssets([file]); if (asset?.kind !== "video") throw new Error("來源必須是影片。 "); setSource(asset); setJob(null); } catch (reason) { setError(reason instanceof Error ? reason.message : "無法上傳來源影片。"); } finally { setBusy(false); }
    }

    async function uploadReferences(event: ChangeEvent<HTMLInputElement>) {
        const files = Array.from(event.target.files || []).slice(0, 4); event.target.value = "";
        if (!files.length || busy || active) return;
        setBusy(true); setError("");
        try { const assets = await uploadAssets(files); if (assets.some((asset) => asset.kind !== "image")) throw new Error("參考圖必須全部是圖片。"); setReferences(assets); setJob(null); } catch (reason) { setError(reason instanceof Error ? reason.message : "無法上傳參考圖片。"); } finally { setBusy(false); }
    }

    function selectSource(assets: StudioAsset[]) {
        if (busy || active) return;
        const selected = assets.find((asset) => asset.kind === "video" && (asset.root === "input" || asset.root === "output"));
        if (!selected) return setError("請從 input 或 output 選擇一個影片素材。");
        setSource(selected);
        setJob(null);
        setError("");
    }

    function selectReferences(assets: StudioAsset[]) {
        if (busy || active) return;
        const selected = assets
            .filter((asset) => asset.kind === "image" && (asset.root === "input" || asset.root === "output"))
            .slice(0, 4);
        if (!selected.length) return setError("請從 input 或 output 選擇一至四張圖片素材。");
        setReferences(selected);
        setJob(null);
        setError("");
    }

    function changeMode(next: VideoCharacterMode) { if (busy || active) return; setMode(next); setSteps(next === "replace" ? "40" : "6"); setError(""); }

    function snapResolution(value: number) {
        const snapped = Math.round(value / RESOLUTION_STEP) * RESOLUTION_STEP;
        return Math.max(RESOLUTION_MIN, Math.min(RESOLUTION_MAX, snapped));
    }

    function updateResolution(axis: "width" | "height", value: string) {
        if (value === "") {
            if (axis === "width") setWidth(value); else setHeight(value);
            return;
        }
        const next = Number(value);
        if (!Number.isFinite(next)) return;
        if (!aspectLocked) {
            if (axis === "width") setWidth(value); else setHeight(value);
            return;
        }

        const currentWidth = Number(width) || 512;
        const currentHeight = Number(height) || 896;
        const ratio = currentWidth / currentHeight;
        let nextWidth = axis === "width" ? next : next * ratio;
        let nextHeight = axis === "height" ? next : next / ratio;
        const fit = Math.min(1, RESOLUTION_MAX / nextWidth, RESOLUTION_MAX / nextHeight);
        nextWidth *= fit;
        nextHeight *= fit;
        nextWidth = snapResolution(nextWidth);
        nextHeight = snapResolution(nextHeight);
        if (axis === "width" && nextWidth === RESOLUTION_MIN && next < RESOLUTION_MIN) nextHeight = snapResolution(nextWidth / ratio);
        if (axis === "height" && nextHeight === RESOLUTION_MIN && next < RESOLUTION_MIN) nextWidth = snapResolution(nextHeight * ratio);
        setWidth(String(nextWidth));
        setHeight(String(nextHeight));
    }

    async function start() {
        if (busy || active) return;
        if (!source) return setError("請先選擇原始影片。");
        if (!references.length) return setError("請至少選擇一張參考人物圖片。");
        if (!health?.modes[mode]) return setError("此模式尚未就緒；請先完成實作文件中的 runtime runner。");
        const parsed = { width: Number(width), height: Number(height), fps: Number(fps), steps: Number(steps), targetIndex: Number(targetIndex) };
        if (![parsed.width, parsed.height].every((value) => Number.isInteger(value) && value >= 256 && value <= 1536 && value % 32 === 0)) return setError("解析度必須是 256–1536 且為 32 的倍數。");
        if (!Number.isFinite(parsed.fps) || parsed.fps <= 0 || parsed.fps > 120 || !Number.isInteger(parsed.steps) || parsed.steps < 1 || parsed.steps > 80 || !Number.isInteger(parsed.targetIndex) || parsed.targetIndex < 0) return setError("FPS、步數或人物索引不符合範圍。");
        setBusy(true); setError("");
        try { setJob(await submitVideoCharacter({ mode, source, references, prompt, negativePrompt, ...parsed, targetPrompt: "person", targetOrder: "left_to_right" })); } catch (reason) { setError(reason instanceof Error ? reason.message : "無法開始影片人物工作流程。"); } finally { setBusy(false); }
    }

    async function clearWorkspace() { if (!job || active || busy) return; setBusy(true); setError(""); try { setJob(await clearVideoCharacterWorkspace(job.id)); } catch (reason) { setError(reason instanceof Error ? reason.message : "無法清除中繼檔。"); } finally { setBusy(false); } }
    async function cancel() { if (!job || !active || busy) return; setBusy(true); try { setJob(await cancelVideoCharacterJob(job.id)); } catch (reason) { setError(reason instanceof Error ? reason.message : "無法取消工作。"); } finally { setBusy(false); } }

    const lastMemory = job?.memory?.at(-1);
    const progress = job ? measuredProgress(job) : null;
    const sourceKeys = source ? [assetKey(source)] : [];
    const referenceKeys = references.map(assetKey);
    return <div className={styles.workspace}>
        <div className={styles.layout}>
            <section className={styles.panel}>
                <div className={styles.header}><div><span className={styles.eyebrow}>VIDEO CHARACTER</span><h2>影片人物工作流程</h2></div><span className={`${styles.health} ${health?.modes[mode] ? styles.healthReady : styles.healthBlocked}`}>{health?.modes[mode] ? "已就緒" : "等待 runtime"}</span></div>
                <p className={styles.hint}>兩種模式共用 24 fps、完整頭部與四肢構圖；中繼檔會集中在每個工作的 workspace。</p>
                <div className={styles.fields}>
                    <div className={styles.file}><strong>原始影片</strong><span>保留場景、鏡頭與動作</span><div className={styles.assetActions}>{!busy && !active && <AssetPickerButton triggerId="video-character-source-picker" allowedRoots={["input", "output"]} kind="video" selectedKeys={sourceKeys} onSelect={selectSource} label="從素材庫選擇影片" />}<label className={styles.uploadButton}>從裝置上傳影片<input type="file" accept="video/*" onChange={uploadSource} disabled={busy || active} /></label></div>{source && <div className={styles.refList}><span className={styles.refItem}><b>{source.root.toUpperCase()}</b>{source.name}</span></div>}</div>
                    <div className={styles.file}><strong>參考人物圖片（最多 4 張）</strong><span>人物外觀與服裝來源</span><div className={styles.assetActions}>{!busy && !active && <AssetPickerButton triggerId="video-character-reference-picker" allowedRoots={["input", "output"]} kind="image" multiple maxSelection={4} allowFolderSelection={false} selectedKeys={referenceKeys} onSelect={selectReferences} label="從素材庫選擇圖片" />}<label className={styles.uploadButton}>從裝置上傳圖片<input type="file" accept="image/*" multiple onChange={uploadReferences} disabled={busy || active} /></label></div>{references.length > 0 && <div className={styles.refList}>{references.map((item) => <span className={styles.refItem} key={`${item.root}:${item.name}`}><b>{item.root.toUpperCase()}</b>{item.name}</span>)}</div>}</div>
                    <label className={styles.field}><span>模式</span><select value={mode} onChange={(event) => changeMode(event.target.value as VideoCharacterMode)} disabled={busy || active}><option value="replace">原場景換人物（保留場景）</option><option value="dwpose">DWPose 動作骨架重生成</option></select></label>
                    <label className={styles.field}><span>目標人物索引</span><input type="number" min="0" value={targetIndex} onChange={(event) => setTargetIndex(event.target.value)} disabled={busy || active} /><small>多人畫面由左至右排序，0 是最左側人物。</small></label>
                    <label className={styles.field}><span>寬度：{width || "—"} px</span><input type="number" min="256" max="1536" step="32" value={width} onChange={(event) => updateResolution("width", event.target.value)} disabled={busy || active} /><input className={styles.range} type="range" min="256" max="1536" step="32" value={width === "" ? 256 : width} aria-label="影片寬度滑桿" onInput={(event) => updateResolution("width", event.currentTarget.value)} disabled={busy || active} /></label>
                    <label className={styles.field}><span>高度：{height || "—"} px</span><input type="number" min="256" max="1536" step="32" value={height} onChange={(event) => updateResolution("height", event.target.value)} disabled={busy || active} /><input className={styles.range} type="range" min="256" max="1536" step="32" value={height === "" ? 256 : height} aria-label="影片高度滑桿" onInput={(event) => updateResolution("height", event.currentTarget.value)} disabled={busy || active} /></label>
                    <label className={styles.lockToggle}><input type="checkbox" checked={aspectLocked} onChange={(event) => setAspectLocked(event.target.checked)} disabled={busy || active} /><span>鎖定等比例（{width || "—"} × {height || "—"}）</span></label>
                    <label className={styles.field}><span>FPS</span><input type="number" value={fps} onChange={(event) => setFps(event.target.value)} disabled={busy || active} /><small>預設 24 fps。</small></label>
                    <label className={styles.field}><span>取樣步數</span><input type="number" value={steps} onChange={(event) => setSteps(event.target.value)} disabled={busy || active} /></label>
                    <label className={`${styles.field} ${styles.wide}`}><span>完成畫面描述</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} disabled={busy || active} /></label>
                    <label className={`${styles.field} ${styles.wide}`}><span>負面提示</span><textarea value={negativePrompt} onChange={(event) => setNegativePrompt(event.target.value)} disabled={busy || active} /></label>
                </div>
                {error && <div className={styles.error}>{error}</div>}
                <div className={styles.actions}><button className={styles.primary} type="button" onClick={() => void start()} disabled={busy || active || !source || !references.length}>{busy ? "處理中…" : "開始生成"}</button>{active && <button className={styles.secondary} type="button" onClick={() => void cancel()} disabled={busy}>取消</button>}{job && !active && job.workspace.exists && <button className={styles.secondary} type="button" onClick={() => void clearWorkspace()} disabled={busy}>清除本次中繼檔</button>}</div>
            </section>
            <section className={styles.output}><div className={styles.header}><div><span className={styles.eyebrow}>JOB STATUS</span><h2>工作狀態</h2></div>{progress && <span className={styles.health}>{progress.label}</span>}</div>{job ? <><div className={styles.status}><strong>{job.stage}</strong><span>{statusLabel(job.status)}</span></div><div className={styles.progress} role="progressbar" aria-label="影片人物工作進度" aria-valuemin={0} aria-valuemax={100} {...(progress?.percent === null ? {} : { "aria-valuenow": progress?.percent })}>{progress?.percent === null ? <span className={styles.indeterminate} /> : <span style={{ width: `${progress?.percent || 0}%` }} />}</div><p className={styles.hint}>{progress?.detail}{job.updatedAt ? ` · 更新 ${new Date(job.updatedAt).toLocaleTimeString()}` : ""}</p>{lastMemory && <p className={styles.hint}>最近記憶體取樣：RAM {bytes(lastMemory.rssBytes)} · VRAM {bytes(lastMemory.vramUsedBytes)} / {bytes(lastMemory.vramTotalBytes)}</p>}{job.output ? <video controls playsInline src={assetUrl(job.output)}><track kind="captions" /></video> : <div className={styles.empty}>完成後影片會顯示在這裡<br /><small>中繼檔：{job.workspace.exists ? "保留中" : "已清除"}</small></div>}{job.error && <div className={styles.error}>{job.error}</div>}</> : <div className={styles.empty}>尚未開始工作<br /><small>先上傳原始影片與參考人物圖片。</small></div>}</section>
        </div>
    </div>;
}
