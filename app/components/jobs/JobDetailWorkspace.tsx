"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createSingleCreateDraftFromJob, SINGLE_CREATE_DRAFT_STORAGE_KEY } from "../../lib/single-create-draft.mjs";
import { localizedCopy, sourceLabel } from "../../lib/ui-copy.mjs";
import { useI18n } from "../../i18n/I18nProvider";
import { fetchUnifiedJob, jobOutputHref, performJobAction, type JobSourceError, type UnifiedJob } from "./job-client";
import { StatusBadge } from "./JobsWorkspace";
import { SaveJobAsScript } from "./SaveJobAsScript";
import styles from "./JobsWorkspace.module.css";

export function JobDetailWorkspace({ jobId, sourceHint }: { jobId: string; sourceHint?: string }) {
  const { locale, t } = useI18n();
  const { ACTION_LABELS } = localizedCopy(locale);
  const router = useRouter();
  const [job, setJob] = useState<UnifiedJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [sourceUnavailable, setSourceUnavailable] = useState<JobSourceError | null>(null);
  const actionErrorRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async (targetId = jobId, targetSource = sourceHint) => {
    const { job: next, sourceError: failedSource } = await fetchUnifiedJob(targetId, targetSource);
    setJob(next);
    setSourceUnavailable(failedSource);
    setError("");
    setLoading(false);
    return next;
  }, [jobId, sourceHint]);

  useEffect(() => {
    let active = true;
    let timer = 0;
    const poll = async () => {
      if (!active) return;
      let next: UnifiedJob | null = null;
      try {
        if (document.visibilityState !== "hidden") next = await refresh();
      } catch (reason) {
        if (active) {
          setLoading(false);
          setError(reason instanceof Error ? reason.message : "無法載入工作。");
        }
      }
      if (active && (!next || next.status === "queued" || next.status === "running")) {
        timer = window.setTimeout(() => void poll(), 2500);
      }
    };
    void poll();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [refresh]);

  useEffect(() => {
    if (!error) return;
    const frame = window.requestAnimationFrame(() => {
      actionErrorRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      actionErrorRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [error]);

  async function action(name: "cancel" | "pause" | "resume" | "retry") {
    if (!job || busy) return;
    setBusy(name);
    setError("");
    try {
      const result = await performJobAction(job, name) as { job?: { id?: string } };
      const nextId = typeof result?.job?.id === "string" ? result.job.id : "";
      if (name === "retry" && ["lora", "upscale", "img2img"].includes(job.source) && nextId && nextId !== job.id) {
        router.replace(`/app/jobs/${encodeURIComponent(nextId)}?source=${encodeURIComponent(job.source)}`);
        await refresh(nextId, job.source);
      } else {
        await refresh();
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "工作操作失敗。");
    } finally {
      setBusy("");
    }
  }

  function retry() {
    if (!job || busy) return;
    if (job.source === "video") {
      try {
        const draft = createSingleCreateDraftFromJob(job.raw);
        window.localStorage.setItem(SINGLE_CREATE_DRAFT_STORAGE_KEY, JSON.stringify(draft));
        router.push("/app/create/single");
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "無法還原原始單影片設定。");
      }
      return;
    }
    if (job.source === "long") {
      router.push(`/app/create/long?retry=${encodeURIComponent(job.id)}`);
      return;
    }
    void action("retry");
  }

  if (loading) return <div className={styles.empty}>載入工作中…</div>;
  if (!job && sourceUnavailable) {
    return (
      <div className={styles.error} role="alert">
        <strong>工作來源無法使用。</strong>
        <p>{sourceLabel(sourceUnavailable.source, locale)}: {sourceUnavailable.message}</p>
        <a href="/app/jobs" className={styles.backLink}>← {ACTION_LABELS.viewAll}工作</a>
      </div>
    );
  }
  if (!job) return <div className={styles.error} role="alert">找不到工作。</div>;

  const outputHref = jobOutputHref(job);
  const outputMissing = Boolean(job.status === "complete" && job.output && job.outputAvailable === false);
  const progress = Math.min(100, Math.max(0, Math.round(Number(job.progress) || 0)));
  const active = job.status === "queued" || job.status === "running";
  const complete = job.status === "complete" || job.status === "partial";
  const hasEta = Number.isFinite(job.etaMs);
  const hasEtaRange = Number.isFinite(job.etaLowerMs)
    && Number.isFinite(job.etaUpperMs)
    && Number(job.etaUpperMs) - Number(job.etaLowerMs) >= 15_000;
  const etaText = active
    ? hasEtaRange
      ? t("jobs.etaRange", {
          lower: formatEtaDuration(Number(job.etaLowerMs), t),
          upper: formatEtaDuration(Number(job.etaUpperMs), t),
        })
      : hasEta
        ? t("jobs.eta", { duration: formatEtaDuration(Number(job.etaMs), t) })
        : t("jobs.etaEstimating")
    : "";

  return (
    <div className={styles.detailLayout}>
      <section className={styles.detailCard}>
        <div className={styles.jobHeader}>
          <StatusBadge status={job.status} source={job.source} />
          <span className={styles.source}>{sourceLabel(job.source, locale)}</span>
        </div>
        <h2>{job.title}</h2>
        {job.subtitle && <p>{job.subtitle}</p>}

        <section className={`${styles.statusPanel} ${complete ? styles.statusPanelComplete : ""}`} aria-label="工作狀態">
          {active ? (
            <>
              <div className={styles.statusProgressHeader}>
                <strong>{progress}%</strong>
                <span>{etaText}</span>
              </div>
              <div className={styles.statusProgressTrack} role="progressbar" aria-label="工作進度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={`${progress}% 已完成`}>
                <span style={{ width: `${progress}%` }} />
              </div>
            </>
          ) : complete ? (
            <div className={styles.statusMessage}>
              <strong>生成完成</strong>
              <span>{job.updatedAt ? `更新於 ${formatDate(job.updatedAt, locale)}` : "工作已完成"}</span>
            </div>
          ) : (
            <div className={styles.statusMessage}>
              <strong>{job.status === "error" ? "生成失敗" : job.status === "cancelled" ? "工作已取消" : "工作狀態"}</strong>
              <span>{job.updatedAt ? formatDate(job.updatedAt, locale) : job.stage || "—"}</span>
            </div>
          )}
        </section>

        {job.error && <div className={styles.error} role="alert">{job.error}</div>}
        {error && <div ref={actionErrorRef} className={styles.error} role="alert" tabIndex={-1}>{error}</div>}
        {job.artifact && <p className={styles.artifactLine}>成品：{job.artifact.fileName || job.artifact.displayName || "LoRA 模型產物"}</p>}

        <div className={styles.detailDisclosures}>
          {job.prompt && (
            <details className={styles.detailDisclosure}>
              <summary>提示詞</summary>
              <div className={styles.detailDisclosureBody}>
                {complete && <SaveJobAsScript defaultName={job.title} prompt={job.prompt} negativePrompt={job.negativePrompt || ""} />}
                <strong>Prompt</strong>
                <pre className={styles.promptPreview}>{job.prompt}</pre>
                {job.negativePrompt && <><strong>Negative Prompt</strong><pre className={styles.promptPreview}>{job.negativePrompt}</pre></>}
              </div>
            </details>
          )}

          <details className={styles.detailDisclosure}>
            <summary>生成參數</summary>
            <dl className={styles.detailInfoGrid}>
              {job.modelProfile && <div><dt>Model</dt><dd>{job.modelProfile}</dd></div>}
              {job.width !== null && job.height !== null && Number.isFinite(Number(job.width)) && Number.isFinite(Number(job.height)) && <div><dt>解析度</dt><dd>{job.width} × {job.height}</dd></div>}
              {job.duration !== null && Number.isFinite(Number(job.duration)) && <div><dt>長度</dt><dd>{job.duration} 秒</dd></div>}
              {job.steps !== null && Number.isFinite(Number(job.steps)) && <div><dt>Steps</dt><dd>{job.steps}</dd></div>}
              {job.seed !== null && Number.isFinite(Number(job.seed)) && <div><dt>Seed</dt><dd>{job.seed}</dd></div>}
              {job.outputName && <div><dt>輸出檔名</dt><dd>{job.outputName}</dd></div>}
            </dl>
          </details>

          <details className={styles.detailDisclosure}>
            <summary>技術資訊</summary>
            <dl className={styles.detailInfoGrid}>
              <div><dt>Job ID</dt><dd>{job.id}</dd></div>
              <div><dt>Source</dt><dd>{sourceLabel(job.source, locale)}</dd></div>
              <div><dt>Stage</dt><dd>{job.stage || "—"}</dd></div>
              <div><dt>更新時間</dt><dd>{job.updatedAt || "—"}</dd></div>
              {job.comfyNode && <div><dt>ComfyUI Node</dt><dd>{job.comfyNode}{job.comfyNodeTitle ? ` · ${job.comfyNodeTitle}` : ""}</dd></div>}
              {job.nativeCurrent !== null && job.nativeMaximum !== null && Number.isFinite(Number(job.nativeCurrent)) && Number.isFinite(Number(job.nativeMaximum)) && <div><dt>Sampler Step</dt><dd>{job.nativeCurrent}/{job.nativeMaximum}</dd></div>}
              {job.progressSource && <div><dt>Progress Source</dt><dd>{job.progressSource}</dd></div>}
              {job.etaSource && <div><dt>ETA Source</dt><dd>{job.etaSource}{job.etaConfidence ? ` · ${job.etaConfidence}` : ""}</dd></div>}
            </dl>
          </details>
        </div>
      </section>

      <aside className={styles.actionCard}>
        <div className={styles.actionTitle}>工作操作</div>
        {job.canCancel && <button type="button" className={styles.dangerButton} disabled={Boolean(busy)} onClick={() => void action("cancel")}>{busy === "cancel" ? "取消中…" : ACTION_LABELS.cancel}</button>}
        {job.canPause && <button type="button" disabled={Boolean(busy)} onClick={() => void action("pause")}>{ACTION_LABELS.pause}</button>}
        {job.canResume && <button type="button" disabled={Boolean(busy)} onClick={() => void action("resume")}>{ACTION_LABELS.resume}</button>}
        {job.canRetry && <button type="button" disabled={Boolean(busy)} onClick={retry}>{busy === "retry" ? "Retrying…" : ACTION_LABELS.retry}</button>}
        {outputHref && <a href={outputHref} className={styles.outputButton}>{job.source === "lora" ? ACTION_LABELS.downloadResult : ACTION_LABELS.openOutput}</a>}
        {outputMissing && <p className={styles.error} role="status">輸出檔案不存在或已失效。</p>}
        <a href="/app/jobs" className={styles.backLink}>← {ACTION_LABELS.viewAll}工作</a>
      </aside>
    </div>
  );
}

function formatEtaDuration(
  ms: number,
  t: (key: "time.seconds" | "time.minutesSeconds", values: Record<string, number>) => string,
) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60
    ? t("time.seconds", { seconds })
    : t("time.minutesSeconds", { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
}

function formatDate(value: string, locale: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale);
}
