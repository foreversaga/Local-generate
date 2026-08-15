"use client";

import { cloneElement, isValidElement, useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  buildLongPlanRequest,
  buildLongSaveRequest,
  H3_REALISM_PEOPLE_PRESET,
  H3_REALISM_PEOPLE_DEFAULT_STRENGTH,
  longJobIsActive,
  selectHydratableLongJob,
  validateLongCreate,
} from "../../lib/long-create-contract.mjs";
import {
  STUDIO_SETTINGS_DEFAULTS,
  loadStudioSettings,
  reconcileStudioSettings,
} from "../../lib/studio-settings.mjs";
import { assetKey as libraryAssetKey, uploadAssets } from "../library/asset-client";
import { AssetPickerButton } from "../library/AssetPickerButton";
import { FIELD_LABELS, jobStatusLabel, localizedCopy } from "../../lib/ui-copy.mjs";
import { useI18n } from "../../i18n/I18nProvider";
import styles from "./LongCreateForm.module.css";

const BRIDGE_URL = "/app";
const MAX_LONG_REFERENCE_IMAGES = 8;

type NumberDraft = number | "";
type PromptProvider = "ollama" | "codex";
type InputType = "text" | "image";
type ReferenceMode = "continuity" | "multi_reference";
type TimelineMode = "auto" | "manual";
type Asset = {
  name: string;
  root: "input" | "output";
  kind: "image" | "video";
  mime: string;
  size: number;
  modified: string;
  url: string;
};
type LongSegment = {
  id?: string;
  start: number;
  end: number;
  duration?: number;
  description: string;
  prompt?: string;
  negativePrompt?: string;
  endingState?: string;
  mode?: "t2v" | "i2v" | "ref2v";
  promptSource?: string;
  status?: string;
  progress?: number;
  error?: string | { code?: string; message?: string };
};
type LongPlan = {
  title?: string;
  inputType: InputType;
  inputText?: string;
  inputAsset?: Asset;
  referenceMode?: ReferenceMode;
  referenceAssets?: Asset[];
  duration?: number;
  promptProvider?: PromptProvider;
  ollamaModel?: string;
  codexModel?: string;
  codexReasoningEffort?: string;
  negativePrompt?: string;
  h3LoraEnabled?: boolean;
  h3LoraPreset?: string | null;
  characterLoraName?: string;
  characterLoraId?: string;
  characterLoraStrength?: number;
  planningSettings?: { timelineMode?: TimelineMode; targetDuration?: number; segmentDurationHint?: number; segmentCount?: number };
  planMeta?: { timelineSource?: string; segmentDurationHint?: number; model?: string; [key: string]: unknown };
  continuityBible?: Record<string, unknown>;
  segments: LongSegment[];
};
type LongJob = LongPlan & {
  id: string;
  status: string;
  revision: number;
  outputFolder?: string;
  finalAsset?: { root: "output"; name: string; kind: "video" };
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
  modelProfile?: string;
  h3LoraEnabled?: boolean;
  h3LoraPreset?: string | null;
  characterLoraName?: string;
  characterLoraId?: string;
  characterLoraStrength?: number;
  seam?: "keep_duplicate_frame" | "drop_next_first_frame";
  progress?: number;
  stage?: string;
  updatedAt?: string;
  error?: string | { code?: string; message?: string };
};
type Health = {
  ollama?: { online?: boolean; models?: string[] };
  codex?: { online?: boolean; skill?: boolean; models?: Array<{ value: string; label?: string; note?: string; reasoningEfforts?: string[] }> };
  comfy?: { online?: boolean };
};
type ApiError = { error?: string | { code?: string; message?: string } };
type ValidationIssue = { field: string; message: string };

const CODEX_FALLBACK = [
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra", reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { value: "gpt-5.6-luna", label: "GPT-5.6 Luna", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
] as const;
const REASONING = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
const RENDER_MODELS = [
  { value: "nvfp4_blackwell", label: "NVFP4 Blackwell" },
  { value: "int4_convrot_low_vram", label: "INT4 ConvRot" },
  { value: "official_pruned_int8_convrot", label: "Official INT8" },
] as const;

