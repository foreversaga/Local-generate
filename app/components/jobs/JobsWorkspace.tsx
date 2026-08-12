"use client";

import { useEffect, useMemo, useState } from "react";
import { ACTION_LABELS, jobStatusLabel, sourceLabel } from "../../lib/ui-copy.mjs";
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
        if (active) setError(reason instanceof Error ? reason.message : "無法載入工作。");
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
      <section className={styles.toolbar} aria-label="工作篩選">
        <label className={styles.searchField}>
          <span className="sr-only">搜尋工作</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋標題、識別碼或來源" />
        </label>
        <div className={styles.filters} role="group" aria-label="依來源篩選">
          {SOURCE_OPTIONS.map((option) => (
            <button key={option} type="button" className={source === option ? styles.filterActive : ""} aria-pressed={source === option} onClick={() => setSource(option)}>
              {sourceLabel(option)}
            </button>
          ))}
        </div>
        <div className={styles.filters} role="group" aria-label="依狀態篩選">
          {STATUS_OPTIONS.map((option) => (
            <button key={option} type="button" className={status === option ? styles.filterActive : ""} aria-pressed={status === option} onClick={() => setStatus(option)}>
              {option === "all" ? "全部" : jobStatusLabel(option)}
            </button>
          ))}
        </div>
      </section>

      {error && <div className={styles.error} role="alert">{error}</div>}
      {sourceErrors.length > 0 && (
        <div className={styles.sourceWarning} role="status" aria-live="polite">
          <strong>部分工作來源無法使用。</strong>
          <span>{sourceErrors.map((item) => `${sourceLabel(item.source)}：${item.message}`).join(" · ")}</span>
        </div>
      )}
      <div className={styles.summaryLine} aria-live="polite">{loading ? "載入工作中…" : sourceErrors.length > 0 ? `顯示 ${visible.length} 項工作 · ${sourceErrors.length} 個來源無法使用` : `${visible.length} 項工作 · ${jobs.filter((job) => job.status === "queued" || job.status === "running").length} 項進行中`}</div>

      <div className={styles.list}>
        {visible.map((job) => <JobRow key={`${job.source}:${job.id}`} job={job} />)}
        {!loading && visible.length === 0 && sourceErrors.length === 0 && <div className={styles.empty}>沒有符合目前篩選條件的工作。</div>}
        {!loading && visible.length === 0 && sourceErrors.length > 0 && <div className={styles.empty}>來源暫時無法使用，工作數量不完整；系統會繼續重試。</div>}
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
          <StatusBadge status={job.status} source={job.source} />
          <span className={styles.source}>{sourceLabel(job.source)}</span>
          <time className={styles.time}>{formatDate(job.updatedAt || job.createdAt)}</time>
        </div>
        <h2>{job.title}</h2>
        <p>{job.subtitle || job.stage}</p>
        {(job.status === "queued" || job.status === "running") && (
          <div className={styles.progressWrap}>
            <div className={styles.progressTrack} role="progressbar" aria-label="工作進度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={`${progress}% 已完成`}>
              <span style={{ width: `${progress}%` }} />
            </div>
            <span>{progress}%{job.etaMs ? ` · ETA ${formatDuration(job.etaMs)}` : ""}</span>
          </div>
        )}
        {job.error && <p className={styles.jobError}>{job.error}</p>}
      </div>
      <a className={styles.detailLink} href={`/app/jobs/${encodeURIComponent(job.id)}?source=${encodeURIComponent(job.source)}`}>{ACTION_LABELS.details} <span aria-hidden="true">→</span></a>
    </article>
  );
}

export function StatusBadge({ status, source }: { status: string; source?: string }) {
  return <span className={`${styles.badge} ${styles[`badge_${status}`] || ""}`}>{jobStatusLabel(status, source)}</span>;
}
function formatDate(value: string) { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString(); }
function formatDuration(ms: number) { const seconds = Math.max(0, Math.round(ms / 1000)); return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`; }
