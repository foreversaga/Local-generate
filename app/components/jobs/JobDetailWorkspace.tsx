"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { lookupUnifiedJob } from "../../lib/job-source-fetch.mjs";
import { ACTION_LABELS, sourceLabel } from "../../lib/ui-copy.mjs";
import { fetchUnifiedJobs, jobOutputHref, performJobAction, type JobSourceError, type UnifiedJob, type VideoRetryOverrides } from "./job-client";
import { StatusBadge } from "./JobsWorkspace";
import styles from "./JobsWorkspace.module.css";

type RetryDraft = {
  prompt: string;
  negativePrompt: string;
  modelProfile: string;
  width: string;
  height: string;
  duration: string;
  steps: string;
  seed: string;
  timeoutSeconds: string;
  outputName: string;
};

const RETRY_PROFILES = [
  "nvfp4_blackwell",
  "official_pruned_int8_convrot",
  "int4_convrot_low_vram",
  "ref2va_pruned_nvfp4",
  "ref2va_pruned_int8_convrot",
];

function draftNumber(value: number | null | undefined, fallback: number) {
  return Number.isFinite(Number(value)) ? String(value) : String(fallback);
}

function retryDraftFromJob(job: UnifiedJob): RetryDraft {
  return {
    prompt: job.prompt || "",
    negativePrompt: job.negativePrompt || "",
    modelProfile: job.modelProfile || "nvfp4_blackwell",
    width: draftNumber(job.width, 736),
    height: draftNumber(job.height, 416),
    duration: draftNumber(job.duration, 5),
    steps: draftNumber(job.steps, 20),
    seed: draftNumber(job.seed, 12345),
    timeoutSeconds: draftNumber(job.timeoutSeconds, 3600),
    outputName: job.outputName || "h3-render.mp4",
  };
}

