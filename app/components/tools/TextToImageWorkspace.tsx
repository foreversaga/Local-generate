"use client";

import { FormEvent, type CSSProperties, useCallback, useEffect, useState } from "react";
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

const DEFAULT_STEPS = 20;
const DEFAULT_SEED = 12345;
const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 1024;
const CUSTOM_PRESET_ID = "custom";
const DEFAULT_MODEL_ID = "flux2-dev";
const DEFAULT_ENCODER_ID = "official";
const MODEL_OPTIONS = [
  {
    id: DEFAULT_MODEL_ID,
    mark: "DEV",
    nameKey: "text2img.model.dev.name",
    noteKey: "text2img.model.dev.note",
    licenseKey: "text2img.model.dev.license",
    commercial: false,
    defaultSteps: 20,
    maxSteps: 50,
  },
] as const;

const JOB_STAGE_KEYS = {
  Queued: "text2img.job.stage.queued",
  "Checking image models": "text2img.job.stage.checking",
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

function normalizeDimensionField(value: string, fallback: number) {
  const bounded = normalizeIntegerField(value, fallback, 512, 1536);
  return Math.max(512, Math.min(1536, Math.round(bounded / 16) * 16));
}

function resolutionScaleBounds(width: number, height: number) {
  return {
    min: Math.ceil(Math.max(512 / width, 512 / height) * 100),
    max: Math.floor(Math.min(1536 / width, 1536 / height) * 100),
  };
}

function scaledDimension(value: number, percent: number) {
  return Math.round((value * percent) / 100 / 16) * 16;
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
  const [descriptionCopyStatus, setDescriptionCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [prompt, setPrompt] = useState("");
  const [promptModel, setPromptModel] = useState("");
  const [promptBusy, setPromptBusy] = useState(false);
  const [unloadPromptModel, setUnloadPromptModel] = useState(false);
  const [modelId, setModelId] = useState(DEFAULT_MODEL_ID);
  const [encoderId, setEncoderId] = useState(DEFAULT_ENCODER_ID);
  const [presetId, setPresetId] = useState<(typeof SIZE_PRESETS)[number]["id"] | typeof CUSTOM_PRESET_ID>("square");
  const [resolutionScale, setResolutionScale] = useState(100);
  const [width, setWidth] = useState(String(DEFAULT_WIDTH));
  const [height, setHeight] = useState(String(DEFAULT_HEIGHT));
  const [steps, setSteps] = useState(String(DEFAULT_STEPS));
  const [seed, setSeed] = useState(String(DEFAULT_SEED));
  const [job, setJob] = useState<Text2ImgJob | null>(null);
  const [submitError, setSubmitError] = useState("");

  const selectedOption = MODEL_OPTIONS.find((item) => item.id === modelId) || MODEL_OPTIONS[0];
  const selectedPreset = SIZE_PRESETS.find((item) => item.id === presetId);
  const scaleBounds = selectedPreset ? resolutionScaleBounds(selectedPreset.width, selectedPreset.height) : null;
  const selectedHealth = health?.profiles?.[modelId];
  const selectedEncoderHealth = selectedHealth?.encoders?.[encoderId];
  const selectedReady = Boolean(selectedEncoderHealth ? selectedEncoderHealth.ready : selectedHealth?.ready);
  const defaultSteps = selectedHealth?.defaultSteps || selectedOption.defaultSteps;
  const maxSteps = selectedHealth?.maxSteps || selectedOption.maxSteps;

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

  async function copyDescription() {
    if (!description) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(description);
      } else {
        const copyTarget = document.createElement("textarea");
        copyTarget.value = description;
        copyTarget.setAttribute("readonly", "");
        copyTarget.style.position = "fixed";
        copyTarget.style.opacity = "0";
        document.body.append(copyTarget);
        copyTarget.select();
        let copied = false;
        try {
          copied = document.execCommand("copy");
        } finally {
          copyTarget.remove();
        }
        if (!copied) throw new Error("Copy command was rejected.");
      }
      setDescriptionCopyStatus("copied");
    } catch {
      setDescriptionCopyStatus("failed");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedReady || !health?.promptAssistant?.ready || !description.trim() || promptBusy || (job && !terminal(job.status))) return;
    setSubmitError("");
    setJob(null);
    setPromptBusy(true);
    try {
      const normalizedSteps = normalizeIntegerField(steps, defaultSteps, 1, maxSteps);
      const normalizedSeed = normalizeIntegerField(seed, DEFAULT_SEED, 0, 2_147_483_647);
      const normalizedWidth = normalizeDimensionField(width, DEFAULT_WIDTH);
      const normalizedHeight = normalizeDimensionField(height, DEFAULT_HEIGHT);
      setSteps(String(normalizedSteps));
      setSeed(String(normalizedSeed));
      setWidth(String(normalizedWidth));
      setHeight(String(normalizedHeight));
      const generated = await generateText2ImgPrompt(description.trim(), { unloadPromptModel });
      setPrompt(generated.prompt);
      setPromptModel(generated.model);
      setPromptBusy(false);
      setJob(await submitText2Img({
        prompt: generated.prompt,
        width: normalizedWidth,
        height: normalizedHeight,
        steps: normalizedSteps,
        seed: normalizedSeed,
        modelId,
        encoderId,
      }));
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t("text2img.submit.error"));
    } finally {
      setPromptBusy(false);
    }
  }

  async function repeatGeneration(completedJob: Text2ImgJob) {
    const matchingPreset = SIZE_PRESETS.find((item) => item.width === completedJob.width && item.height === completedJob.height);
    const encoder = completedJob.encoderId || DEFAULT_ENCODER_ID;
    const repeatProfile = health?.profiles?.[completedJob.modelId];
    const repeatReady = repeatProfile?.encoders?.[encoder]?.ready
      ?? health?.profiles?.[completedJob.modelId]?.ready
      ?? false;
    if (!repeatReady || isBusy) return;
    setSubmitError("");
    setModelId(completedJob.modelId);
    setEncoderId(encoder);
    setPresetId(matchingPreset?.id || CUSTOM_PRESET_ID);
    setResolutionScale(100);
    setWidth(String(completedJob.width));
    setHeight(String(completedJob.height));
    setSteps(String(completedJob.steps));
    setSeed(String(completedJob.seed));
    setPrompt(completedJob.prompt);
    setPromptModel("");
    try {
      setJob(await submitText2Img({
        prompt: completedJob.prompt,
        width: completedJob.width,
        height: completedJob.height,
        steps: completedJob.steps,
        seed: completedJob.seed,
        modelId: completedJob.modelId,
        encoderId: encoder,
      }));
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t("text2img.repeat.error"));
    }
  }

  const statusText = healthError
    ? healthError
    : !health
      ? t("text2img.health.checking")
      : selectedReady
        ? t("text2img.health.ready")
        : selectedHealth?.reason === "LOCAL_ONLY_MODEL"
          ? t("text2img.health.localOnly")
          : selectedHealth?.reason === "COMFY_UNREACHABLE"
            ? t("text2img.health.comfyOffline")
            : t("text2img.health.modelsMissing");

  const isBusy = promptBusy || Boolean(job && !terminal(job.status));
  const promptAssistantReady = Boolean(health?.promptAssistant?.ready);
  const workflowReady = Boolean(selectedReady && promptAssistantReady);
  const repeatProfile = job ? health?.profiles?.[job.modelId] : null;
  const repeatReady = Boolean(job && (repeatProfile?.encoders?.[job.encoderId || DEFAULT_ENCODER_ID]?.ready
    ?? repeatProfile?.ready));

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
          <span className={`${styles.statusChip} ${selectedReady ? styles.ready : health ? styles.blocked : styles.checking}`}>
            {statusText}
          </span>
          {!selectedReady && <button type="button" className={styles.refreshButton} onClick={() => void refreshHealth()}>{t("text2img.health.retry")}</button>}
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

          <div className={styles.fieldWide}>
            <div className={styles.fieldLabelRow}>
              <label htmlFor="text2img-description">{t("text2img.description.label")}</label>
              <button
                type="button"
                className={styles.copyButton}
                disabled={!description}
                onClick={() => void copyDescription()}
              >
                {t(`text2img.description.copy.${descriptionCopyStatus}`)}
              </button>
            </div>
            <textarea
              id="text2img-description"
              value={description}
              maxLength={2000}
              rows={6}
              placeholder={t("text2img.description.placeholder")}
              onChange={(event) => {
                setDescription(event.target.value);
                setDescriptionCopyStatus("idle");
                setPrompt("");
                setPromptModel("");
              }}
            />
            <small>{t("text2img.description.help")} · {description.length}/2000</small>
          </div>

          <div className={`${styles.assistantBar} ${promptAssistantReady ? styles.assistantReady : styles.assistantBlocked}`}>
            <div>
              <span>{t("text2img.assistant.title")}</span>
              <strong>{health?.promptAssistant?.model || t("text2img.assistant.unavailable")}</strong>
            </div>
            <span>{promptAssistantReady ? t("text2img.assistant.ready") : t("text2img.assistant.blocked")}</span>
          </div>

          {health?.promptAssistant?.provider === "ollama" && (
          <button
            type="button"
            role="switch"
            aria-checked={unloadPromptModel}
            className={`${styles.assistantSetting} ${unloadPromptModel ? styles.assistantSettingActive : ""}`}
            onClick={() => setUnloadPromptModel((current) => !current)}
          >
            <span className={styles.assistantSettingCopy}>
              <strong>{t("text2img.assistant.unload.label")}</strong>
              <small>{t(unloadPromptModel ? "text2img.assistant.unload.on" : "text2img.assistant.unload.off")}</small>
            </span>
            <span className={styles.switchTrack} aria-hidden="true"><span className={styles.switchThumb} /></span>
          </button>
          )}

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
                        setEncoderId(DEFAULT_ENCODER_ID);
                        setSteps(String(item.defaultSteps));
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

          <p className={styles.licenseWarning} role="note">{t("text2img.model.dev.warning")}</p>


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
                    onChange={() => {
                      setPresetId(item.id);
                      setResolutionScale(100);
                      setWidth(String(item.width));
                      setHeight(String(item.height));
                    }}
                  />
                  <span>{t(item.label)}</span>
                  <small>{item.width} × {item.height}</small>
                </label>
              ))}
            </div>
            {selectedPreset && scaleBounds && (
              <div className={styles.scaleControl}>
                <div className={styles.scaleHeader}>
                  <label htmlFor="text2img-resolution-scale">{t("text2img.size.scale")}</label>
                  <strong>{resolutionScale}%</strong>
                </div>
                <input
                  id="text2img-resolution-scale"
                  type="range"
                  min={scaleBounds.min}
                  max={scaleBounds.max}
                  step={1}
                  value={resolutionScale}
                  onChange={(event) => {
                    const nextScale = Number(event.target.value);
                    setResolutionScale(nextScale);
                    setWidth(String(scaledDimension(selectedPreset.width, nextScale)));
                    setHeight(String(scaledDimension(selectedPreset.height, nextScale)));
                  }}
                />
                <div className={styles.scaleRange} aria-hidden="true">
                  <span>{scaleBounds.min}%</span>
                  <span>{t("text2img.size.scale.help")}</span>
                  <span>{scaleBounds.max}%</span>
                </div>
              </div>
            )}
            <div className={styles.dimensionGrid}>
              <label className={styles.field}>
                <span>{t("text2img.size.width")}</span>
                <input
                  type="number"
                  min={512}
                  max={1536}
                  step={16}
                  value={width}
                  onChange={(event) => { setWidth(event.target.value); setPresetId(CUSTOM_PRESET_ID); setResolutionScale(100); }}
                  onBlur={() => setWidth(String(normalizeDimensionField(width, DEFAULT_WIDTH)))}
                />
              </label>
              <label className={styles.field}>
                <span>{t("text2img.size.height")}</span>
                <input
                  type="number"
                  min={512}
                  max={1536}
                  step={16}
                  value={height}
                  onChange={(event) => { setHeight(event.target.value); setPresetId(CUSTOM_PRESET_ID); setResolutionScale(100); }}
                  onBlur={() => setHeight(String(normalizeDimensionField(height, DEFAULT_HEIGHT)))}
                />
              </label>
            </div>
            <small className={styles.dimensionHelp}>{t("text2img.size.help")}</small>
          </fieldset>

          <div className={styles.parameterGrid}>
            <label className={styles.field}>
              <span>{t("text2img.steps.label")}</span>
              <input
                type="number"
                min={1}
                max={maxSteps}
                step={1}
                value={steps}
                onChange={(event) => setSteps(event.target.value)}
                onBlur={() => setSteps(String(normalizeIntegerField(steps, defaultSteps, 1, maxSteps)))}
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
            <span>CFG {selectedHealth?.cfg ?? 1}</span>
            <span>{selectedHealth?.sampler || "Euler"}</span>
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
                <button className={styles.repeatButton} type="button" onClick={() => void repeatGeneration(job)} disabled={!repeatReady || isBusy}>{t("text2img.output.repeat")}</button>
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
