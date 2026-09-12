"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AssetPickerButton } from "../library/AssetPickerButton";
import { assetKey, type StudioAsset } from "../library/asset-client";
import {
  assetLocator,
  cancelSolH3Job,
  createSolH3Job,
  fetchSolH3Jobs,
  fetchSolH3Readiness,
  pollSolH3JobEvents,
  subscribeSolH3JobEvents,
  type SolH3Job,
  type SolH3Mode,
  type SolH3Readiness,
} from "./sol-h3-client";
import styles from "./SolH3Workspace.module.css";

const ACTIVE = new Set(["queued", "waiting_gpu", "preparing", "qwen_running", "stage1_running", "upscaling", "adapting", "stage2_running", "validating", "cancel_requested"]);

const MODE_COPY: Record<SolH3Mode, { label: string; help: string }> = {
  t2va: { label: "T2VA｜文字 → 影片＋音訊", help: "只輸入提示詞；Stage 1 不載入 input VAE。" },
  fl2va: { label: "FL2VA｜首幀＋尾幀", help: "使用一張首幀與一張尾幀，產生固定規格影片與音訊。" },
  ref2va: { label: "REF2VA｜參考素材", help: "MVP 使用一個圖片或影片參考；音訊是條件，不是直接替換音軌。" },
};

function statusLabel(status: string) {
  return ({
    queued: "已排隊",
    waiting_gpu: "等待 GPU",
    preparing: "準備中",
    qwen_running: "Qwen 處理中",
    stage1_running: "H3 Stage 1",
    upscaling: "Latent upscaler",
    adapting: "H3 → LTX adapter",
    stage2_running: "LTX Stage 2",
    validating: "驗證輸出",
    cancel_requested: "取消中",
    succeeded: "已完成",
    failed: "失敗",
    cancelled: "已取消",
    interrupted: "已中斷",
  } as Record<string, string>)[status] || status;
}

function displayAsset(asset: StudioAsset | null) {
  return asset ? asset.root.toUpperCase() + " / " + asset.name : "尚未選擇";
}

function createIdempotencyKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `sol-ui-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export function SolH3Workspace() {
  const [mode, setMode] = useState<SolH3Mode>("t2va");
  const [prompt, setPrompt] = useState("傍晚海邊，一名成年人沿岸慢跑；鏡頭自然跟拍，遠處有海浪與海鳥聲。");
  const [seed, setSeed] = useState("");
  const [firstFrame, setFirstFrame] = useState<StudioAsset | null>(null);
  const [lastFrame, setLastFrame] = useState<StudioAsset | null>(null);
  const [reference, setReference] = useState<StudioAsset | null>(null);
  const [readiness, setReadiness] = useState<SolH3Readiness | null>(null);
  const [job, setJob] = useState<SolH3Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pendingIdempotencyKey = useRef<string | null>(null);

  const promptLength = useMemo(() => [...prompt].length, [prompt]);

  const resetPendingSubmit = useCallback(() => {
    pendingIdempotencyKey.current = null;
  }, []);

  const refreshReadiness = useCallback(async () => {
    try {
      setReadiness(await fetchSolH3Readiness());
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "無法檢查 Sol-H3 readiness。");
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refreshReadiness(), 0);
    const timer = window.setInterval(() => void refreshReadiness(), 5000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refreshReadiness]);

  useEffect(() => {
    let disposed = false;
    void fetchSolH3Jobs().then((jobs) => {
      if (!disposed) setJob(jobs.find((item) => ACTIVE.has(item.status)) || jobs[0] || null);
    }).catch(() => {});
    return () => { disposed = true; };
  }, []);

  const active = Boolean(job && ACTIVE.has(job.status));
  useEffect(() => {
    if (!job?.id || !active) return;
    let disposed = false;
    let streamHealthy = false;
    const unsubscribe = subscribeSolH3JobEvents(job.id, {
      onJob: (next) => { if (!disposed) setJob(next); },
      onOpen: () => { streamHealthy = true; },
      onError: () => { streamHealthy = false; },
    });
    const poll = async () => {
      if (disposed || streamHealthy) return;
      try {
        const payload = await pollSolH3JobEvents(job.id);
        if (!disposed) setJob(payload.job);
      } catch {
        // Keep the last durable state visible while the server is restarting.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [active, job?.id]);

  const selectedKeys = useMemo(() => (asset: StudioAsset | null) => asset ? [assetKey(asset)] : [], []);
  const currentModeReady = Boolean(readiness?.modes?.[mode]?.ready);

  function selectSingle(setter: (asset: StudioAsset | null) => void, allowed: Array<"image" | "video">, assets: StudioAsset[]) {
    const selected = assets.find((asset) => allowed.includes(asset.kind) && (asset.root === "input" || asset.root === "output"));
    if (!selected) {
      setError("請從 input 或 output 選擇支援的素材。");
      return;
    }
    setter(selected);
    resetPendingSubmit();
    setJob(null);
    setError("");
  }

  async function start() {
    if (busy || active) return;
    if (!currentModeReady) {
      setError("目前模式尚未通過 readiness；請先完成官方 runtime、hash lock 與 prompt cache。");
      return;
    }
    if (!prompt.trim()) {
      setError("請輸入提示詞。");
      return;
    }
    if (promptLength > 4000) {
      setError("Prompt 不可超過 4,000 Unicode code points。");
      return;
    }
    if (mode === "fl2va" && (!firstFrame || !lastFrame)) {
      setError("FL2VA 需要首幀與尾幀各一張圖片。");
      return;
    }
    if (mode === "ref2va" && !reference) {
      setError("REF2VA MVP 需要一個圖片或影片參考。");
      return;
    }
    const parsedSeed = seed.trim() ? Number(seed) : undefined;
    if (parsedSeed !== undefined && (!Number.isSafeInteger(parsedSeed) || parsedSeed < 0)) {
      setError("Seed 必須是非負整數。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const inputs: Record<string, ReturnType<typeof assetLocator> | ReturnType<typeof assetLocator>[]> = {};
      if (mode === "fl2va" && firstFrame && lastFrame) {
        inputs.firstFrame = assetLocator(firstFrame);
        inputs.lastFrame = assetLocator(lastFrame);
      }
      if (mode === "ref2va" && reference) inputs.references = [assetLocator(reference)];
      const key = pendingIdempotencyKey.current || createIdempotencyKey();
      pendingIdempotencyKey.current = key;
      const created = await createSolH3Job({
        schemaVersion: 1,
        mode,
        prompt: prompt.trim(),
        ...(parsedSeed === undefined ? {} : { seed: parsedSeed }),
        audio: { generate: true },
        inputs,
      }, { idempotencyKey: key });
      pendingIdempotencyKey.current = null;
      setJob(created);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "無法建立 Sol-H3 工作。");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!job || !active || busy) return;
    setBusy(true);
    try { setJob(await cancelSolH3Job(job.id)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "無法取消 Sol-H3 工作。"); }
    finally { setBusy(false); }
  }

  return (
    <div className={styles.workspace}>
      <section className={styles.panel}>
        <div className={styles.header}>
          <div><p className={styles.eyebrow}>SOL-H3-SPARK</p><h2>官方兩階段影片＋音訊</h2></div>
          <span className={styles.badge + " " + (currentModeReady ? styles.ready : styles.blocked)}>{currentModeReady ? "模式已就緒" : "等待 readiness"}</span>
        </div>
        <p className={styles.hint}>Sol-H3 使用獨立 Qwen、H3 Stage 1 與 LTX Stage 2 runtime，會取得全域 GPU 排他 lease；既有 ComfyUI profile 不會被替換。</p>

        <div className={styles.modeGrid} role="radiogroup" aria-label="Sol-H3 模式">
          {Object.entries(MODE_COPY).map(([value, copy]) => {
            const item = value as SolH3Mode;
            const ready = Boolean(readiness?.modes?.[item]?.ready);
            return <button key={item} className={styles.mode + " " + (mode === item ? styles.modeActive : "")} type="button" onClick={() => { if (!active) { setMode(item); resetPendingSubmit(); setError(""); } }} aria-pressed={mode === item} disabled={busy || active}>
              <strong>{copy.label}</strong><span>{copy.help}</span><small>{ready ? "READY" : (readiness?.modes?.[item]?.missing?.slice(0, 2).join(" · ") || "尚未檢查")}</small>
            </button>;
          })}
        </div>

        <div className={styles.fields}>
          <label className={styles.field + " " + styles.wide}><span>Prompt（同時描述畫面、動作與聲音）</span><textarea value={prompt} onChange={(event) => { setPrompt(event.target.value); resetPendingSubmit(); }} disabled={busy || active} aria-invalid={promptLength > 4000} /><small className={promptLength > 4000 ? styles.overLimit : undefined}>{promptLength} / 4000 Unicode code points</small></label>
          <label className={styles.field}><span>Seed（可選）</span><input value={seed} onChange={(event) => { setSeed(event.target.value); resetPendingSubmit(); }} inputMode="numeric" placeholder="42" disabled={busy || active} /></label>
          <div className={styles.spec}><span>固定輸出</span><strong>1344 × 768 · 121 frames · 24 FPS</strong><small>MP4 · AAC · 原生 H3 音訊</small></div>

          {mode === "fl2va" && <><div className={styles.assetField}><strong>首幀</strong><span>{displayAsset(firstFrame)}</span><AssetPickerButton triggerId="sol-h3-first-frame-picker" allowedRoots={["input", "output"]} kind="image" selectedKeys={selectedKeys(firstFrame)} onSelect={(assets) => selectSingle(setFirstFrame, ["image"], assets)} label="選擇首幀" /></div><div className={styles.assetField}><strong>尾幀</strong><span>{displayAsset(lastFrame)}</span><AssetPickerButton triggerId="sol-h3-last-frame-picker" allowedRoots={["input", "output"]} kind="image" selectedKeys={selectedKeys(lastFrame)} onSelect={(assets) => selectSingle(setLastFrame, ["image"], assets)} label="選擇尾幀" /></div></>}
          {mode === "ref2va" && <div className={styles.assetField + " " + styles.wide}><strong>參考素材（MVP 一個）</strong><span>{displayAsset(reference)}</span><AssetPickerButton triggerId="sol-h3-reference-picker" allowedRoots={["input", "output"]} allowedKinds={["image", "video"]} selectedKeys={selectedKeys(reference)} onSelect={(assets) => selectSingle(setReference, ["image", "video"], assets)} label="選擇圖片或影片" /></div>}
        </div>

        {readiness && <div className={styles.readiness}>
          <div><strong>Runtime</strong><span>{Object.values(readiness.runtimes || {}).filter((item) => item.ready).length} / 3 ready · {readiness.paths?.source === "prepared" ? "paths 已準備" : "等待 paths.json"}</span></div>
          <div><strong>Checkpoints</strong><span>{readiness.checkpoints?.verified ? "hash 已鎖定" : "尚未完成 hash lock"} · cache {readiness.checkpoints?.promptCache ? "已存在" : "缺少"}</span></div>
          <div><strong>GPU</strong><span>{readiness.conflicts?.length ? "偵測到外部模型衝突" : readiness.hostLock?.held ? "Sol-H3 lock 使用中" : "由 admission gate 管理"}</span></div>
        </div>}

        {error && <p className={styles.error}>{error}</p>}
        <div className={styles.actions}><button className={styles.primary} type="button" onClick={() => void start()} disabled={busy || active || !currentModeReady || promptLength > 4000}>{busy ? "處理中…" : "開始 Sol-H3 生成"}</button>{active && <button className={styles.secondary} type="button" onClick={() => void cancel()} disabled={busy}>取消工作</button>}</div>
      </section>

      <section className={styles.output}>
        <div className={styles.header}><div><p className={styles.eyebrow}>JOB STATUS</p><h2>Sol-H3 工作狀態</h2></div>{job && <span className={styles.badge}>{statusLabel(job.status)}</span>}</div>
        {job ? <><div className={styles.jobMeta}><strong>{job.stage}</strong><span>{job.id}</span></div><div className={styles.progress} role="progressbar" aria-label="Sol-H3 工作進度" aria-valuemin={0} aria-valuemax={100} {...(job.progress === null ? {} : { "aria-valuenow": job.progress })}>{job.progress === null ? <i /> : <span style={{ width: Math.max(0, Math.min(100, job.progress)) + "%" }} />}</div><div className={styles.timeline}>{job.events.slice(-8).map((event, index) => <div key={(event.seq ?? event.at) + "-" + index}><time>{new Date(event.at).toLocaleTimeString()}</time><span>{event.stage || event.status || "狀態更新"}</span></div>)}</div>{job.output ? <><video className={styles.video} controls playsInline src={"/app" + job.output.url}><track kind="captions" /></video><p className={styles.success}>MP4＋AAC、{job.outputSpec.width}×{job.outputSpec.height}、{job.outputSpec.frames} frames、{job.outputSpec.fps} FPS 已通過 server 驗證。{job.outputMetadata?.artifact?.sha256 ? ` SHA-256 ${job.outputMetadata.artifact.sha256.slice(0, 16)}…` : ""}</p><div className={styles.actions}><a className={styles.secondary} href={"/app" + job.output.url} download={job.output.name}>下載影片</a></div></> : <div className={styles.empty}>完成後影片會顯示在這裡</div>}{job.error && <p className={styles.error}>{job.errorCode ? job.errorCode + ": " : ""}{job.error}</p>}</> : <div className={styles.empty}>尚未建立工作<br /><small>先完成 runtime readiness，再選擇模式與素材。</small></div>}
      </section>
    </div>
  );
}
