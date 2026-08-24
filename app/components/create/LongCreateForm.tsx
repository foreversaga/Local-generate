"use client";

import { cloneElement, isValidElement, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  buildLongDirectPlan,
  buildLongSaveRequest,
  composeLongScriptText,
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
import {
  clampResolutionScale,
  normalizeImageResolution,
  normalizeResolutionDimension,
  readImageDimensions,
  resolutionScaleForDimensions,
  scaleImageResolution,
} from "../../lib/single-image-resolution.mjs";
import { useI18n } from "../../i18n/I18nProvider";
import { createLongScript, LongScriptComposer, type LongScriptDraft } from "./LongScriptComposer";
import styles from "./LongCreateForm.module.css";

const BRIDGE_URL = "/app";
const MAX_LONG_REFERENCE_IMAGES = 8;

type NumberDraft = number | "";
type PromptProvider = "ollama" | "codex";
type InputType = "text" | "image";
type ReferenceMode = "continuity" | "multi_reference";
type ContinuationMode = "legacy_tail" | "motion_context" | "latent_context";
type MultishotContinuityMode = "first_frame" | "context_pin";
type MultishotPromptMode = "manual_shots" | "auto_extend";
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
};
type LongPlan = {
  title?: string;
  inputType: InputType;
  inputText?: string;
  scripts?: LongScriptDraft[];
  inputAsset?: Asset;
  referenceMode?: ReferenceMode;
  referenceAssets?: Asset[];
  continuationMode?: ContinuationMode;
  motionContextSeconds?: number;
  longVideoEnabled?: boolean;
  targetDurationSeconds?: number;
  framesPerShot?: 243 | 362;
  continuityMode?: MultishotContinuityMode;
  promptMode?: MultishotPromptMode;
  identityAnchor?: boolean;
  voiceContinuity?: boolean;
  contextFrames?: 5 | 22 | 39 | 56;
  chainGainControl?: "off" | "flatten";
  masterNormalize?: "off" | "luma" | "luma+contrast";
  effectiveContinuityMode?: MultishotContinuityMode;
  continuityWarning?: string | null;
  duration?: number;
  promptProvider?: PromptProvider;
  ollamaModel?: string;
  sglangModel?: string;
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
type MultishotHealth = { continuity?: { contextPin?: { available?: boolean; missingNodes?: string[]; missingInputs?: string[]; error?: string } } };
type ApiError = { error?: string | { code?: string; message?: string } };
type ValidationIssue = { field: string; message: string };

const RENDER_MODELS = [
  { value: "nvfp4_blackwell", label: "快速 NVFP4", description: "約 12.5 GB DiT；速度與記憶體優先，適合預覽與一般生成。" },
  { value: "int8_convrot_quality", label: "高畫質 INT8 ConvRot", description: "約 21.0 GB DiT；動態與物體形狀通常較穩，但使用更多 UMA、生成稍慢。" },
] as const;

const MULTISHOT_FRAMES_HELP: Record<243 | 362, string> = {
  243: "每個 window 生成 243 幀（24 FPS 下約 10.125 秒）；段數較多，但每段較短。",
  362: "每個 window 生成 362 幀（24 FPS 下約 15.083 秒）；接縫較少，但每段生成時間較長。",
};

const MULTISHOT_CONTINUITY_HELP: Record<MultishotContinuityMode, string> = {
  first_frame: "將上一個 window 的最後一幀作為下一段的 H3 原生 frame-0 guide；畫面接續穩定，但不會傳遞原始音訊 latent。",
  context_pin: "將上一個 window 尾端的原始影音 latent 傳給下一段，較能延續動作、運鏡與聲音；需要本機 Motion Context nodes。",
};

const MULTISHOT_PROMPT_HELP: Record<MultishotPromptMode, string> = {
  auto_extend: "依時間標記（例如 00:10–00:20）把完整故事分配到對應 window；每段只生成自己的內容，再加入人物、場景與動作延續約束。沒有時間標記時會依段落順序分配。",
  manual_shots: "每個 generation window 使用一張獨立劇本卡；劇本數量必須與系統計算的 windows 數量相同。",
};

const CONTEXT_FRAMES_HELP: Record<5 | 22 | 39 | 56, string> = {
  5: "保留約 0.21 秒的原始影音 latent；約束最弱、下一段自由度最高。",
  22: "保留約 0.92 秒的原始影音 latent；連續性與下一段自由度較平衡。",
  39: "保留約 1.63 秒的原始影音 latent；動作與聲音延續較強。",
  56: "保留約 2.33 秒的原始影音 latent；延續最強，但處理量較高且下一段較受前段約束。",
};

const CHAIN_GAIN_HELP: Record<"off" | "flatten", string> = {
  off: "不加入紋理增益限制；後續 windows 完全依各段提示詞生成。",
  flatten: "要求後續 windows 對齊第一段的紋理強度、銳利度與微對比，抑制細節逐段累積；這不是音量控制。",
};

const MASTER_NORMALIZE_HELP: Record<"off" | "luma" | "luma+contrast", string> = {
  off: "直接合併片段、不重新編碼；速度最快並保留原始畫質。",
  luma: "成片組裝時平滑跨片段亮度差異；會重新編碼影片，音訊保持不變。",
  "luma+contrast": "成片組裝時更強地平衡亮度、對比與冷暖色偏；會重新編碼影片。",
};

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
  const [longVideoEnabled, setLongVideoEnabled] = useState(false);
  const [targetDurationSeconds, setTargetDurationSeconds] = useState<NumberDraft>(30);
  const [framesPerShot, setFramesPerShot] = useState<243 | 362>(243);
  const [continuityMode, setContinuityMode] = useState<MultishotContinuityMode>("first_frame");
  const [promptMode, setPromptMode] = useState<MultishotPromptMode>("auto_extend");
  const [autoExtendPrompt, setAutoExtendPrompt] = useState("");
  const [identityAnchor, setIdentityAnchor] = useState(true);
  const [voiceContinuity, setVoiceContinuity] = useState(true);
  const [contextFrames, setContextFrames] = useState<5 | 22 | 39 | 56>(22);
  const [chainGainControl, setChainGainControl] = useState<"off" | "flatten">("off");
  const [masterNormalize, setMasterNormalize] = useState<"off" | "luma" | "luma+contrast">("off");
  const [multishotHealth, setMultishotHealth] = useState<MultishotHealth | null>(null);
  const [motionContextSeconds, setMotionContextSeconds] = useState<NumberDraft>(2);
  const [references, setReferences] = useState<Asset[]>([]);
  const [scripts, setScripts] = useState<LongScriptDraft[]>([createLongScript(0), createLongScript(1)]);
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
  const [segmentPromptBusy, setSegmentPromptBusy] = useState<number | null>(null);
  const [segmentScriptBusy, setSegmentScriptBusy] = useState<number | null>(null);
  const [segmentScriptNames, setSegmentScriptNames] = useState<Record<string, string>>({});
  const [segmentActionStatus, setSegmentActionStatus] = useState<Record<string, { kind: "success" | "error"; message: string }>>({});

  const visibleOllamaModels = health?.ollama?.models || [];
  // `false` is an explicit clear marker for the fixed preset.  Keep it
  // undefined when hydrating an older arbitrary LoRA so re-saving that job
  // remains backward compatible.
  const h3LoraSelection: boolean | undefined = h3LoraEnabled
    ? true
    : characterLoraName.trim() || characterLoraId.trim()
      ? undefined
      : false;
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
  const combinedScriptText = useMemo(() => composeLongScriptText(scripts), [scripts]);
  const totalScriptDuration = useMemo(() => scripts.reduce((total, script) => total + (Number(script.duration) || 0), 0), [scripts]);
  const continuationLabel = continuationMode === "latent_context"
    ? "Latent 連續生成"
    : continuationMode === "motion_context"
      ? "Ref2VA 參考延續"
      : "尾幀延續";
  const continuityContextLabel = continuationMode === "latent_context"
    ? "前段尾端 39 幀原生影音 latent"
    : continuationMode === "motion_context"
      ? "上一分鏡最後 2 秒影片"
      : "上一分鏡尾幀";
  const h3FrameHandlingLabel = continuationMode === "latent_context"
    ? "自動對齊 H3 原生幀網格"
    : continuationMode === "motion_context"
      ? "每個故事分鏡獨立生成"
      : "尾幀作為下一段起點";
  const multishotCount = useMemo(() => Math.max(1, Math.ceil(Number(targetDurationSeconds || 0) / (framesPerShot / 24))), [framesPerShot, targetDurationSeconds]);
  const baseIssues = useMemo(() => validateLongCreate({
    scripts,
    inputText: autoExtendPrompt,
    inputType,
    referenceAssets: references,
    continuationMode,
    longVideoEnabled,
    targetDurationSeconds,
    framesPerShot,
    continuityMode,
    promptMode,
    identityAnchor,
    voiceContinuity,
    contextFrames,
    chainGainControl,
    masterNormalize,
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
  }) as ValidationIssue[], [autoExtendPrompt, chainGainControl, characterLoraId, characterLoraName, characterLoraStrength, contextFrames, continuityMode, continuationMode, duration, framesPerShot, h3LoraSelection, height, identityAnchor, inputType, longVideoEnabled, masterNormalize, modelProfile, motionContextSeconds, promptMode, references, scripts, seed, segmentDurationHint, steps, targetDurationSeconds, timeline, timelineMode, voiceContinuity, width]);
  const submitIssues = useMemo(() => validateLongCreate({
    scripts,
    inputText: autoExtendPrompt,
    inputType,
    referenceAssets: references,
    continuationMode,
    longVideoEnabled,
    targetDurationSeconds,
    framesPerShot,
    continuityMode,
    promptMode,
    identityAnchor,
    voiceContinuity,
    contextFrames,
    chainGainControl,
    masterNormalize,
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
  }) as ValidationIssue[], [autoExtendPrompt, chainGainControl, characterLoraId, characterLoraName, characterLoraStrength, contextFrames, continuityMode, continuationMode, duration, framesPerShot, h3LoraSelection, height, identityAnchor, inputType, longVideoEnabled, masterNormalize, modelProfile, motionContextSeconds, outputFolder, plan, planDirty, promptMode, references, scripts, seed, segmentDurationHint, steps, targetDurationSeconds, timeline, timelineMode, voiceContinuity, width]);
  const issuesByField = useMemo(() => new Map(submitIssues.map((issue) => [issue.field, issue.message])), [submitIssues]);
  const activeJob = Boolean(job && longJobIsActive(job.status));
  const canPlan = baseIssues.length === 0 && !planning && !saving && !uploading;
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
      const [response, multishotResponse] = await Promise.all([
        fetch(`${BRIDGE_URL}/api/health`),
        fetch(`${BRIDGE_URL}/api/sequences/health`),
      ]);
      if (multishotResponse.ok) setMultishotHealth((await multishotResponse.json()) as MultishotHealth);
      if (!response.ok) return null;
      const next = (await response.json()) as Health;
      return next;
    } catch {
      return null;
    }
  }

  function hydrateFromJob(next: LongJob, assetList: Asset[]) {
    if (next.longVideoEnabled !== true && (!Array.isArray(next.scripts) || next.scripts.length < 2 || next.planMeta?.source !== "author" || next.planMeta?.promptSource !== "manual")) return;
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
    if (Array.isArray(next.scripts) && next.scripts.length) setScripts(next.scripts);
    setReferenceMode(next.referenceMode === "multi_reference" ? "multi_reference" : "continuity");
    setContinuationMode(next.continuationMode === "latent_context" && next.inputType === "image" ? "latent_context" : next.continuationMode === "legacy_tail" ? "legacy_tail" : "motion_context");
    setLongVideoEnabled(next.longVideoEnabled === true);
    setTargetDurationSeconds(next.targetDurationSeconds ?? next.duration ?? 30);
    setFramesPerShot(next.framesPerShot === 362 ? 362 : 243);
    setContinuityMode(next.continuityMode === "context_pin" ? "context_pin" : "first_frame");
    setPromptMode(next.promptMode === "manual_shots" ? "manual_shots" : "auto_extend");
    setAutoExtendPrompt(next.promptMode === "auto_extend" ? next.inputText || "" : "");
    setIdentityAnchor(next.identityAnchor !== false);
    setVoiceContinuity(next.voiceContinuity !== false);
    setContextFrames([5, 22, 39, 56].includes(Number(next.contextFrames)) ? Number(next.contextFrames) as 5 | 22 | 39 | 56 : 22);
    setChainGainControl(next.chainGainControl === "flatten" ? "flatten" : "off");
    setMasterNormalize(next.masterNormalize === "luma" || next.masterNormalize === "luma+contrast" ? next.masterNormalize : "off");
    setMotionContextSeconds(next.motionContextSeconds || 2);
    setReferences(nextRefs);
    setOutputFolder(next.outputFolder || "");
    setDuration(next.duration || 10);
    setTimeline((next.segments || []).map((segment) => `[${segment.start.toFixed(3)} - ${segment.end.toFixed(3)}] ${segment.description}`).join("\n"));
    setTimelineMode(["ollama", "sglang", "codex"].includes(next.planMeta?.timelineSource || "") ? "auto" : "manual");
    setSegmentDurationHint(next.planningSettings?.segmentDurationHint || next.planMeta?.segmentDurationHint || 5);
    if (next.width) setWidth(next.width);
    if (next.height) setHeight(next.height);
    if (next.inputType !== "image" && next.width && next.height) setResolutionStatus("manual");
    if (next.steps) setSteps(next.steps);
    if (next.seed !== undefined) setSeed(next.seed);
    const nextModelProfile = typeof next.modelProfile === "string"
      && RENDER_MODELS.some((model) => model.value === next.modelProfile)
      ? next.modelProfile
      : "nvfp4_blackwell";
    setModelProfile(nextModelProfile);
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
    setSeam("keep_duplicate_frame");
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
    setPlanning(true);
    try {
      const directPlan = buildLongDirectPlan({
        title, inputType, inputText: autoExtendPrompt, scripts, referenceMode, referenceAssets: references, negativePrompt,
        longVideoEnabled, targetDurationSeconds: Number(targetDurationSeconds), framesPerShot, continuityMode, promptMode,
        identityAnchor, voiceContinuity, contextFrames, chainGainControl, masterNormalize,
      }) as LongPlan;
      const nextPlan = {
        ...directPlan,
        continuationMode: longVideoEnabled ? continuityMode : continuationMode,
        motionContextSeconds: Number(motionContextSeconds),
        segments: directPlan.segments,
        ...(h3LoraEnabled
          ? { h3LoraEnabled: true, h3LoraPreset: H3_REALISM_PEOPLE_PRESET, characterLoraName: H3_REALISM_PEOPLE_PRESET, characterLoraStrength: characterLoraStrength === "" ? H3_REALISM_PEOPLE_DEFAULT_STRENGTH : Number(characterLoraStrength) }
          : !characterLoraName.trim() && !characterLoraId
            ? { h3LoraEnabled: false, h3LoraPreset: null, characterLoraName: null, characterLoraId: null, characterLoraStrength: null }
            : { characterLoraName: characterLoraName.trim(), ...(characterLoraId ? { characterLoraId } : {}), characterLoraStrength: characterLoraStrength === "" ? 0.75 : Number(characterLoraStrength) }),
      } as LongPlan;
      setPlan(nextPlan);
      setSegmentDurationDrafts({});
      setSegmentActionStatus({});
      setSegmentScriptNames({});
      setPlanDirty(false);
      setTimeline((nextPlan.segments || []).map((segment) => `[${segment.start.toFixed(3)} - ${segment.end.toFixed(3)}] ${segment.description}`).join("\n"));
      if (nextPlan.duration) setDuration(nextPlan.duration);
      setNotice(longVideoEnabled
        ? `已建立 ${nextPlan.segments.length} 個 H3 generation windows（${framesPerShot} frames @ 24 FPS）。`
        : `已直接套用 ${nextPlan.segments.length} 個劇本提示詞，未經 AI 改寫。`);
      return nextPlan;
    } finally {
      setPlanning(false);
    }
  }

  async function savePlan(planOverride?: LongPlan): Promise<LongJob> {
    const selectedPlan = planOverride || plan;
    if (!selectedPlan) throw new Error("請先產生分鏡與 H3 提示詞。");
    const issues = validateLongCreate({
      scripts,
      inputText: autoExtendPrompt,
      inputType,
      referenceAssets: references,
      continuationMode,
      longVideoEnabled,
      targetDurationSeconds,
      framesPerShot,
      continuityMode,
      promptMode,
      identityAnchor,
      voiceContinuity,
      contextFrames,
      chainGainControl,
      masterNormalize,
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
        inputText: longVideoEnabled && promptMode === "auto_extend" ? autoExtendPrompt : combinedScriptText,
        scripts,
          referenceMode,
          referenceAssets: references,
          continuationMode: longVideoEnabled ? continuityMode : continuationMode,
          motionContextSeconds: Number(motionContextSeconds),
        longVideoEnabled,
        targetDurationSeconds: Number(targetDurationSeconds),
        framesPerShot,
        continuityMode,
        promptMode,
        identityAnchor,
        voiceContinuity,
        contextFrames,
        chainGainControl,
        masterNormalize,
        timelineText: timeline,
        outputFolder,
        modelProfile,
        width: Number(width),
        height: Number(height),
        steps: Number(steps),
        seed: Number(seed),
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

  function segmentKey(segment: LongSegment, index: number) {
    return segment.id || String(index);
  }

  function setSegmentStatus(segment: LongSegment, index: number, kind: "success" | "error", message: string) {
    const key = segmentKey(segment, index);
    setSegmentActionStatus((current) => ({ ...current, [key]: { kind, message } }));
  }

  async function generateContinuationPrompt(index: number) {
    const previous = plan?.segments[index - 1];
    const segment = plan?.segments[index];
    if (!previous || !segment || index < 1) return;
    if (!health?.ollama?.online) {
      setSegmentStatus(segment, index, "error", "Ollama 尚未連線。");
      return;
    }
    const effectiveModel = visibleOllamaModels.includes(ollamaModel) ? ollamaModel : visibleOllamaModels[0];
    if (!effectiveModel) {
      setSegmentStatus(segment, index, "error", "找不到可用的 Ollama 模型。");
      return;
    }
    setSegmentPromptBusy(index);
    setSegmentStatus(segment, index, "success", "正在使用前一分鏡與本段描述整理提示詞…");
    try {
      const response = await fetch(`${BRIDGE_URL}/api/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          purpose: "long_video_segment_continuation",
          provider: "ollama",
          model: effectiveModel,
          mode: "ref2v",
          segmentIndex: index,
          duration: Number(segment.duration || segment.end - segment.start),
          previousPrompt: previous.prompt || previous.description,
          description: segment.description,
          negativePrompt: segment.negativePrompt || negativePrompt,
          staticReferenceCount: inputType === "image" ? references.length : 0,
          continuationMode,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as ApiError & { prompt?: string; negativePrompt?: string };
      if (!response.ok || !payload.prompt || !payload.negativePrompt) throw new Error(apiError(payload, "Ollama 無法產生此分鏡提示詞。"));
      updateSegment(index, { prompt: payload.prompt, negativePrompt: payload.negativePrompt, promptSource: "ollama" });
      setSegmentStatus(segment, index, "success", "已回填 Ollama 產生的提示詞與負面提示詞。");
    } catch (promptError) {
      setSegmentStatus(segment, index, "error", promptError instanceof Error ? promptError.message : "Ollama 無法產生此分鏡提示詞。");
    } finally {
      setSegmentPromptBusy(null);
    }
  }

  async function saveSegmentAsScript(index: number) {
    const segment = plan?.segments[index];
    if (!segment?.prompt?.trim()) return;
    const key = segmentKey(segment, index);
    const fallbackName = scripts[index]?.name || `分鏡 ${index + 1}`;
    const name = String(segmentScriptNames[key] ?? fallbackName).trim();
    if (!name) {
      setSegmentStatus(segment, index, "error", "請先輸入劇本名稱。");
      return;
    }
    setSegmentScriptBusy(index);
    try {
      const response = await fetch(`${BRIDGE_URL}/api/scripts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, prompt: segment.prompt, negativePrompt: segment.negativePrompt || "" }),
      });
      const payload = (await response.json().catch(() => ({}))) as ApiError & { script?: { id?: string; name?: string } };
      if (!response.ok || !payload.script) throw new Error(apiError(payload, "無法儲存此分鏡劇本。"));
      setSegmentStatus(segment, index, "success", `已將「${payload.script.name || name}」儲存至一般劇本庫。`);
    } catch (scriptError) {
      setSegmentStatus(segment, index, "error", scriptError instanceof Error ? scriptError.message : "無法儲存此分鏡劇本。");
    } finally {
      setSegmentScriptBusy(null);
    }
  }

  function updateInputType(value: InputType) {
    if (value === inputType) return;
    resetResolutionToDefault();
    setInputType(value);
    if (value === "text" && continuationMode === "latent_context") setContinuationMode("motion_context");
    markPlanDirty();
  }

  function updateContinuationMode(value: ContinuationMode) {
    setContinuationMode(value);
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
    setTitle(""); setOutputFolder(""); setInputType("text"); setReferenceMode("continuity"); setContinuationMode("motion_context"); setMotionContextSeconds(2); setReferences([]);
    setLongVideoEnabled(false); setTargetDurationSeconds(30); setFramesPerShot(243); setContinuityMode("first_frame"); setPromptMode("auto_extend"); setAutoExtendPrompt(""); setIdentityAnchor(true); setVoiceContinuity(true); setContextFrames(22); setChainGainControl("off"); setMasterNormalize("off");
    setScripts([createLongScript(0), createLongScript(1)]); setNegativePrompt(""); setTimelineMode("manual"); setDuration(10); setSegmentDurationHint(5); setTimeline("");
    setModelProfile("nvfp4_blackwell"); resetResolutionToDefault(); setSteps(20); setSeed(12345); setSeam("keep_duplicate_frame");
    setH3LoraEnabled(false); setCharacterLoraName(""); setCharacterLoraId(""); setCharacterLoraStrength(H3_REALISM_PEOPLE_DEFAULT_STRENGTH);
    setPlan(null); setSegmentDurationDrafts({}); setSegmentActionStatus({}); setSegmentScriptNames({}); setPlanDirty(false); setJob(null); setError(""); setNotice("已清除目前長影片編輯狀態；已保存工作未刪除。" );
  }

  const visibleIssues = attempted ? submitIssues : [];

  return (
    <div className={styles.layout}>
      <nav className={styles.sectionNav} aria-label="長影片建立區段">
        <a href="#long-story">故事</a><a href="#long-planner">規劃</a><a href="#long-segments">分鏡</a><a href="#long-review">檢查</a>
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
              <p className={styles.helper}>{referenceMode === "continuity" ? "Picture 1 只鎖定第一個分鏡的第 0.00 秒，後續分鏡沿用為一致性參考。" : `最多 ${MAX_LONG_REFERENCE_IMAGES} 張；所有分鏡都會沿用這些固定參考。`}</p>
              <InlineError message={attempted ? issuesByField.get("referenceAssets") : ""} />
            </div>
          )}
          <div className={styles.multishotPanel}>
            <div className={styles.multishotHeader}>
              <div><strong>Long Video / Multishot Mode</strong><span>將同一個 take 拆成 H3 原生 generation windows。</span></div>
              <div className={styles.segmented} role="group" aria-label="Long Video Multishot Mode">
                <button type="button" className={!longVideoEnabled ? styles.active : ""} aria-pressed={!longVideoEnabled} disabled={!canInteract} onClick={() => { setLongVideoEnabled(false); markPlanDirty(); }}>OFF</button>
                <button type="button" className={longVideoEnabled ? styles.active : ""} aria-pressed={longVideoEnabled} disabled={!canInteract} onClick={() => { setLongVideoEnabled(true); markPlanDirty(); }}>ON</button>
              </div>
            </div>
            {longVideoEnabled && <div className={styles.stack}>
              <div className={styles.twoColumns}>
                <Field label="Target Duration" error={attempted ? issuesByField.get("targetDurationSeconds") : ""}><input id="long-target-duration" className={styles.input} type="number" min={1} max={600} step={1} value={targetDurationSeconds} disabled={!canInteract} onChange={(event) => { setTargetDurationSeconds(numberDraft(event.target.value)); markPlanDirty(); }} /></Field>
                <Field label="Frames Per Shot" error={attempted ? issuesByField.get("framesPerShot") : ""} helper={MULTISHOT_FRAMES_HELP[framesPerShot]}><select id="long-frames-per-shot" className={styles.select} value={framesPerShot} disabled={!canInteract} onChange={(event) => { setFramesPerShot(Number(event.target.value) as 243 | 362); markPlanDirty(); }}><option value={243}>243 frames · 10.125s</option><option value={362}>362 frames · 15.083s</option></select></Field>
              </div>
              <div className={styles.twoColumns}>
                <Field label="Continuity" error={attempted ? issuesByField.get("continuityMode") : ""} helper={`${MULTISHOT_CONTINUITY_HELP[continuityMode]}${continuityMode === "context_pin" && !multishotHealth?.continuity?.contextPin?.available ? " 目前本機不可用，提交時會自動退回 first_frame。" : ""}`}><select id="long-multishot-continuity" className={styles.select} value={continuityMode} disabled={!canInteract} onChange={(event) => { setContinuityMode(event.target.value as MultishotContinuityMode); markPlanDirty(); }}><option value="first_frame">first_frame · H3 native</option><option value="context_pin">context_pin · raw latent</option></select></Field>
                <Field label="Prompt Mode" error={attempted ? issuesByField.get("promptMode") : ""} helper={MULTISHOT_PROMPT_HELP[promptMode]}><select id="long-prompt-mode" className={styles.select} value={promptMode} disabled={!canInteract} onChange={(event) => { setPromptMode(event.target.value as MultishotPromptMode); markPlanDirty(); }}><option value="auto_extend">auto_extend</option><option value="manual_shots">manual_shots</option></select></Field>
              </div>
              <p className={styles.helper}>將建立 {multishotCount} 個 generation windows；不會嘗試單次 sampling 生成整支長片。{continuityMode === "context_pin" && !multishotHealth?.continuity?.contextPin?.available ? " 本機 Motion Context nodes 不可用，提交後會明確記錄並自動 fallback 到 first_frame。" : ""}</p>
              {promptMode === "auto_extend" && <Field label="完整場景描述" error={attempted ? issuesByField.get("inputText") : ""} helper="每段會加入同人物、服裝、環境、攝影機、光線、動作與對話延續約束。"><textarea id="long-auto-extend-prompt" className={styles.textarea} value={autoExtendPrompt} disabled={!canInteract} onChange={(event) => { setAutoExtendPrompt(event.target.value); markPlanDirty(); }} placeholder="描述一個連續 take；除非明確要求，系統不會加入 cut 或 new scene。" /></Field>}
              <div className={styles.toggleGrid}>
                <label><input type="checkbox" checked={identityAnchor} disabled={!canInteract} onChange={(event) => { setIdentityAnchor(event.target.checked); markPlanDirty(); }} /><span>Identity Anchor</span></label>
                <label><input type="checkbox" checked={voiceContinuity} disabled={!canInteract} onChange={(event) => { setVoiceContinuity(event.target.checked); markPlanDirty(); }} /><span>Voice Continuity</span></label>
              </div>
              <p className={styles.helper}>Identity Anchor 會讓每個 Ref2VA window 重用原始 reference；上一段尾端只負責 motion continuity。Voice Continuity 在 context_pin 可沿用 raw audio latent，first_frame 僅保留提示詞層級的聲線約束。</p>
              <details className={styles.advancedPanel}>
                <summary>Advanced</summary>
                <div className={styles.advancedBody}>
                  <div className={styles.twoColumns}><Field label="Context Frames" helper={continuityMode === "context_pin" ? CONTEXT_FRAMES_HELP[contextFrames] : "只在 context_pin 模式生效；目前使用 first_frame，因此此項不套用。"}><select className={styles.select} value={contextFrames} disabled={!canInteract || continuityMode !== "context_pin"} onChange={(event) => { setContextFrames(Number(event.target.value) as 5 | 22 | 39 | 56); markPlanDirty(); }}>{[5, 22, 39, 56].map((value) => <option key={value} value={value}>{value}</option>)}</select></Field><Field label="Chain Gain Control" helper={CHAIN_GAIN_HELP[chainGainControl]}><select className={styles.select} value={chainGainControl} disabled={!canInteract} onChange={(event) => { setChainGainControl(event.target.value as "off" | "flatten"); markPlanDirty(); }}><option value="off">off</option><option value="flatten">flatten</option></select></Field></div>
                  <Field label="Master Normalize" helper={MASTER_NORMALIZE_HELP[masterNormalize]}><select className={styles.select} value={masterNormalize} disabled={!canInteract} onChange={(event) => { setMasterNormalize(event.target.value as "off" | "luma" | "luma+contrast"); markPlanDirty(); }}><option value="off">off</option><option value="luma">luma</option><option value="luma+contrast">luma+contrast</option></select></Field>
                </div>
              </details>
            </div>}
          </div>
          {!longVideoEnabled && <Field label="連續生成模式" error={attempted ? issuesByField.get("continuationMode") : ""}>
            <select id="long-continuation-mode" className={styles.select} value={continuationMode} onChange={(event) => updateContinuationMode(event.target.value as ContinuationMode)}>
              <option value="latent_context" disabled={inputType !== "image"}>Latent 連續生成（推薦，需圖片起點）</option>
              <option value="motion_context">參考延續（Ref2VA）</option>
              <option value="legacy_tail">尾幀延續（相容舊版）</option>
            </select>
            <span className={styles.helper}>{continuationMode === "latent_context" ? "前段尾端 39 幀原生影音 latent 直接帶入下一段，保留動作、構圖與聲音連續性；輸出時同步移除重複前綴。" : continuationMode === "motion_context" ? "將前段最後 2 秒影片作為下一分鏡的 Ref2VA 弱視覺參考；各分鏡仍是獨立生成，這不是 Motion Context / context pin。" : "以前一分鏡尾幀作為下一段起點；只為舊工作與 I2VA 流程保留。"}</span>
          </Field>}
          {(!longVideoEnabled || promptMode === "manual_shots") && <LongScriptComposer value={scripts} minimumShots={longVideoEnabled ? 1 : 2} disabled={!canInteract} error={attempted ? issuesByField.get("scripts") : ""} onChange={(next) => { setScripts(next); markPlanDirty(); }} />}
          <Field label="負面提示詞／限制" helper="空白時 planner 可自行補齊。">
            <textarea className={`${styles.textarea} ${styles.compactTextarea}`} value={negativePrompt} onChange={(event) => setNegativePrompt(event.target.value)} placeholder="角色漂移、服裝改變、閃爍、文字、浮水印…" />
          </Field>
        </LongSection>

        <LongSection id="long-planner" code="02 / 套用與時間軸" title="套用與時間軸">
          <div className={styles.flowPanel}>
            <div className={styles.flowHeader}>
              <div><span className={styles.eyebrow}>STORYBOARD / H3 GENERATION</span><strong>分鏡定義故事，生成器負責 H3 幀處理</strong></div>
              <span className={styles.flowBadge}>自動</span>
            </div>
            <ol className={styles.flowSteps}>
              <li>{longVideoEnabled ? "每個 window 使用 H3 原生生成長度，系統自動建立所需段數。" : "每張劇本卡只定義故事分鏡、描述與故事長度；它不是 H3 底層 sampling window。"}</li>
              <li>{longVideoEnabled ? continuityMode === "context_pin" ? `上一個 window 的最後 ${contextFrames} 幀 raw AV latent 會傳給下一段；node 不可用時自動 fallback first_frame。` : "上一個 window 的最後一幀會透過 H3 原生 frame-0 guide 接到下一段。" : continuationMode === "latent_context" ? "上一分鏡最後 39 幀的原生影音 latent 會成為下一段受保護的開頭，讓動作、構圖與聲音沿同一時間線延續。" : continuationMode === "motion_context" ? "上一分鏡最後 2 秒會自動作為下一分鏡的弱視覺參考，只維持角色、場景、光線與狀態一致。" : "上一分鏡尾幀會作為下一分鏡首幀參考。"}</li>
              <li>{longVideoEnabled ? "每段先在 base resolution 保存 continuity state，再同步裁掉重複畫面與音訊、組裝 master；upscale 不會回餵 H3。" : continuationMode === "latent_context" ? "輸出前同步裁掉重複的 39 幀畫面與音訊，再依分鏡順序合併；每段 latent 會保存供失敗重試。" : "各段不共享原生影音 latent；最後依分鏡順序合併。"}</li>
            </ol>
          </div>
          <p className={styles.helper}>{longVideoEnabled ? `時間軸由目標長度自動建立，目前 ${Number(targetDurationSeconds || 0).toFixed(1)} 秒、${multishotCount} 個 windows。` : `時間軸由上方劇本卡的影片長度自動累加，目前共 ${totalScriptDuration.toFixed(1)} 秒、${scripts.length} 支影片。`}</p>
          <button type="button" className={styles.planButton} disabled={!canPlan} onClick={() => void requestPlan().catch((planError) => setError(planError instanceof Error ? planError.message : "套用失敗。"))}>{planning ? "套用中…" : "直接套用劇本提示詞"}</button>
          {planDirty && plan && <p className={styles.stale} role="status">劇本已變更；保存或開始前會重新直接套用。</p>}
        </LongSection>

        <LongSection id="long-segments" code="03 / 分鏡檢查" title={`分鏡檢查 · ${plan?.segments.length || 0} 段`}>
          {!plan && <div className={styles.empty}>尚未套用劇本。套用後可在此確認每個故事分鏡使用的原始提示詞。</div>}
          {plan?.segments.map((segment, index) => <article className={styles.segmentCard} key={segment.id || index}>
            <div className={styles.segmentHeading}><div><span>故事分鏡 {index + 1}</span><strong>{segment.start.toFixed(2)}–{segment.end.toFixed(2)} 秒</strong></div><span className={styles.modeBadge}>{(segment.mode || (longVideoEnabled ? referenceMode === "multi_reference" || continuityMode === "context_pin" && index > 0 ? "ref2v" : index === 0 && inputType === "text" ? "t2v" : "i2v" : (continuationMode === "motion_context" || continuationMode === "latent_context") && index > 0 || referenceMode === "multi_reference" ? "ref2v" : index === 0 && inputType === "text" ? "t2v" : "i2v")).toUpperCase()}</span></div>
            <Field label="故事分鏡長度（秒）" helper={longVideoEnabled ? "由 Multishot 的 frames per shot 自動決定。" : continuationMode === "latent_context" ? "這是故事時間；實際生成幀會在執行時自動對齊 H3 原生幀網格。" : "這是故事段落長度，不是底層 frame 數。"}><input className={styles.input} type="number" min={0.5} max={60} step={0.5} disabled={longVideoEnabled} value={segmentDurationDrafts[segment.id || String(index)] ?? (segment.end - segment.start).toFixed(3)} onChange={(event) => updateSegmentDuration(index, event.target.value)} onBlur={() => commitSegmentDuration(index)} /></Field>
            <div className={styles.twoColumns}><Field label="分鏡描述"><textarea className={styles.compactTextarea} value={segment.description} onChange={(event) => updateSegment(index, { description: event.target.value })} /></Field><Field label="段尾狀態"><textarea className={styles.compactTextarea} value={segment.endingState || ""} onChange={(event) => updateSegment(index, { endingState: event.target.value })} /></Field></div>
            <Field label="H3 提示詞（劇本原文）"><textarea className={styles.textarea} value={segment.prompt || ""} onChange={(event) => updateSegment(index, { prompt: event.target.value, promptSource: "manual" })} /></Field>
            <Field label="此段負面提示詞" helper="空白則使用全片設定。"><textarea className={styles.compactTextarea} value={segment.negativePrompt || ""} onChange={(event) => updateSegment(index, { negativePrompt: event.target.value })} /></Field>
            {index > 0 && <div className={styles.segmentAssistant}>
              <div className={styles.segmentAssistantHeader}><div><strong>Ollama 延續提示詞</strong><p>參考前一分鏡提示詞與本段描述，產生本段 {continuationMode === "latent_context" ? "latent 連續" : continuationMode === "motion_context" ? "Ref2VA 參考延續" : "尾幀延續"}提示詞及負面提示詞。</p></div><button type="button" disabled={segmentPromptBusy !== null || !canInteract} onClick={() => void generateContinuationPrompt(index)}>{segmentPromptBusy === index ? "產生中…" : "用 Ollama 產生"}</button></div>
              <div className={styles.segmentSaveRow}><label><span>另存劇本名稱</span><input value={segmentScriptNames[segmentKey(segment, index)] ?? scripts[index]?.name ?? `分鏡 ${index + 1}`} maxLength={80} onChange={(event) => setSegmentScriptNames((current) => ({ ...current, [segmentKey(segment, index)]: event.target.value }))} /></label><button type="button" disabled={segmentScriptBusy !== null || !segment.prompt?.trim()} onClick={() => void saveSegmentAsScript(index)}>{segmentScriptBusy === index ? "儲存中…" : "存成一般劇本"}</button></div>
              {segmentActionStatus[segmentKey(segment, index)] && <p className={segmentActionStatus[segmentKey(segment, index)].kind === "error" ? styles.segmentActionError : styles.segmentActionSuccess} role="status" aria-live="polite">{segmentActionStatus[segmentKey(segment, index)].message}</p>}
            </div>}
          </article>)}
        </LongSection>

        <AdvancedSection id="long-setup" code="04 / 進階設定" title="進階生成設定" summary="模型、尺寸、LoRA、Steps、Seed">
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
          <Field label="影片模型" error={attempted ? issuesByField.get("modelProfile") : ""} helper={RENDER_MODELS.find((model) => model.value === modelProfile)?.description || RENDER_MODELS[0].description}>
            <select id="long-model-profile" className={styles.select} value={modelProfile} onChange={(event) => { setModelProfile(event.target.value); markPlanDirty(); }}>
              {RENDER_MODELS.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}
            </select>
          </Field>
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
        </AdvancedSection>
      </div>

      <aside id="long-review" className={styles.summary} aria-label="長影片生成摘要">
        <section className={styles.summaryCard}>
          <span className={styles.eyebrow}>生成摘要</span><h2>長影片</h2>
          <div className={styles.summaryRows}><Summary label="來源素材" value={inputType === "text" ? "文字" : `${references.length} 張圖片`} /><Summary label="故事總長" value={longVideoEnabled ? `${Number(targetDurationSeconds || 0).toFixed(1)} 秒` : `${totalScriptDuration.toFixed(1)} 秒`} /><Summary label="故事分鏡" value={longVideoEnabled ? `${multishotCount} windows` : `${scripts.length} 個`} /><Summary label="連續模式" value={longVideoEnabled ? continuityMode : continuationLabel} /><Summary label="連續上下文" value={longVideoEnabled ? continuityMode === "context_pin" ? `${contextFrames} 幀 raw AV latent` : "H3 原生尾幀續接" : continuityContextLabel} /><Summary label="H3 幀處理" value={longVideoEnabled ? `${framesPerShot} frames / window` : h3FrameHandlingLabel} /><Summary label="尺寸" value={`${width || "—"} × ${height || "—"}`} /></div>
          {job && <div className={styles.jobSummary}><span className={styles.statusDot} /><div><strong>{jobStatusLabel(job.status, "long", locale)}</strong><small>{Math.round(Number(job.progress) || 0)}% · {job.stage || "—"}</small></div><a href={`/app/jobs/${encodeURIComponent(job.id)}`}>查看工作</a></div>}
        </section>
        <section id="long-validation-summary" className={styles.summaryCard}>
          <span className={styles.eyebrow}>檢查結果</span>
          <ul className={styles.validation}>{visibleIssues.length ? visibleIssues.map((issue) => <li key={`${issue.field}:${issue.message}`} className={styles.invalid}><button type="button" className={styles.validationLink} onClick={() => focusLongValidationField(issue.field)}>× {issue.message}</button></li>) : <li className={styles.valid}>✓ 劇本提示詞將直接使用，不經 AI 規劃。</li>}</ul>
          {error && <p className={styles.errorBox} role="alert">{error}</p>}{notice && <p className={styles.notice} role="status">{notice}</p>}
          <button type="button" className={styles.primaryButton} disabled={!canInteract} onClick={() => void startLongVideo()} aria-describedby="long-validation-summary">{activeJob ? "生成中…" : saving ? "處理中…" : !plan || planDirty ? "套用劇本並開始生成" : "開始長影片生成"}<span>→</span></button>
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

