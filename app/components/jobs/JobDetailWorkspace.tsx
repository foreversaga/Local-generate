"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { lookupUnifiedJob } from "../../lib/job-source-fetch.mjs";
import { ACTION_LABELS, sourceLabel } from "../../lib/ui-copy.mjs";
import { fetchUnifiedJobs, jobOutputHref, performJobAction, type JobSourceError, type UnifiedJob } from "./job-client";
import { StatusBadge } from "./JobsWorkspace";
import styles from "./JobsWorkspace.module.css";

export function JobDetailWorkspace({ jobId, sourceHint }: { jobId: string; sourceHint?: string }) {
  const router = useRouter();
  const [job, setJob] = useState<UnifiedJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [sourceUnavailable, setSourceUnavailable] = useState<JobSourceError | null>(null);

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

  async function action(name: "cancel" | "pause" | "resume" | "retry") {
    if (!job || busy) return;
    setBusy(name); setError("");
    try {
      const result = await performJobAction(job, name) as { job?: { id?: string } };
      const nextId = typeof result?.job?.id === "string" ? result.job.id : "";
      if (name === "retry" && ["lora", "video", "upscale", "img2img"].includes(job.source) && nextId && nextId !== job.id) {
        router.replace(`/app/jobs/${encodeURIComponent(nextId)}?source=${encodeURIComponent(job.source)}`);
        await refresh(nextId, job.source);
      } else {
        await refresh();
      }
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : "工作操作失敗。"); }
    finally { setBusy(""); }
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
        {(job.status === "queued" || job.status === "running") && <div className={styles.progressTrack} role="progressbar" aria-label="工作進度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={`${progress}% 已完成`}><span style={{ width: `${progress}%` }} /></div>}
        {job.artifact && <p className={styles.helper}>成品：{job.artifact.fileName || job.artifact.displayName || "LoRA 模型產物"}{job.artifact.registryId ? ` · 註冊編號 ${job.artifact.registryId}` : ""}</p>}
        {job.error && <div className={styles.error} role="alert">{job.error}</div>}
        {error && <div className={styles.error} role="alert">{error}</div>}
      </section>
      <aside className={styles.actionCard}>
        <div className={styles.actionTitle}>工作操作</div>
        {job.canCancel && <button type="button" className={styles.dangerButton} disabled={Boolean(busy)} onClick={() => void action("cancel")}>{busy === "cancel" ? "取消中…" : ACTION_LABELS.cancel}</button>}
        {job.canPause && <button type="button" disabled={Boolean(busy)} onClick={() => void action("pause")}>{ACTION_LABELS.pause}</button>}
        {job.canResume && <button type="button" disabled={Boolean(busy)} onClick={() => void action("resume")}>{ACTION_LABELS.resume}</button>}
        {job.canRetry && <button type="button" disabled={Boolean(busy)} onClick={() => void action("retry")}>{busy === "retry" ? "重試中…" : ACTION_LABELS.retry}</button>}
        {outputHref && <a href={outputHref} className={styles.outputButton}>{job.source === "lora" ? ACTION_LABELS.downloadResult : ACTION_LABELS.openOutput}</a>}
        <a href="/app/jobs" className={styles.backLink}>← {ACTION_LABELS.viewAll}工作</a>
        {(job.source === "upscale" || job.source === "img2img") && !job.canCancel && (job.status === "queued" || job.status === "running") && <p className={styles.helper}>目前工具服務未提供取消端點，因此此頁不會顯示虛假的取消結果。</p>}
      </aside>
    </div>
  );
}