function numericDraft(value: string, label: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} 必須是有效數字。`);
  return parsed;
}

export function JobDetailWorkspace({ jobId, sourceHint }: { jobId: string; sourceHint?: string }) {
  const router = useRouter();
  const [job, setJob] = useState<UnifiedJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [sourceUnavailable, setSourceUnavailable] = useState<JobSourceError | null>(null);
  const [retryDraft, setRetryDraft] = useState<RetryDraft | null>(null);

  const refresh = useCallback(async (targetId = jobId, targetSource = sourceHint) => {
    const snapshot = await fetchUnifiedJobs();
    const { job: next, sourceError: failedSource } = lookupUnifiedJob(snapshot, { jobId: targetId, sourceHint: targetSource });
    setJob(next);
    setSourceUnavailable(failedSource);
    setError("");
    setLoading(false);
  }, [jobId, sourceHint]);

  useEffect(() => {
    let active = true;
    const poll = async () => { if (!active) return; try { await refresh(); } catch (reason) { if (active) { setLoading(false); setError(reason instanceof Error ? reason.message : "無法載入工作。"); } } };
    void poll();
    const timer = window.setInterval(poll, 2500);
    return () => { active = false; window.clearInterval(timer); };
  }, [refresh]);

  async function action(name: "cancel" | "pause" | "resume" | "retry", retryOverrides?: VideoRetryOverrides) {
    if (!job || busy) return;
    setBusy(name); setError("");
    try {
      const result = await performJobAction(job, name, retryOverrides) as { job?: { id?: string } };
      const nextId = typeof result?.job?.id === "string" ? result.job.id : "";
      if (name === "retry" && ["lora", "video", "upscale", "img2img"].includes(job.source) && nextId && nextId !== job.id) {
        setRetryDraft(null);
        router.replace(`/app/jobs/${encodeURIComponent(nextId)}?source=${encodeURIComponent(job.source)}`);
        await refresh(nextId, job.source);
      } else {
        await refresh();
      }
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : "工作操作失敗。"); }
    finally { setBusy(""); }
  }

  function openRetryEditor() {
    if (!job) return;
    if (job.source !== "video") {
      void action("retry");
      return;
    }
    setError("");
    setRetryDraft(retryDraftFromJob(job));
  }

  function updateRetryDraft(field: keyof RetryDraft, value: string) {
    setRetryDraft((current) => current ? { ...current, [field]: value } : current);
  }

  async function submitRetry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!job || !retryDraft || busy) return;
    if (!retryDraft.prompt.trim()) {
      setError("提示詞不能是空白。請保留原提示詞或輸入新的描述。");
      return;
    }
    try {
      const overrides: VideoRetryOverrides = {
        prompt: retryDraft.prompt,
        negativePrompt: retryDraft.negativePrompt,
        modelProfile: retryDraft.modelProfile.trim(),
        width: numericDraft(retryDraft.width, "寬度"),
        height: numericDraft(retryDraft.height, "高度"),
        duration: numericDraft(retryDraft.duration, "片長"),
        steps: numericDraft(retryDraft.steps, "Steps"),
        seed: numericDraft(retryDraft.seed, "Seed"),
        timeoutSeconds: numericDraft(retryDraft.timeoutSeconds, "Timeout"),
        outputName: retryDraft.outputName.trim(),
      };
      await action("retry", overrides);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "重試參數無效。");
    }
  }

  if (loading) return <div className={styles.empty}>載入工作中…</div>;
  if (!job && sourceUnavailable) {
    return (
      <div className={styles.error} role="alert">
        <strong>工作來源無法使用。</strong>
        <p>{sourceLabel(sourceUnavailable.source)}: {sourceUnavailable.message}</p>
        <a href="/app/jobs" className={styles.backLink}>← {ACTION_LABELS.viewAll}工作</a>
      </div>
    );
  }
  if (!job) return <div className={styles.error} role="alert">找不到工作。</div>;
  const outputHref = jobOutputHref(job);
  const progress = Math.min(100, Math.max(0, Math.round(Number(job.progress) || 0)));
  return (
    <div className={styles.detailLayout}>
      <section className={styles.detailCard}>
        <div className={styles.jobHeader}><StatusBadge status={job.status} source={job.source} /><span className={styles.source}>{sourceLabel(job.source)}</span></div>
        <h2>{job.title}</h2>
        <p>{job.subtitle}</p>
        <dl className={styles.metaGrid}>
          <div><dt>ID</dt><dd>{job.id}</dd></div>
          <div><dt>階段</dt><dd>{job.stage}</dd></div>
          <div><dt>進度</dt><dd>{progress}%</dd></div>
          <div><dt>更新時間</dt><dd>{job.updatedAt || "—"}</dd></div>
        </dl>
        {job.source === "video" && (
          <div className={styles.promptStack}>
            <details className={styles.promptDetails} open>
              <summary>查看完整提示詞</summary>
              <pre className={styles.promptPreview}>{job.prompt || "（沒有保存提示詞）"}</pre>
            </details>
            {job.negativePrompt && (
              <details className={styles.promptDetails} open>
                <summary>查看完整 Negative Prompt</summary>
                <pre className={styles.promptPreview}>{job.negativePrompt}</pre>
              </details>
            )}
          </div>
        )}
        {(job.status === "queued" || job.status === "running") && <div className={styles.progressTrack} role="progressbar" aria-label="工作進度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={`${progress}% 已完成`}><span style={{ width: `${progress}%` }} /></div>}
        {job.artifact && <p className={styles.helper}>成品：{job.artifact.fileName || job.artifact.displayName || "LoRA 模型產物"}{job.artifact.registryId ? ` · 註冊編號 ${job.artifact.registryId}` : ""}</p>}
        {job.error && <div className={styles.error} role="alert">{job.error}</div>}
        {error && <div className={styles.error} role="alert">{error}</div>}
        {job.source === "video" && retryDraft && (
          <section className={styles.retryEditor} aria-labelledby="retry-editor-title">
            <div className={styles.retryEditorHeader}>
              <div>
                <h3 id="retry-editor-title">編輯參數後重試</h3>
                <p>原工作會保留；送出後會建立新的 retry 工作。提示詞可完整修改。</p>
              </div>
              <span className={styles.retryAttempt}>原工作 #{job.attempt || 1}</span>
            </div>
            <form className={styles.retryForm} onSubmit={(event) => void submitRetry(event)}>
              <label className={styles.retryFieldWide}>
                <span>Prompt（完整，可修改）</span>
                <textarea
                  value={retryDraft.prompt}
                  onChange={(event) => updateRetryDraft("prompt", event.target.value)}
                  rows={16}
                  maxLength={20000}
                  spellCheck={false}
                  required
                />
                <small>{retryDraft.prompt.length}/20000</small>
              </label>
              <label className={styles.retryFieldWide}>
                <span>Negative Prompt</span>
                <textarea
                  value={retryDraft.negativePrompt}
                  onChange={(event) => updateRetryDraft("negativePrompt", event.target.value)}
                  rows={5}
                  maxLength={20000}
                  spellCheck={false}
                />
              </label>
              <label className={styles.retryField}>
                <span>Model Profile</span>
                <input
                  list="retry-model-profiles"
                  value={retryDraft.modelProfile}
                  onChange={(event) => updateRetryDraft("modelProfile", event.target.value)}
                  required
                />
                <datalist id="retry-model-profiles">
                  {RETRY_PROFILES.map((profile) => <option key={profile} value={profile} />)}
                </datalist>
              </label>
              <label className={styles.retryField}>
                <span>輸出檔名</span>
                <input value={retryDraft.outputName} onChange={(event) => updateRetryDraft("outputName", event.target.value)} required />
              </label>
              <label className={styles.retryField}>
                <span>寬度</span>
                <input type="number" min={32} max={2048} step={32} value={retryDraft.width} onChange={(event) => updateRetryDraft("width", event.target.value)} required />
              </label>
              <label className={styles.retryField}>
                <span>高度</span>
                <input type="number" min={32} max={2048} step={32} value={retryDraft.height} onChange={(event) => updateRetryDraft("height", event.target.value)} required />
              </label>
              <label className={styles.retryField}>
                <span>片長（秒）</span>
                <input type="number" min={0.1} max={120} step={0.1} value={retryDraft.duration} onChange={(event) => updateRetryDraft("duration", event.target.value)} required />
              </label>
              <label className={styles.retryField}>
                <span>Steps</span>
                <input type="number" min={1} max={80} step={1} value={retryDraft.steps} onChange={(event) => updateRetryDraft("steps", event.target.value)} required />
              </label>
              <label className={styles.retryField}>
                <span>Seed</span>
                <input type="number" min={0} max={2147483647} step={1} value={retryDraft.seed} onChange={(event) => updateRetryDraft("seed", event.target.value)} required />
              </label>
              <label className={styles.retryField}>
                <span>Timeout（秒）</span>
                <input type="number" min={60} max={86400} step={60} value={retryDraft.timeoutSeconds} onChange={(event) => updateRetryDraft("timeoutSeconds", event.target.value)} required />
                <small>目前預設 3600；長片可改 7200。</small>
              </label>
              <div className={styles.retryActions}>
                <button type="submit" className={styles.retryPrimary} disabled={Boolean(busy)}>{busy === "retry" ? "建立重試中…" : "以修改後參數重試"}</button>
                <button type="button" className={styles.retrySecondary} disabled={Boolean(busy)} onClick={() => setRetryDraft(null)}>取消</button>
              </div>
            </form>
          </section>
        )}
      </section>
      <aside className={styles.actionCard}>
        <div className={styles.actionTitle}>工作操作</div>
        {job.canCancel && <button type="button" className={styles.dangerButton} disabled={Boolean(busy)} onClick={() => void action("cancel")}>{busy === "cancel" ? "取消中…" : ACTION_LABELS.cancel}</button>}
        {job.canPause && <button type="button" disabled={Boolean(busy)} onClick={() => void action("pause")}>{ACTION_LABELS.pause}</button>}
        {job.canResume && <button type="button" disabled={Boolean(busy)} onClick={() => void action("resume")}>{ACTION_LABELS.resume}</button>}
        {job.canRetry && !retryDraft && <button type="button" disabled={Boolean(busy)} onClick={openRetryEditor}>{job.source === "video" ? "編輯後重試" : (busy === "retry" ? "重試中…" : ACTION_LABELS.retry)}</button>}
        {outputHref && <a href={outputHref} className={styles.outputButton}>{job.source === "lora" ? ACTION_LABELS.downloadResult : ACTION_LABELS.openOutput}</a>}
        <a href="/app/jobs" className={styles.backLink}>← {ACTION_LABELS.viewAll}工作</a>
        {(job.source === "upscale" || job.source === "img2img") && !job.canCancel && (job.status === "queued" || job.status === "running") && <p className={styles.helper}>目前工具服務未提供取消端點，因此此頁不會顯示虛假的取消結果。</p>}
      </aside>
    </div>
  );
}