function AdvancedSection({ id, code, title, summary, children }: { id: string; code: string; title: string; summary: string; children: ReactNode }) {
  return (
    <details id={id} className={`${styles.section} ${styles.advancedSection}`}>
      <summary className={styles.advancedSummary}>
        <div><span className={styles.eyebrow}>{code}</span><h2>{title}</h2></div>
        <span className={styles.advancedSummaryMeta}>{summary}</span>
      </summary>
      <div className={`${styles.stack} ${styles.advancedContent}`}>{children}</div>
    </details>
  );
}

function focusLongValidationField(field: string) {
  if (field === "scripts") {
    document.getElementById("long-script-0-content")?.focus();
    document.getElementById("long-script-0-content")?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  const scriptField = field.match(/^script-(\d+)-(name|content|duration)$/);
  if (scriptField) {
    const element = document.getElementById(`long-script-${scriptField[1]}-${scriptField[2]}`);
    element?.focus();
    element?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  const advancedFields = new Set(["width", "height", "steps", "seed", "h3LoraPreset", "characterLoraName", "characterLoraStrength", "modelProfile"]);
  if (advancedFields.has(field)) {
    const advanced = document.getElementById("long-setup");
    if (advanced instanceof HTMLDetailsElement) advanced.open = true;
  }
  const ids: Record<string, string> = {
    outputFolder: "long-output-folder",
    referenceAssets: "long-reference-assets",
    continuationMode: "long-continuation-mode",
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
