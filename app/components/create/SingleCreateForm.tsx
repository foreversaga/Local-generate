"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  batchOutputName,
  batchSeed,
  buildSingleRenderRequest,
} from "../../lib/single-render-request.mjs";
import {
  clampResolutionScale,
  normalizeImageResolution,
  normalizeResolutionDimension,
  readImageDimensions,
  resolutionScaleForDimensions,
  scaleImageResolution,
} from "../../lib/single-image-resolution.mjs";
import { validateSingleRender } from "../../lib/single-render-validation.mjs";
import { FIELD_LABELS } from "../../lib/ui-copy.mjs";
import { assetKey as libraryAssetKey, uploadAssets } from "../library/asset-client";
import { AssetPickerButton } from "../library/AssetPickerButton";
import { SinglePromptAssistant } from "./SinglePromptAssistant";
import { useSingleCreateDraft, type SingleCreateDraft } from "./useSingleCreateDraft";
import styles from "./SingleCreateForm.module.css";

const BRIDGE_URL = "/app";
const H3_PROMPT_MAX_CHARS = 7000;
const MAX_REF2V_IMAGES = 9;

type Mode = "t2v" | "i2v" | "fl2v" | "l2v" | "ref2v" | "replace";
type NumberDraft = number | "";
type AssetKind = "image" | "video";
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
  kind: AssetKind;
  mime: string;
  size: number;
  modified: string;
  url: string;
};
type Job = { id: string };
type ValidationIssue = { field: string; message: string };
type UploadTarget = "referenceImage" | "referenceImages" | "lastFrameImage" | "sourceVideo";
type IconName = "spark" | "image" | "frames" | "layers" | "video" | "upload" | "close" | "shuffle" | "arrow" | "check" | "folder";
type ApiErrorPayload = {
  error?: string | { code?: string; message?: string };
  code?: string;
};
type ServiceState = { bridge: boolean; comfy: boolean };
type ModeOption = { value: Mode; label: string; note: string; icon: IconName };
type ModelOption = { value: string; label: string; note: string };

const MODE_OPTIONS: readonly ModeOption[] = [
  { value: "t2v", label: "文字生片", note: "Text → Video", icon: "spark" },
  { value: "i2v", label: "參考圖生片", note: "Image → Video", icon: "image" },
  { value: "fl2v", label: "首尾幀生片", note: "First + Last Frame", icon: "frames" },
  { value: "l2v", label: "尾幀生片", note: "Last Frame → Video", icon: "image" },
  { value: "ref2v", label: "多圖參考生片", note: "Ref2VA · 最多 9 張", icon: "layers" },
  { value: "replace", label: "影片替換", note: "Wan Animate", icon: "video" },
] as const;

const MODEL_OPTIONS: readonly ModelOption[] = [
  { value: "nvfp4_blackwell", label: "NVFP4 Blackwell", note: "推薦 · 16GB VRAM" },
  { value: "int4_convrot_low_vram", label: "INT4 ConvRot", note: "低顯存 fallback" },
  { value: "official_pruned_int8_convrot", label: "Official INT8", note: "品質比較" },
  { value: "ref2va_pruned_nvfp4", label: "Ref2VA Pruned NVFP4", note: "12.5 GB · Blackwell" },
  { value: "wan22_animate_fp8", label: "Wan2.2 Animate", note: "影片替換模式" },
] as const;

