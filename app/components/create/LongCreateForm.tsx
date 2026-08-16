"use client";

import { cloneElement, isValidElement, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  buildLongPlanRequest,
  buildLongSaveRequest,
  H3_REALISM_PEOPLE_PRESET,
  H3_REALISM_PEOPLE_DEFAULT_STRENGTH,
  longJobIsActive,
  resizeLongSegment,
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
import { FIELD_LABELS, jobStatusLabel } from "../../lib/ui-copy.mjs";
import { createDefaultRef2VCameraPlan } from "../../lib/ref2v-camera-plan.mjs";
import {
  clampResolutionScale,
  normalizeImageResolution,
  normalizeResolutionDimension,
  readImageDimensions,
  resolutionScaleForDimensions,
  scaleImageResolution,
} from "../../lib/single-image-resolution.mjs";
import { useI18n } from "../../i18n/I18nProvider";
import { Ref2VCameraPlanner, type CameraPlan } from "./Ref2VCameraPlanner";
import styles from "./LongCreateForm.module.css";

const BRIDGE_URL = "/app";
const MAX_LONG_REFERENCE_IMAGES = 8;

type NumberDraft = number | "";
type PromptProvider = "ollama" | "codex";
type InputType = "text" | "image";
type ReferenceMode = "continuity" | "multi_reference";
type ContinuationMode = "legacy_tail" | "motion_context";
type TimelineMode = "auto" | "manual";
type ResolutionStatus = "default" | "loading" | "auto" | "adjusted" | "manual" | "error";
type ResolutionInfo = {
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
  grid: number;
  scalePercent: number;
  scaled: boolean;
  adjusted: boolean;
};
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
  cameraPlan?: CameraPlan;
};
type LongPlan = {
  title?: string;
  inputType: InputType;
  inputText?: string;
  inputAsset?: Asset;
  referenceMode?: ReferenceMode;
  referenceAssets?: Asset[];
  continuationMode?: ContinuationMode;
  motionContextSeconds?: number;
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
  const router = useRouter();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [title, setTitle] = useState("");
  const [outputFolder, setOutputFolder] = useState("");
  const [inputType, setInputType] = useState<InputType>("text");
  const [referenceMode, setReferenceMode] = useState<ReferenceMode>("continuity");
  const [continuationMode, setContinuationMode] = useState<ContinuationMode>("motion_context");
  const [motionContextSeconds, setMotionContextSeconds] = useState<NumberDraft>(1.5);
  const [references, setReferences] = useState<Asset[]>([]);
  const [brief, setBrief] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [timelineMode, setTimelineMode] = useState<TimelineMode>("auto");
  const [duration, setDuration] = useState<NumberDraft>(10);
  const [segmentDurationHint, setSegmentDurationHint] = useState<NumberDraft>(5);
  const [segmentDurationDrafts, setSegmentDurationDrafts] = useState<Record<string, string>>({});
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
  const [resolutionStatus, setResolutionStatus] = useState<ResolutionStatus>("default");
  const [resolutionInfo, setResolutionInfo] = useState<ResolutionInfo | null>(null);
  const [resolutionScale, setResolutionScale] = useState(100);
  const [aspectLocked, setAspectLocked] = useState(true);
  const [resolutionFlipped, setResolutionFlipped] = useState(false);
  const [resolutionError, setResolutionError] = useState("");
  const resolutionRequestRef = useRef(0);
  const hydratedResolutionRef = useRef<{ width: number; height: number } | null>(null);
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
  const resolutionAsset = inputType === "image" ? references[0] || null : null;
  const resolutionAssetKey = resolutionAsset ? assetKey(resolutionAsset) : "";
  const resolutionAssetUrl = resolutionAsset ? `${BRIDGE_URL}${resolutionAsset.url}` : "";
  const resolutionAssetName = resolutionAsset?.name || "";

  useEffect(() => {
    const requestId = resolutionRequestRef.current + 1;
    resolutionRequestRef.current = requestId;
    if (!resolutionAssetName) return;

    queueMicrotask(() => {
      if (resolutionRequestRef.current !== requestId) return;
      setResolutionScale(100);
      setAspectLocked(true);
      setResolutionFlipped(false);
      setResolutionInfo(null);
      setResolutionError("");
      setResolutionStatus("loading");
    });

    void readImageDimensions(resolutionAssetUrl)
      .then((dimensions) => {
        if (resolutionRequestRef.current !== requestId) return;
        const normalized = normalizeImageResolution(dimensions.width, dimensions.height, "i2v") as ResolutionInfo;
        const hydrated = hydratedResolutionRef.current;
        hydratedResolutionRef.current = null;
        if (hydrated) {
          const scalePercent = resolutionScaleForDimensions(dimensions.width, dimensions.height, hydrated.width, hydrated.height);
          setWidth(hydrated.width);
          setHeight(hydrated.height);
          setResolutionScale(scalePercent);
          setResolutionInfo({ ...normalized, ...hydrated, scalePercent, adjusted: true });
          setResolutionStatus("manual");
          return;
        }
        setWidth(normalized.width);
        setHeight(normalized.height);
        setResolutionInfo(normalized);
        setResolutionStatus(normalized.adjusted ? "adjusted" : "auto");
      })
      .catch((readError: unknown) => {
        if (resolutionRequestRef.current !== requestId) return;
        hydratedResolutionRef.current = null;
        setResolutionInfo(null);
        setResolutionStatus("error");
        setResolutionError(`無法讀取 ${resolutionAssetName} 的尺寸。${readError instanceof Error ? readError.message : "無法讀取圖片尺寸。"} 請手動輸入輸出尺寸。`);
      });

    return () => {
      if (resolutionRequestRef.current === requestId) resolutionRequestRef.current += 1;
    };
  }, [resolutionAssetKey, resolutionAssetName, resolutionAssetUrl]);
  const baseIssues = useMemo(() => validateLongCreate({
    inputText: brief,
    inputType,
    referenceAssets: references,
    continuationMode,
    motionContextSeconds,
    modelProfile,
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
  }) as ValidationIssue[], [brief, characterLoraId, characterLoraName, characterLoraStrength, continuationMode, duration, h3LoraSelection, height, inputType, modelProfile, motionContextSeconds, references, seed, segmentDurationHint, steps, timeline, timelineMode, width]);
  const submitIssues = useMemo(() => validateLongCreate({
    inputText: brief,
    inputType,
    referenceAssets: references,
    continuationMode,
    motionContextSeconds,
    modelProfile,
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
  }) as ValidationIssue[], [brief, characterLoraId, characterLoraName, characterLoraStrength, continuationMode, duration, h3LoraSelection, height, inputType, modelProfile, motionContextSeconds, references, seed, segmentDurationHint, steps, timeline, timelineMode, width, outputFolder, plan, planDirty]);
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
    const hydrateAsset = (candidate?: Asset) => {
      if (!candidate) return null;
      return byKey.get(assetKey(candidate)) || assetReference(candidate);
    };
    const nextRefs = uniqueAssets([
      hydrateAsset(next.inputAsset),
      ...(next.referenceAssets || []).map(hydrateAsset),
    ].filter((asset): asset is Asset => Boolean(asset)), MAX_LONG_REFERENCE_IMAGES);
    hydratedResolutionRef.current = next.inputType === "image" && next.width && next.height
      ? { width: next.width, height: next.height }
      : null;
    setJob(next);
    setPlan(next);
    setSegmentDurationDrafts({});
    setTitle(next.title || "");
    setInputType(next.inputType || "text");
    setBrief(next.inputText || "");
    setReferenceMode(next.referenceMode === "multi_reference" ? "multi_reference" : "continuity");
    setContinuationMode(next.continuationMode === "motion_context" ? "motion_context" : "legacy_tail");
    setMotionContextSeconds(next.motionContextSeconds || 1.5);
    setReferences(nextRefs);
    setOutputFolder(next.outputFolder || "");
    setDuration(next.duration || 10);
    setTimeline((next.segments || []).map((segment) => `[${segment.start.toFixed(3)} - ${segment.end.toFixed(3)}] ${segment.description}`).join("\n"));
    setTimelineMode(["ollama", "codex"].includes(next.planMeta?.timelineSource || "") ? "auto" : "manual");
    setSegmentDurationHint(next.planningSettings?.segmentDurationHint || next.planMeta?.segmentDurationHint || 5);
    if (next.width) setWidth(next.width);
    if (next.height) setHeight(next.height);
    if (next.inputType !== "image" && next.width && next.height) setResolutionStatus("manual");
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

  async function hydrateRetryJob(jobId: string, assetList: Asset[]) {
    try {
      const response = await fetch(`${BRIDGE_URL}/api/sequences/${encodeURIComponent(jobId)}`);
      if (!response.ok) return false;
      const payload = (await response.json()) as { job?: LongJob };
      if (!payload.job) return false;
      hydrateFromJob(payload.job, assetList);
      setJob(null);
      setNotice("已帶入原工作設定；確認或修改後再開始生成。");
      return true;
    } catch {
      return false;
    }
  }

  async function initialize() {
    const [nextAssets, nextHealth] = await Promise.all([refreshAssets(), refreshHealth()]);
    setHealth(nextHealth);
    const retryJobId = new URLSearchParams(window.location.search).get("retry");
    if (retryJobId && await hydrateRetryJob(retryJobId, nextAssets)) return;
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
          continuationMode,
          motionContextSeconds: Number(motionContextSeconds),
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
        continuationMode,
        motionContextSeconds: Number(motionContextSeconds),
        segments: (payload.plan.segments || []).map((segment, index) => ({
          ...segment,
          cameraPlan: plan?.segments?.[index]?.cameraPlan || createDefaultRef2VCameraPlan({
            referenceCount: cameraReferenceCount(index, inputType, referenceMode, references.length, continuationMode),
            hasVideo: continuationMode === "motion_context" && index > 0,
          }),
        })),
        ...(h3LoraEnabled
          ? { h3LoraEnabled: true, h3LoraPreset: H3_REALISM_PEOPLE_PRESET, characterLoraName: H3_REALISM_PEOPLE_PRESET, characterLoraStrength: characterLoraStrength === "" ? H3_REALISM_PEOPLE_DEFAULT_STRENGTH : Number(characterLoraStrength) }
          : !characterLoraName.trim() && !characterLoraId
            ? { h3LoraEnabled: false, h3LoraPreset: null, characterLoraName: null, characterLoraId: null, characterLoraStrength: null }
            : { characterLoraName: characterLoraName.trim(), ...(characterLoraId ? { characterLoraId } : {}), characterLoraStrength: characterLoraStrength === "" ? 0.75 : Number(characterLoraStrength) }),
      } as LongPlan;
      setPlan(nextPlan);
      setSegmentDurationDrafts({});
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
      continuationMode,
      motionContextSeconds,
      modelProfile,
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
          continuationMode,
          motionContextSeconds: Number(motionContextSeconds),
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
    setSegmentDurationDrafts({});
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

  function timelineTextForSegments(segments: LongSegment[]) {
    return segments.map((segment) => `[${segment.start.toFixed(3)} - ${segment.end.toFixed(3)}] ${segment.description}`).join("\n");
  }

  function applySegmentTimeline(segments: LongSegment[]) {
    const totalDuration = segments.length ? segments[segments.length - 1].end : 0;
    setPlan((current) => current ? { ...current, duration: totalDuration, segments } : current);
    setTimeline(timelineTextForSegments(segments));
    setDuration(totalDuration);
    setPlanDirty(true);
  }

  function updateSegment(index: number, patch: Partial<LongSegment>) {
    if (!plan) return;
    applySegmentTimeline(plan.segments.map((segment, itemIndex) => itemIndex === index ? { ...segment, ...patch } : segment));
  }

  function updateSegmentDuration(index: number, rawValue: string) {
    const segment = plan?.segments[index];
    if (!segment) return;
    const key = segment.id || String(index);
    setSegmentDurationDrafts((current) => ({ ...current, [key]: rawValue }));
    const nextDuration = Number(rawValue);
    if (!Number.isFinite(nextDuration) || nextDuration < 0.5 || nextDuration > 60) return;
    applySegmentTimeline(resizeLongSegment(plan.segments, index, nextDuration));
  }

  function commitSegmentDuration(index: number) {
    const segment = plan?.segments[index];
    if (!segment) return;
    const key = segment.id || String(index);
    setSegmentDurationDrafts((current) => ({
      ...current,
      [key]: String((segment.end - segment.start).toFixed(3)),
    }));
  }

  function randomizeSeed() {
    const values = new Uint32Array(1);
    globalThis.crypto?.getRandomValues?.(values);
    setSeed(values[0] ? values[0] % 2147483648 : Math.floor(Math.random() * 2147483648));
  }

  function updateInputType(value: InputType) {
    if (value === inputType) return;
    resetResolutionToDefault();
    setInputType(value);
    markPlanDirty();
  }

  function removeReference(asset: Asset) {
    setReferences((current) => current.filter((item) => assetKey(item) !== assetKey(asset)));
    if (references.length === 1) resetResolutionToDefault();
    markPlanDirty();
  }

  function swapResolution() {
    markManualResolution();
    setWidth(height);
    setHeight(width);
    setResolutionFlipped((current) => !current);
    if (typeof width === "number" && typeof height === "number") {
      setResolutionInfo((current) => current ? { ...current, width: height, height: width, adjusted: true } : current);
    }
  }

  function resetResolutionToDefault() {
    resolutionRequestRef.current += 1;
    hydratedResolutionRef.current = null;
    setWidth(736);
    setHeight(416);
    setResolutionInfo(null);
    setResolutionScale(100);
    setAspectLocked(true);
    setResolutionFlipped(false);
    setResolutionError("");
    setResolutionStatus("default");
  }

  function markManualResolution() {
    resolutionRequestRef.current += 1;
    setResolutionStatus("manual");
    setResolutionError("");
  }

  function applyResolutionScale(nextScale: number) {
    if (!resolutionInfo) return;
    const normalizedScale = clampResolutionScale(nextScale);
    const sourceWidth = resolutionFlipped ? resolutionInfo.originalHeight : resolutionInfo.originalWidth;
    const sourceHeight = resolutionFlipped ? resolutionInfo.originalWidth : resolutionInfo.originalHeight;
    const scaled = scaleImageResolution(sourceWidth, sourceHeight, "i2v", normalizedScale) as ResolutionInfo;
    setResolutionScale(normalizedScale);
    setWidth(scaled.width);
    setHeight(scaled.height);
    setResolutionInfo((current) => current ? {
      ...current,
      width: scaled.width,
      height: scaled.height,
      grid: scaled.grid,
      scalePercent: normalizedScale,
      scaled: scaled.scaled,
      adjusted: scaled.adjusted || resolutionFlipped,
    } : current);
    setResolutionStatus(scaled.adjusted || resolutionFlipped ? "adjusted" : "auto");
  }

  function updateResolutionDimension(axis: "width" | "height", nextValue: NumberDraft) {
    markManualResolution();
    if (nextValue === "" || !Number.isFinite(nextValue)) {
      if (axis === "width") setWidth(nextValue);
      else setHeight(nextValue);
      return;
    }
    const nextNumber = nextValue as number;
    const sourceWidth = resolutionInfo ? (resolutionFlipped ? resolutionInfo.originalHeight : resolutionInfo.originalWidth) : 0;
    const sourceHeight = resolutionInfo ? (resolutionFlipped ? resolutionInfo.originalWidth : resolutionInfo.originalHeight) : 0;
    if (!aspectLocked || !resolutionInfo || !sourceWidth || !sourceHeight) {
      if (axis === "width") setWidth(nextNumber);
      else setHeight(nextNumber);
      return;
    }
    const otherValue = axis === "width"
      ? normalizeResolutionDimension(nextNumber * sourceHeight / sourceWidth, "i2v")
      : normalizeResolutionDimension(nextNumber * sourceWidth / sourceHeight, "i2v");
    const nextWidth = axis === "width" ? nextNumber : otherValue;
    const nextHeight = axis === "height" ? nextNumber : otherValue;
    setWidth(nextWidth);
    setHeight(nextHeight);
    const scalePercent = resolutionScaleForDimensions(sourceWidth, sourceHeight, nextWidth, nextHeight);
    setResolutionScale(scalePercent);
    setResolutionInfo((current) => current ? { ...current, width: nextWidth, height: nextHeight, scalePercent, adjusted: true } : current);
  }

  function clearEditor() {
    if (activeJob || saving || planning) return;
    setTitle(""); setOutputFolder(""); setInputType("text"); setReferenceMode("continuity"); setContinuationMode("motion_context"); setMotionContextSeconds(1.5); setReferences([]);
    setBrief(""); setNegativePrompt(""); setTimelineMode("auto"); setDuration(10); setSegmentDurationHint(5); setTimeline("");
    setModelProfile("nvfp4_blackwell"); resetResolutionToDefault(); setSteps(20); setSeed(12345); setSeam("keep_duplicate_frame");
    setH3LoraEnabled(false); setCharacterLoraName(""); setCharacterLoraId(""); setCharacterLoraStrength(H3_REALISM_PEOPLE_DEFAULT_STRENGTH);
    setPlan(null); setSegmentDurationDrafts({}); setPlanDirty(false); setJob(null); setError(""); setNotice("已清除目前長影片編輯狀態；已保存工作未刪除。" );
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
            <button type="button" className={inputType === "text" ? styles.active : ""} aria-pressed={inputType === "text"} onClick={() => updateInputType("text")}>文字起點</button>
            <button type="button" className={inputType === "image" ? styles.active : ""} aria-pressed={inputType === "image"} onClick={() => updateInputType("image")}>從圖片開始</button>
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
              {references.length > 0 && <div className={styles.referenceGrid}>{references.map((asset, index) => <div className={styles.referenceCard} key={assetKey(asset)}><AssetThumb asset={asset} /><span>{index + 1}</span><strong title={asset.name}>{asset.name}</strong><button type="button" onClick={() => removeReference(asset)} aria-label={`移除 ${asset.name}`}>×</button></div>)}</div>}
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
          <div className={styles.flowPanel}>
            <div className={styles.flowHeader}>
              <div><span className={styles.eyebrow}>CONTINUATION FLOW</span><strong>Ref2VA 動態延續</strong></div>
              <span className={styles.flowBadge}>{continuationMode === "motion_context" ? "推薦" : "相容模式"}</span>
            </div>
            <div className={styles.twoColumns}>
              <Field label="延續方式">
                <select className={styles.select} value={continuationMode} onChange={(event) => { setContinuationMode(event.target.value as ContinuationMode); markPlanDirty(); }}>
                  <option value="motion_context">尾幀＋短 AV 脈絡 → Ref2VA</option>
                  <option value="legacy_tail">舊版：只用尾幀 → I2VA</option>
                </select>
              </Field>
              <Field label="尾端 AV 長度">
                <select id="long-motion-context-seconds" className={styles.select} value={motionContextSeconds} disabled={continuationMode !== "motion_context"} onChange={(event) => { setMotionContextSeconds(Number(event.target.value)); markPlanDirty(); }}>
                  <option value={1}>1.0 秒（H3 對齊約 0.92 秒）</option><option value={1.5}>1.5 秒（H3 對齊約 1.63 秒）</option><option value={2}>2.0 秒（H3 對齊約 1.63 秒）</option>
                </select>
              </Field>
            </div>
            <ol className={styles.flowSteps}>
              <li>每段輸出先標準化，再依 H3 幀格擷取約 1–2 秒的尾端影片／音訊與尾幀。</li>
              <li>下一段固定保留角色參考圖，尾幀排在最後一張 Picture。</li>
              <li>短片與原音軌以 Video 1／Audio 1 傳給 Ref2VA，只繼承動作、節奏、環境聲與音色，不重播前段。</li>
            </ol>
          </div>
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
            <p className={styles.helper}>規劃完成後，可在下方每個分鏡卡片中獨立設定長度；後續分鏡會自動順延，時間軸保持連續。</p>
          </div>
          {timelineMode === "manual" && <Field label="手動時間軸" helper="例如：[0 - 5] Opening；[5 - 10] Ending" error={attempted ? issuesByField.get("timelineText") : ""}><textarea id="long-timeline" className={styles.textarea} value={timeline} onChange={(event) => { setTimeline(event.target.value); markPlanDirty(); }} /></Field>}
          <button type="button" className={styles.planButton} disabled={!canPlan} onClick={() => void requestPlan().catch((planError) => setError(planError instanceof Error ? planError.message : "規劃失敗。"))}>{planning ? "規劃中…" : `用 ${promptProvider === "codex" ? "Codex CLI" : "Ollama"} 產生分鏡與 H3 提示詞`}</button>
          {planDirty && plan && <p className={styles.stale} role="status">規劃輸入已變更；保存或開始前會重新規劃。</p>}
        </LongSection>

        <LongSection id="long-segments" code="03 / 片段檢查" title={`片段檢查 · ${plan?.segments.length || 0} 段`}>
          {!plan && <div className={styles.empty}>尚無分段提示詞。先完成 Planner，再在此逐段檢查與編輯。</div>}
          {plan?.segments.map((segment, index) => <article className={styles.segmentCard} key={segment.id || index}>
            <div className={styles.segmentHeading}><div><span>片段 {index + 1}</span><strong>{segment.start.toFixed(2)}–{segment.end.toFixed(2)} 秒</strong></div><span className={styles.modeBadge}>{(segment.mode || (continuationMode === "motion_context" && index > 0 || referenceMode === "multi_reference" ? "ref2v" : index === 0 && inputType === "text" ? "t2v" : "i2v")).toUpperCase()}</span></div>
            <Field label="分鏡長度（秒）"><input className={styles.input} type="number" min={0.5} max={60} step={0.5} value={segmentDurationDrafts[segment.id || String(index)] ?? (segment.end - segment.start).toFixed(3)} onChange={(event) => updateSegmentDuration(index, event.target.value)} onBlur={() => commitSegmentDuration(index)} /></Field>
            <div className={styles.twoColumns}><Field label="分鏡描述"><textarea className={styles.compactTextarea} value={segment.description} onChange={(event) => updateSegment(index, { description: event.target.value })} /></Field><Field label="段尾狀態"><textarea className={styles.compactTextarea} value={segment.endingState || ""} onChange={(event) => updateSegment(index, { endingState: event.target.value })} /></Field></div>
            <Field label="H3 提示詞"><textarea className={styles.textarea} value={segment.prompt || ""} onChange={(event) => updateSegment(index, { prompt: event.target.value, promptSource: "manual" })} /></Field>
            <Field label="此段負面提示詞" helper="空白則使用全片設定。"><textarea className={styles.compactTextarea} value={segment.negativePrompt || ""} onChange={(event) => updateSegment(index, { negativePrompt: event.target.value })} /></Field>
            <Ref2VCameraPlanner
              locale={locale}
              duration={segment.end - segment.start}
              referenceCount={cameraReferenceCount(index, inputType, referenceMode, references.length, continuationMode)}
              hasVideo={continuationMode === "motion_context" && index > 0}
              value={segment.cameraPlan || createDefaultRef2VCameraPlan({
                referenceCount: cameraReferenceCount(index, inputType, referenceMode, references.length, continuationMode),
                hasVideo: continuationMode === "motion_context" && index > 0,
              }) as CameraPlan}
              onChange={(cameraPlan) => updateSegment(index, { cameraPlan })}
            />
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
            {(h3LoraEnabled || characterLoraName.trim() || characterLoraId.trim()) && <Field label="LoRA strength" error={attempted ? issuesByField.get("characterLoraStrength") : ""}>
              <input id="long-character-lora-strength" className={styles.input} type="number" min={0} max={2} step={0.05} value={characterLoraStrength} onChange={(event) => { setCharacterLoraStrength(numberDraft(event.target.value)); markPlanDirty(); }} />
            </Field>}
          </div>
          <p className={styles.helper}>固定 H3 preset 支援 T2V/I2V/Ref2VA；舊版自訂 LoRA 仍限 T2V/I2V。strength 範圍 0–2，固定預設 0.8。</p>
          <div className={styles.twoColumns}><Field label="模型設定檔" error={attempted ? issuesByField.get("modelProfile") : ""}><select id="long-model-profile" className={styles.select} value={modelProfile} onChange={(event) => setModelProfile(event.target.value)}>{RENDER_MODELS.map((model) => <option key={model.value} value={model.value} disabled={continuationMode === "motion_context" && model.value === "int4_convrot_low_vram"}>{model.label}</option>)}</select></Field><Field label="接縫處理"><select className={styles.select} value={seam} onChange={(event) => setSeam(event.target.value as typeof seam)}><option value="keep_duplicate_frame">保留重複畫面</option><option value="drop_next_first_frame" disabled>移除下一段首幀（目前不支援）</option></select></Field></div>
          <div className={styles.resolutionField}>
            <span className={styles.label}>影片尺寸</span>
            <div className={styles.resolutionRow}>
              <label className={`${styles.field} ${attempted && issuesByField.get("width") ? styles.fieldInvalid : ""}`}>
                <span className={styles.helper}>寬</span>
                <input id="long-width" className={styles.input} type="number" min={32} max={2048} step={32} inputMode="numeric" value={width} aria-label="影片寬度" onChange={(event) => updateResolutionDimension("width", numberDraft(event.target.value))} />
                <InlineError id="long-width-error" message={attempted ? issuesByField.get("width") : ""} />
              </label>
              <button type="button" className={styles.iconButton} onClick={swapResolution} aria-label="交換影片寬度與高度" title="交換寬高">↔</button>
              <label className={`${styles.field} ${attempted && issuesByField.get("height") ? styles.fieldInvalid : ""}`}>
                <span className={styles.helper}>高</span>
                <input id="long-height" className={styles.input} type="number" min={32} max={2048} step={32} inputMode="numeric" value={height} aria-label="影片高度" onChange={(event) => updateResolutionDimension("height", numberDraft(event.target.value))} />
                <InlineError id="long-height-error" message={attempted ? issuesByField.get("height") : ""} />
              </label>
            </div>
            {resolutionInfo && <div className={styles.resolutionControls}>
              <div className={styles.resolutionMeta}><span>原始圖片 {resolutionInfo.originalWidth} × {resolutionInfo.originalHeight}</span><span>輸出尺寸 {width || "—"} × {height || "—"}</span></div>
              <label className={styles.field}>
                <span className={styles.rangeHeader}><span className={styles.label}>縮放比例</span><span className={styles.rangeValue}>{resolutionScale}%</span></span>
                <input id="long-resolution-scale" className={styles.range} type="range" min={10} max={100} step={1} value={resolutionScale} aria-label="來源圖片縮放比例" onInput={(event) => applyResolutionScale(Number(event.currentTarget.value))} />
                <span className={styles.scaleTicks} aria-hidden="true"><span>10%</span><span>50%</span><span>100%</span></span>
              </label>
              <label className={styles.lockToggle}><input type="checkbox" checked={aspectLocked} onChange={(event) => setAspectLocked(event.target.checked)} /><span>鎖定來源比例</span></label>
            </div>}
            <span id="long-resolution-status" className={styles.helper} role="status" aria-live="polite" data-resolution-status={resolutionStatus}>{longResolutionStatusText(resolutionStatus, resolutionInfo)}</span>
            <InlineError id="long-resolution-error" message={resolutionError} />
            <span className={styles.helper}>32 的倍數，範圍 32–2048 px。</span>
          </div>
          <div className={styles.twoColumns}><Field label="Steps" error={attempted ? issuesByField.get("steps") : ""}><input id="long-steps" className={styles.input} type="number" min={1} max={80} value={steps} onChange={(event) => setSteps(numberDraft(event.target.value))} /></Field><Field label="Seed" error={attempted ? issuesByField.get("seed") : ""}><div className={styles.seedRow}><input id="long-seed" className={styles.input} type="number" min={0} max={2147483647} value={seed} onChange={(event) => setSeed(numberDraft(event.target.value))} /><button type="button" onClick={randomizeSeed} aria-label="隨機種子">↻</button></div></Field></div>
        </LongSection>
      </div>

      <aside id="long-review" className={styles.summary} aria-label="長影片生成摘要">
        <section className={styles.summaryCard}>
          <span className={styles.eyebrow}>生成摘要</span><h2>長影片</h2>
          <div className={styles.summaryRows}><Summary label="來源素材" value={inputType === "text" ? "文字" : `${references.length} 張圖片`} /><Summary label="延續" value={continuationMode === "motion_context" ? `Ref2VA / ${motionContextSeconds}s AV` : "I2VA 尾幀"} /><Summary label="時間軸" value={timelineMode === "auto" ? `${duration || "—"} 秒 / 自動` : "手動"} /><Summary label="分段" value={`${plan?.segments.length || 0} 段`} /><Summary label="尺寸" value={`${width || "—"} × ${height || "—"}`} /><Summary label="提示詞提供者" value={promptProvider === "codex" ? effectiveCodexModel : effectiveOllamaModel} /></div>
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
    motionContextSeconds: "long-motion-context-seconds",
    modelProfile: "long-model-profile",
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
function assetReference(asset: Asset): Asset {
  if (asset.url) return asset;
  return {
    ...asset,
    url: `/media?root=${encodeURIComponent(asset.root)}&name=${encodeURIComponent(asset.name)}`,
  };
}
function assetKey(asset: Pick<Asset, "root" | "name">) { return `${asset.root}:${asset.name}`; }
function uniqueAssets(values: Asset[], limit: number) { const map = new Map<string, Asset>(); for (const asset of values) if (asset?.name) map.set(assetKey(asset), asset); return [...map.values()].slice(0, limit); }
function cameraReferenceCount(index: number, inputType: InputType, referenceMode: ReferenceMode, referenceCount: number, continuationMode: ContinuationMode) {
  const staticCount = inputType === "image" ? (referenceMode === "multi_reference" ? referenceCount : Math.min(1, referenceCount)) : 0;
  if (referenceMode === "multi_reference") return Math.min(9, staticCount + (index > 0 ? 1 : 0));
  if (index === 0) return inputType === "image" ? 1 : 0;
  return continuationMode === "motion_context" ? Math.min(9, staticCount + 1) : 1;
}
function numberDraft(value: string): NumberDraft { return value === "" ? "" : Number(value); }
function longResolutionStatusText(status: ResolutionStatus, info: ResolutionInfo | null) {
  if (status === "loading") return "正在讀取來源圖片尺寸…";
  if (status === "error") return "無法取得圖片尺寸；請手動輸入輸出尺寸。";
  if (status === "manual") return "手動輸出解析度；目前顯示的尺寸會送出。";
  if (status === "adjusted" && info) return `來源 ${info.originalWidth} × ${info.originalHeight}；縮放 ${info.scalePercent}%；輸出 ${info.width} × ${info.height}，符合 ${info.grid}px 模型網格。`;
  if (status === "auto" && info) return `來源 ${info.originalWidth} × ${info.originalHeight}；縮放 ${info.scalePercent}%；輸出 ${info.width} × ${info.height}。`;
  return "預設輸出解析度；選擇圖片後會計算最終尺寸。";
}
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
