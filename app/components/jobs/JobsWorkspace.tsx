"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchUnifiedJobs, type JobSourceError, type UnifiedJob } from "./job-client";
import styles from "./JobsWorkspace.module.css";

const STATUS_OPTIONS = ["all", "queued", "running", "complete", "partial", "error", "cancelled"] as const;
const SOURCE_OPTIONS = ["all", "video", "long", "upscale", "img2img", "lora"] as const;

export function JobsWorkspace() {
  const [jobs, setJobs] = useState<UnifiedJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<(typeof STATUS_OPTIONS)[number]>("all");
  const [source, setSource] = useState<(typeof SOURCE_OPTIONS)[number]>("all");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [sourceErrors, setSourceErrors] = useState<JobSourceError[]>([]);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const snapshot = await fetchUnifiedJobs();
        if (active) { setJobs(snapshot.jobs); setSourceErrors(snapshot.errors); setError(""); }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : "Unable to load jobs.");
      } finally {
        if (active) setLoading(false);
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return jobs.filter((job) => (source === "all" || job.source === source)
      && (status === "all" || job.status === status)
      && (!needle || `${job.title} ${job.subtitle} ${job.id} ${job.source}`.toLowerCase().includes(needle)));
  }, [jobs, query, source, status]);

  return (
    <div className={styles.workspace}>
      <section className={styles.toolbar} aria-label="Job filters">
        <label className={styles.searchField}>
          <span className="sr-only">Search jobs</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, id, source…" />
        </label>
        <div className={styles.filters} role="group" aria-label="Filter by source">
          {SOURCE_OPTIONS.map((option) => (
            <button key={option} type="button" className={source === option ? styles.filterActive : ""} aria-pressed={source === option} onClick={() => setSource(option)}>
              {option === "all" ? "All sources" : sourceLabel(option)}
            </button>
          ))}
        </div>
        <div className={styles.filters} role="group" aria-label="Filter by status">
          {STATUS_OPTIONS.map((option) => (
            <button key={option} type="button" className={status === option ? styles.filterActive : ""} aria-pressed={status === option} onClick={() => setStatus(option)}>
              {option === "all" ? "All" : statusLabel(option)}
            </button>
          ))}
        </div>
      </section>

      {error && <div className={styles.error} role="alert">{error}</div>}
      {sourceErrors.length > 0 && (
        <div className={styles.sourceWarning} role="status" aria-live="polite">
          <strong>Some job sources are unavailable.</strong>
          <span>{sourceErrors.map((item) => `${sourceLabel(item.source)}: ${item.message}`).join(" · ")}</span>
        </div>
      )}
      <div className={styles.summaryLine} aria-live="polite">{loading ? "Loading jobs…" : sourceErrors.length > 0 ? `${visible.length} jobs shown · ${sourceErrors.length} source${sourceErrors.length === 1 ? "" : "s"} unavailable` : `${visible.length} jobs · ${jobs.filter((job) => job.status === "queued" || job.status === "running").length} active`}</div>

      <div className={styles.list}>
        {visible.map((job) => <JobRow key={`${job.source}:${job.id}`} job={job} />)}
        {!loading && visible.length === 0 && sourceErrors.length === 0 && <div className={styles.empty}>No jobs match the current filters.</div>}
        {!loading && visible.length === 0 && sourceErrors.length > 0 && <div className={styles.empty}>Job counts are incomplete while unavailable sources are being retried.</div>}
      </div>
    </div>
  );
}

function JobRow({ job }: { job: UnifiedJob }) {
  const progress = Math.min(100, Math.max(0, Math.round(Number(job.progress) || 0)));
  return (
    <article className={styles.jobCard}>
      <div className={styles.jobMain}>
        <div className={styles.jobHeader}>
          <StatusBadge status={job.status} />
          <span className={styles.source}>{sourceLabel(job.source)}</span>
          <time className={styles.time}>{formatDate(job.updatedAt || job.createdAt)}</time>
        </div>
        <h2>{job.title}</h2>
        <p>{job.subtitle || job.stage}</p>
        {(job.status === "queued" || job.status === "running") && (
          <div className={styles.progressWrap}>
            <div className={styles.progressTrack} role="progressbar" aria-label="Job progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={`${progress}% complete`}>
              <span style={{ width: `${progress}%` }} />
            </div>
            <span>{progress}%{job.etaMs ? ` · ETA ${formatDuration(job.etaMs)}` : ""}</span>
          </div>
        )}
        {job.error && <p className={styles.jobError}>{job.error}</p>}
      </div>
      <a className={styles.detailLink} href={`/app/jobs/${encodeURIComponent(job.id)}?source=${encodeURIComponent(job.source)}`}>Details <span aria-hidden="true">→</span></a>
    </article>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`${styles.badge} ${styles[`badge_${status}`] || ""}`}>{statusLabel(status)}</span>;
}

function statusLabel(status: string) {
  return ({ queued: "Queued", running: "Running", complete: "Complete", partial: "Partial", error: "Error", cancelled: "Cancelled" } as Record<string, string>)[status] || status;
}
function sourceLabel(source: string) { return ({ video: "Single", long: "Long", upscale: "Upscale", img2img: "I2I", lora: "LoRA 訓練" } as Record<string, string>)[source] || source; }
function formatDate(value: string) { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString(); }
function formatDuration(ms: number) { const seconds = Math.max(0, Math.round(ms / 1000)); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`; }
