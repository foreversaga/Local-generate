"use client";

import { useEffect, useRef, useState } from "react";
import { activeJobCount } from "../../lib/job-adapter.mjs";
import { ACTION_LABELS, jobStatusLabel } from "../../lib/ui-copy.mjs";
import { fetchUnifiedJobs, type JobSourceError, type UnifiedJob } from "./job-client";
import styles from "./RecentJobsDrawer.module.css";

export function RecentJobsDrawer() {
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<UnifiedJob[]>([]);
  const [sourceErrors, setSourceErrors] = useState<JobSourceError[]>([]);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    const refresh = async () => { const snapshot = await fetchUnifiedJobs(); if (active) { setJobs(snapshot.jobs); setSourceErrors(snapshot.errors); } };
    void refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => { active = false; window.clearInterval(timer); };
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
        <span className={styles.pulse} aria-hidden="true" /> 工作 {active > 0 && <span className={styles.count}>{active}</span>}
      </button>
      {open && (
        <div className={styles.backdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
          <div ref={panelRef} className={styles.panel} role="dialog" aria-modal="true" aria-label="最近工作">
            <div className={styles.header}><div><span>最近工作</span><strong>{active} 項進行中</strong></div><button type="button" onClick={() => setOpen(false)} aria-label="關閉最近工作">×</button></div>
            {sourceErrors.length > 0 && <p className={styles.warning} role="status">部分工作來源無法使用；清單不完整。</p>}
            <div className={styles.list}>
              {jobs.slice(0, 5).map((job) => <a key={`${job.source}:${job.id}`} href={`/app/jobs/${encodeURIComponent(job.id)}?source=${job.source}`}><span className={`${styles.dot} ${styles[`dot_${job.status}`] || ""}`} /><span><strong>{job.title}</strong><small>{jobStatusLabel(job.status, job.source)} · {job.progress}%</small></span></a>)}
              {!jobs.length && sourceErrors.length === 0 && <p>目前沒有工作。</p>}
              {!jobs.length && sourceErrors.length > 0 && <p>來源無法使用時無法統計工作。</p>}
            </div>
            <a className={styles.all} href="/app/jobs">{ACTION_LABELS.viewAll}工作 →</a>
          </div>
        </div>
      )}
    </div>
  );
}