export function SingleCreateForm() {
  const router = useRouter();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetsReady, setAssetsReady] = useState(false);
  const [serviceState, setServiceState] = useState<ServiceState>({ bridge: false, comfy: false });
  const [mode, setMode] = useState<Mode>("t2v");
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [modelProfile, setModelProfile] = useState("nvfp4_blackwell");
  const [width, setWidth] = useState<NumberDraft>(736);
  const [height, setHeight] = useState<NumberDraft>(416);
  const [resolutionStatus, setResolutionStatus] = useState<ResolutionStatus>("default");
  const [resolutionInfo, setResolutionInfo] = useState<ResolutionInfo | null>(null);
  const [resolutionScale, setResolutionScale] = useState(100);
  const [aspectLocked, setAspectLocked] = useState(true);
  const [resolutionFlipped, setResolutionFlipped] = useState(false);
  const [resolutionError, setResolutionError] = useState("");
  const resolutionRequestRef = useRef(0);
  const [duration, setDuration] = useState(5);
  const [steps, setSteps] = useState<NumberDraft>(20);
  const [seed, setSeed] = useState<NumberDraft>(12345);
  const [renderCount, setRenderCount] = useState<NumberDraft>(1);
  const [outputName, setOutputName] = useState("");
  const [characterLoraName, setCharacterLoraName] = useState("");
  const [characterLoraStrength, setCharacterLoraStrength] = useState<NumberDraft>(0.75);
  const [characterLoraOptions, setCharacterLoraOptions] = useState<string[]>([]);
  const [referenceImage, setReferenceImage] = useState<Asset | null>(null);
  const [referenceImages, setReferenceImages] = useState<Asset[]>([]);
  const [lastFrameImage, setLastFrameImage] = useState<Asset | null>(null);
  const [sourceVideo, setSourceVideo] = useState<Asset | null>(null);
  const [uploadingTarget, setUploadingTarget] = useState<UploadTarget | null>(null);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [touchedFields, setTouchedFields] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  const inputAssets = useMemo(() => assets.filter((asset) => asset.root === "input"), [assets]);
  const availableModels = useMemo(() => modelOptionsForMode(mode), [mode]);
  const modeOption = MODE_OPTIONS.find((option) => option.value === mode) || MODE_OPTIONS[0];
  const selectedModel = availableModels.find((option) => option.value === modelProfile) || availableModels[0];
  const resolutionAsset = useMemo(
    () => resolutionAssetForMode(mode, referenceImage, referenceImages, lastFrameImage),
    [lastFrameImage, mode, referenceImage, referenceImages],
  );
  const resolutionAssetKey = resolutionAsset ? assetKey(resolutionAsset) : "";
  const resolutionAssetUrl = resolutionAsset ? assetUrl(resolutionAsset) : "";
  const resolutionAssetName = resolutionAsset?.name || "";

  useEffect(() => {
    const requestId = resolutionRequestRef.current + 1;
    resolutionRequestRef.current = requestId;

    if (!resolutionAssetName) {
      return () => {
        if (resolutionRequestRef.current === requestId) resolutionRequestRef.current += 1;
      };
    }

    queueMicrotask(() => {
      if (resolutionRequestRef.current !== requestId) return;
      setResolutionScale(100);
      setAspectLocked(true);
      setResolutionFlipped(false);
      setWidth("");
      setHeight("");
      setResolutionInfo(null);
      setResolutionError("");
      setResolutionStatus("loading");
    });

    void readImageDimensions(resolutionAssetUrl)
      .then((dimensions) => {
        if (resolutionRequestRef.current !== requestId) return;
        const normalized = normalizeImageResolution(dimensions.width, dimensions.height, mode) as ResolutionInfo;
        setWidth(normalized.width);
        setHeight(normalized.height);
        setResolutionInfo(normalized);
        setResolutionStatus(normalized.adjusted ? "adjusted" : "auto");
      })
      .catch((error: unknown) => {
        if (resolutionRequestRef.current !== requestId) return;
        const reason = error instanceof Error ? error.message : "無法讀取圖片尺寸。";
        setWidth("");
        setHeight("");
        setResolutionInfo(null);
        setResolutionStatus("error");
        setResolutionError(`無法讀取 ${resolutionAssetName} 的尺寸。${reason} 請選擇其他圖片或手動輸入輸出尺寸。`);
      });

    return () => {
      if (resolutionRequestRef.current === requestId) resolutionRequestRef.current += 1;
    };
  }, [mode, resolutionAssetKey, resolutionAssetName, resolutionAssetUrl]);

  const validationIssues = useMemo(() => validateSingleRender({
    mode,
    prompt,
    promptMaxChars: H3_PROMPT_MAX_CHARS,
    enforcePromptMaxChars: true,
    width,
    height,
    steps,
    seed,
    renderCount,
    characterLoraName,
    characterLoraStrength,
    referenceImage,
    referenceImages,
    lastFrameImage,
    sourceVideo,
  }) as ValidationIssue[], [
    height,
    lastFrameImage,
    mode,
    prompt,
    referenceImage,
    referenceImages,
    renderCount,
    characterLoraName,
    characterLoraStrength,
    seed,
    sourceVideo,
    steps,
    width,
  ]);
  const issuesByField = useMemo(() => new Map(validationIssues.map((issue) => [issue.field, issue.message])), [validationIssues]);
  const previewAsset = referenceImage || referenceImages[0] || lastFrameImage || sourceVideo;
  const isUploading = uploadingTarget !== null;
  const canInteract = !submitting && !isUploading;
  const draftValue = useMemo(() => ({
    mode,
    prompt,
    negativePrompt,
    modelProfile,
    width,
    height,
    duration,
    steps,
    seed,
    renderCount,
    outputName,
    characterLoraName,
    characterLoraStrength,
    referenceImageKey: referenceImage ? assetKey(referenceImage) : null,
    referenceImageKeys: referenceImages.map(assetKey),
    lastFrameImageKey: lastFrameImage ? assetKey(lastFrameImage) : null,
    sourceVideoKey: sourceVideo ? assetKey(sourceVideo) : null,
  }), [
    duration,
    height,
    lastFrameImage,
    mode,
    modelProfile,
    negativePrompt,
    outputName,
    characterLoraName,
    characterLoraStrength,
    prompt,
    referenceImage,
    referenceImages,
    renderCount,
    seed,
    sourceVideo,
    steps,
    width,
  ]);
  const { clearDraft, status: draftStatus } = useSingleCreateDraft({
    ready: assetsReady,
    value: draftValue,
    onHydrate: hydrateSingleCreateDraft,
  });

  async function refreshAssets(): Promise<boolean> {
    try {
      const response = await fetch(`${BRIDGE_URL}/api/assets?root=all`);
      if (!response.ok) return false;
      const payload = (await response.json()) as { assets?: Asset[] };
      setAssets(payload.assets || []);
      setAssetsReady(true);
      return true;
    } catch {
      setAssets([]);
      return false;
    }
  }

  async function refreshHealth() {
    try {
      const response = await fetch(`${BRIDGE_URL}/api/health`);
      if (!response.ok) throw new Error("bridge unavailable");
      const payload = (await response.json()) as { comfy?: { online?: boolean } };
      setServiceState({ bridge: true, comfy: Boolean(payload.comfy?.online) });
    } catch {
      setServiceState({ bridge: false, comfy: false });
    }
  }

  async function refreshCharacterLoras() {
    try {
      const response = await fetch(`${BRIDGE_URL}/api/loras?family=wan&profile=wan22_animate_fp8&consumer=single-replace`);
      if (!response.ok) {
        setCharacterLoraOptions([]);
        return;
      }
      const payload = (await response.json()) as { loras?: unknown };
      setCharacterLoraOptions(Array.isArray(payload.loras)
        ? payload.loras.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
        : []);
    } catch {
      // The field remains usable as a free-text relative path when discovery is unavailable.
      setCharacterLoraOptions([]);
    }
  }

  async function initializeSingleCreate() {
    const [assetsLoaded] = await Promise.all([refreshAssets(), refreshHealth(), refreshCharacterLoras()]);
    setAssetsReady(assetsLoaded);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => { void initializeSingleCreate(); }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- The bridge bootstrap intentionally runs once on mount.
  }, []);

  function hydrateSingleCreateDraft(draft: SingleCreateDraft) {
    const draftMode = MODE_OPTIONS.some((option) => option.value === draft.mode)
      ? draft.mode as Mode
      : "t2v";
    const modelOptions = modelOptionsForMode(draftMode);
    const nextModelProfile = modelOptions.some((option) => option.value === draft.modelProfile)
      ? draft.modelProfile
      : modelOptions[0]?.value || "nvfp4_blackwell";
    const assetByKey = new Map(inputAssets.map((asset) => [assetKey(asset), asset]));
    const imageByKey = (key: string | null) => {
      const asset = key ? assetByKey.get(key) : null;
      return asset?.kind === "image" ? asset : null;
    };
    const videoByKey = (key: string | null) => {
      const asset = key ? assetByKey.get(key) : null;
      return asset?.kind === "video" ? asset : null;
    };

    setMode(draftMode);
    setPrompt(draft.prompt);
    setNegativePrompt(draft.negativePrompt);
    setModelProfile(nextModelProfile);
    setWidth(draft.width);
    setHeight(draft.height);
    setDuration(draft.duration);
    setSteps(draft.steps);
    setSeed(draft.seed);
    setRenderCount(draft.renderCount);
    setOutputName(draft.outputName);
    setCharacterLoraName(draft.characterLoraName);
    setCharacterLoraStrength(draft.characterLoraStrength);
    setReferenceImage(imageByKey(draft.referenceImageKey));
    setReferenceImages(draft.referenceImageKeys
      .map((key) => imageByKey(key))
      .filter((asset): asset is Asset => Boolean(asset))
      .slice(0, MAX_REF2V_IMAGES));
    setLastFrameImage(imageByKey(draft.lastFrameImageKey));
    setSourceVideo(videoByKey(draft.sourceVideoKey));
    setSubmitAttempted(false);
    setTouchedFields(new Set());
  }

  function markTouched(field: string) {
    setTouchedFields((current) => {
      if (current.has(field)) return current;
      const next = new Set(current);
      next.add(field);
      return next;
    });
  }

  function visibleFieldError(field: string) {
    if (!submitAttempted && !touchedFields.has(field)) return "";
    return issuesByField.get(field) || "";
  }

  function updateMode(nextMode: Mode) {
    setSubmitError("");
    if (nextMode === mode) return;
    resetResolutionToDefault(nextMode);
    setMode(nextMode);
    if (nextMode === "replace") {
      setModelProfile("wan22_animate_fp8");
      setWidth(832);
      setHeight(480);
      setSteps(6);
      return;
    }
    if (nextMode === "ref2v") {
      setModelProfile("ref2va_pruned_nvfp4");
      setWidth(736);
      setHeight(416);
      setSteps(20);
      return;
    }
    if (modelProfile === "wan22_animate_fp8" || modelProfile === "ref2va_pruned_nvfp4") {
      setModelProfile("nvfp4_blackwell");
      setWidth(736);
      setHeight(416);
      setSteps(20);
    }
  }

  function randomizeSeed() {
    const values = new Uint32Array(1);
    if (globalThis.crypto?.getRandomValues) {
      globalThis.crypto.getRandomValues(values);
      setSeed(values[0] % 2147483648);
      return;
    }
    setSeed(Math.floor(Math.random() * 2147483648));
  }

  function swapResolution() {
    markManualResolution();
    setWidth(height);
    setHeight(width);
    setResolutionFlipped((current) => !current);
    if (typeof width === "number" && typeof height === "number") {
      setResolutionInfo((current) => current ? {
        ...current,
        width: height,
        height: width,
        adjusted: true,
      } : current);
    }
  }

  function resetResolutionToDefault(nextMode: Mode = mode) {
    resolutionRequestRef.current += 1;
    const fallback = defaultResolutionForMode(nextMode);
    setWidth(fallback.width);
    setHeight(fallback.height);
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

  function applyResolutionScale(value: number) {
    if (!resolutionInfo) return;
    const nextScale = clampResolutionScale(value);
    const sourceWidth = resolutionFlipped ? resolutionInfo.originalHeight : resolutionInfo.originalWidth;
    const sourceHeight = resolutionFlipped ? resolutionInfo.originalWidth : resolutionInfo.originalHeight;
    const scaled = scaleImageResolution(sourceWidth, sourceHeight, mode, nextScale);
    setResolutionScale(nextScale);
    setWidth(scaled.width);
    setHeight(scaled.height);
    setResolutionInfo((current) => current ? {
      ...current,
      width: scaled.width,
      height: scaled.height,
      grid: scaled.grid,
      scalePercent: nextScale,
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
    const sourceWidth = resolutionInfo
      ? (resolutionFlipped ? resolutionInfo.originalHeight : resolutionInfo.originalWidth)
      : 0;
    const sourceHeight = resolutionInfo
      ? (resolutionFlipped ? resolutionInfo.originalWidth : resolutionInfo.originalHeight)
      : 0;
    if (!aspectLocked || !resolutionInfo || !sourceWidth || !sourceHeight) {
      if (axis === "width") setWidth(nextNumber);
      else setHeight(nextNumber);
      return;
    }

    const otherValue = axis === "width"
      ? normalizeResolutionDimension(nextNumber * sourceHeight / sourceWidth, mode)
      : normalizeResolutionDimension(nextNumber * sourceWidth / sourceHeight, mode);
    const nextWidth = axis === "width" ? nextNumber : otherValue;
    const nextHeight = axis === "height" ? nextNumber : otherValue;
    setWidth(nextWidth);
    setHeight(nextHeight);
    setResolutionScale(resolutionScaleForDimensions(sourceWidth, sourceHeight, nextWidth, nextHeight));
    setResolutionInfo((current) => current ? {
      ...current,
      width: nextWidth,
      height: nextHeight,
      scalePercent: resolutionScaleForDimensions(sourceWidth, sourceHeight, nextWidth, nextHeight),
      adjusted: true,
    } : current);
  }

  function selectSingleAsset(target: Exclude<UploadTarget, "referenceImages">, key: string) {
    const nextAsset = assets.find((asset) => assetKey(asset) === key) || null;
    if (target === "referenceImage") setReferenceImage(nextAsset?.kind === "image" ? nextAsset : null);
    if (target === "lastFrameImage") setLastFrameImage(nextAsset?.kind === "image" ? nextAsset : null);
    if (target === "sourceVideo") setSourceVideo(nextAsset?.kind === "video" ? nextAsset : null);
    if ((target === "referenceImage" || target === "lastFrameImage") && !nextAsset) resetResolutionToDefault();
    markTouched(target);
  }

  function addReferenceImage(key: string) {
    const asset = assets.find((item) => assetKey(item) === key && item.kind === "image");
    if (!asset || referenceImages.some((item) => assetKey(item) === key)) return;
    setReferenceImages((current) => [...current, asset].slice(0, MAX_REF2V_IMAGES));
    markTouched("referenceImages");
  }

  function removeReferenceImage(asset: Asset) {
    setReferenceImages((current) => current.filter((item) => assetKey(item) !== assetKey(asset)));
    if (referenceImages.length === 1) resetResolutionToDefault();
    markTouched("referenceImages");
  }

  async function uploadFiles(files: File[], target: UploadTarget) {
    const candidates = target === "referenceImages"
      ? files.filter((file) => file.type.startsWith("image/")).slice(0, Math.max(0, MAX_REF2V_IMAGES - referenceImages.length))
      : files.slice(0, 1);
    if (!candidates.length) return;

    setUploadingTarget(target);
    setSubmitError("");
    try {
      const uploaded = (await uploadAssets(candidates)).filter((asset): asset is Asset => asset.root === "input");

      setAssets((current) => mergeAssets(current, uploaded));
      if (target === "referenceImage") setReferenceImage(uploaded[0] || null);
      if (target === "lastFrameImage") setLastFrameImage(uploaded[0] || null);
      if (target === "sourceVideo") setSourceVideo(uploaded[0] || null);
      if (target === "referenceImages") {
        setReferenceImages((current) => mergeAssets(current, uploaded).slice(0, MAX_REF2V_IMAGES));
      }
      markTouched(target);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "資源上傳失敗。");
    } finally {
      setUploadingTarget(null);
    }
  }

  async function startRender() {
    setSubmitAttempted(true);
    setSubmitError("");
    if (validationIssues.length) {
      focusValidationField(validationIssues[0].field);
      return;
    }

    const submittedWidth = Number(width);
    const submittedHeight = Number(height);
    const submittedSteps = Number(steps);
    const submittedSeed = Number(seed);
    const count = Number(renderCount);
    const batchId = count > 1
      ? `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      : "";
    const referenceImageNames = referenceImages.map((asset) => asset.name).slice(0, MAX_REF2V_IMAGES);
    const referenceImageRoots = referenceImages.map((asset) => asset.root).slice(0, MAX_REF2V_IMAGES);
    const primaryReference = mode === "ref2v" ? referenceImages[0] || referenceImage : referenceImage;

    setSubmitting(true);
    try {
      const createdJobs = await Promise.all(Array.from({ length: count }, async (_, index) => {
        const response = await fetch(`${BRIDGE_URL}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildSingleRenderRequest({
            mode,
            prompt,
            negativePrompt,
            referenceImageName: primaryReference?.kind === "image" ? primaryReference.name : "",
            referenceImageRoot: primaryReference?.kind === "image" ? primaryReference.root : undefined,
            referenceImageNames,
            referenceImageRoots,
            lastFrameName: lastFrameImage?.kind === "image" ? lastFrameImage.name : "",
            lastFrameRoot: lastFrameImage?.kind === "image" ? lastFrameImage.root : undefined,
            sourceVideoName: sourceVideo?.kind === "video" ? sourceVideo.name : "",
            sourceVideoRoot: sourceVideo?.kind === "video" ? sourceVideo.root : undefined,
            characterLoraName: mode === "replace" ? characterLoraName : "",
            characterLoraStrength: mode === "replace" ? Number(characterLoraStrength) : undefined,
            modelProfile,
            width: submittedWidth,
            height: submittedHeight,
            duration,
            steps: submittedSteps,
            seed: batchSeed(submittedSeed, index),
            outputName: batchOutputName(outputName, index, count),
            batchId,
            batchIndex: index + 1,
            batchTotal: count,
          })),
        });
        const payload = (await response.json().catch(() => ({}))) as ApiErrorPayload & { job?: Job };
        if (!response.ok || !payload.job) {
          throw new Error(apiErrorMessage(payload, "無法建立生成工作"));
        }
        return payload.job;
      }));

      const destination = createdJobs[0]?.id
        ? `/app/jobs/${encodeURIComponent(createdJobs[0].id)}`
        : "/app/jobs";
      clearDraft();
      router.push(destination);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "生成服務未連線。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.layout}>
      <nav className={styles.sectionNav} aria-label="Single Create sections">
        <a href="#single-source-section">來源</a>
        <a href="#single-prompt-section">提示詞</a>
        <a href="#single-setup-section">設定</a>
        <a href="#single-review-section">檢查</a>
      </nav>

      <div className={styles.formColumn}>
        <FormSection id="single-source-section" code="01 / SOURCE" title="來源與模式" icon="layers">
          <div className={styles.fieldStack}>
            <div>
              <div className={styles.fieldLabel}>生成模式</div>
              <p className={styles.helper}>選擇 H3 / Wan Animate 工作流；切換模式會套用既有建議 profile、尺寸與 steps。</p>
            </div>
            <div className={styles.modeGrid} role="radiogroup" aria-label="生成模式">
              {MODE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={mode === option.value}
                  className={`${styles.modeButton} ${mode === option.value ? styles.modeButtonSelected : ""}`}
                  onClick={() => updateMode(option.value)}
                >
                  <span className={styles.modeIcon}><Icon name={option.icon} /></span>
                  <span className={styles.modeCopy}>
                    <strong>{option.label}</strong>
                    <span>{option.note}</span>
                  </span>
                </button>
              ))}
            </div>
            <SourceFields
              mode={mode}
              referenceImage={referenceImage}
              referenceImages={referenceImages}
              lastFrameImage={lastFrameImage}
              sourceVideo={sourceVideo}
              uploadingTarget={uploadingTarget}
              errorFor={visibleFieldError}
              onSelectSingle={selectSingleAsset}
              onAddReferences={(keys) => keys.forEach(addReferenceImage)}
              onRemoveReference={removeReferenceImage}
              onClearReference={() => {
                setReferenceImage(null);
                resetResolutionToDefault();
              }}
              onClearLastFrame={() => {
                setLastFrameImage(null);
                resetResolutionToDefault();
              }}
              onClearVideo={() => setSourceVideo(null)}
              onUpload={uploadFiles}
            />
          </div>
        </FormSection>

        <FormSection id="single-prompt-section" code="02 / 提示詞" title={FIELD_LABELS.prompt} icon="spark">
          <div className={styles.fieldStack}>
            <SinglePromptAssistant
              mode={mode}
              duration={duration}
              negativePrompt={negativePrompt}
              referenceImage={referenceImage}
              referenceImages={referenceImages}
              lastFrameImage={lastFrameImage}
              sourceVideo={sourceVideo}
              onPromptGenerated={setPrompt}
              onNegativePromptGenerated={setNegativePrompt}
            />
            <label className={`${styles.field} ${visibleFieldError("prompt") ? styles.fieldInvalid : ""}`}>
              <span className={styles.fieldLabel}>H3 提示詞</span>
              <textarea
                id="single-prompt"
                className={styles.textarea}
                value={prompt}
                maxLength={mode === "replace" ? undefined : H3_PROMPT_MAX_CHARS}
                aria-invalid={Boolean(visibleFieldError("prompt"))}
                aria-describedby="single-prompt-helper single-prompt-error"
                placeholder="輸入要送給 MiniMax H3 的完整提示詞…"
                onBlur={() => markTouched("prompt")}
                onChange={(event) => setPrompt(event.target.value)}
              />
              <span id="single-prompt-helper" className={styles.counterRow}>
                <span className={styles.helper}>可直接貼入既有 H3 prompt；影片替換模式不套用 H3 字數上限。</span>
                <span className={`${styles.counter} ${mode !== "replace" && prompt.length >= 6500 ? styles.counterWarning : ""}`} aria-live="polite">
                  {mode === "replace" ? `${prompt.length} 字` : `${prompt.length} / ${H3_PROMPT_MAX_CHARS}`}
                </span>
              </span>
              <FieldError id="single-prompt-error" message={visibleFieldError("prompt")} />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>{FIELD_LABELS.negativePrompt} <span className={styles.optional}>選填</span></span>
              <textarea
                className={`${styles.textarea} ${styles.negativeTextarea}`}
                value={negativePrompt}
                placeholder="模糊、閃爍、浮水印…"
                onChange={(event) => setNegativePrompt(event.target.value)}
              />
              <span className={styles.helper}>沿用既有生成 API 內容，不改變後端行為。</span>
            </label>
          </div>
        </FormSection>

        <FormSection id="single-setup-section" code="03 / 生成設定" title="生成設定" icon="frames">
          <div className={styles.fieldStack}>
            <div className={styles.fieldGrid}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>{FIELD_LABELS.modelProfile}</span>
                <select className={styles.select} value={modelProfile} onChange={(event) => setModelProfile(event.target.value)}>
                  {availableModels.map((option) => (
                    <option key={option.value} value={option.value}>{option.label} · {option.note}</option>
                  ))}
                </select>
              </label>

              {mode === "replace" && (
                <>
                  <label className={`${styles.field} ${visibleFieldError("characterLoraName") ? styles.fieldInvalid : ""}`}>
                    <span className={styles.fieldLabel}>角色 LoRA <span className={styles.optional}>選填</span></span>
                    <input
                      id="single-character-lora"
                      className={styles.input}
                      list="single-character-lora-options"
                      value={characterLoraName}
                      aria-describedby={`single-character-lora-helper${visibleFieldError("characterLoraName") ? " single-character-lora-error" : ""}`}
                      aria-invalid={Boolean(visibleFieldError("characterLoraName"))}
                      onBlur={() => markTouched("characterLoraName")}
                      onChange={(event) => setCharacterLoraName(event.target.value)}
                    />
                    <datalist id="single-character-lora-options">
                      {characterLoraOptions.map((name) => <option key={name} value={name} />)}
                    </datalist>
                    <span id="single-character-lora-helper" className={styles.helper}>可直接輸入 models/loras 下相對路徑；僅支援 Wan2.2 Animate 相容 LoRA。真人建議 0.55–0.75，動漫角色建議 0.7–0.9。不要重選官方 LightX2V／relight。</span>
                    <FieldError id="single-character-lora-error" message={visibleFieldError("characterLoraName")} />
                  </label>

                  <label className={`${styles.field} ${visibleFieldError("characterLoraStrength") ? styles.fieldInvalid : ""}`}>
                    <span className={styles.rangeHeader}>
                      <span className={styles.fieldLabel}>LoRA 強度</span>
                      <span className={styles.rangeValue}>{characterLoraStrength === "" ? "—" : Number(characterLoraStrength).toFixed(2)}</span>
                    </span>
                    <input
                      id="single-character-lora-strength"
                      className={styles.input}
                      type="number"
                      min={0}
                      max={2}
                      step={0.05}
                      value={characterLoraStrength}
                      aria-describedby={`single-character-lora-strength-helper${visibleFieldError("characterLoraStrength") ? " single-character-lora-strength-error" : ""}`}
                      aria-invalid={Boolean(visibleFieldError("characterLoraStrength"))}
                      onBlur={() => markTouched("characterLoraStrength")}
                      onChange={(event) => setCharacterLoraStrength(numberDraft(event.target.value))}
                    />
                    <span id="single-character-lora-strength-helper" className={styles.helper}>範圍 0–2，預設 0.75；留白 LoRA 名稱時不會送出。</span>
                    <FieldError id="single-character-lora-strength-error" message={visibleFieldError("characterLoraStrength")} />
                  </label>
                </>
              )}

              <div className={styles.field}>
                <span className={styles.fieldLabel}>影片尺寸</span>
                <div className={styles.resolutionRow}>
                  <label className={`${styles.field} ${visibleFieldError("width") ? styles.fieldInvalid : ""}`}>
                    <span className={styles.helper}>寬</span>
                    <input
                      id="single-width"
                      className={styles.input}
                      type="number"
                      min={32}
                      max={2048}
                      step={mode === "replace" ? 16 : 32}
                      inputMode="numeric"
                      value={width}
                      aria-label="影片寬度"
                      aria-invalid={Boolean(visibleFieldError("width"))}
                      aria-describedby={visibleFieldError("width") ? "single-width-error" : undefined}
                      onBlur={() => markTouched("width")}
                      onChange={(event) => updateResolutionDimension("width", numberDraft(event.target.value))}
                    />
                    <FieldError id="single-width-error" message={visibleFieldError("width")} />
                  </label>
                  <button type="button" className={styles.iconButton} onClick={swapResolution} aria-label="交換影片寬度與高度" title="交換寬高">
                    <Icon name="shuffle" />
                  </button>
                  <label className={`${styles.field} ${visibleFieldError("height") ? styles.fieldInvalid : ""}`}>
                    <span className={styles.helper}>高</span>
                    <input
                      id="single-height"
                      className={styles.input}
                      type="number"
                      min={32}
                      max={2048}
                      step={mode === "replace" ? 16 : 32}
                      inputMode="numeric"
                      value={height}
                      aria-label="影片高度"
                      aria-invalid={Boolean(visibleFieldError("height"))}
                      aria-describedby={visibleFieldError("height") ? "single-height-error" : undefined}
                      onBlur={() => markTouched("height")}
                      onChange={(event) => updateResolutionDimension("height", numberDraft(event.target.value))}
                    />
                    <FieldError id="single-height-error" message={visibleFieldError("height")} />
                  </label>
                </div>
                {resolutionInfo && (
                  <div className={styles.resolutionControls}>
                    <div className={styles.resolutionMeta}>
                      <span>原始圖片 {resolutionInfo.originalWidth} × {resolutionInfo.originalHeight}</span>
                      <span>輸出尺寸 {width || "—"} × {height || "—"}</span>
                    </div>
                    <label className={styles.field}>
                      <span className={styles.rangeHeader}>
                        <span className={styles.fieldLabel}>縮放比例</span>
                        <span className={styles.rangeValue}>{resolutionScale}%</span>
                      </span>
                      <input
                        id="single-resolution-scale"
                        className={styles.range}
                        type="range"
                        min={10}
                        max={100}
                        step={1}
                        value={resolutionScale}
                        aria-label="來源圖片縮放比例"
                        onInput={(event) => applyResolutionScale(Number(event.currentTarget.value))}
                      />
                      <span className={styles.scaleTicks} aria-hidden="true"><span>10%</span><span>50%</span><span>100%</span></span>
                    </label>
                    <label className={styles.lockToggle}>
                      <input type="checkbox" checked={aspectLocked} onChange={(event) => setAspectLocked(event.target.checked)} />
                      <span>鎖定來源比例</span>
                    </label>
                  </div>
                )}
                <span
                  id="single-resolution-status"
                  className={styles.helper}
                  role="status"
                  aria-live="polite"
                  data-resolution-status={resolutionStatus}
                >
                  {resolutionStatusText(resolutionStatus, resolutionInfo)}
                </span>
                <FieldError id="single-resolution-error" message={resolutionError} />
                <span className={styles.helper}>{mode === "replace" ? "16" : "32"} 的倍數，範圍 32–2048 px。</span>
              </div>
            </div>

            <label className={styles.field}>
              <span className={styles.rangeHeader}>
                <span className={styles.fieldLabel}>片段長度</span>
                <span className={styles.rangeValue}>{duration.toFixed(1)} sec</span>
              </span>
              <input className={styles.range} type="range" min={2} max={10} step={0.5} value={duration} onChange={(event) => setDuration(Number(event.target.value))} />
              <span className={styles.helper}>2–10 秒；既有流程預設 5 秒。</span>
            </label>

            <div className={styles.compactGrid}>
              <label className={`${styles.field} ${visibleFieldError("steps") ? styles.fieldInvalid : ""}`}>
                <span className={styles.fieldLabel}>{FIELD_LABELS.steps}</span>
                <input
                  id="single-steps"
                  className={styles.input}
                  type="number"
                  min={1}
                  max={80}
                  value={steps}
                  aria-invalid={Boolean(visibleFieldError("steps"))}
                  aria-describedby={visibleFieldError("steps") ? "single-steps-error" : undefined}
                  onBlur={() => markTouched("steps")}
                  onChange={(event) => setSteps(numberDraft(event.target.value))}
                />
                <FieldError id="single-steps-error" message={visibleFieldError("steps")} />
              </label>

              <label className={`${styles.field} ${visibleFieldError("seed") ? styles.fieldInvalid : ""}`}>
                <span className={styles.fieldLabel}>{FIELD_LABELS.seed}</span>
                <input
                  id="single-seed"
                  className={styles.input}
                  type="number"
                  min={0}
                  max={2147483647}
                  value={seed}
                  aria-invalid={Boolean(visibleFieldError("seed"))}
                  aria-describedby={visibleFieldError("seed") ? "single-seed-error" : undefined}
                  onBlur={() => markTouched("seed")}
                  onChange={(event) => setSeed(numberDraft(event.target.value))}
                />
                <button type="button" className={styles.secondaryButton} onClick={randomizeSeed}><Icon name="shuffle" />隨機種子</button>
                <FieldError id="single-seed-error" message={visibleFieldError("seed")} />
              </label>

              <label className={`${styles.field} ${visibleFieldError("renderCount") ? styles.fieldInvalid : ""}`}>
                <span className={styles.fieldLabel}>影片數量</span>
                <input
                  id="single-render-count"
                  className={styles.input}
                  type="number"
                  min={1}
                  max={20}
                  value={renderCount}
                  aria-invalid={Boolean(visibleFieldError("renderCount"))}
                  aria-describedby={visibleFieldError("renderCount") ? "single-render-count-error" : undefined}
                  onBlur={() => markTouched("renderCount")}
                  onChange={(event) => setRenderCount(numberDraft(event.target.value))}
                />
                <span className={styles.helper}>批次會沿用既有 seed + index 規則。</span>
                <FieldError id="single-render-count-error" message={visibleFieldError("renderCount")} />
              </label>
            </div>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>輸出檔名 <span className={styles.optional}>選填</span></span>
              <input className={styles.input} value={outputName} placeholder="例如：h3-render" onChange={(event) => setOutputName(event.target.value)} />
              <span className={styles.helper}>批次生成時自動加上序號；副檔名由既有流程處理。</span>
            </label>
          </div>
        </FormSection>
      </div>

      <aside id="single-review-section" className={styles.summary} aria-label="生成摘要">
        <section className={styles.summaryCard}>
          <div className={styles.summaryLabel}>生成摘要</div>
          <h2 className={styles.summaryTitle}>單次生成</h2>
          <AssetPreview asset={previewAsset} />
          <div className={styles.summaryRows}>
            <SummaryRow label="模式" value={modeOption.label} />
            <SummaryRow label="模型" value={selectedModel?.label || modelProfile} />
            <SummaryRow label="尺寸" value={`${width || "—"} × ${height || "—"}`} />
            <SummaryRow label="長度" value={`${duration.toFixed(1)} 秒`} />
            <SummaryRow label="採樣步數 / 隨機種子" value={`${steps || "—"} / ${seed === "" ? "—" : seed}`} />
            <SummaryRow label="數量" value={renderCount === "" ? "—" : String(renderCount)} />
            <SummaryRow label="素材" value={assetSummary(mode, referenceImage, referenceImages, lastFrameImage, sourceVideo)} />
            {mode === "replace" && characterLoraName.trim() && (
              <SummaryRow label="角色 LoRA" value={`${characterLoraName.trim()} · ${characterLoraStrength === "" ? "—" : Number(characterLoraStrength).toFixed(2)}`} />
            )}
          </div>
        </section>

          <section id="single-validation-summary" className={styles.summaryCard} aria-live="polite">
          <div className={styles.validationLabel}>檢查結果</div>
          <ul className={styles.validationList}>
            {validationIssues.length ? validationIssues.map((issue) => (
              <li key={`${issue.field}:${issue.message}`} className={styles.validationItem}>
                <span className={styles.validationIcon} aria-hidden="true"><Icon name="close" /></span>
                <button type="button" className={styles.validationLink} onClick={() => focusValidationField(issue.field)}>{issue.message}</button>
              </li>
            )) : (
              <li className={`${styles.validationItem} ${styles.validationReady}`}>
                <span className={styles.validationIcon} aria-hidden="true"><Icon name="check" /></span>
                <span>必要欄位與素材已就緒，可以建立工作。</span>
              </li>
            )}
          </ul>
          <div className={styles.serviceState}>
            <span className={`${styles.statusDot} ${serviceState.bridge && serviceState.comfy ? styles.statusDotOnline : ""}`} aria-hidden="true" />
            <span>{serviceState.bridge && serviceState.comfy ? "Bridge / ComfyUI 在線" : "Bridge 或 ComfyUI 尚未就緒；提交時仍由既有 API 回報錯誤。"}</span>
          </div>
          <div className={`${styles.draftState} ${draftStatus === "error" ? styles.draftStateError : ""}`} role="status" aria-live="polite">
            <Icon name={draftStatus === "error" ? "close" : "check"} />
            <span>{draftStatusLabel(draftStatus)}</span>
          </div>
          {submitError && <div className={styles.submitError} role="alert">{submitError}</div>}
          <div className={styles.desktopGenerate}>
            <GenerateButton canInteract={canInteract} submitting={submitting} uploading={isUploading} onClick={() => void startRender()} />
          </div>
        </section>
      </aside>

      <div className={styles.mobileCta}>
        <GenerateButton canInteract={canInteract} submitting={submitting} uploading={isUploading} onClick={() => void startRender()} />
      </div>
    </div>
  );
}

