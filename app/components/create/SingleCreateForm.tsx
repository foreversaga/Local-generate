"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  batchOutputName,
  batchSeed,
  buildSingleRenderRequest,
} from "../../lib/single-render-request.mjs";
import { validateSingleRender } from "../../lib/single-render-validation.mjs";
import styles from "./SingleCreateForm.module.css";

const BRIDGE_URL = "/app";
const H3_PROMPT_MAX_CHARS = 7000;
const MAX_REF2V_IMAGES = 9;

type Mode = "t2v" | "i2v" | "fl2v" | "l2v" | "ref2v" | "replace";
type NumberDraft = number | "";
type AssetKind = "image" | "video";
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
  const [serviceState, setServiceState] = useState<ServiceState>({ bridge: false, comfy: false });
  const [mode, setMode] = useState<Mode>("t2v");
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [modelProfile, setModelProfile] = useState("nvfp4_blackwell");
  const [width, setWidth] = useState<NumberDraft>(736);
  const [height, setHeight] = useState<NumberDraft>(416);
  const [duration, setDuration] = useState(5);
  const [steps, setSteps] = useState<NumberDraft>(20);
  const [seed, setSeed] = useState<NumberDraft>(12345);
  const [renderCount, setRenderCount] = useState<NumberDraft>(1);
  const [outputName, setOutputName] = useState("");
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
  const imageAssets = useMemo(() => inputAssets.filter((asset) => asset.kind === "image"), [inputAssets]);
  const videoAssets = useMemo(() => inputAssets.filter((asset) => asset.kind === "video"), [inputAssets]);
  const availableModels = useMemo(() => modelOptionsForMode(mode), [mode]);
  const modeOption = MODE_OPTIONS.find((option) => option.value === mode) || MODE_OPTIONS[0];
  const selectedModel = availableModels.find((option) => option.value === modelProfile) || availableModels[0];
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
    seed,
    sourceVideo,
    steps,
    width,
  ]);
  const issuesByField = useMemo(() => new Map(validationIssues.map((issue) => [issue.field, issue.message])), [validationIssues]);
  const previewAsset = referenceImage || referenceImages[0] || lastFrameImage || sourceVideo;
  const isUploading = uploadingTarget !== null;
  const canSubmit = validationIssues.length === 0 && !submitting && !isUploading;

  useEffect(() => {
    void Promise.all([refreshAssets(), refreshHealth()]);
  }, []);

  async function refreshAssets() {
    try {
      const response = await fetch(`${BRIDGE_URL}/api/assets?root=all`);
      if (!response.ok) return;
      const payload = (await response.json()) as { assets?: Asset[] };
      setAssets(payload.assets || []);
    } catch {
      setAssets([]);
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
    setMode(nextMode);
    setSubmitError("");
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
    setWidth(height);
    setHeight(width);
  }

  function selectSingleAsset(target: Exclude<UploadTarget, "referenceImages">, key: string) {
    const nextAsset = inputAssets.find((asset) => assetKey(asset) === key) || null;
    if (target === "referenceImage") setReferenceImage(nextAsset?.kind === "image" ? nextAsset : null);
    if (target === "lastFrameImage") setLastFrameImage(nextAsset?.kind === "image" ? nextAsset : null);
    if (target === "sourceVideo") setSourceVideo(nextAsset?.kind === "video" ? nextAsset : null);
    markTouched(target);
  }

  function addReferenceImage(key: string) {
    const asset = imageAssets.find((item) => assetKey(item) === key);
    if (!asset || referenceImages.some((item) => assetKey(item) === key)) return;
    setReferenceImages((current) => [...current, asset].slice(0, MAX_REF2V_IMAGES));
    markTouched("referenceImages");
  }

  function removeReferenceImage(asset: Asset) {
    setReferenceImages((current) => current.filter((item) => assetKey(item) !== assetKey(asset)));
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
      const uploaded: Asset[] = [];
      for (const file of candidates) {
        const response = await fetch(`${BRIDGE_URL}/api/assets/upload`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: file.name,
            mimeType: file.type,
            data: await fileToBase64(file),
          }),
        });
        const payload = (await response.json().catch(() => ({}))) as { asset?: Asset; error?: string };
        if (!response.ok || !payload.asset) throw new Error(payload.error || `無法上傳 ${file.name}`);
        uploaded.push(payload.asset);
      }

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
            referenceImageNames,
            lastFrameName: lastFrameImage?.kind === "image" ? lastFrameImage.name : "",
            sourceVideoName: sourceVideo?.kind === "video" ? sourceVideo.name : "",
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
      router.push(destination);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "生成服務未連線。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.layout}>
      <div className={styles.formColumn}>
        <FormSection code="01 / SOURCE" title="來源與模式" icon="layers">
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
              imageAssets={imageAssets}
              videoAssets={videoAssets}
              referenceImage={referenceImage}
              referenceImages={referenceImages}
              lastFrameImage={lastFrameImage}
              sourceVideo={sourceVideo}
              uploadingTarget={uploadingTarget}
              errorFor={visibleFieldError}
              onSelectSingle={selectSingleAsset}
              onAddReference={addReferenceImage}
              onRemoveReference={removeReferenceImage}
              onClearReference={() => setReferenceImage(null)}
              onClearLastFrame={() => setLastFrameImage(null)}
              onClearVideo={() => setSourceVideo(null)}
              onUpload={uploadFiles}
            />
          </div>
        </FormSection>

        <FormSection code="02 / PROMPT" title="Prompt" icon="spark">
          <div className={styles.fieldStack}>
            <label className={`${styles.field} ${visibleFieldError("prompt") ? styles.fieldInvalid : ""}`}>
              <span className={styles.fieldLabel}>H3 Prompt</span>
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
                  {mode === "replace" ? `${prompt.length} chars` : `${prompt.length} / ${H3_PROMPT_MAX_CHARS}`}
                </span>
              </span>
              <FieldError id="single-prompt-error" message={visibleFieldError("prompt")} />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>負面提示詞 <span className={styles.optional}>選填</span></span>
              <textarea
                className={`${styles.textarea} ${styles.negativeTextarea}`}
                value={negativePrompt}
                placeholder="blurry, flicker, watermark…"
                onChange={(event) => setNegativePrompt(event.target.value)}
              />
              <span className={styles.helper}>沿用既有 `/api/generate` payload，不改 backend semantics。</span>
            </label>
          </div>
        </FormSection>

        <FormSection code="03 / RENDER SETUP" title="生成設定" icon="frames">
          <div className={styles.fieldStack}>
            <div className={styles.fieldGrid}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>模型 profile</span>
                <select className={styles.select} value={modelProfile} onChange={(event) => setModelProfile(event.target.value)}>
                  {availableModels.map((option) => (
                    <option key={option.value} value={option.value}>{option.label} · {option.note}</option>
                  ))}
                </select>
              </label>

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
                      onBlur={() => markTouched("width")}
                      onChange={(event) => setWidth(numberDraft(event.target.value))}
                    />
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
                      onBlur={() => markTouched("height")}
                      onChange={(event) => setHeight(numberDraft(event.target.value))}
                    />
                  </label>
                </div>
                <span className={styles.helper}>{mode === "replace" ? "16" : "32"} 的倍數，範圍 32–2048 px。</span>
                <FieldError message={visibleFieldError("width") || visibleFieldError("height")} />
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
                <span className={styles.fieldLabel}>Steps</span>
                <input
                  id="single-steps"
                  className={styles.input}
                  type="number"
                  min={1}
                  max={80}
                  value={steps}
                  aria-invalid={Boolean(visibleFieldError("steps"))}
                  onBlur={() => markTouched("steps")}
                  onChange={(event) => setSteps(numberDraft(event.target.value))}
                />
                <FieldError message={visibleFieldError("steps")} />
              </label>

              <label className={`${styles.field} ${visibleFieldError("seed") ? styles.fieldInvalid : ""}`}>
                <span className={styles.fieldLabel}>Seed</span>
                <input
                  id="single-seed"
                  className={styles.input}
                  type="number"
                  min={0}
                  max={2147483647}
                  value={seed}
                  aria-invalid={Boolean(visibleFieldError("seed"))}
                  onBlur={() => markTouched("seed")}
                  onChange={(event) => setSeed(numberDraft(event.target.value))}
                />
                <button type="button" className={styles.secondaryButton} onClick={randomizeSeed}><Icon name="shuffle" />隨機 Seed</button>
                <FieldError message={visibleFieldError("seed")} />
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
                  onBlur={() => markTouched("renderCount")}
                  onChange={(event) => setRenderCount(numberDraft(event.target.value))}
                />
                <span className={styles.helper}>批次會沿用既有 seed + index 規則。</span>
                <FieldError message={visibleFieldError("renderCount")} />
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

      <aside className={styles.summary} aria-label="生成摘要">
        <section className={styles.summaryCard}>
          <div className={styles.summaryLabel}>Review</div>
          <h2 className={styles.summaryTitle}>Single render</h2>
          <AssetPreview asset={previewAsset} />
          <div className={styles.summaryRows}>
            <SummaryRow label="模式" value={modeOption.label} />
            <SummaryRow label="模型" value={selectedModel?.label || modelProfile} />
            <SummaryRow label="尺寸" value={`${width || "—"} × ${height || "—"}`} />
            <SummaryRow label="長度" value={`${duration.toFixed(1)} 秒`} />
            <SummaryRow label="Steps / Seed" value={`${steps || "—"} / ${seed === "" ? "—" : seed}`} />
            <SummaryRow label="數量" value={renderCount === "" ? "—" : String(renderCount)} />
            <SummaryRow label="素材" value={assetSummary(mode, referenceImage, referenceImages, lastFrameImage, sourceVideo)} />
          </div>
        </section>

        <section className={styles.summaryCard} aria-live="polite">
          <div className={styles.validationLabel}>Validation</div>
          <ul className={styles.validationList}>
            {validationIssues.length ? validationIssues.map((issue) => (
              <li key={`${issue.field}:${issue.message}`} className={styles.validationItem}>
                <span className={styles.validationIcon} aria-hidden="true"><Icon name="close" /></span>
                <span>{issue.message}</span>
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
          {submitError && <div className={styles.submitError} role="alert">{submitError}</div>}
          <div className={styles.desktopGenerate}>
            <GenerateButton canSubmit={canSubmit} submitting={submitting} uploading={isUploading} onClick={() => void startRender()} />
          </div>
        </section>
      </aside>

      <div className={styles.mobileCta}>
        <GenerateButton canSubmit={canSubmit} submitting={submitting} uploading={isUploading} onClick={() => void startRender()} />
      </div>
    </div>
  );
}

function FormSection({ code, title, icon, children }: { code: string; title: string; icon: IconName; children: ReactNode }) {
  return (
    <fieldset className={styles.section}>
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
  imageAssets,
  videoAssets,
  referenceImage,
  referenceImages,
  lastFrameImage,
  sourceVideo,
  uploadingTarget,
  errorFor,
  onSelectSingle,
  onAddReference,
  onRemoveReference,
  onClearReference,
  onClearLastFrame,
  onClearVideo,
  onUpload,
}: {
  mode: Mode;
  imageAssets: Asset[];
  videoAssets: Asset[];
  referenceImage: Asset | null;
  referenceImages: Asset[];
  lastFrameImage: Asset | null;
  sourceVideo: Asset | null;
  uploadingTarget: UploadTarget | null;
  errorFor: (field: string) => string;
  onSelectSingle: (target: Exclude<UploadTarget, "referenceImages">, key: string) => void;
  onAddReference: (key: string) => void;
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
          assets={imageAssets}
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
          assets={imageAssets}
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
              <div className={styles.fieldLabel}>參考圖片</div>
              <div className={styles.assetMeta}>至少一張圖片或一段參考影片；最多 {MAX_REF2V_IMAGES} 張圖片。</div>
            </div>
            <span className={styles.assetMeta}>{referenceImages.length} / {MAX_REF2V_IMAGES}</span>
          </div>
          <div className={styles.assetControls}>
            <select
              id="single-reference-images"
              className={styles.select}
              value=""
              aria-invalid={Boolean(errorFor("referenceImages"))}
              onChange={(event) => {
                onAddReference(event.target.value);
                event.target.value = "";
              }}
            >
              <option value="">從資源庫加入圖片…</option>
              {imageAssets.filter((asset) => !referenceImages.some((selected) => assetKey(selected) === assetKey(asset))).map((asset) => (
                <option key={assetKey(asset)} value={assetKey(asset)}>{asset.name}</option>
              ))}
            </select>
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
          <FieldError message={errorFor("referenceImages")} />
        </div>
      )}

      {mode === "fl2v" && (
        <SingleAssetPicker
          id="single-last-frame"
          label="尾幀圖片"
          kind="image"
          assets={imageAssets}
          selected={lastFrameImage}
          error={errorFor("referenceImage") ? "" : errorFor("lastFrameImage")}
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
          assets={videoAssets}
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
  assets,
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
  assets: Asset[];
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
          <div className={styles.fieldLabel}>{label}</div>
          <div className={styles.assetMeta}>{kind === "image" ? "PNG / JPG / WEBP" : "MP4 / MOV / WEBM"}</div>
        </div>
      </div>
      <div className={styles.assetControls}>
        <select id={id} className={styles.select} value={selected ? assetKey(selected) : ""} aria-invalid={Boolean(error)} onChange={(event) => onSelect(event.target.value)}>
          <option value="">從資源庫選擇…</option>
          {assets.map((asset) => <option key={assetKey(asset)} value={assetKey(asset)}>{asset.name}</option>)}
        </select>
        <UploadButton kind={kind} busy={uploading} onFiles={onUpload} />
      </div>
      {selected && (
        <div className={styles.assetSelection}>
          <AssetThumb asset={selected} />
          <div className={styles.assetName}>
            <strong title={selected.name}>{selected.name}</strong>
            <span>{formatBytes(selected.size)} · input</span>
          </div>
          <button type="button" className={styles.removeButton} onClick={onClear} aria-label={`移除 ${label}`}><Icon name="close" /></button>
        </div>
      )}
      <FieldError message={error} />
    </div>
  );
}

function UploadButton({ kind, busy, multiple = false, disabled = false, onFiles }: { kind: AssetKind; busy: boolean; multiple?: boolean; disabled?: boolean; onFiles: (files: File[]) => Promise<void> }) {
  return (
    <label className={styles.uploadButton} aria-disabled={busy || disabled}>
      <Icon name="upload" />
      <span>{busy ? "上傳中…" : "上傳"}</span>
      <input
        hidden
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

function GenerateButton({ canSubmit, submitting, uploading, onClick }: { canSubmit: boolean; submitting: boolean; uploading: boolean; onClick: () => void }) {
  return (
    <button type="button" className={styles.primaryButton} disabled={!canSubmit} onClick={onClick}>
      <span>{submitting ? "建立工作中…" : uploading ? "素材上傳中…" : canSubmit ? "開始生成影片" : "完成必要欄位後生成"}</span>
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

function modelOptionsForMode(mode: Mode) {
  return MODEL_OPTIONS.filter((option) => {
    if (mode === "replace") return option.value === "wan22_animate_fp8";
    if (mode === "ref2v") return option.value === "ref2va_pruned_nvfp4";
    return option.value !== "wan22_animate_fp8" && option.value !== "ref2va_pruned_nvfp4";
  });
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

async function fileToBase64(file: File) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || "");
      resolve(value.includes(",") ? value.split(",")[1] : value);
    };
    reader.onerror = () => reject(new Error("讀取檔案失敗。"));
    reader.readAsDataURL(file);
  });
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
