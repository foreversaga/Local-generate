"use client";

import { FormEvent, type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { assetUrl } from "../library/asset-client";
import {
  fetchText2ImgHealth,
  fetchText2ImgJob,
  generateText2ImgPrompt,
  submitText2Img,
  type Text2ImgHealth,
  type Text2ImgJob,
} from "./text2img-client";
import styles from "./TextToImageWorkspace.module.css";

const SIZE_PRESETS = [
  { id: "square", width: 1024, height: 1024, label: "text2img.size.square" },
  { id: "portrait", width: 768, height: 1024, label: "text2img.size.portrait" },
  { id: "portraitWide", width: 896, height: 1152, label: "text2img.size.portraitWide" },
  { id: "landscape", width: 1024, height: 768, label: "text2img.size.landscape" },
  { id: "landscapeWide", width: 1152, height: 896, label: "text2img.size.landscapeWide" },
] as const;

const DEFAULT_STEPS = 4;
const DEFAULT_SEED = 12345;
const DEFAULT_MODEL_ID = "flux2-klein-4b";
const MODEL_OPTIONS = [
  {
    id: DEFAULT_MODEL_ID,
    mark: "4B",
    nameKey: "text2img.model.4b.name",
    noteKey: "text2img.model.4b.note",
    licenseKey: "text2img.model.4b.license",
    commercial: true,
  },
  {
    id: "flux2-klein-9b",
    mark: "9B",
    nameKey: "text2img.model.9b.name",
    noteKey: "text2img.model.9b.note",
    licenseKey: "text2img.model.9b.license",
    commercial: false,
  },
] as const;

const JOB_STAGE_KEYS = {
  Queued: "text2img.job.stage.queued",
  "Checking FLUX models": "text2img.job.stage.checking",
  "Submitting ComfyUI workflow": "text2img.job.stage.submitting",
  "Generating image": "text2img.job.stage.generating",
  "Registering image": "text2img.job.stage.registering",
  Completed: "text2img.job.stage.completed",
} as const;

function jobStageKey(stage: string) {
  return Object.hasOwn(JOB_STAGE_KEYS, stage)
    ? JOB_STAGE_KEYS[stage as keyof typeof JOB_STAGE_KEYS]
    : "text2img.job.stage.running";
}

function normalizeIntegerField(value: string, fallback: number, min: number, max: number) {
  if (!value.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function randomSeed() {
  return Math.floor(Math.random() * 2_147_483_648);
}

function terminal(status?: string) {
  return status === "completed" || status === "failed";
}

export function TextToImageWorkspace() {
  const { t } = useI18n();
  const [health, setHealth] = useState<Text2ImgHealth | null>(null);
  const [healthError, setHealthError] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [promptModel, setPromptModel] = useState("");
  const [promptBusy, setPromptBusy] = useState(false);
  const [modelId, setModelId] = useState(DEFAULT_MODEL_ID);
  const [presetId, setPresetId] = useState<(typeof SIZE_PRESETS)[number]["id"]>("square");
  const [steps, setSteps] = useState(String(DEFAULT_STEPS));
  const [seed, setSeed] = useState(String(DEFAULT_SEED));
  const [job, setJob] = useState<Text2ImgJob | null>(null);
  const [submitError, setSubmitError] = useState("");

  const preset = useMemo(() => SIZE_PRESETS.find((item) => item.id === presetId) || SIZE_PRESETS[0], [presetId]);
  const selectedOption = MODEL_OPTIONS.find((item) => item.id === modelId) || MODEL_OPTIONS[0];
  const selectedHealth = health?.profiles?.[modelId];

  const refreshHealth = useCallback(async () => {
    setHealthError("");
    try {
      setHealth(await fetchText2ImgHealth());
    } catch (error) {
      setHealth(null);
      setHealthError(error instanceof Error ? error.message : t("text2img.health.error"));
    }
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    void fetchText2ImgHealth().then((next) => {
      if (!cancelled) setHealth(next);
    }).catch((error) => {
      if (cancelled) return;
      setHealth(null);
      setHealthError(error instanceof Error ? error.message : t("text2img.health.error"));
    });
    return () => { cancelled = true; };
  }, [t]);

  useEffect(() => {
    if (!job?.id || terminal(job.status)) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await fetchText2ImgJob(job.id);
        if (!cancelled) setJob(next);
      } catch (error) {
        if (!cancelled) setSubmitError(error instanceof Error ? error.message : t("text2img.job.error"));
      }
    };
    const timer = window.setInterval(() => { void poll(); }, 750);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [job?.id, job?.status, t]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedHealth?.ready || !health?.promptAssistant?.ready || !description.trim() || promptBusy || (job && !terminal(job.status))) return;
    setSubmitError("");
    setJob(null);
    setPromptBusy(true);
    try {
      const normalizedSteps = normalizeIntegerField(steps, DEFAULT_STEPS, 1, 8);
      const normalizedSeed = normalizeIntegerField(seed, DEFAULT_SEED, 0, 2_147_483_647);
      setSteps(String(normalizedSteps));
      setSeed(String(normalizedSeed));
      const generated = await generateText2ImgPrompt(description.trim());
      setPrompt(generated.prompt);
      setPromptModel(generated.model);
      setPromptBusy(false);
      setJob(await submitText2Img({
        prompt: generated.prompt,
        width: preset.width,
        height: preset.height,
        steps: normalizedSteps,
        seed: normalizedSeed,
        modelId,
      }));
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t("text2img.submit.error"));
    } finally {
      setPromptBusy(false);
    }
  }

  const statusText = healthError
    ? healthError
    : !health
      ? t("text2img.health.checking")
      : selectedHealth?.ready
        ? t("text2img.health.ready")
        : selectedHealth?.reason === "LOCAL_ONLY_MODEL"
          ? t("text2img.health.localOnly")
          : selectedHealth?.reason === "COMFY_UNREACHABLE"
            ? t("text2img.health.comfyOffline")
            : t("text2img.health.modelsMissing");

  const isBusy = promptBusy || Boolean(job && !terminal(job.status));
  const promptAssistantReady = Boolean(health?.promptAssistant?.ready);
  const workflowReady = Boolean(selectedHealth?.ready && promptAssistantReady);

  return (
    <div className={styles.workspace}>
      <section className={styles.modelBar} aria-label={t("text2img.model.title")}>
        <div className={styles.modelIdentity}>
          <span className={styles.modelMark} aria-hidden="true">{selectedOption.mark}</span>
          <div>
            <span className={styles.eyebrow}>{t("text2img.model.title")}</span>
            <h2>{t(selectedOption.nameKey)}</h2>
            <p>{t(selectedOption.noteKey)}</p>
          </div>
        </div>
        <div className={styles.modelStatus}>
          <span className={`${styles.statusChip} ${selectedHealth?.ready ? styles.ready : health ? styles.blocked : styles.checking}`}>
            {statusText}
          </span>
          {!selectedHealth?.ready && <button type="button" className={styles.refreshButton} onClick={() => void refreshHealth()}>{t("text2img.health.retry")}</button>}
        </div>
      </section>

      <div className={styles.layout}>
        <form className={styles.panel} onSubmit={submit}>
          <div className={styles.sectionHeader}>
            <div>
              <span className={styles.eyebrow}>{t("text2img.input.eyebrow")}</span>
              <h2>{t("text2img.input.title")}</h2>
            </div>
            <span className={styles.sectionCode}>{t("text2img.section.prompt")}</span>
          </div>

          <label className={styles.fieldWide}>
            <span>{t("text2img.description.label")}</span>
            <textarea
              value={description}
              maxLength={2000}
              rows={6}
              placeholder={t("text2img.description.placeholder")}
              onChange={(event) => {
                setDescription(event.target.value);
                setPrompt("");
                setPromptModel("");
              }}
            />
            <small>{t("text2img.description.help")} · {description.length}/2000</small>
          </label>

          <div className={`${styles.assistantBar} ${promptAssistantReady ? styles.assistantReady : styles.assistantBlocked}`}>
            <div>
              <span>{t("text2img.assistant.title")}</span>
              <strong>{health?.promptAssistant?.model || t("text2img.assistant.unavailable")}</strong>
            </div>
            <span>{promptAssistantReady ? t("text2img.assistant.ready") : t("text2img.assistant.blocked")}</span>
          </div>

          {prompt && (
            <details className={styles.promptPreview}>
              <summary>{t("text2img.prompt.generated")}</summary>
              <p>{prompt}</p>
              <small>{promptModel} · nature-camera</small>
            </details>
          )}

          <fieldset className={styles.modelFieldset}>
            <legend>{t("text2img.model.choose")}</legend>
            <div className={styles.modelGrid}>
              {MODEL_OPTIONS.map((item) => {
                const profile = health?.profiles?.[item.id];
                return (
                  <label key={item.id} className={`${styles.modelOption} ${modelId === item.id ? styles.modelOptionActive : ""}`}>
                    <input
                      type="radio"
                      name="image-model"
                      value={item.id}
                      checked={modelId === item.id}
                      onChange={() => {
                        setModelId(item.id);
                        setJob(null);
                        setSubmitError("");
                      }}
                    />
                    <span className={styles.modelOptionMark}>{item.mark}</span>
                    <span className={styles.modelOptionCopy}>
                      <strong>{t(item.nameKey)}</strong>
                      <small>{t(item.noteKey)}</small>
                    </span>
                    <span className={`${styles.licenseTag} ${item.commercial ? styles.commercialTag : styles.nonCommercialTag}`}>
                      {t(item.licenseKey)}
                    </span>
                    {health && <span className={profile?.ready ? styles.optionReady : styles.optionMissing} aria-label={profile?.ready ? t("text2img.health.ready") : t("text2img.health.modelsMissing")} />}
                  </label>
                );
              })}
            </div>
          </fieldset>

          {!selectedOption.commercial && <p className={styles.licenseWarning} role="note">{t("text2img.model.9b.warning")}</p>}

          <fieldset className={styles.presetFieldset}>
            <legend>{t("text2img.size.label")}</legend>
            <div className={styles.presetGrid}>
              {SIZE_PRESETS.map((item) => (
                <label key={item.id} className={`${styles.preset} ${presetId === item.id ? styles.presetActive : ""}`}>
                  <input
                    type="radio"
                    name="image-size"
                    value={item.id}
                    checked={presetId === item.id}
                    onChange={() => setPresetId(item.id)}
                  />
                  <span>{t(item.label)}</span>
                  <small>{item.width} × {item.height}</small>
                </label>
              ))}
            </div>
          </fieldset>

          <div className={styles.parameterGrid}>
            <label className={styles.field}>
              <span>{t("text2img.steps.label")}</span>
              <input
                type="number"
                min={1}
                max={8}
                step={1}
                value={steps}
                onChange={(event) => setSteps(event.target.value)}
                onBlur={() => setSteps(String(normalizeIntegerField(steps, DEFAULT_STEPS, 1, 8)))}
              />
              <small>{t("text2img.steps.help")}</small>
            </label>
            <label className={styles.field}>
              <span>{t("text2img.seed.label")}</span>
              <div className={styles.seedControl}>
                <input
                  type="number"
                  min={0}
                  max={2147483647}
                  step={1}
                  value={seed}
                  onChange={(event) => setSeed(event.target.value)}
                  onBlur={() => setSeed(String(normalizeIntegerField(seed, DEFAULT_SEED, 0, 2_147_483_647)))}
                />
                <button type="button" onClick={() => setSeed(String(randomSeed()))}>{t("text2img.seed.random")}</button>
              </div>
              <small>{t("text2img.seed.help")}</small>
            </label>
          </div>

          <div className={styles.fixedSettings}>
            <span>CFG 1.0</span>
            <span>Euler</span>
            <span>{selectedHealth?.precision || "BF16"}</span>
            <span>{selectedHealth?.license || t(selectedOption.licenseKey)}</span>
          </div>
          <p className={styles.helper}>{t("text2img.negativeNote")}</p>

          {submitError && <p className={styles.error} role="alert">{submitError}</p>}
          <button className={styles.primaryButton} type="submit" disabled={!workflowReady || !description.trim() || isBusy}>
            {promptBusy ? t("text2img.generate.prompting") : isBusy ? t("text2img.generate.running") : t("text2img.generate.action")}
          </button>
        </form>

        <section className={styles.outputCard} aria-live="polite">
          <div className={styles.sectionHeader}>
            <div>
              <span className={styles.eyebrow}>{t("text2img.output.eyebrow")}</span>
              <h2>{t("text2img.output.title")}</h2>
            </div>
            <span className={styles.sectionCode}>{t("text2img.section.output")}</span>
          </div>

          {promptBusy ? (
            <div className={styles.progressState}>
              <div className={styles.progressRing} style={{ "--progress": "14%" } as CSSProperties}><span>AI</span></div>
              <strong>{t("text2img.output.prompting")}</strong>
              <p>{t("text2img.output.promptingHelp")}</p>
              <div className={styles.progressTrack}><span style={{ width: "14%" }} /></div>
            </div>
          ) : job?.output ? (
            <div className={styles.result}>
              {/* ComfyUI outputs are dynamic same-origin assets, not build-time image resources. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={assetUrl(job.output)} alt={t("text2img.output.alt")} />
              <div className={styles.resultMeta}>
                <span>{job.width} × {job.height}</span>
                <span>{t("text2img.result.seed", { seed: job.seed })}</span>
                <span>{t("text2img.result.steps", { steps: job.steps })}</span>
                <span>{job.modelLabel}</span>
              </div>
              <div className={styles.outputActions}>
                <a className={styles.secondaryButton} href={assetUrl(job.output)} target="_blank" rel="noreferrer">{t("text2img.output.open")}</a>
                <a className={styles.secondaryButton} href={`${assetUrl(job.output)}&download=1`} download>{t("text2img.output.download")}</a>
                <a className={styles.textLink} href="/app/library">{t("text2img.output.library")}</a>
              </div>
            </div>
          ) : job ? (
            <div className={styles.progressState}>
              <div className={styles.progressRing} style={{ "--progress": `${Math.max(0, Math.min(100, job.progress))}%` } as CSSProperties}>
                <span>{job.progress}%</span>
              </div>
              <strong>{job.status === "failed" ? t("text2img.output.failed") : t("text2img.output.generating")}</strong>
              <p>{job.status === "failed" ? job.error : t(jobStageKey(job.stage))}</p>
              <div className={styles.progressTrack}><span style={{ width: `${job.progress}%` }} /></div>
            </div>
          ) : (
            <div className={styles.emptyOutput}>
              <span className={styles.emptyGlyph} aria-hidden="true">＋</span>
              <strong>{t("text2img.output.empty")}</strong>
              <p>{t("text2img.output.emptyHelp")}</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
