"use client";

import { useEffect, useState } from "react";
import { fetchUnifiedJobs, jobOutputHref, performJobAction, type UnifiedJob } from "./job-client";
import { StatusBadge } from "./JobsWorkspace";
import styles from "./JobsWorkspace.module.css";

export function JobDetailWorkspace({ jobId, sourceHint }: { jobId: string; sourceHint?: string }) {
  const [job, setJob] = useState<UnifiedJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  async function refresh() {
    const jobs = await fetchUnifiedJobs();
    const next = jobs.find((item) => item.id === jobId && (!sourceHint || item.source === sourceHint)) || jobs.find((item) => item.id === jobId) || null;
    setJob(next); setLoading(false);
  }

  useEffect(() => {
    let active = true;
    const poll = async () => { if (!active) return; try { await refresh(); } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : "Unable to load job."); } };
    void poll();
    const timer = window.setInterval(poll, 2500);
    return () => { active = false; window.clearInterval(timer); };
  }, [jobId, sourceHint]);

  async function action(name: "cancel" | "pause" | "resume" | "retry") {
    if (!job || busy) return;
    setBusy(name); setError("");
    try { await performJobAction(job, name); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Action failed."); }
    finally { setBusy(""); }
  }

  if (loading) return <div className={styles.empty}>Loading job…</div>;
  if (!job) return <div className={styles.error} role="alert">Job not found.</div>;
  const outputHref = jobOutputHref(job);
  return (
    <div className={styles.detailLayout}>
      <section className={styles.detailCard}>
        <div className={styles.jobHeader}><StatusBadge status={job.status} /><span className={styles.source}>{job.source}</span></div>
        <h2>{job.title}</h2>
        <p>{job.subtitle}</p>
        <dl className={styles.metaGrid}>
          <div><dt>ID</dt><dd>{job.id}</dd></div>
          <div><dt>Stage</dt><dd>{job.stage}</dd></div>
          <div><dt>Progress</dt><dd>{job.progress}%</dd></div>
          <div><dt>Updated</dt><dd>{job.updatedAt || "—"}</dd></div>
        </dl>
        {(job.status === "queued" || job.status === "running") && <div className={styles.progressTrack}><span style={{ width: `${job.progress}%` }} /></div>}
        {job.error && <div className={styles.error} role="alert">{job.error}</div>}
        {error && <div className={styles.error} role="alert">{error}</div>}
      </section>
      <aside className={styles.actionCard}>
        <div className={styles.actionTitle}>Actions</div>
        {job.canCancel && <button type="button" className={styles.dangerButton} disabled={Boolean(busy)} onClick={() => void action("cancel")}>{busy === "cancel" ? "Cancelling…" : "Cancel"}</button>}
        {job.canPause && <button type="button" disabled={Boolean(busy)} onClick={() => void action("pause")}>Pause</button>}
        {job.canResume && <button type="button" disabled={Boolean(busy)} onClick={() => void action("resume")}>Resume</button>}
        {job.canRetry && <button type="button" disabled={Boolean(busy)} onClick={() => void action("retry")}>{busy === "retry" ? "Retrying…" : "Retry"}</button>}
        {outputHref && <a href={outputHref} className={styles.outputButton}>Open output</a>}
        <a href="/app/jobs" className={styles.backLink}>← All jobs</a>
        {(job.source === "upscale" || job.source === "img2img") && !job.canCancel && (job.status === "queued" || job.status === "running") && <p className={styles.helper}>The existing tool API does not expose a cancel endpoint; this UI does not fake cancellation.</p>}
      </aside>
    </div>
  );
}