function FormSection({ id, code, title, icon, children }: { id?: string; code: string; title: string; icon: IconName; children: ReactNode }) {
  return (
    <fieldset id={id} className={styles.section}>
      <legend className="sr-only">{title}</legend>
      <div className={styles.sectionHeader}>
        <div>
          <div className={styles.sectionCode}>{code}</div>
          <h2 className={styles.sectionTitle}>{title}</h2>
        </div>
        <span className={styles.sectionIcon} aria-hidden="true"><Icon name={icon} /></span>
      </div>
      {children}
    </fieldset>
  );
}

function SourceFields({
  mode,
  referenceImage,
  referenceImages,
  lastFrameImage,
  sourceVideo,
  uploadingTarget,
  errorFor,
  onSelectSingle,
  onAddReferences,
  onRemoveReference,
  onClearReference,
  onClearLastFrame,
  onClearVideo,
  onUpload,
}: {
  mode: Mode;
  referenceImage: Asset | null;
  referenceImages: Asset[];
  lastFrameImage: Asset | null;
  sourceVideo: Asset | null;
  uploadingTarget: UploadTarget | null;
  errorFor: (field: string) => string;
  onSelectSingle: (target: Exclude<UploadTarget, "referenceImages">, key: string) => void;
  onAddReferences: (keys: string[]) => void;
  onRemoveReference: (asset: Asset) => void;
  onClearReference: () => void;
  onClearLastFrame: () => void;
  onClearVideo: () => void;
  onUpload: (files: File[], target: UploadTarget) => Promise<void>;
}) {
  if (mode === "t2v") {
    return <p className={styles.helper}>文字生片不需要來源素材。若要從圖片或影片開始，切換上方模式。</p>;
  }

  return (
    <div className={styles.assetList} id="single-source-fields">
      {(mode === "i2v" || mode === "fl2v" || mode === "replace") && (
        <SingleAssetPicker
          id="single-reference-image"
          label={mode === "fl2v" ? "首幀圖片" : mode === "replace" ? "角色／外觀參考圖片" : "參考圖片"}
          kind="image"
          selected={referenceImage}
          error={errorFor("referenceImage")}
          uploading={uploadingTarget === "referenceImage"}
          onSelect={(key) => onSelectSingle("referenceImage", key)}
          onClear={onClearReference}
          onUpload={(files) => onUpload(files, "referenceImage")}
        />
      )}

      {mode === "l2v" && (
        <SingleAssetPicker
          id="single-last-frame"
          label="尾幀圖片"
          kind="image"
          selected={lastFrameImage}
          error={errorFor("lastFrameImage")}
          uploading={uploadingTarget === "lastFrameImage"}
          onSelect={(key) => onSelectSingle("lastFrameImage", key)}
          onClear={onClearLastFrame}
          onUpload={(files) => onUpload(files, "lastFrameImage")}
        />
      )}

      {mode === "ref2v" && (
        <div className={styles.assetCard}>
          <div className={styles.assetHeader}>
            <div>
              <label htmlFor="single-reference-images" className={styles.fieldLabel}>參考圖片</label>
              <div className={styles.assetMeta}>至少一張圖片或一段參考影片；最多 {MAX_REF2V_IMAGES} 張圖片。</div>
            </div>
            <span className={styles.assetMeta}>{referenceImages.length} / {MAX_REF2V_IMAGES}</span>
          </div>
          <div className={styles.assetControls}>
            <AssetPickerButton
              triggerId="single-reference-images"
              allowedRoots={["input", "output"]}
              allowedKinds={["image"]}
              multiple
              maxSelection={MAX_REF2V_IMAGES}
              selectedKeys={referenceImages.map(assetKey)}
              label="從素材庫加入圖片"
              onSelect={(chosen) => onAddReferences(chosen.map(libraryAssetKey))}
            />
            <UploadButton
              kind="image"
              multiple
              busy={uploadingTarget === "referenceImages"}
              disabled={referenceImages.length >= MAX_REF2V_IMAGES}
              onFiles={(files) => onUpload(files, "referenceImages")}
            />
          </div>
          {referenceImages.length > 0 && (
            <div className={styles.referenceChips} aria-label="已選 Ref2V 參考圖片">
              {referenceImages.map((asset) => (
                <span key={assetKey(asset)} className={styles.referenceChip}>
                  <span title={asset.name}>{asset.name}</span>
                  <button type="button" onClick={() => onRemoveReference(asset)} aria-label={`移除 ${asset.name}`}><Icon name="close" /></button>
                </span>
              ))}
            </div>
          )}
          <FieldError id="single-reference-images-error" message={errorFor("referenceImages")} />
        </div>
      )}

      {mode === "fl2v" && (
        <SingleAssetPicker
          id="single-last-frame"
          label="尾幀圖片"
          kind="image"
          selected={lastFrameImage}
          error={errorFor("lastFrameImage")}
          uploading={uploadingTarget === "lastFrameImage"}
          onSelect={(key) => onSelectSingle("lastFrameImage", key)}
          onClear={onClearLastFrame}
          onUpload={(files) => onUpload(files, "lastFrameImage")}
        />
      )}

      {(mode === "replace" || mode === "ref2v") && (
        <SingleAssetPicker
          id="single-source-video"
          label={mode === "ref2v" ? "參考影片（Video 1）" : "來源動作影片"}
          kind="video"
          selected={sourceVideo}
          error={errorFor("sourceVideo")}
          uploading={uploadingTarget === "sourceVideo"}
          onSelect={(key) => onSelectSingle("sourceVideo", key)}
          onClear={onClearVideo}
          onUpload={(files) => onUpload(files, "sourceVideo")}
        />
      )}

      <a className={styles.secondaryButton} href="/app/library"><Icon name="folder" />開啟完整資源庫</a>
    </div>
  );
}

