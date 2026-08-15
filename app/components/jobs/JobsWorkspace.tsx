"use client";

import { useEffect, useMemo, useState } from "react";
import { jobStatusLabel, localizedCopy, sourceLabel } from "../../lib/ui-copy.mjs";
import { useI18n } from "../../i18n/I18nProvider";
import { fetchUnifiedJobs, type JobSourceError, type UnifiedJob } from "./job-client";
import styles from "./JobsWorkspace.module.css";

const STATUS_OPTIONS = ["all", "queued", "running", "complete", "partial", "error", "cancelled"] as const;
const SOURCE_OPTIONS = ["all", "video", "long", "upscale", "img2img", "lora"] as const;

export function JobsWorkspace() {
  const { locale, t } = useI18n();
  const [jobs, setJobs] = useState<UnifiedJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<(typeof STATUS_OPTIONS)[number]>("all");
  const [source, setSource] = useState<(typeof SOURCE_OPTIONS)[number]>("all");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [sourceErrors, setSourceErrors] = useState<JobSourceError[]>([]);

  useEffect(() => {
    let active = true;
    let timer = 0;
    const refresh = async () => {
      let delay = 15_000;
      try {
        if (document.visibilityState === "hidden") return;
        const snapshot = await fetchUnifiedJobs({ summary: true, includeOutputAvailability: false });
        if (active) { setJobs(snapshot.jobs); setSourceErrors(snapshot.errors); setError(""); }
        if (snapshot.jobs.some((job) => job.status === "queued" || job.status === "running")) delay = 3000;
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : t("jobs.loadError"));
      } finally {
        if (active) setLoading(false);
        if (active) timer = window.setTimeout(() => void refresh(), delay);
      }
    };
    void refresh();
    return () => { active = false; window.clearTimeout(timer); };
  }, [t]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return jobs.filter((job) => (source === "all" || job.source === source)
      && (status === "all" || job.status === status)
      && (!needle || `${job.title} ${job.subtitle} ${job.id} ${job.source}`.toLowerCase().includes(needle)));
  }, [jobs, query, source, status]);

  return (
    <div className={styles.workspace}>
      <section className={styles.toolbar} aria-label={t("jobs.filters")}>
        <label className={styles.searchField}>
          <span className="sr-only">{t("jobs.search")}</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("jobs.searchPlaceholder")} />
        </label>
        <div className={styles.filters} role="group" aria-label={t("jobs.sourceFilter")}>
          {SOURCE_OPTIONS.map((option) => (
            <button key={option} type="button" className={source === option ? styles.filterActive : ""} aria-pressed={source === option} onClick={() => setSource(option)}>
              {sourceLabel(option, locale)}
            </button>
          ))}
        </div>
        <div className={styles.filters} role="group" aria-label={t("jobs.statusFilter")}>
          {STATUS_OPTIONS.map((option) => (
            <button key={option} type="button" className={status === option ? styles.filterActive : ""} aria-pressed={status === option} onClick={() => setStatus(option)}>
              {jobStatusLabel(option, undefined, locale)}
            </button>
          ))}
        </div>
      </section>

      {error && <div className={styles.error} role="alert">{error}</div>}
      {sourceErrors.length > 0 && (
        <div className={styles.sourceWarning} role="status" aria-live="polite">
          <strong>{t("jobs.sourcesUnavailable")}</strong>
          <span>{sourceErrors.map((item) => `${sourceLabel(item.source, locale)}: ${item.message}`).join(" · ")}</span>
        </div>
      )}
      <div className={styles.summaryLine} aria-live="polite">{loading ? t("jobs.loading") : sourceErrors.length > 0 ? t("jobs.summaryUnavailable", { visible: visible.length, errors: sourceErrors.length }) : t("jobs.summary", { visible: visible.length, active: jobs.filter((job) => job.status === "queued" || job.status === "running").length })}</div>

      <div className={styles.list}>
        {visible.map((job) => <JobRow key={`${job.source}:${job.id}`} job={job} />)}
        {!loading && visible.length === 0 && sourceErrors.length === 0 && <div className={styles.empty}>{t("jobs.empty")}</div>}
        {!loading && visible.length === 0 && sourceErrors.length > 0 && <div className={styles.empty}>{t("jobs.emptyUnavailable")}</div>}
      </div>
    </div>
  );
}

function JobRow({ job }: { job: UnifiedJob }) {
  const { locale, t } = useI18n();
  const { ACTION_LABELS } = localizedCopy(locale);
  const progress = Math.min(100, Math.max(0, Math.round(Number(job.progress) || 0)));
  const hasNativeStep = job.source === "img2img"
    && job.nativeCurrent !== null
    && job.nativeMaximum !== null
    && Number(job.nativeMaximum) > 0;
  return (
    <article className={styles.jobCard}>
      <div className={styles.jobMain}>
        <div className={styles.jobHeader}>
          <StatusBadge status={job.status} source={job.source} />
          <span className={styles.source}>{sourceLabel(job.source, locale)}</span>
          <time className={styles.time}>{formatDate(job.updatedAt || job.createdAt, locale)}</time>
        </div>
        <h2>{job.title}</h2>
        <p>{job.subtitle || job.stage}</p>
        {job.source === "img2img" && (job.comfyNode || hasNativeStep) && (
          <small className={styles.helper}>
            ComfyUI: {job.comfyNode || "running"}
            {hasNativeStep ? ` · ${job.nativeCurrent}/${job.nativeMaximum}` : ""}
          </small>
        )}
        {(job.status === "queued" || job.status === "running") && (
          <div className={styles.progressWrap}>
            <div className={styles.progressTrack} role="progressbar" aria-label={t("jobs.progress")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={t("jobs.progressText", { progress })}>
              <span style={{ width: `${progress}%` }} />
            </div>
            <span>{progress}%{job.etaMs ? ` · ETA ${formatDuration(job.etaMs, t)}` : ""}</span>
          </div>
        )}
        {job.error && <p className={styles.jobError}>{job.error}</p>}
      </div>
      <a className={styles.detailLink} href={`/app/jobs/${encodeURIComponent(job.id)}?source=${encodeURIComponent(job.source)}`}>{ACTION_LABELS.details} <span aria-hidden="true">→</span></a>
    </article>
  );
}

export function StatusBadge({ status, source }: { status: string; source?: string }) {
  const { locale } = useI18n();
  return <span className={`${styles.badge} ${styles[`badge_${status}`] || ""}`}>{jobStatusLabel(status, source, locale)}</span>;
}
function formatDate(value: string, locale: string) { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale); }
function formatDuration(ms: number, t: (key: "time.seconds" | "time.minutesSeconds", values: Record<string, number>) => string) { const seconds = Math.max(0, Math.round(ms / 1000)); return seconds < 60 ? t("time.seconds", { seconds }) : t("time.minutesSeconds", { minutes: Math.floor(seconds / 60), seconds: seconds % 60 }); }
