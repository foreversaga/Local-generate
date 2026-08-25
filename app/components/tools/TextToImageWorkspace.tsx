"use client";

import { FormEvent, type CSSProperties, useCallback, useEffect, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { assetUrl } from "../library/asset-client";
import {
  fetchText2ImgHealth,
  fetchText2ImgJob,
  fetchPersonPhotoLibrary,
  generateText2ImgPrompt,
  randomizePersonPhotos,
  submitText2Img,
  type ClothingRequirement,
  type PersonPhotoLibrary,
  type PersonPhotoRecipe,
  type Text2ImgHealth,
  type Text2ImgJob,
  type Text2ImgLoraSelection,
} from "./text2img-client";
import styles from "./TextToImageWorkspace.module.css";

type SizePreset = {
  id: string;
  width: number;
  height: number;
  steps?: number;
  label: "text2img.size.square" | "text2img.size.portrait" | "text2img.size.portraitWide" | "text2img.size.landscape" | "text2img.size.landscapeWide";
};

const SIZE_PRESETS_BY_MODEL: Record<string, readonly SizePreset[]> = {
  "flux2-klein-9b": [
    { id: "square", width: 1024, height: 1024, label: "text2img.size.square" },
    { id: "portrait", width: 768, height: 1024, label: "text2img.size.portrait" },
    { id: "portraitWide", width: 896, height: 1152, label: "text2img.size.portraitWide" },
    { id: "landscape", width: 1024, height: 768, label: "text2img.size.landscape" },
    { id: "landscapeWide", width: 1152, height: 896, label: "text2img.size.landscapeWide" },
  ],
};

const DEFAULT_STEPS = 4;
const DEFAULT_GUIDANCE = 1;
const MIN_GUIDANCE = 1;
const MAX_GUIDANCE = 8;
const DEFAULT_SEED = 12345;
const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 1024;
const CUSTOM_PRESET_ID = "custom";
const DEFAULT_MODEL_ID = "flux2-klein-9b";
const DEFAULT_ENCODER_ID = "official";
const KLEIN_LORA_OPTIONS = [
  { id: "consistency-v2", nameKey: "text2img.lora.consistency.name", useKey: "text2img.lora.consistency.use", defaultStrength: 0.8 },
  { id: "image-restore-v1", nameKey: "text2img.lora.restore.name", useKey: "text2img.lora.restore.use", defaultStrength: 0.8 },
  { id: "ultrareal-v4", nameKey: "text2img.lora.ultrareal.name", useKey: "text2img.lora.ultrareal.use", defaultStrength: 0.55 },
] as const;
const CLOTHING_CATEGORY_KEYS: Record<string, string> = {
  outfit: "text2img.random.category.outfit",
  top: "text2img.random.category.top",
  bottom: "text2img.random.category.bottom",
  shoes: "text2img.random.category.shoes",
  outerwear: "text2img.random.category.outerwear",
  hosiery: "text2img.random.category.hosiery",
  custom: "text2img.random.category.custom",
};
const MODEL_OPTIONS = [
  {
    id: DEFAULT_MODEL_ID,
    mark: "K9",
    nameKey: "text2img.model.klein9b.name",
    noteKey: "text2img.model.klein9b.note",
    defaultSteps: 4,
    maxSteps: 20,
    defaultGuidance: 1,
    minDimension: 512,
    maxDimension: 1536,
    sizeHelpKey: "text2img.size.help.klein9b",
    stepsHelpKey: "text2img.steps.help.klein9b",
    negativeNoteKey: "text2img.negativeNote.klein9b",
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

function normalizeDecimalField(value: string, fallback: number, min: number, max: number, step: number) {
  if (!value.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const bounded = Math.max(min, Math.min(max, parsed));
  return Math.round(bounded / step) * step;
}

function normalizeDimensionField(value: string, fallback: number, min: number, max: number) {
  const bounded = normalizeIntegerField(value, fallback, min, max);
  return Math.max(min, Math.min(max, Math.round(bounded / 16) * 16));
}

function resolutionScaleBounds(width: number, height: number, minDimension: number, maxDimension: number) {
  return {
    min: Math.ceil(Math.max(minDimension / width, minDimension / height) * 100),
    max: Math.floor(Math.min(maxDimension / width, maxDimension / height) * 100),
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
  const [inputMode, setInputMode] = useState<"manual" | "random">("manual");
  const [randomMode, setRandomMode] = useState<"single" | "batch">("single");
  const [batchCount, setBatchCount] = useState("4");
  const [recipeSeed, setRecipeSeed] = useState("");
  const [clothingCategory, setClothingCategory] = useState("hosiery");
  const [clothingText, setClothingText] = useState("");
  const [clothingOptionId, setClothingOptionId] = useState("");
  const [personLibrary, setPersonLibrary] = useState<PersonPhotoLibrary | null>(null);
  const [recipes, setRecipes] = useState<PersonPhotoRecipe[]>([]);
  const [recipeBusy, setRecipeBusy] = useState(false);
  const [descriptionCopyStatus, setDescriptionCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [prompt, setPrompt] = useState("");
  const [promptModel, setPromptModel] = useState("");
  const [promptBusy, setPromptBusy] = useState(false);
  const [unloadPromptModel, setUnloadPromptModel] = useState(false);
  const [modelId, setModelId] = useState(DEFAULT_MODEL_ID);
  const [encoderId, setEncoderId] = useState(DEFAULT_ENCODER_ID);
  const [presetId, setPresetId] = useState<string>("square");
  const [resolutionScale, setResolutionScale] = useState(100);
  const [width, setWidth] = useState(String(DEFAULT_WIDTH));
  const [height, setHeight] = useState(String(DEFAULT_HEIGHT));
  const [steps, setSteps] = useState(String(DEFAULT_STEPS));
  const [guidance, setGuidance] = useState(String(DEFAULT_GUIDANCE));
  const [seed, setSeed] = useState(String(DEFAULT_SEED));
  const [loraSettings, setLoraSettings] = useState<Record<string, { enabled: boolean; strength: string }>>(() => Object.fromEntries(
    KLEIN_LORA_OPTIONS.map((item) => [item.id, { enabled: false, strength: String(item.defaultStrength) }]),
  ));
  const [job, setJob] = useState<Text2ImgJob | null>(null);
  const [jobs, setJobs] = useState<Text2ImgJob[]>([]);
  const [submitError, setSubmitError] = useState("");

  const selectedOption = MODEL_OPTIONS.find((item) => item.id === modelId) || MODEL_OPTIONS[0];
  const sizePresets = SIZE_PRESETS_BY_MODEL[modelId] || SIZE_PRESETS_BY_MODEL[DEFAULT_MODEL_ID];
  const selectedHealth = health?.profiles?.[modelId];
  const selectedEncoderHealth = selectedHealth?.encoders?.[encoderId];
  const selectedReady = Boolean(selectedEncoderHealth ? selectedEncoderHealth.ready : selectedHealth?.ready);
  const defaultSteps = selectedHealth?.defaultSteps || selectedOption.defaultSteps;
  const maxSteps = selectedHealth?.maxSteps || selectedOption.maxSteps;
  const minDimension = selectedHealth?.minDimension || selectedOption.minDimension;
  const maxDimension = selectedHealth?.maxDimension || selectedOption.maxDimension;
  const selectedPreset = sizePresets.find((item) => item.id === presetId);
  const scaleBounds = selectedPreset ? resolutionScaleBounds(selectedPreset.width, selectedPreset.height, minDimension, maxDimension) : null;
  const selectedLoras = (): Text2ImgLoraSelection[] => modelId === "flux2-klein-9b"
    ? KLEIN_LORA_OPTIONS.flatMap((item) => {
      const setting = loraSettings[item.id];
      return setting?.enabled ? [{ id: item.id, strength: normalizeDecimalField(setting.strength, item.defaultStrength, 0, 2, 0.05) }] : [];
    })
    : [];

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
    if (inputMode !== "random" || personLibrary) return;
    void fetchPersonPhotoLibrary().then(setPersonLibrary).catch((error) => {
      setSubmitError(error instanceof Error ? error.message : t("text2img.random.error"));
    });
  }, [inputMode, personLibrary, t]);

  useEffect(() => {
    const active = jobs.filter((item) => !terminal(item.status));
    if (!active.length) return;
    let cancelled = false;
    const poll = async () => {
      const updates = await Promise.all(active.map(async (item) => {
        try { return await fetchText2ImgJob(item.id); } catch { return item; }
      }));
      if (!cancelled) setJobs((current) => current.map((item) => updates.find((next) => next.id === item.id) || item));
    };
    const timer = window.setInterval(() => { void poll(); }, 750);
    void poll();
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [jobs]);

  const clothingRequirements = (): ClothingRequirement[] => clothingText.trim() ? [{
    category: clothingCategory, value: clothingText.trim(), ...(clothingOptionId ? { optionId: clothingOptionId } : {}), applyToAll: true,
  }] : [];

  async function randomizeRecipes() {
    setRecipeBusy(true); setSubmitError("");
    try {
      const count = randomMode === "single" ? 1 : normalizeIntegerField(batchCount, 4, 1, 20);
      setBatchCount(String(count));
      const seedValue = recipeSeed.trim() ? normalizeIntegerField(recipeSeed, 0, 0, 2_147_483_647) : undefined;
      const result = await randomizePersonPhotos({ count, seed: seedValue, clothingRequirements: clothingRequirements() });
      setRecipes(result.recipes); setRecipeSeed(String(result.batchSeed));
      if (result.recipes[0]) setDescription(result.recipes[0].brief);
    } catch (error) { setSubmitError(error instanceof Error ? error.message : t("text2img.random.error")); }
    finally { setRecipeBusy(false); }
  }

  useEffect(() => {
    if (jobs.length || !job?.id || terminal(job.status)) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await fetchText2ImgJob(job.id);
        if (!cancelled) {
          setJob(next);
          setSubmitError("");
        }
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
  }, [job?.id, job?.status, jobs.length, t]);

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
    if (!selectedReady || !health?.promptAssistant?.ready || (inputMode === "manual" ? !description.trim() : !recipes.length)
      || promptBusy || (job && !terminal(job.status)) || jobs.some((item) => !terminal(item.status))) return;
    setSubmitError("");
    setJob(null);
    setJobs([]);
    setPromptBusy(true);
    try {
      const normalizedSteps = normalizeIntegerField(steps, defaultSteps, 1, maxSteps);
      const normalizedGuidance = normalizeDecimalField(guidance, selectedHealth?.cfg || DEFAULT_GUIDANCE, MIN_GUIDANCE, MAX_GUIDANCE, 0.1);
      const normalizedSeed = normalizeIntegerField(seed, DEFAULT_SEED, 0, 2_147_483_647);
      const normalizedWidth = normalizeDimensionField(width, DEFAULT_WIDTH, minDimension, maxDimension);
      const normalizedHeight = normalizeDimensionField(height, DEFAULT_HEIGHT, minDimension, maxDimension);
      setSteps(String(normalizedSteps));
      setGuidance(String(normalizedGuidance));
      setSeed(String(normalizedSeed));
      setWidth(String(normalizedWidth));
      setHeight(String(normalizedHeight));
      if (inputMode === "random") {
        const generatedPrompts = [];
        for (const recipe of recipes) generatedPrompts.push(await generateText2ImgPrompt(recipe.brief, { unloadPromptModel, recipe }));
        setPrompt(generatedPrompts[0]?.prompt || ""); setPromptModel(generatedPrompts[0]?.model || "");
        const queued: Text2ImgJob[] = [];
        for (let index = 0; index < recipes.length; index += 1) {
          const recipe = recipes[index]; const generated = generatedPrompts[index];
          queued.push(await submitText2Img({ prompt: generated.prompt, width: recipe.dimensions.width, height: recipe.dimensions.height,
            steps: normalizedSteps, cfg: normalizedGuidance, seed: randomSeed(), modelId, encoderId, loras: selectedLoras(),
            batchId: recipe.batchId, batchIndex: recipe.batchIndex, batchSize: recipe.batchSize, recipeSeed: recipe.recipeSeed, recipe }));
          if (recipes.length > 1) setJobs([...queued]);
        }
        if (queued.length === 1) setJob(queued[0]);
        else setJobs(queued);
        return;
      }
      const generated = await generateText2ImgPrompt(description.trim(), { unloadPromptModel });
      setPrompt(generated.prompt);
      setPromptModel(generated.model);
      setPromptBusy(false);
      setJob(await submitText2Img({
        prompt: generated.prompt,
        width: normalizedWidth,
        height: normalizedHeight,
        steps: normalizedSteps,
        cfg: normalizedGuidance,
        seed: normalizedSeed,
        modelId,
        encoderId,
        loras: selectedLoras(),
      }));
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t("text2img.submit.error"));
    } finally {
      setPromptBusy(false);
    }
  }

  async function repeatGeneration(completedJob: Text2ImgJob) {
    const repeatPresets = SIZE_PRESETS_BY_MODEL[completedJob.modelId] || SIZE_PRESETS_BY_MODEL[DEFAULT_MODEL_ID];
    const matchingPreset = repeatPresets.find((item) => item.width === completedJob.width && item.height === completedJob.height
      && (item.steps === undefined || item.steps === completedJob.steps));
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
    setGuidance(String(completedJob.cfg));
    setSeed(String(completedJob.seed));
    setLoraSettings((current) => Object.fromEntries(KLEIN_LORA_OPTIONS.map((item) => {
      const selected = completedJob.loras?.find((lora) => lora.id === item.id);
      return [item.id, { enabled: Boolean(selected), strength: String(selected?.strength ?? current[item.id]?.strength ?? item.defaultStrength) }];
    })));
    setPrompt(completedJob.prompt);
    setPromptModel("");
    try {
      setJob(await submitText2Img({
        prompt: completedJob.prompt,
        width: completedJob.width,
        height: completedJob.height,
        steps: completedJob.steps,
        cfg: completedJob.cfg,
        seed: completedJob.seed,
        modelId: completedJob.modelId,
        encoderId: encoder,
        loras: completedJob.loras || [],
      }));
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t("text2img.repeat.error"));
    }
  }

  async function retryBatchJob(failedJob: Text2ImgJob) {
    setSubmitError("");
    try {
      const next = await submitText2Img({ prompt: failedJob.prompt, width: failedJob.width, height: failedJob.height,
        steps: failedJob.steps, cfg: failedJob.cfg, seed: failedJob.seed, modelId: failedJob.modelId,
        encoderId: failedJob.encoderId || DEFAULT_ENCODER_ID, loras: failedJob.loras || [], batchId: failedJob.batchId,
        batchIndex: failedJob.batchIndex, batchSize: failedJob.batchSize, recipeSeed: failedJob.recipeSeed, recipe: failedJob.recipe });
      setJobs((current) => current.map((item) => item.id === failedJob.id ? next : item));
    } catch (error) { setSubmitError(error instanceof Error ? error.message : t("text2img.repeat.error")); }
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

  const isBusy = promptBusy || Boolean(job && !terminal(job.status)) || jobs.some((item) => !terminal(item.status));
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

          <div className={styles.modeTabs} role="group" aria-label={t("text2img.mode.label")}>
            <button type="button" disabled={isBusy} className={inputMode === "manual" ? styles.modeActive : ""} onClick={() => { setInputMode("manual"); setRecipes([]); setJobs([]); setJob(null); }}>{t("text2img.mode.manual")}</button>
            <button type="button" disabled={isBusy} className={inputMode === "random" ? styles.modeActive : ""} onClick={() => { setInputMode("random"); setJobs([]); setJob(null); }}>{t("text2img.mode.random")}</button>
          </div>
          {inputMode === "random" && <section className={styles.randomPanel}>
            <div className={styles.modeTabs} role="group"><button type="button" className={randomMode === "single" ? styles.modeActive : ""} onClick={() => { setRandomMode("single"); setRecipes([]); }}>{t("text2img.random.single")}</button><button type="button" className={randomMode === "batch" ? styles.modeActive : ""} onClick={() => { setRandomMode("batch"); setRecipes([]); }}>{t("text2img.random.batch")}</button></div>
            <div className={styles.randomFields}>
              {randomMode === "batch" && <label className={styles.field}><span>{t("text2img.random.count")}</span><input type="number" min={1} max={20} value={batchCount} onChange={(event) => setBatchCount(event.target.value)} onBlur={() => setBatchCount(String(normalizeIntegerField(batchCount, 4, 1, 20)))} /></label>}
              <label className={styles.field}><span>{t("text2img.random.recipeSeed")}</span><input type="number" min={0} max={2147483647} value={recipeSeed} placeholder={t("text2img.random.auto")} onChange={(event) => setRecipeSeed(event.target.value)} /></label>
              <label className={styles.field}><span>{t("text2img.random.clothingCategory")}</span><select value={clothingCategory} onChange={(event) => { setClothingCategory(event.target.value); setClothingOptionId(""); }}>{Object.keys(personLibrary?.clothingOptions || { hosiery: [] }).map((category) => <option key={category} value={category}>{t(CLOTHING_CATEGORY_KEYS[category] || category)}</option>)}</select></label>
              <label className={styles.field}><span>{t("text2img.random.mustInclude")}</span><input value={clothingText} placeholder={t("text2img.random.mustIncludePlaceholder")} onChange={(event) => { setClothingText(event.target.value); setClothingOptionId(""); }} /></label>
            </div>
            <div className={styles.quickChoices}><button type="button" onClick={() => { setClothingCategory("hosiery"); setClothingText("白色短襪"); setClothingOptionId("H01"); }}>H01 · {t("text2img.random.whiteAnkleSocks")}</button><button type="button" onClick={() => { setClothingCategory("hosiery"); setClothingText("白色中筒襪"); setClothingOptionId("H04"); }}>H04 · {t("text2img.random.whiteCrewSocks")}</button></div>
            {randomMode === "batch" && <p className={styles.applyAll}>{t("text2img.random.applyAll")}</p>}
            <button type="button" className={styles.secondaryButton} disabled={recipeBusy} onClick={() => void randomizeRecipes()}>{recipeBusy ? t("text2img.random.randomizing") : recipes.length ? t("text2img.random.rerollLocked") : t("text2img.random.action")}</button>
            {!!recipes.length && <div className={styles.recipeGrid}>{recipes.map((recipe) => <article key={recipe.id} className={styles.recipeCard}><header><strong>#{recipe.batchIndex + 1}</strong><span>{t("text2img.random.score").replace("{score}", String(recipe.validation.score))}</span></header><p>{recipe.brief}</p><small>{recipe.dimensions.aspectRatio} · {recipe.dimensions.width} × {recipe.dimensions.height} · Seed {recipe.recipeSeed}</small>{recipe.validation.warnings?.map((warning) => <p className={styles.recipeWarning} key={warning}>⚠ {warning}</p>)}{!!recipe.validation.checks?.length && <details className={styles.recipeChecks}><summary>{t("text2img.random.rules")}</summary><ul>{recipe.validation.checks.map((check) => <li key={check.id}>{check.passed ? "✓" : "✕"} {check.detail}</li>)}</ul></details>}</article>)}</div>}
          </section>}

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
              readOnly={inputMode === "random"}
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
                        const nextPreset = SIZE_PRESETS_BY_MODEL[item.id][0];
                        setModelId(item.id);
                        setEncoderId(DEFAULT_ENCODER_ID);
                        setSteps(String(item.defaultSteps));
                        setGuidance(String(item.defaultGuidance));
                        setPresetId(nextPreset.id);
                        setResolutionScale(100);
                        setWidth(String(nextPreset.width));
                        setHeight(String(nextPreset.height));
                        setJob(null);
                        setSubmitError("");
                      }}
                    />
                    <span className={styles.modelOptionMark}>{item.mark}</span>
                    <span className={styles.modelOptionCopy}>
                      <strong>{t(item.nameKey)}</strong>
                      <small>{t(item.noteKey)}</small>
                    </span>
                    {health && <span className={profile?.ready ? styles.optionReady : styles.optionMissing} aria-label={profile?.ready ? t("text2img.health.ready") : t("text2img.health.modelsMissing")} />}
                  </label>
                );
              })}
            </div>
          </fieldset>

          {modelId === "flux2-klein-9b" && (
            <fieldset className={styles.loraFieldset}>
              <legend>{t("text2img.lora.title")}</legend>
              <p>{t("text2img.lora.help")}</p>
              <div className={styles.loraGrid}>
                {KLEIN_LORA_OPTIONS.map((item) => {
                  const setting = loraSettings[item.id];
                  const available = Boolean(selectedHealth?.loras?.[item.id]?.available);
                  return (
                    <div key={item.id} className={`${styles.loraOption} ${setting.enabled ? styles.loraOptionActive : ""} ${!available ? styles.loraOptionMissing : ""}`}>
                      <label className={styles.loraToggle}>
                        <input
                          type="checkbox"
                          checked={setting.enabled}
                          disabled={!available}
                          onChange={(event) => setLoraSettings((current) => ({ ...current, [item.id]: { ...current[item.id], enabled: event.target.checked } }))}
                        />
                        <span>
                          <strong>{t(item.nameKey)}</strong>
                          <small>{t(item.useKey)}</small>
                        </span>
                        <em>{available ? t("text2img.lora.available") : t("text2img.lora.missing")}</em>
                      </label>
                      <label className={styles.loraStrength}>
                        <span>{t("text2img.lora.strength")}</span>
                        <input
                          type="number"
                          min={0}
                          max={2}
                          step={0.05}
                          value={setting.strength}
                          disabled={!available || !setting.enabled}
                          onChange={(event) => setLoraSettings((current) => ({ ...current, [item.id]: { ...current[item.id], strength: event.target.value } }))}
                          onBlur={() => setLoraSettings((current) => ({ ...current, [item.id]: { ...current[item.id], strength: String(normalizeDecimalField(current[item.id].strength, item.defaultStrength, 0, 2, 0.05)) } }))}
                        />
                      </label>
                    </div>
                  );
                })}
              </div>
            </fieldset>
          )}

          <fieldset className={styles.presetFieldset}>
            <legend>{t("text2img.size.label")}</legend>
            <div className={styles.presetGrid}>
              {sizePresets.map((item) => (
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
                      setSteps(String(item.steps ?? defaultSteps));
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
                  min={minDimension}
                  max={maxDimension}
                  step={16}
                  value={width}
                  onChange={(event) => { setWidth(event.target.value); setPresetId(CUSTOM_PRESET_ID); setResolutionScale(100); }}
                  onBlur={() => setWidth(String(normalizeDimensionField(width, DEFAULT_WIDTH, minDimension, maxDimension)))}
                />
              </label>
              <label className={styles.field}>
                <span>{t("text2img.size.height")}</span>
                <input
                  type="number"
                  min={minDimension}
                  max={maxDimension}
                  step={16}
                  value={height}
                  onChange={(event) => { setHeight(event.target.value); setPresetId(CUSTOM_PRESET_ID); setResolutionScale(100); }}
                  onBlur={() => setHeight(String(normalizeDimensionField(height, DEFAULT_HEIGHT, minDimension, maxDimension)))}
                />
              </label>
            </div>
            <small className={styles.dimensionHelp}>{t(selectedOption.sizeHelpKey)}</small>
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
              <small>{t(selectedOption.stepsHelpKey)}</small>
            </label>
            <label className={styles.field}>
              <span>{t("text2img.guidance.label")}</span>
              <input
                type="number"
                min={MIN_GUIDANCE}
                max={MAX_GUIDANCE}
                step={0.1}
                value={guidance}
                onChange={(event) => setGuidance(event.target.value)}
                onBlur={() => setGuidance(String(normalizeDecimalField(guidance, selectedHealth?.cfg || DEFAULT_GUIDANCE, MIN_GUIDANCE, MAX_GUIDANCE, 0.1)))}
              />
              <small>{t("text2img.guidance.help")}</small>
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
            <span>{selectedHealth?.sampler || "Euler"}</span>
            <span>{selectedHealth?.precision || "BF16"}</span>
          </div>
          <p className={styles.helper}>{t(selectedOption.negativeNoteKey)}</p>

          {submitError && <p className={styles.error} role="alert">{submitError}</p>}
          <button className={styles.primaryButton} type="submit" disabled={!workflowReady || (inputMode === "manual" ? !description.trim() : !recipes.length) || isBusy}>
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

          {jobs.length > 0 ? (
            <div className={styles.outputGrid}>{jobs.map((item) => <article className={styles.outputItem} key={item.id}>
              <header><strong>#{(item.batchIndex ?? 0) + 1}</strong><span>{item.status}</span></header>
              {item.output ? <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={assetUrl(item.output)} alt={t("text2img.output.alt")} />
              </> : <div className={styles.outputPlaceholder}>{item.status === "failed" ? item.error || t("text2img.output.failed") : `${Math.round(item.progress)}%`}</div>}
              <small>Seed {item.seed} · Recipe {item.recipeSeed}</small><details><summary>{t("text2img.prompt.generated")}</summary><p>{item.prompt}</p></details>
              {item.status === "failed" && <button type="button" onClick={() => void retryBatchJob(item)}>{t("text2img.output.retry")}</button>}
            </article>)}</div>
          ) : promptBusy ? (
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
                <span>{t("text2img.result.guidance", { guidance: job.cfg })}</span>
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