export function LongCreateForm() {
  const { locale } = useI18n();
  const { FIELD_LABELS } = localizedCopy(locale);
  const router = useRouter();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [title, setTitle] = useState("");
  const [outputFolder, setOutputFolder] = useState("");
  const [inputType, setInputType] = useState<InputType>("text");
  const [referenceMode, setReferenceMode] = useState<ReferenceMode>("continuity");
  const [references, setReferences] = useState<Asset[]>([]);
  const [brief, setBrief] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [timelineMode, setTimelineMode] = useState<TimelineMode>("auto");
  const [duration, setDuration] = useState<NumberDraft>(10);
  const [segmentDurationHint, setSegmentDurationHint] = useState<NumberDraft>(5);
  const [timeline, setTimeline] = useState("");
  const [promptProvider, setPromptProvider] = useState<PromptProvider>(STUDIO_SETTINGS_DEFAULTS.promptProvider as PromptProvider);
  const [ollamaModel, setOllamaModel] = useState<string>(STUDIO_SETTINGS_DEFAULTS.ollamaModel);
  const [codexModel, setCodexModel] = useState<string>(STUDIO_SETTINGS_DEFAULTS.codexModel);
  const [reasoningEffort, setReasoningEffort] = useState<string>(STUDIO_SETTINGS_DEFAULTS.codexReasoningEffort);
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const [modelProfile, setModelProfile] = useState("nvfp4_blackwell");
  const [h3LoraEnabled, setH3LoraEnabled] = useState(false);
  const [characterLoraName, setCharacterLoraName] = useState("");
  const [characterLoraId, setCharacterLoraId] = useState("");
  const [characterLoraStrength, setCharacterLoraStrength] = useState<NumberDraft>(H3_REALISM_PEOPLE_DEFAULT_STRENGTH);
  const [width, setWidth] = useState<NumberDraft>(736);
  const [height, setHeight] = useState<NumberDraft>(416);
  const [steps, setSteps] = useState<NumberDraft>(20);
  const [seed, setSeed] = useState<NumberDraft>(12345);
  const [seam, setSeam] = useState<"keep_duplicate_frame" | "drop_next_first_frame">("keep_duplicate_frame");
  const [plan, setPlan] = useState<LongPlan | null>(null);
  const [planDirty, setPlanDirty] = useState(false);
  const [job, setJob] = useState<LongJob | null>(null);
  const [planning, setPlanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const visibleOllamaModels = health?.ollama?.models || [];
  const effectiveOllamaModel = visibleOllamaModels.includes(ollamaModel) ? ollamaModel : visibleOllamaModels[0] || ollamaModel;
  const codexModels = health?.codex?.models?.length ? health.codex.models : CODEX_FALLBACK;
  const selectedCodex = codexModels.find((model) => model.value === codexModel) || codexModels[0];
  const reasoningOptions: readonly string[] = selectedCodex?.reasoningEfforts?.length ? selectedCodex.reasoningEfforts : [...REASONING];
  const effectiveReasoning = reasoningOptions.includes(reasoningEffort) ? reasoningEffort : reasoningOptions.includes("medium") ? "medium" : reasoningOptions[0] || "medium";
  const effectiveCodexModel = selectedCodex?.value || codexModel;
  // `false` is an explicit clear marker for the fixed preset.  Keep it
  // undefined when hydrating an older arbitrary LoRA so re-saving that job
  // remains backward compatible.
  const h3LoraSelection: boolean | undefined = h3LoraEnabled
    ? true
    : characterLoraName.trim() || characterLoraId.trim()
      ? undefined
      : false;
  const providerReady = promptProvider === "ollama"
    ? Boolean(health?.ollama?.online && visibleOllamaModels.includes(effectiveOllamaModel))
    : Boolean(health?.codex?.online && health?.codex?.skill);
  const baseIssues = useMemo(() => validateLongCreate({
    inputText: brief,
    inputType,
    referenceAssets: references,
    timelineMode,
    duration,
    segmentDurationHint,
    timelineText: timeline,
    width,
    height,
    steps,
    seed,
    h3LoraEnabled: h3LoraSelection,
    h3LoraPreset: h3LoraSelection ? H3_REALISM_PEOPLE_PRESET : undefined,
    characterLoraName,
    characterLoraId,
    characterLoraStrength,
    requireSavedPlan: false,
  }) as ValidationIssue[], [brief, characterLoraId, characterLoraName, characterLoraStrength, duration, h3LoraSelection, height, inputType, references, seed, segmentDurationHint, steps, timeline, timelineMode, width]);
  const submitIssues = useMemo(() => validateLongCreate({
    inputText: brief,
    inputType,
    referenceAssets: references,
    timelineMode,
    duration,
    segmentDurationHint,
    timelineText: timeline,
    width,
    height,
    steps,
    seed,
    h3LoraEnabled: h3LoraSelection,
    h3LoraPreset: h3LoraSelection ? H3_REALISM_PEOPLE_PRESET : undefined,
    characterLoraName,
    characterLoraId,
    characterLoraStrength,
    requireSavedPlan: true,
    plan,
    planDirty,
    outputFolder,
  }) as ValidationIssue[], [brief, characterLoraId, characterLoraName, characterLoraStrength, duration, h3LoraSelection, height, inputType, references, seed, segmentDurationHint, steps, timeline, timelineMode, width, outputFolder, plan, planDirty]);
  const issuesByField = useMemo(() => new Map(submitIssues.map((issue) => [issue.field, issue.message])), [submitIssues]);
  const activeJob = Boolean(job && longJobIsActive(job.status));
  const canPlan = baseIssues.length === 0 && providerReady && !planning && !saving && !uploading;
  const canInteract = !planning && !saving && !uploading && !activeJob;
  const canSave = Boolean(plan && !planDirty && outputFolder.trim() && submitIssues.length === 0 && !saving && !activeJob);

  async function refreshAssets(): Promise<Asset[]> {
    try {
      const response = await fetch(`${BRIDGE_URL}/api/assets?root=all`);
      if (!response.ok) return [];
      const payload = (await response.json()) as { assets?: Asset[] };
      const next = payload.assets || [];
      setAssets(next);
      return next;
    } catch {
      return [];
    }
  }

  async function refreshHealth(): Promise<Health | null> {
    try {
      const response = await fetch(`${BRIDGE_URL}/api/health`);
      if (!response.ok) return null;
      const next = (await response.json()) as Health;
      return next;
    } catch {
      return null;
    }
  }

  function hydrateFromJob(next: LongJob, assetList: Asset[]) {
    const byKey = new Map(assetList.map((asset) => [assetKey(asset), asset]));
    const hydrateAsset = (candidate?: Asset) => candidate ? byKey.get(assetKey(candidate)) || candidate : null;
    const nextRefs = uniqueAssets([
      hydrateAsset(next.inputAsset),
      ...(next.referenceAssets || []).map(hydrateAsset),
    ].filter((asset): asset is Asset => Boolean(asset)), MAX_LONG_REFERENCE_IMAGES);
    setJob(next);
    setPlan(next);
    setTitle(next.title || "");
    setInputType(next.inputType || "text");
    setBrief(next.inputText || "");
    setReferenceMode(next.referenceMode === "multi_reference" ? "multi_reference" : "continuity");
    setReferences(nextRefs);
    setOutputFolder(next.outputFolder || "");
    setDuration(next.duration || 10);
    setTimeline((next.segments || []).map((segment) => `[${segment.start.toFixed(3)} - ${segment.end.toFixed(3)}] ${segment.description}`).join("\n"));
    setTimelineMode(["ollama", "codex"].includes(next.planMeta?.timelineSource || "") ? "auto" : "manual");
    setSegmentDurationHint(next.planningSettings?.segmentDurationHint || next.planMeta?.segmentDurationHint || 5);
    if (next.width) setWidth(next.width);
    if (next.height) setHeight(next.height);
    if (next.steps) setSteps(next.steps);
    if (next.seed !== undefined) setSeed(next.seed);
    if (next.modelProfile) setModelProfile(next.modelProfile);
    const nextH3Enabled = next.h3LoraEnabled === true || next.h3LoraPreset === H3_REALISM_PEOPLE_PRESET || next.characterLoraName === H3_REALISM_PEOPLE_PRESET;
    setH3LoraEnabled(nextH3Enabled);
    setCharacterLoraName(nextH3Enabled ? H3_REALISM_PEOPLE_PRESET : next.characterLoraName || "");
    setCharacterLoraId(nextH3Enabled ? "" : next.characterLoraId || "");
    setCharacterLoraStrength(nextH3Enabled ? (next.characterLoraStrength ?? H3_REALISM_PEOPLE_DEFAULT_STRENGTH) : (next.characterLoraName || next.characterLoraId ? (next.characterLoraStrength ?? 0.75) : H3_REALISM_PEOPLE_DEFAULT_STRENGTH));
    if (next.promptProvider) setPromptProvider(next.promptProvider);
    if (next.codexModel) setCodexModel(next.codexModel);
    if (next.codexReasoningEffort) setReasoningEffort(next.codexReasoningEffort);
    if (next.ollamaModel && visibleOllamaModels.includes(next.ollamaModel)) setOllamaModel(next.ollamaModel);
    setNegativePrompt(next.negativePrompt || "");
    if (next.seam) setSeam(next.seam);
    setPlanDirty(false);
  }

  async function refreshSequences(assetList = assets) {
    try {
      const response = await fetch(`${BRIDGE_URL}/api/sequences`);
      if (!response.ok) return;
      const payload = (await response.json()) as { jobs?: LongJob[] };
      const latest = selectHydratableLongJob(payload.jobs) as LongJob | null;
      if (latest) hydrateFromJob(latest, assetList);
    } catch {
      // Preserve local editing if the bridge is offline.
    }
  }

  async function initialize() {
    const [nextAssets, nextHealth] = await Promise.all([refreshAssets(), refreshHealth()]);
    setHealth(nextHealth);
    await refreshSequences(nextAssets);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => { void initialize(); }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- The bridge bootstrap intentionally runs once on mount.
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const stored = reconcileStudioSettings(loadStudioSettings());
      setPromptProvider(stored.promptProvider as PromptProvider);
      setOllamaModel(stored.ollamaModel);
      setCodexModel(stored.codexModel);
      setReasoningEffort(stored.codexReasoningEffort);
      setSettingsHydrated(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!settingsHydrated || !health) return;
    const timer = window.setTimeout(() => {
      const next = reconcileStudioSettings({
        promptProvider,
        ollamaModel,
        codexModel,
        codexReasoningEffort: reasoningEffort,
      }, health);
      setPromptProvider(next.promptProvider as PromptProvider);
      setOllamaModel(next.ollamaModel);
      setCodexModel(next.codexModel);
      setReasoningEffort(next.codexReasoningEffort);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [codexModel, health, ollamaModel, promptProvider, reasoningEffort, settingsHydrated]);

  useEffect(() => {
    if (!job?.id || !longJobIsActive(job.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`${BRIDGE_URL}/api/sequences/${encodeURIComponent(job.id)}`);
        if (!response.ok) return;
        const payload = (await response.json()) as { job?: LongJob };
        if (!payload.job) return;
        setJob(payload.job);
        if (longJobIsActive(payload.job.status)) setPlan(payload.job);
        if (!longJobIsActive(payload.job.status)) void refreshAssets();
      } catch {
        // Polling recovers on the next interval.
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [job?.id, job?.status]);

  function markPlanDirty() {
    if (plan) setPlanDirty(true);
  }

  function updateReferenceMode(value: ReferenceMode) {
    setReferenceMode(value);
    setReferences((current) => value === "continuity" ? current.slice(0, 1) : current.slice(0, MAX_LONG_REFERENCE_IMAGES));
    markPlanDirty();
  }

  function updateH3LoraEnabled(enabled: boolean) {
    setH3LoraEnabled(enabled);
    setCharacterLoraName(enabled ? H3_REALISM_PEOPLE_PRESET : "");
    setCharacterLoraId("");
    setCharacterLoraStrength(H3_REALISM_PEOPLE_DEFAULT_STRENGTH);
    markPlanDirty();
  }

  function addReference(key: string) {
    const asset = assets.find((item) => assetKey(item) === key && item.kind === "image");
    if (!asset) return;
    setReferences((current) => uniqueAssets(referenceMode === "continuity" ? [asset] : [...current, asset], MAX_LONG_REFERENCE_IMAGES));
    markPlanDirty();
  }

  async function uploadReferences(files: File[]) {
    const candidates = files.filter((file) => file.type.startsWith("image/")).slice(0, referenceMode === "continuity" ? 1 : Math.max(0, MAX_LONG_REFERENCE_IMAGES - references.length));
    if (!candidates.length) return;
    setUploading(true);
    setError("");
    try {
      const uploaded = (await uploadAssets(candidates)).filter((asset): asset is Asset => asset.root === "input");
      setAssets((current) => uniqueAssets([...current, ...uploaded], Number.POSITIVE_INFINITY));
      setReferences((current) => uniqueAssets(referenceMode === "continuity" ? uploaded.slice(0, 1) : [...current, ...uploaded], MAX_LONG_REFERENCE_IMAGES));
      markPlanDirty();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "參考圖片上傳失敗。");
    } finally {
      setUploading(false);
    }
  }

  async function requestPlan(): Promise<LongPlan> {
    setAttempted(true);
    setError("");
    setNotice("");
    if (baseIssues.length) throw new Error(baseIssues[0].message);
    if (!providerReady) throw new Error(promptProvider === "codex" ? "Codex CLI 或 h3-prompt-writing skill 尚未就緒。" : "Ollama 或所選模型尚未就緒。");
    setPlanning(true);
    try {
      const plannerImages = inputType === "image"
        ? await Promise.all(references.slice(0, referenceMode === "multi_reference" ? MAX_LONG_REFERENCE_IMAGES : 1).map(async (asset, index) => ({
          role: referenceMode === "multi_reference" ? `picture_${index + 1}` : "first_frame",
          data: await assetToPromptImage(asset),
        })))
        : [];
      const response = await fetch(`${BRIDGE_URL}/api/sequences/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildLongPlanRequest({
          title,
          inputType,
          inputText: brief,
          referenceMode,
          referenceAssets: references,
          timelineMode,
          duration: Number(duration),
          segmentDurationHint: Number(segmentDurationHint),
          timelineText: timeline,
          promptProvider,
          ollamaModel: effectiveOllamaModel,
          codexModel: effectiveCodexModel,
          reasoningEffort: effectiveReasoning,
          negativePrompt,
          h3LoraEnabled: h3LoraSelection,
          h3LoraPreset: h3LoraSelection ? H3_REALISM_PEOPLE_PRESET : undefined,
          characterLoraName,
          characterLoraId: characterLoraId || undefined,
          characterLoraStrength: characterLoraStrength === "" ? undefined : Number(characterLoraStrength),
          plannerImages,
        })),
      });
      const payload = (await response.json().catch(() => ({}))) as { plan?: LongPlan } & ApiError;
      if (!response.ok || !payload.plan) throw new Error(apiError(payload, "長影片規劃失敗。"));
      const nextPlan = {
        ...payload.plan,
        ...(h3LoraEnabled
          ? { h3LoraEnabled: true, h3LoraPreset: H3_REALISM_PEOPLE_PRESET, characterLoraName: H3_REALISM_PEOPLE_PRESET, characterLoraStrength: characterLoraStrength === "" ? H3_REALISM_PEOPLE_DEFAULT_STRENGTH : Number(characterLoraStrength) }
          : !characterLoraName.trim() && !characterLoraId
            ? { h3LoraEnabled: false, h3LoraPreset: null, characterLoraName: null, characterLoraId: null, characterLoraStrength: null }
            : { characterLoraName: characterLoraName.trim(), ...(characterLoraId ? { characterLoraId } : {}), characterLoraStrength: characterLoraStrength === "" ? 0.75 : Number(characterLoraStrength) }),
      } as LongPlan;
      setPlan(nextPlan);
      setPlanDirty(false);
      setTimeline((nextPlan.segments || []).map((segment) => `[${segment.start.toFixed(3)} - ${segment.end.toFixed(3)}] ${segment.description}`).join("\n"));
      if (nextPlan.duration) setDuration(nextPlan.duration);
      setNotice(`已產生 ${nextPlan.segments.length} 段分鏡，可逐段檢查與編輯。`);
      return nextPlan;
    } finally {
      setPlanning(false);
    }
  }

  async function savePlan(planOverride?: LongPlan): Promise<LongJob> {
    const selectedPlan = planOverride || plan;
    if (!selectedPlan) throw new Error("請先產生分鏡與 H3 提示詞。");
    const issues = validateLongCreate({
      inputText: brief,
      inputType,
      referenceAssets: references,
      timelineMode,
      duration,
      segmentDurationHint,
      timelineText: timeline,
      width,
      height,
      steps,
      seed,
      h3LoraEnabled: h3LoraSelection,
      h3LoraPreset: h3LoraSelection ? H3_REALISM_PEOPLE_PRESET : undefined,
      characterLoraName,
      characterLoraId,
      characterLoraStrength,
      requireSavedPlan: true,
      plan: selectedPlan,
      planDirty: planOverride ? false : planDirty,
      outputFolder,
    }) as ValidationIssue[];
    if (issues.length) throw new Error(issues[0].message);
    const existing = job && ["draft", "ready", "interrupted", "failed", "cancelled"].includes(job.status) ? job : null;
    const response = await fetch(existing ? `${BRIDGE_URL}/api/sequences/${encodeURIComponent(existing.id)}` : `${BRIDGE_URL}/api/sequences`, {
      method: existing ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildLongSaveRequest({
        plan: selectedPlan,
        title,
        inputType,
        inputText: brief,
        referenceMode,
        referenceAssets: references,
        timelineText: timeline,
        outputFolder,
        modelProfile,
        width: Number(width),
        height: Number(height),
        steps: Number(steps),
        seed: Number(seed),
        ollamaModel: effectiveOllamaModel,
        promptProvider,
        codexModel: effectiveCodexModel,
        reasoningEffort: effectiveReasoning,
        negativePrompt,
        h3LoraEnabled: h3LoraSelection,
        h3LoraPreset: h3LoraSelection ? H3_REALISM_PEOPLE_PRESET : undefined,
        characterLoraName,
        characterLoraId: characterLoraId || undefined,
        characterLoraStrength: characterLoraStrength === "" ? undefined : Number(characterLoraStrength),
        clearCharacterLora: Boolean(existing && !characterLoraName.trim() && !characterLoraId.trim()),
        seam,
        revision: existing?.revision,
      })),
    });
    const payload = (await response.json().catch(() => ({}))) as { job?: LongJob } & ApiError;
    if (!response.ok || !payload.job) throw new Error(apiError(payload, "無法儲存長影片工作。"));
    setJob(payload.job);
    setPlan(payload.job);
    setPlanDirty(false);
    return payload.job;
  }

  async function saveDraft() {
    setSaving(true);
    setError("");
    try {
      await savePlan();
      setNotice("長影片草稿已保存。" );
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "無法保存長影片草稿。");
    } finally {
      setSaving(false);
    }
  }

  async function startLongVideo() {
    setAttempted(true);
    setError("");
    setNotice("");
    if (!canInteract) return;
    const firstIssue = baseIssues[0] || (!outputFolder.trim() ? { field: "outputFolder", message: "請輸入輸出資料夾。" } : null);
    if (firstIssue) {
      setError(firstIssue.message);
      focusLongValidationField(firstIssue.field);
      return;
    }
    if (!providerReady) {
      setError("規劃工具尚未就緒；請先確認 Ollama 或 Codex CLI 是否可用。");
      document.getElementById("long-provider-status")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    setSaving(true);
    try {
      const readyPlan = !plan || planDirty ? await requestPlan() : plan;
      const saved = await savePlan(readyPlan);
      const response = await fetch(`${BRIDGE_URL}/api/sequences/${encodeURIComponent(saved.id)}/start`, { method: "POST" });
      const payload = (await response.json().catch(() => ({}))) as { job?: LongJob } & ApiError;
      if (!response.ok || !payload.job) throw new Error(apiError(payload, "無法開始長影片工作。"));
      setJob(payload.job);
      router.push(`/app/jobs/${encodeURIComponent(payload.job.id)}`);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "無法開始長影片生成。" );
    } finally {
      setSaving(false);
    }
  }

  function updateSegment(index: number, patch: Partial<LongSegment>) {
    setPlan((current) => current ? {
      ...current,
      segments: current.segments.map((segment, itemIndex) => itemIndex === index ? { ...segment, ...patch } : segment),
    } : current);
  }

  function randomizeSeed() {
    const values = new Uint32Array(1);
    globalThis.crypto?.getRandomValues?.(values);
    setSeed(values[0] ? values[0] % 2147483648 : Math.floor(Math.random() * 2147483648));
  }

  function clearEditor() {
    if (activeJob || saving || planning) return;
    setTitle(""); setOutputFolder(""); setInputType("text"); setReferenceMode("continuity"); setReferences([]);
    setBrief(""); setNegativePrompt(""); setTimelineMode("auto"); setDuration(10); setSegmentDurationHint(5); setTimeline("");
    setModelProfile("nvfp4_blackwell"); setWidth(736); setHeight(416); setSteps(20); setSeed(12345); setSeam("keep_duplicate_frame");
    setH3LoraEnabled(false); setCharacterLoraName(""); setCharacterLoraId(""); setCharacterLoraStrength(H3_REALISM_PEOPLE_DEFAULT_STRENGTH);
    setPlan(null); setPlanDirty(false); setJob(null); setError(""); setNotice("已清除目前長影片編輯狀態；已保存工作未刪除。" );
  }

  const visibleIssues = attempted ? submitIssues : [];

  return (
    <div className={styles.layout}>
      <nav className={styles.sectionNav} aria-label="長影片建立區段">
        <a href="#long-story">故事</a><a href="#long-planner">規劃</a><a href="#long-segments">分段</a><a href="#long-review">檢查</a>
      </nav>

      <div className={styles.formColumn}>
        <LongSection id="long-story" code="01 / 故事與來源" title="故事與來源">
          <div className={styles.twoColumns}>
            <Field label="標題"><input className={styles.input} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="兩段式故事" /></Field>
            <Field label="輸出資料夾" error={attempted ? issuesByField.get("outputFolder") : ""}><input id="long-output-folder" className={styles.input} value={outputFolder} onChange={(event) => setOutputFolder(event.target.value)} placeholder="my-sequence-001" /></Field>
          </div>
          <div className={styles.segmented} role="group" aria-label="長影片起點類型">
            <button type="button" className={inputType === "text" ? styles.active : ""} aria-pressed={inputType === "text"} onClick={() => { setInputType("text"); markPlanDirty(); }}>文字起點</button>
            <button type="button" className={inputType === "image" ? styles.active : ""} aria-pressed={inputType === "image"} onClick={() => { setInputType("image"); markPlanDirty(); }}>從圖片開始</button>
          </div>
          {inputType === "image" && (
            <div className={styles.referencePanel}>
              <div className={styles.segmented} role="group" aria-label="參考模式">
                <button type="button" className={referenceMode === "continuity" ? styles.active : ""} aria-pressed={referenceMode === "continuity"} onClick={() => updateReferenceMode("continuity")}>連續首幀</button>
                <button type="button" className={referenceMode === "multi_reference" ? styles.active : ""} aria-pressed={referenceMode === "multi_reference"} onClick={() => updateReferenceMode("multi_reference")}>多參考</button>
              </div>
              <div className={styles.assetControls}>
                <AssetPickerButton
                  triggerId="long-reference-assets"
                  allowedRoots={["input", "output"]}
                  allowedKinds={["image"]}
                  multiple={referenceMode === "multi_reference"}
                  maxSelection={referenceMode === "multi_reference" ? MAX_LONG_REFERENCE_IMAGES : 1}
                  selectedKeys={references.map(assetKey)}
                  label="從素材庫加入圖片"
                  onSelect={(chosen) => chosen.forEach((asset) => addReference(libraryAssetKey(asset)))}
                />
                <UploadButton busy={uploading} multiple={referenceMode === "multi_reference"} onFiles={uploadReferences} />
              </div>
              {references.length > 0 && <div className={styles.referenceGrid}>{references.map((asset, index) => <div className={styles.referenceCard} key={assetKey(asset)}><AssetThumb asset={asset} /><span>{index + 1}</span><strong title={asset.name}>{asset.name}</strong><button type="button" onClick={() => { setReferences((current) => current.filter((item) => assetKey(item) !== assetKey(asset))); markPlanDirty(); }} aria-label={`移除 ${asset.name}`}>×</button></div>)}</div>}
              <p className={styles.helper}>{referenceMode === "continuity" ? "Picture 1 會鎖定第 0.00 秒 first frame。" : `最多 ${MAX_LONG_REFERENCE_IMAGES} 張；前段尾幀仍會作為下一段 continuation reference。`}</p>
              <InlineError message={attempted ? issuesByField.get("referenceAssets") : ""} />
            </div>
          )}
          <Field label="整體提示詞／故事描述" error={attempted ? issuesByField.get("inputText") : ""}>
            <textarea id="long-brief" className={styles.textarea} value={brief} onChange={(event) => { setBrief(event.target.value); markPlanDirty(); }} placeholder="描述角色、場景、情節、鏡頭、對話與聲音方向…" />
          </Field>
          <Field label="負面提示詞／限制" helper="空白時 planner 可自行補齊。">
            <textarea className={`${styles.textarea} ${styles.compactTextarea}`} value={negativePrompt} onChange={(event) => setNegativePrompt(event.target.value)} placeholder="角色漂移、服裝改變、閃爍、文字、浮水印…" />
          </Field>
        </LongSection>

        <LongSection id="long-planner" code="02 / 規劃與時間軸" title="規劃與時間軸">
          <div id="long-provider-status" className={styles.providerRow} tabIndex={-1}>
            <div className={styles.segmented} role="group" aria-label="長影片規劃 provider">
              <button type="button" className={promptProvider === "ollama" ? styles.active : ""} aria-pressed={promptProvider === "ollama"} onClick={() => { setPromptProvider("ollama"); markPlanDirty(); }}>Ollama</button>
              <button type="button" className={promptProvider === "codex" ? styles.active : ""} aria-pressed={promptProvider === "codex"} onClick={() => { setPromptProvider("codex"); markPlanDirty(); }}>Codex CLI</button>
            </div>
            <span className={`${styles.providerStatus} ${providerReady ? styles.ready : ""}`}><i />{providerReady ? "已就緒" : "無法使用"}</span>
          </div>
          {promptProvider === "ollama" ? <Field label="Ollama 模型"><select className={styles.select} value={effectiveOllamaModel} disabled={!visibleOllamaModels.length} onChange={(event) => { setOllamaModel(event.target.value); markPlanDirty(); }}>{visibleOllamaModels.length ? visibleOllamaModels.map((model) => <option key={model} value={model}>{model}</option>) : <option value={ollamaModel}>沒有可用模型</option>}</select></Field> : <div className={styles.twoColumns}><Field label="Codex 模型"><select className={styles.select} value={effectiveCodexModel} onChange={(event) => { setCodexModel(event.target.value); markPlanDirty(); }}>{codexModels.map((model) => <option key={model.value} value={model.value}>{model.label || model.value}</option>)}</select></Field><Field label="Reasoning"><select className={styles.select} value={effectiveReasoning} onChange={(event) => { setReasoningEffort(event.target.value); markPlanDirty(); }}>{reasoningOptions.map((value) => <option key={value} value={value}>{value}</option>)}</select></Field></div>}
          <div className={styles.segmented} role="group" aria-label="時間軸模式"><button type="button" className={timelineMode === "auto" ? styles.active : ""} aria-pressed={timelineMode === "auto"} onClick={() => { setTimelineMode("auto"); markPlanDirty(); }}>自動</button><button type="button" className={timelineMode === "manual" ? styles.active : ""} aria-pressed={timelineMode === "manual"} onClick={() => { setTimelineMode("manual"); markPlanDirty(); }}>手動</button></div>
          <div className={styles.twoColumns}>
            {timelineMode === "auto" && <Field label="目標總長（秒）" error={attempted ? issuesByField.get("duration") : ""}><input id="long-duration" className={styles.input} type="number" min={1} max={3600} value={duration} onChange={(event) => { setDuration(numberDraft(event.target.value)); markPlanDirty(); }} /></Field>}
            <Field label="目標單段長度（秒）" error={attempted ? issuesByField.get("segmentDurationHint") : ""}><input id="long-segment-duration" className={styles.input} type="number" min={0.5} max={60} step={0.5} value={segmentDurationHint} onChange={(event) => { setSegmentDurationHint(numberDraft(event.target.value)); markPlanDirty(); }} /></Field>
          </div>
          {timelineMode === "manual" && <Field label="手動時間軸" helper="例如：[0 - 5] Opening；[5 - 10] Ending" error={attempted ? issuesByField.get("timelineText") : ""}><textarea id="long-timeline" className={styles.textarea} value={timeline} onChange={(event) => { setTimeline(event.target.value); markPlanDirty(); }} /></Field>}
          <button type="button" className={styles.planButton} disabled={!canPlan} onClick={() => void requestPlan().catch((planError) => setError(planError instanceof Error ? planError.message : "規劃失敗。"))}>{planning ? "規劃中…" : `用 ${promptProvider === "codex" ? "Codex CLI" : "Ollama"} 產生分鏡與 H3 提示詞`}</button>
          {planDirty && plan && <p className={styles.stale} role="status">規劃輸入已變更；保存或開始前會重新規劃。</p>}
        </LongSection>

        <LongSection id="long-segments" code="03 / 片段檢查" title={`片段檢查 · ${plan?.segments.length || 0} 段`}>
          {!plan && <div className={styles.empty}>尚無分段提示詞。先完成 Planner，再在此逐段檢查與編輯。</div>}
          {plan?.segments.map((segment, index) => <article className={styles.segmentCard} key={segment.id || index}>
            <div className={styles.segmentHeading}><div><span>片段 {index + 1}</span><strong>{segment.start.toFixed(2)}–{segment.end.toFixed(2)} 秒</strong></div><span className={styles.modeBadge}>{(segment.mode || (index === 0 && inputType === "text" ? "t2v" : "i2v")).toUpperCase()}</span></div>
            <div className={styles.twoColumns}><Field label="分鏡描述"><textarea className={styles.compactTextarea} value={segment.description} onChange={(event) => updateSegment(index, { description: event.target.value })} /></Field><Field label="段尾狀態"><textarea className={styles.compactTextarea} value={segment.endingState || ""} onChange={(event) => updateSegment(index, { endingState: event.target.value })} /></Field></div>
            <Field label="H3 提示詞"><textarea className={styles.textarea} value={segment.prompt || ""} onChange={(event) => updateSegment(index, { prompt: event.target.value, promptSource: "manual" })} /></Field>
            <Field label="此段負面提示詞" helper="空白則使用全片設定。"><textarea className={styles.compactTextarea} value={segment.negativePrompt || ""} onChange={(event) => updateSegment(index, { negativePrompt: event.target.value })} /></Field>
          </article>)}
        </LongSection>

        <LongSection id="long-setup" code="04 / 生成設定" title="生成設定">
          <label className={styles.field}>
            <span className={styles.label}>H3 Realism People LoRA</span>
            <span className={styles.segmented}>
              <button type="button" className={h3LoraEnabled ? styles.active : ""} aria-pressed={h3LoraEnabled} onClick={() => updateH3LoraEnabled(!h3LoraEnabled)}>{h3LoraEnabled ? "已啟用" : "停用"}</button>
            </span>
            <span className={styles.helper}>固定預設：{H3_REALISM_PEOPLE_PRESET}；trigger <code>r34l1sm</code> 由 bridge 注入。停用會清除已保存 LoRA。</span>
          </label>
          <div className={styles.twoColumns}>
            <Field label="Character LoRA" error={attempted ? issuesByField.get("characterLoraName") : ""}>
              <input id="long-character-lora" className={styles.input} value={h3LoraEnabled ? H3_REALISM_PEOPLE_PRESET : characterLoraName} readOnly={h3LoraEnabled} onChange={(event) => { setCharacterLoraName(event.target.value); markPlanDirty(); }} placeholder="停用（可保留舊版 LoRA 路徑）" />
            </Field>
            <Field label="LoRA strength" error={attempted ? issuesByField.get("characterLoraStrength") : ""}>
              <input id="long-character-lora-strength" className={styles.input} type="number" min={0} max={2} step={0.05} value={characterLoraStrength} onChange={(event) => { setCharacterLoraStrength(numberDraft(event.target.value)); markPlanDirty(); }} />
            </Field>
          </div>
          <p className={styles.helper}>固定 H3 preset 支援 T2V/I2V/Ref2VA；舊版自訂 LoRA 仍限 T2V/I2V。strength 範圍 0–2，固定預設 0.8。</p>
          <div className={styles.twoColumns}><Field label="模型設定檔"><select className={styles.select} value={modelProfile} onChange={(event) => setModelProfile(event.target.value)}>{RENDER_MODELS.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}</select></Field><Field label="接縫處理"><select className={styles.select} value={seam} onChange={(event) => setSeam(event.target.value as typeof seam)}><option value="keep_duplicate_frame">保留重複畫面</option><option value="drop_next_first_frame" disabled>移除下一段首幀（目前不支援）</option></select></Field></div>
          <div className={styles.fourColumns}><Field label={FIELD_LABELS.width} error={attempted ? issuesByField.get("width") : ""}><input id="long-width" className={styles.input} type="number" min={32} max={2048} step={32} value={width} onChange={(event) => setWidth(numberDraft(event.target.value))} /></Field><Field label={FIELD_LABELS.height} error={attempted ? issuesByField.get("height") : ""}><input id="long-height" className={styles.input} type="number" min={32} max={2048} step={32} value={height} onChange={(event) => setHeight(numberDraft(event.target.value))} /></Field><Field label="Steps" error={attempted ? issuesByField.get("steps") : ""}><input id="long-steps" className={styles.input} type="number" min={1} max={80} value={steps} onChange={(event) => setSteps(numberDraft(event.target.value))} /></Field><Field label="Seed" error={attempted ? issuesByField.get("seed") : ""}><div className={styles.seedRow}><input id="long-seed" className={styles.input} type="number" min={0} max={2147483647} value={seed} onChange={(event) => setSeed(numberDraft(event.target.value))} /><button type="button" onClick={randomizeSeed} aria-label="隨機種子">↻</button></div></Field></div>
        </LongSection>
      </div>

      <aside id="long-review" className={styles.summary} aria-label="長影片生成摘要">
        <section className={styles.summaryCard}>
          <span className={styles.eyebrow}>生成摘要</span><h2>長影片</h2>
          <div className={styles.summaryRows}><Summary label="來源素材" value={inputType === "text" ? "文字" : `${references.length} 張圖片`} /><Summary label="時間軸" value={timelineMode === "auto" ? `${duration || "—"} 秒 / 自動` : "手動"} /><Summary label="分段" value={`${plan?.segments.length || 0} 段`} /><Summary label="尺寸" value={`${width || "—"} × ${height || "—"}`} /><Summary label="提示詞提供者" value={promptProvider === "codex" ? effectiveCodexModel : effectiveOllamaModel} /></div>
          {job && <div className={styles.jobSummary}><span className={styles.statusDot} /><div><strong>{jobStatusLabel(job.status, "long", locale)}</strong><small>{Math.round(Number(job.progress) || 0)}% · {job.stage || "—"}</small></div><a href={`/app/jobs/${encodeURIComponent(job.id)}`}>查看工作</a></div>}
        </section>
        <section id="long-validation-summary" className={styles.summaryCard}>
          <span className={styles.eyebrow}>檢查結果</span>
          <ul className={styles.validation}>{visibleIssues.length ? visibleIssues.map((issue) => <li key={`${issue.field}:${issue.message}`} className={styles.invalid}><button type="button" className={styles.validationLink} onClick={() => focusLongValidationField(issue.field)}>× {issue.message}</button></li>) : <li className={styles.valid}>✓ 基本欄位可提交；若尚未規劃會先自動規劃。</li>}</ul>
          <div className={styles.providerSummary}><span className={`${styles.statusDot} ${providerReady ? styles.online : ""}`} />{providerReady ? "規劃工具已就緒" : "規劃工具無法使用"}</div>
          {error && <p className={styles.errorBox} role="alert">{error}</p>}{notice && <p className={styles.notice} role="status">{notice}</p>}
          <button type="button" className={styles.primaryButton} disabled={!canInteract} onClick={() => void startLongVideo()} aria-describedby="long-validation-summary">{activeJob ? "生成中…" : saving ? "處理中…" : !plan || planDirty ? "規劃並開始生成" : "開始長影片生成"}<span>→</span></button>
          <div className={styles.secondaryActions}><button type="button" disabled={!canSave} onClick={() => void saveDraft()}>{saving ? "保存中…" : "保存草稿"}</button><button type="button" disabled={activeJob || saving || planning} onClick={clearEditor}>清除設定</button></div>
        </section>
      </aside>

      <div className={styles.mobileCta}><button type="button" className={styles.primaryButton} disabled={!canInteract} onClick={() => void startLongVideo()} aria-describedby="long-validation-summary">{!plan || planDirty ? "規劃並開始生成" : "開始長影片生成"}<span>→</span></button></div>
    </div>
  );
}

function LongSection({ id, code, title, children }: { id: string; code: string; title: string; children: ReactNode }) {
  return <section id={id} className={styles.section}><div className={styles.sectionHeader}><div><span className={styles.eyebrow}>{code}</span><h2>{title}</h2></div></div><div className={styles.stack}>{children}</div></section>;
}

function focusLongValidationField(field: string) {
  const ids: Record<string, string> = {
    outputFolder: "long-output-folder",
    referenceAssets: "long-reference-assets",
    inputText: "long-brief",
    duration: "long-duration",
    segmentDurationHint: "long-segment-duration",
    timelineText: "long-timeline",
    width: "long-width",
    height: "long-height",
    steps: "long-steps",
    seed: "long-seed",
    h3LoraPreset: "long-character-lora",
    characterLoraName: "long-character-lora",
    characterLoraStrength: "long-character-lora-strength",
  };
  const element = document.getElementById(ids[field] || "");
  if (element instanceof HTMLElement) {
    element.focus();
    element.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function Field({ label, helper, error, children }: { label: string; helper?: string; error?: string; children: ReactNode }) {
  const childProps = isValidElement(children) ? children.props as Record<string, unknown> : {};
  const childId = typeof childProps.id === "string" && childProps.id
    ? childProps.id
    : `long-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  const errorId = `${childId}-error`;
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
      id: childProps.id || childId,
      "aria-invalid": error ? true : childProps["aria-invalid"],
      "aria-describedby": error
        ? [childProps["aria-describedby"], errorId].filter(Boolean).join(" ")
        : childProps["aria-describedby"],
    })
    : children;
  return <label className={`${styles.field} ${error ? styles.fieldInvalid : ""}`}><span className={styles.label}>{fieldLabel(label)}</span>{control}{helper && <span className={styles.helper}>{helper}</span>}<InlineError id={errorId} message={error} /></label>;
}

function fieldLabel(label: string) {
  return ({
    Prompt: FIELD_LABELS.prompt,
    "Negative Prompt": FIELD_LABELS.negativePrompt,
    Seed: FIELD_LABELS.seed,
    Steps: FIELD_LABELS.steps,
    Reasoning: FIELD_LABELS.reasoning,
    "H3 Prompt": "H3 提示詞",
    "Model profile": FIELD_LABELS.modelProfile,
  } as Record<string, string>)[label] || label;
}

function InlineError({ id, message }: { id?: string; message?: string }) { return message ? <span id={id} className={styles.inlineError} role="alert">{message}</span> : null; }
function Summary({ label, value }: { label: string; value: string }) { return <div className={styles.summaryRow}><span>{label}</span><strong title={value}>{value}</strong></div>; }

function UploadButton({ busy, multiple, onFiles }: { busy: boolean; multiple: boolean; onFiles: (files: File[]) => Promise<void> }) {
  return <label className={styles.uploadButton}><span>{busy ? "上傳中…" : "上傳圖片"}</span><input className={styles.fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple={multiple} disabled={busy} onChange={(event) => { const files = Array.from(event.target.files || []); if (files.length) void onFiles(files); event.target.value = ""; }} /></label>;
}

function AssetThumb({ asset }: { asset: Asset }) {
  return (
    <span className={styles.thumb}>
      {/* eslint-disable-next-line @next/next/no-img-element -- Bridge asset URLs are dynamic and served without Next image metadata. */}
      <img src={`${BRIDGE_URL}${asset.url}`} alt="" />
    </span>
  );
}
function assetKey(asset: Pick<Asset, "root" | "name">) { return `${asset.root}:${asset.name}`; }
function uniqueAssets(values: Asset[], limit: number) { const map = new Map<string, Asset>(); for (const asset of values) if (asset?.name) map.set(assetKey(asset), asset); return [...map.values()].slice(0, limit); }
function numberDraft(value: string): NumberDraft { return value === "" ? "" : Number(value); }
function apiError(payload: ApiError, fallback: string) { return typeof payload.error === "string" ? payload.error : [payload.error?.code, payload.error?.message].filter(Boolean).join(": ") || fallback; }

async function assetToPromptImage(asset: Asset) {
  const response = await fetch(`${BRIDGE_URL}${asset.url}`);
  if (!response.ok) throw new Error("無法讀取參考素材。");
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = new Image(); image.src = objectUrl;
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("無法解碼參考圖片。")); });
    const canvas = document.createElement("canvas"); const scale = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.86); return dataUrl.slice(dataUrl.indexOf(",") + 1);
  } finally { URL.revokeObjectURL(objectUrl); }
}
