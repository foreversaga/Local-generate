"use client";

import { useEffect, useRef, useState } from "react";
import { activeJobCount } from "../../lib/job-adapter.mjs";
import { jobStatusLabel } from "../../lib/ui-copy.mjs";
import { useI18n } from "../../i18n/I18nProvider";
import { fetchUnifiedJobs, type JobSourceError, type UnifiedJob } from "./job-client";
import styles from "./RecentJobsDrawer.module.css";

export function RecentJobsDrawer() {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<UnifiedJob[]>([]);
  const [sourceErrors, setSourceErrors] = useState<JobSourceError[]>([]);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    let timer = 0;
    const refresh = async () => {
      let delay = 15_000;
      try {
        if (document.visibilityState !== "hidden") {
          const snapshot = await fetchUnifiedJobs({ limitPerSource: 5, summary: true, includeOutputAvailability: false });
          if (active) { setJobs(snapshot.jobs); setSourceErrors(snapshot.errors); }
          if (activeJobCount(snapshot.jobs) > 0) delay = 5000;
        }
      } catch {
        // Keep the last known badge state and retry on the next scheduled pass.
      } finally {
        if (active) timer = window.setTimeout(() => void refresh(), delay);
      }
    };
    void refresh();
    return () => { active = false; window.clearTimeout(timer); };
  }, []);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.querySelector<HTMLElement>("a,button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); buttonRef.current?.focus(); return; }
      if (event.key !== "Tab" || !panelRef.current) return;
      const items = [...panelRef.current.querySelectorAll<HTMLElement>("a,button")].filter((item) => !item.hasAttribute("disabled"));
      if (!items.length) return;
      const first = items[0]; const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); if (previous && document.contains(previous)) previous.focus(); };
  }, [open]);

  const active = activeJobCount(jobs);
  return (
    <div className={styles.root}>
      <button ref={buttonRef} type="button" className={styles.trigger} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className={styles.pulse} aria-hidden="true" /> {t("jobs.trigger")} {active > 0 && <span className={styles.count}>{active}</span>}
      </button>
      {open && (
        <div className={styles.backdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
          <div ref={panelRef} className={styles.panel} role="dialog" aria-modal="true" aria-label={t("jobs.recent")}>
            <div className={styles.header}><div><span>{t("jobs.recent")}</span><strong>{t("jobs.activeCount", { count: active })}</strong></div><button type="button" onClick={() => setOpen(false)} aria-label={t("jobs.closeRecent")}>×</button></div>
            {sourceErrors.length > 0 && <p className={styles.warning} role="status">{t("jobs.partialWarning")}</p>}
            <div className={styles.list}>
              {jobs.slice(0, 5).map((job) => <a key={`${job.source}:${job.id}`} href={`/app/jobs/${encodeURIComponent(job.id)}?source=${job.source}`}><span className={`${styles.dot} ${styles[`dot_${job.status}`] || ""}`} /><span><strong>{job.title}</strong><small>{jobStatusLabel(job.status, job.source, locale)} · {job.progress}%</small></span></a>)}
              {!jobs.length && sourceErrors.length === 0 && <p>{t("jobs.none")}</p>}
              {!jobs.length && sourceErrors.length > 0 && <p>{t("jobs.noneUnavailable")}</p>}
            </div>
            <a className={styles.all} href="/app/jobs">{t("jobs.viewAll")} →</a>
          </div>
        </div>
      )}
    </div>
  );
}
