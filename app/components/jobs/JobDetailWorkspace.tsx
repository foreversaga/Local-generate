"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { lookupUnifiedJob } from "../../lib/job-source-fetch.mjs";
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
    const poll = async () => { if (!active) return; try { await refresh(); } catch (reason) { if (active) { setLoading(false); setError(reason instanceof Error ? reason.message : "Unable to load job."); } } };
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
      if (name === "retry" && job.source === "lora" && nextId && nextId !== job.id) {
        router.replace(`/app/jobs/${encodeURIComponent(nextId)}?source=lora`);
        await refresh(nextId, "lora");
      } else {
        await refresh();
      }
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Action failed."); }
    finally { setBusy(""); }
  }

  if (loading) return <div className={styles.empty}>Loading job…</div>;
  if (!job && sourceUnavailable) {
    return (
      <div className={styles.error} role="alert">
        <strong>Job source unavailable.</strong>
        <p>{sourceLabel(sourceUnavailable.source)}: {sourceUnavailable.message}</p>
        <a href="/app/jobs" className={styles.backLink}>← All jobs</a>
      </div>
    );
  }
  if (!job) return <div className={styles.error} role="alert">Job not found.</div>;
  const outputHref = jobOutputHref(job);
  const progress = Math.min(100, Math.max(0, Math.round(Number(job.progress) || 0)));
  return (
    <div className={styles.detailLayout}>
      <section className={styles.detailCard}>
        <div className={styles.jobHeader}><StatusBadge status={job.status} /><span className={styles.source}>{job.source === "lora" ? "LoRA 訓練" : job.source}</span></div>
        <h2>{job.title}</h2>
        <p>{job.subtitle}</p>
        <dl className={styles.metaGrid}>
          <div><dt>ID</dt><dd>{job.id}</dd></div>
          <div><dt>Stage</dt><dd>{job.stage}</dd></div>
          <div><dt>Progress</dt><dd>{progress}%</dd></div>
          <div><dt>Updated</dt><dd>{job.updatedAt || "—"}</dd></div>
        </dl>
        {(job.status === "queued" || job.status === "running") && <div className={styles.progressTrack} role="progressbar" aria-label="Job progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={`${progress}% complete`}><span style={{ width: `${progress}%` }} /></div>}
        {job.artifact && <p className={styles.helper}>成品：{job.artifact.fileName || job.artifact.displayName || "LoRA artifact"}{job.artifact.registryId ? ` · registry ${job.artifact.registryId}` : ""}</p>}
        {job.error && <div className={styles.error} role="alert">{job.error}</div>}
        {error && <div className={styles.error} role="alert">{error}</div>}
      </section>
      <aside className={styles.actionCard}>
        <div className={styles.actionTitle}>Actions</div>
        {job.canCancel && <button type="button" className={styles.dangerButton} disabled={Boolean(busy)} onClick={() => void action("cancel")}>{busy === "cancel" ? "Cancelling…" : "Cancel"}</button>}
        {job.canPause && <button type="button" disabled={Boolean(busy)} onClick={() => void action("pause")}>Pause</button>}
        {job.canResume && <button type="button" disabled={Boolean(busy)} onClick={() => void action("resume")}>Resume</button>}
        {job.canRetry && <button type="button" disabled={Boolean(busy)} onClick={() => void action("retry")}>{busy === "retry" ? "Retrying…" : "Retry"}</button>}
        {outputHref && <a href={outputHref} className={styles.outputButton}>{job.source === "lora" ? "下載成品" : "Open output"}</a>}
        <a href="/app/jobs" className={styles.backLink}>← All jobs</a>
        {(job.source === "upscale" || job.source === "img2img") && !job.canCancel && (job.status === "queued" || job.status === "running") && <p className={styles.helper}>The existing tool API does not expose a cancel endpoint; this UI does not fake cancellation.</p>}
      </aside>
    </div>
  );
}
function sourceLabel(source: string) { return ({ video: "Single", long: "Long", upscale: "Upscale", img2img: "I2I", lora: "LoRA" } as Record<string, string>)[source] || source; }
