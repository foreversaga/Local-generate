"use client";

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { calculateAspectRatioDimensions, normalizeResolutionDimension } from "../../lib/single-image-resolution.mjs";
import { localizedCopy, sourceLabel } from "../../lib/ui-copy.mjs";
import { useI18n } from "../../i18n/I18nProvider";
import { fetchUnifiedJob, jobOutputHref, performJobAction, type JobSourceError, type UnifiedJob, type VideoRetryOverrides } from "./job-client";
import { StatusBadge } from "./JobsWorkspace";
import styles from "./JobsWorkspace.module.css";

type RetryDraft = {
  prompt: string;
  negativePrompt: string;
  modelProfile: string;
  aspectRatio: string;
  aspectLocked: boolean;
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

const ASPECT_RATIO_OPTIONS = [
  { value: "custom", label: "Custom (free adjustment)" },
  { value: "16:9", label: "16:9 (Landscape)" },
  { value: "9:16", label: "9:16 (Portrait)" },
  { value: "1:1", label: "1:1 (Square)" },
  { value: "4:3", label: "4:3 (Landscape)" },
  { value: "3:4", label: "3:4 (Portrait)" },
];

function draftNumber(value: number | null | undefined, fallback: number) {
  return Number.isFinite(Number(value)) ? String(value) : String(fallback);
}

function retryDraftFromJob(job: UnifiedJob): RetryDraft {
  return {
    prompt: job.prompt || "",
    negativePrompt: job.negativePrompt || "",
    modelProfile: job.modelProfile || "nvfp4_blackwell",
    aspectRatio: "custom",
    aspectLocked: false,
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
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid number.`);
  return parsed;
}

export function JobDetailWorkspace({ jobId, sourceHint }: { jobId: string; sourceHint?: string }) {
  const { locale } = useI18n();
  const { ACTION_LABELS } = localizedCopy(locale);
  const router = useRouter();
  const [job, setJob] = useState<UnifiedJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const actionErrorRef = useRef<HTMLDivElement>(null);
  const retryEditorRef = useRef<HTMLElement>(null);
  const [sourceUnavailable, setSourceUnavailable] = useState<JobSourceError | null>(null);
  const [retryDraft, setRetryDraft] = useState<RetryDraft | null>(null);

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
        if (active) { setLoading(false); setError(reason instanceof Error ? reason.message : "無法載入工作。"); }
      }
      if (active && (!next || next.status === "queued" || next.status === "running")) {
        timer = window.setTimeout(() => void poll(), 2500);
      }
    };
    void poll();
    return () => { active = false; window.clearTimeout(timer); };
  }, [refresh]);

  useEffect(() => {
    if (!error) return;
    const frame = window.requestAnimationFrame(() => {
      actionErrorRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      actionErrorRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [error]);

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
    window.requestAnimationFrame(() => retryEditorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function updateRetryDraft(field: keyof RetryDraft, value: string) {
    setRetryDraft((current) => current ? { ...current, [field]: value } : current);
  }

  function updateRetryAspectRatio(value: string) {
    setRetryDraft((current) => {
      if (!current) return current;
      if (value === "custom") {
        return { ...current, aspectRatio: value, aspectLocked: false };
      }
      const currentWidth = Number(current.width);
      const dimensions = calculateAspectRatioDimensions(
        value,
        Number.isFinite(currentWidth) && currentWidth > 0 ? currentWidth : 736,
        "width",
      );
      return {
        ...current,
        aspectRatio: value,
        aspectLocked: true,
        width: String(dimensions.width),
        height: String(dimensions.height),
      };
    });
  }

  function updateRetryAspectLock(locked: boolean) {
    setRetryDraft((current) => {
      if (!current || current.aspectRatio === "custom") return current;
      if (!locked) return { ...current, aspectLocked: false };
      const currentWidth = Number(current.width);
      if (!Number.isFinite(currentWidth) || currentWidth <= 0) {
        return { ...current, aspectLocked: true };
      }
      const dimensions = calculateAspectRatioDimensions(current.aspectRatio, currentWidth, "width");
      return {
        ...current,
        aspectLocked: true,
        width: String(dimensions.width),
        height: String(dimensions.height),
      };
    });
  }

  function updateRetryDimension(field: "width" | "height", value: string) {
    setRetryDraft((current) => {
      if (!current) return current;
      const next = { ...current, [field]: value };
      if (!current.aspectLocked || current.aspectRatio === "custom") return next;
      const anchorValue = Number(value);
      if (!Number.isFinite(anchorValue) || anchorValue < 32 || anchorValue > 2048) return next;
      const dimensions = calculateAspectRatioDimensions(current.aspectRatio, anchorValue, field);
      return { ...next, width: String(dimensions.width), height: String(dimensions.height) };
    });
  }

  async function submitRetry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!job || !retryDraft || busy) return;
    if (!retryDraft.prompt.trim()) {
      setError("Prompt cannot be empty. Keep the original prompt or enter a new description.");
      return;
    }
    try {
      const width = numericDraft(retryDraft.width, "Width");
      const height = numericDraft(retryDraft.height, "Height");
      const dimensions = retryDraft.aspectLocked && retryDraft.aspectRatio !== "custom"
        ? calculateAspectRatioDimensions(retryDraft.aspectRatio, width, "width")
        : {
            width: normalizeResolutionDimension(width, "i2v"),
            height: normalizeResolutionDimension(height, "i2v"),
          };
      const overrides: VideoRetryOverrides = {
        prompt: retryDraft.prompt,
        negativePrompt: retryDraft.negativePrompt,
        modelProfile: retryDraft.modelProfile.trim(),
        width: dimensions.width,
        height: dimensions.height,
        duration: numericDraft(retryDraft.duration, "Duration"),
        steps: numericDraft(retryDraft.steps, "Steps"),
        seed: numericDraft(retryDraft.seed, "Seed"),
        timeoutSeconds: numericDraft(retryDraft.timeoutSeconds, "Timeout"),
        outputName: retryDraft.outputName.trim(),
      };
      await action("retry", overrides);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Retry parameters are invalid.");
    }
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
  // Active video jobs may publish their planned output reference before the
  // renderer has created the file. Only treat that reference as stale after
  // the job has actually completed.
  const outputMissing = Boolean(job.status === "complete" && job.output && job.outputAvailable === false);
  const progress = Math.min(100, Math.max(0, Math.round(Number(job.progress) || 0)));
  const hasNativeStep = job.source === "img2img"
    && job.nativeCurrent !== null
    && job.nativeMaximum !== null
    && Number.isFinite(Number(job.nativeCurrent))
    && Number.isFinite(Number(job.nativeMaximum))
    && Number(job.nativeMaximum) > 0;
  return (
    <div className={styles.detailLayout}>
      <section className={styles.detailCard}>
        <div className={styles.jobHeader}><StatusBadge status={job.status} source={job.source} /><span className={styles.source}>{sourceLabel(job.source, locale)}</span></div>
        <h2>{job.title}</h2>
        <p>{job.subtitle}</p>
        <dl className={styles.metaGrid}>
          <div><dt>ID</dt><dd>{job.id}</dd></div>
          <div><dt>階段</dt><dd>{job.stage}</dd></div>
          <div className={styles.progressMeta}>
            <dt>進度</dt>
            <dd>{progress}%</dd>
            {(job.status === "queued" || job.status === "running") && <div className={styles.progressTrack} role="progressbar" aria-label="工作進度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={`${progress}% 已完成`}><span style={{ width: `${progress}%` }} /></div>}
          </div>
          <div><dt>更新時間</dt><dd>{job.updatedAt || "—"}</dd></div>
        </dl>
        {job.source === "img2img" && (job.comfyNode || hasNativeStep) && (
          <p className={styles.helper}>
            ComfyUI node: {job.comfyNode || "running"}
            {job.comfyNodeTitle ? ` (${job.comfyNodeTitle})` : ""}
            {hasNativeStep ? ` · sampler step ${job.nativeCurrent}/${job.nativeMaximum}` : ""}
            {hasNativeStep ? " · overall bar is coarse" : job.progressSource === "estimated" ? " · overall progress is estimated" : ""}
          </p>
        )}
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
        {job.artifact && <p className={styles.helper}>成品：{job.artifact.fileName || job.artifact.displayName || "LoRA 模型產物"}{job.artifact.registryId ? ` · 註冊編號 ${job.artifact.registryId}` : ""}</p>}
        {job.error && <div className={styles.error} role="alert">{job.error}</div>}
        {error && <div ref={actionErrorRef} className={styles.error} role="alert" tabIndex={-1}>{error}</div>}
        {job.source === "video" && retryDraft && (
          <section ref={retryEditorRef} className={styles.retryEditor} aria-labelledby="retry-editor-title">
            <div className={styles.retryEditorHeader}>
              <div>
                <h3 id="retry-editor-title">Edit parameters and retry</h3>
                <p>The original job is preserved. Submitting creates a new retry job, and the prompts can be fully edited.</p>
              </div>
              <span className={styles.retryAttempt}>Original job #{job.attempt || 1}</span>
            </div>
            <form className={styles.retryForm} onSubmit={(event) => void submitRetry(event)}>
              <label className={styles.retryFieldWide}>
                <span>Prompt (full, editable)</span>
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
                <span>Output filename</span>
                <input value={retryDraft.outputName} onChange={(event) => updateRetryDraft("outputName", event.target.value)} required />
              </label>
              <label className={styles.retryField}>
                <span>Aspect ratio</span>
                <select value={retryDraft.aspectRatio} onChange={(event) => updateRetryAspectRatio(event.target.value)}>
                  {ASPECT_RATIO_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                <small>{retryDraft.aspectRatio === "custom" ? "Custom: width and height can be edited independently." : retryDraft.aspectLocked ? "Locked: changing either dimension keeps this ratio." : "Unlocked: width and height can be edited independently."}</small>
              </label>
              <label className={styles.retryField}>
                <span>Aspect ratio lock</span>
                <span className={styles.retryLockControl}>
                  <input
                    type="checkbox"
                    checked={retryDraft.aspectLocked}
                    disabled={retryDraft.aspectRatio === "custom"}
                    onChange={(event) => updateRetryAspectLock(event.target.checked)}
                  />
                  Keep width and height linked
                </span>
              </label>
              <label className={styles.retryField}>
                <span>Width</span>
                <input type="number" min={32} max={2048} step={32} value={retryDraft.width} onChange={(event) => updateRetryDimension("width", event.target.value)} required />
              </label>
              <label className={styles.retryField}>
                <span>Height</span>
                <input type="number" min={32} max={2048} step={32} value={retryDraft.height} onChange={(event) => updateRetryDimension("height", event.target.value)} required />
              </label>
              <label className={styles.retryField}>
                <span>Duration (seconds)</span>
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
                <span>Timeout (seconds)</span>
                <input type="number" min={60} max={86400} step={60} value={retryDraft.timeoutSeconds} onChange={(event) => updateRetryDraft("timeoutSeconds", event.target.value)} required />
                <small>Default 3600; long shots can use 7200.</small>
              </label>
              <div className={styles.retryActions}>
                <button type="submit" className={styles.retryPrimary} disabled={Boolean(busy)}>{busy === "retry" ? "Creating retry…" : "Retry with edited parameters"}</button>
                <button type="button" className={styles.retrySecondary} disabled={Boolean(busy)} onClick={() => setRetryDraft(null)}>Cancel</button>
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
        {job.canRetry && !retryDraft && <button type="button" disabled={Boolean(busy)} onClick={openRetryEditor}>{job.source === "video" ? "Edit and retry" : (busy === "retry" ? "Retrying…" : ACTION_LABELS.retry)}</button>}
        {outputHref && <a href={outputHref} className={styles.outputButton}>{job.source === "lora" ? ACTION_LABELS.downloadResult : ACTION_LABELS.openOutput}</a>}
        {outputMissing && <p className={styles.error} role="status">輸出檔案不存在或已失效。</p>}
        <a href="/app/jobs" className={styles.backLink}>← {ACTION_LABELS.viewAll}工作</a>
        {(job.source === "upscale" || job.source === "img2img") && !job.canCancel && (job.status === "queued" || job.status === "running") && <p className={styles.helper}>目前工具服務未提供取消端點，因此此頁不會顯示虛假的取消結果。</p>}
      </aside>
    </div>
  );
}