function SingleAssetPicker({
  id,
  label,
  kind,
  selected,
  error,
  uploading,
  onSelect,
  onClear,
  onUpload,
}: {
  id: string;
  label: string;
  kind: AssetKind;
  selected: Asset | null;
  error: string;
  uploading: boolean;
  onSelect: (key: string) => void;
  onClear: () => void;
  onUpload: (files: File[]) => Promise<void>;
}) {
  return (
    <div className={styles.assetCard}>
      <div className={styles.assetHeader}>
        <div>
            <label htmlFor={id} className={styles.fieldLabel}>{label}</label>
          <div className={styles.assetMeta}>{kind === "image" ? "PNG / JPG / WEBP" : "MP4 / MOV / WEBM"}</div>
        </div>
      </div>
      <div className={styles.assetControls}>
        <AssetPickerButton
          triggerId={id}
          allowedRoots={["input", "output"]}
          allowedKinds={[kind]}
          selectedKeys={selected ? [assetKey(selected)] : []}
          label="從素材庫選擇"
          onSelect={(chosen) => { if (chosen[0]) onSelect(libraryAssetKey(chosen[0])); }}
        />
        <UploadButton kind={kind} busy={uploading} onFiles={onUpload} />
      </div>
      {selected && (
        <div className={styles.assetSelection}>
          <AssetThumb asset={selected} />
          <div className={styles.assetName}>
            <strong title={selected.name}>{selected.name}</strong>
            <span>{formatBytes(selected.size)} · {selected.root === "output" ? "生成結果" : "素材"}</span>
          </div>
          <button type="button" className={styles.removeButton} onClick={onClear} aria-label={`移除 ${label}`}><Icon name="close" /></button>
        </div>
      )}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

function UploadButton({ kind, busy, multiple = false, disabled = false, onFiles }: { kind: AssetKind; busy: boolean; multiple?: boolean; disabled?: boolean; onFiles: (files: File[]) => Promise<void> }) {
  return (
    <label className={styles.uploadButton} aria-disabled={busy || disabled}>
      <Icon name="upload" />
      <span>{busy ? "上傳中…" : "上傳"}</span>
      <input
        className={styles.fileInput}
        type="file"
        multiple={multiple}
        disabled={busy || disabled}
        accept={kind === "image" ? "image/png,image/jpeg,image/webp" : "video/mp4,video/quicktime,video/webm"}
        onChange={(event) => {
          const files = Array.from(event.target.files || []);
          if (files.length) void onFiles(files);
          event.target.value = "";
        }}
      />
    </label>
  );
}

function GenerateButton({ canInteract, submitting, uploading, onClick }: { canInteract: boolean; submitting: boolean; uploading: boolean; onClick: () => void }) {
  return (
    <button type="button" className={styles.primaryButton} disabled={!canInteract} onClick={onClick} aria-describedby="single-validation-summary">
      <span>{submitting ? "建立工作中…" : uploading ? "素材上傳中…" : "開始生成影片"}</span>
      <Icon name="arrow" />
    </button>
  );
}

function AssetPreview({ asset }: { asset?: Asset | null }) {
  return (
    <div className={styles.preview}>
      {!asset ? (
        <div className={styles.previewEmpty}>選取來源素材後會在這裡顯示預覽。文字生片可直接使用右側摘要確認設定。</div>
      ) : asset.kind === "video" ? (
        <video src={assetUrl(asset)} muted playsInline preload="metadata" aria-label={asset.name} />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={assetUrl(asset)} alt={`參考素材：${asset.name}`} />
      )}
    </div>
  );
}

function AssetThumb({ asset }: { asset: Asset }) {
  return (
    <span className={styles.assetThumb} aria-hidden="true">
      {asset.kind === "video"
        ? <video src={assetUrl(asset)} muted playsInline preload="metadata" />
        // eslint-disable-next-line @next/next/no-img-element
        : <img src={assetUrl(asset)} alt="" />}
    </span>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return <div className={styles.summaryRow}><span>{label}</span><strong title={value}>{value}</strong></div>;
}

function FieldError({ id, message }: { id?: string; message?: string }) {
  if (!message) return null;
  return <p id={id} className={styles.fieldError} role="alert"><Icon name="close" />{message}</p>;
}

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    spark: <><path d="M12 2.8 13.5 8l5.2 1.5-5.2 1.5L12 16.2 10.5 11 5.3 9.5 10.5 8 12 2.8Z" /><path d="m18.5 15 .7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3Z" /></>,
    image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9" r="1.5" /><path d="m4.5 18 5-5 3.5 3 2.5-2.5 4 4.5" /></>,
    frames: <><rect x="4" y="5" width="13" height="13" rx="2" /><path d="M8 5V3h12a1 1 0 0 1 1 1v12h-4" /></>,
    layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5" /><path d="m3 16 9 5 9-5" /></>,
    video: <><rect x="3" y="5" width="14" height="14" rx="2" /><path d="m17 10 4-2v8l-4-2" /></>,
    upload: <><path d="M12 16V4" /><path d="m7.5 8.5 4.5-4.5 4.5 4.5" /><path d="M5 20h14" /></>,
    close: <><path d="m7 7 10 10" /><path d="M17 7 7 17" /></>,
    shuffle: <><path d="M4 7h3c4 0 6 10 10 10h3" /><path d="m17 14 3 3-3 3" /><path d="M4 17h3c1.8 0 3.2-2 4.5-4.2" /><path d="M14 7c1-1.2 2-2 3-2h3" /><path d="m17 2 3 3-3 3" /></>,
    arrow: <><path d="M5 12h14" /><path d="m14 7 5 5-5 5" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    folder: <><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /></>,
  };
  return <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function draftStatusLabel(status: "loading" | "idle" | "saving" | "saved" | "error") {
  if (status === "loading") return "等待資源庫後載入 Single 草稿…";
  if (status === "saving") return "正在自動儲存草稿…";
  if (status === "saved") return "Single 草稿已自動儲存";
  if (status === "error") return "無法儲存 Single 草稿；離開前請保留目前頁面。";
  return "Single 草稿會自動儲存在此瀏覽器";
}

function modelOptionsForMode(mode: Mode) {
  return MODEL_OPTIONS.filter((option) => {
    if (mode === "replace") return option.value === "wan22_animate_fp8";
    if (mode === "ref2v") return option.value === "ref2va_pruned_nvfp4";
    return option.value !== "wan22_animate_fp8" && option.value !== "ref2va_pruned_nvfp4";
  });
}

function resolutionAssetForMode(mode: Mode, referenceImage: Asset | null, referenceImages: Asset[], lastFrameImage: Asset | null) {
  if (mode === "l2v") return lastFrameImage;
  if (mode === "ref2v") return referenceImages[0] || null;
  if (mode === "i2v" || mode === "fl2v" || mode === "replace") return referenceImage;
  return null;
}

function defaultResolutionForMode(mode: Mode) {
  return mode === "replace" ? { width: 832, height: 480 } : { width: 736, height: 416 };
}

function resolutionStatusText(status: ResolutionStatus, info: ResolutionInfo | null) {
  if (status === "loading") return "正在讀取來源圖片尺寸…";
  if (status === "error") return "無法取得圖片尺寸；已清除輸出尺寸。";
  if (status === "manual") return "手動輸出解析度；目前顯示的尺寸會送出。";
  if (status === "adjusted" && info) {
    return `來源 ${info.originalWidth} × ${info.originalHeight}；縮放 ${info.scalePercent}%；輸出 ${info.width} × ${info.height}，符合 ${info.grid}px 模型網格。`;
  }
  if (status === "auto" && info) {
    return `來源 ${info.originalWidth} × ${info.originalHeight}；縮放 ${info.scalePercent}%；輸出 ${info.width} × ${info.height}。`;
  }
  return "預設輸出解析度；選擇圖片後會計算最終尺寸。";
}

function assetKey(asset: Asset) {
  return `${asset.root}:${asset.name}`;
}

function mergeAssets(current: Asset[], incoming: Asset[]) {
  const merged = new Map(current.map((asset) => [assetKey(asset), asset]));
  incoming.forEach((asset) => merged.set(assetKey(asset), asset));
  return [...merged.values()];
}

function assetUrl(asset: Asset) {
  return `${BRIDGE_URL}${asset.url}`;
}

function numberDraft(value: string): NumberDraft {
  return value === "" ? "" : Number(value);
}

function apiErrorMessage(payload: ApiErrorPayload, fallback: string) {
  const message = typeof payload.error === "string" ? payload.error : payload.error?.message || fallback;
  const code = payload.code || (typeof payload.error === "object" ? payload.error?.code : "");
  return code ? `${code}: ${message}` : message;
}

function focusValidationField(field: string) {
  const ids: Record<string, string> = {
    prompt: "single-prompt",
    referenceImage: "single-reference-image",
    referenceImages: "single-reference-images",
    lastFrameImage: "single-last-frame",
    sourceVideo: "single-source-video",
    width: "single-width",
    height: "single-height",
    steps: "single-steps",
    seed: "single-seed",
    renderCount: "single-render-count",
    characterLoraName: "single-character-lora",
    characterLoraStrength: "single-character-lora-strength",
  };
  const element = document.getElementById(ids[field] || "");
  if (element instanceof HTMLElement) {
    element.focus();
    element.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function assetSummary(mode: Mode, referenceImage: Asset | null, referenceImages: Asset[], lastFrameImage: Asset | null, sourceVideo: Asset | null) {
  if (mode === "t2v") return "不需要";
  if (mode === "i2v") return referenceImage ? "1 張圖片" : "未選";
  if (mode === "fl2v") return `${referenceImage ? 1 : 0} 首幀 + ${lastFrameImage ? 1 : 0} 尾幀`;
  if (mode === "l2v") return lastFrameImage ? "1 張尾幀" : "未選";
  if (mode === "ref2v") return `${referenceImages.length} 張圖片${sourceVideo ? " + 1 影片" : ""}`;
  return `${referenceImage ? 1 : 0} 張圖片 + ${sourceVideo ? 1 : 0} 影片`;
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
