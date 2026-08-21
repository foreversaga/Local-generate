"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { buildSinglePromptRequest } from "../../lib/single-prompt-request.mjs";
import { validateSingleRenderAssets } from "../../lib/single-render-validation.mjs";
import { localizedCopy } from "../../lib/ui-copy.mjs";
import { useI18n } from "../../i18n/I18nProvider";
import {
  STUDIO_SETTINGS_DEFAULTS,
  loadStudioSettings,
  reconcileStudioSettings,
} from "../../lib/studio-settings.mjs";
import styles from "./SinglePromptAssistant.module.css";
import { createDefaultRef2VCameraPlan, normalizeRef2VCameraPlan } from "../../lib/ref2v-camera-plan.mjs";
import { Ref2VCameraPlanner, type CameraPlan } from "./Ref2VCameraPlanner";
import { REF2V_WORKFLOW } from "../../lib/ref2v-reference-plan.mjs";

const BRIDGE_URL = "/app";
const MAX_REF2V_IMAGES = 9;
const GEMMA4_12B_OLLAMA_MODEL = "hf.co/HauhauCS/Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced:Q4_K_M";
const GEMMA4_OLLAMA_MODEL = "hf.co/HauhauCS/Gemma4-26B-A4B-QAT-Uncensored-HauhauCS-Balanced-MTP:Q4_K_M";
const QWEN_OLLAMA_MODEL = "huihui_ai/qwen3-vl-abliterated:32b-instruct-q4_K_M";
const QWEN35_HAUHAUCS_OLLAMA_MODEL = "qwen3.5-hauhaucs-aggressive:9b-q6_k";

type Mode = "t2v" | "i2v" | "fl2v" | "l2v" | "ref2v" | "ref2v_motion" | "replace";
type PromptProvider = "ollama" | "sglang" | "codex";
type Asset = {
  name: string;
  root: "input" | "output";
  kind: "image" | "video";
  mime: string;
  size: number;
  modified: string;
  url: string;
};
type CodexModelOption = {
  value: string;
  label: string;
  note: string;
  reasoningEfforts?: readonly string[];
};
type Health = {
  ollama?: {
    online?: boolean;
    models?: string[];
  };
  vllm?: {
    online?: boolean;
    models?: string[];
  };
  sglang?: {
    online?: boolean;
    models?: string[];
  };
  codex?: {
    online?: boolean;
    skill?: boolean;
    models?: Array<{
      value: string;
      label?: string;
      note?: string;
      reasoningEfforts?: string[];
    }>;
  };
};
type ApiErrorPayload = {
  error?: string | { code?: string; message?: string };
  code?: string;
  candidatePrompt?: string;
  details?: {
    candidatePrompt?: string;
    repairAttempts?: number;
    finalValidation?: { code?: string; message?: string };
    secondValidation?: { code?: string; message?: string };
  };
  ollamaPromptReceipt?: string | { id?: string };
};
type Props = {
  mode: Mode;
  duration: number;
  brief: string;
  negativePrompt: string;
  referenceImage: Asset | null;
  referenceImages: Asset[];
  referenceImageRoles: string[];
  clothingMode: "character" | "reference" | "description";
  clothingDescription: string;
  lastFrameImage: Asset | null;
  sourceVideo: Asset | null;
  referenceVideoStart: number;
  referenceVideoEnd: number;
  referenceVideoMaxDimension: number;
  onBriefChange: (value: string) => void;
  onPromptGenerated: (value: string, ollamaPromptReceipt?: string) => void;
  onNegativePromptGenerated: (value: string) => void;
};

type IconName = "spark" | "refresh" | "check" | "close";

const PROMPT_MODEL_CATALOG = [
  {
    value: GEMMA4_12B_OLLAMA_MODEL,
    label: "Gemma 4 12B HauhauCS Balanced Q4_K_M",
    note: "Local · prompt generation",
  },
  {
    value: QWEN35_HAUHAUCS_OLLAMA_MODEL,
    label: "Qwen3.5 9B HauhauCS Aggressive Q6_K",
    note: "Local · text prompt generation",
  },
  {
    value: GEMMA4_OLLAMA_MODEL,
    label: "Gemma 4 26B-A4B QAT Balanced MTP Q4_K_M",
    note: "Prompt generation · text + image",
  },
  {
    value: QWEN_OLLAMA_MODEL,
    label: "Qwen3-VL Abliterated 32B",
    note: "Remote RTX 5090 · text + image",
  },
] as const;

const CODEX_MODEL_CATALOG: readonly CodexModelOption[] = [
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", note: "最高品質", reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra", note: "品質／速度平衡", reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { value: "gpt-5.6-luna", label: "GPT-5.6 Luna", note: "較快、低成本", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
  { value: "gpt-5.5", label: "GPT-5.5", note: "通用 Codex", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
  { value: "gpt-5.4", label: "GPT-5.4", note: "日常 Codex", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
  { value: "gpt-5.4-mini", label: "GPT-5.4 Mini", note: "較快、低成本", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
] as const;

const REASONING_OPTIONS = [
  { value: "low", label: "低", note: "最快" },
  { value: "medium", label: "中", note: "平衡" },
  { value: "high", label: "高", note: "更完整" },
  { value: "xhigh", label: "極高", note: "深度" },
  { value: "max", label: "最高", note: "最高" },
  { value: "ultra", label: "極致", note: "自動分工" },
] as const;

export function SinglePromptAssistant({
  mode,
  duration,
  brief,
  negativePrompt,
  referenceImage,
  referenceImages,
  referenceImageRoles,
  clothingMode,
  clothingDescription,
  lastFrameImage,
  sourceVideo,
  referenceVideoStart,
  referenceVideoEnd,
  referenceVideoMaxDimension,
  onBriefChange,
  onPromptGenerated,
  onNegativePromptGenerated,
}: Props) {
  const { locale } = useI18n();
  const { FIELD_LABELS } = localizedCopy(locale);
  const [health, setHealth] = useState<Health | null>(null);
  const [provider, setProvider] = useState<PromptProvider>(STUDIO_SETTINGS_DEFAULTS.promptProvider as PromptProvider);
  const [ollamaModel, setOllamaModel] = useState<string>(STUDIO_SETTINGS_DEFAULTS.ollamaModel);
  const [vllmModel, setVllmModel] = useState<string>(STUDIO_SETTINGS_DEFAULTS.vllmModel);
  const [codexModel, setCodexModel] = useState<string>(STUDIO_SETTINGS_DEFAULTS.codexModel);
  const [reasoningEffort, setReasoningEffort] = useState<string>(STUDIO_SETTINGS_DEFAULTS.codexReasoningEffort);
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [cameraSettingsEnabled, setCameraSettingsEnabled] = useState(false);
  const [cameraPlan, setCameraPlan] = useState<CameraPlan>(() => createDefaultRef2VCameraPlan() as CameraPlan);
  const isRef2VMode = mode === "ref2v" || mode === "ref2v_motion";
  const isCharacterMotion = mode === "ref2v_motion";
  const requestMode = isRef2VMode ? "ref2v" : mode;

  useEffect(() => {
    if (!isRef2VMode) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setCameraPlan((current) => {
        const normalized = normalizeRef2VCameraPlan(current, { duration, referenceCount: referenceImages.length, hasVideo: Boolean(sourceVideo) }) as CameraPlan;
        return isCharacterMotion ? {
          ...normalized,
          videoPolicy: sourceVideo ? "preserve_camera_cuts" : "none",
          shots: normalized.shots.map((shot) => ({ ...shot, videoReference: Boolean(sourceVideo) })),
        } : normalized;
      });
    });
    return () => { cancelled = true; };
  }, [duration, isCharacterMotion, isRef2VMode, referenceImages.length, sourceVideo]);

  useEffect(() => {
    void refreshHealth();
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const stored = reconcileStudioSettings(loadStudioSettings());
      setProvider(stored.promptProvider as PromptProvider);
      setOllamaModel(stored.ollamaModel);
      setVllmModel(stored.vllmModel);
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
        promptProvider: provider,
        ollamaModel,
        vllmModel,
        codexModel,
        codexReasoningEffort: reasoningEffort,
      }, health);
      setProvider(next.promptProvider as PromptProvider);
      setOllamaModel(next.ollamaModel);
      setVllmModel(next.vllmModel);
      setCodexModel(next.codexModel);
      setReasoningEffort(next.codexReasoningEffort);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [codexModel, health, ollamaModel, provider, reasoningEffort, settingsHydrated, vllmModel]);

  const ollamaModels = health?.ollama?.models;
  const visibleModels = useMemo(() => ollamaModels || [], [ollamaModels]);
  const effectiveOllamaModel = visibleModels.includes(ollamaModel)
    ? ollamaModel
    : visibleModels[0] || ollamaModel;
  const vllmModels = health?.sglang?.models || health?.vllm?.models || [];
  const effectiveVllmModel = vllmModels.includes(vllmModel)
    ? vllmModel
    : vllmModels[0] || vllmModel;
  const ollamaOptions = useMemo(() => {
    const catalogByValue = new Map<string, (typeof PROMPT_MODEL_CATALOG)[number]>(
      PROMPT_MODEL_CATALOG.map((model) => [model.value, model] as const),
    );
    return visibleModels.map((model) => {
      const known = catalogByValue.get(model);
      return {
        value: model,
        label: known?.label || model,
        note: known?.note || "已安裝",
      };
    });
  }, [visibleModels]);
  const codexOptions: readonly CodexModelOption[] = health?.codex?.models?.length
    ? health.codex.models.map((model) => ({
      value: model.value,
      label: model.label || model.value,
      note: model.note || "Codex model",
      reasoningEfforts: model.reasoningEfforts,
    }))
    : CODEX_MODEL_CATALOG;
  const selectedCodexModel = codexOptions.find((model) => model.value === codexModel) || codexOptions[0];
  const supportedReasoning = selectedCodexModel?.reasoningEfforts?.length
    ? selectedCodexModel.reasoningEfforts
    : REASONING_OPTIONS.map((option) => option.value);
  const effectiveReasoning = supportedReasoning.includes(reasoningEffort)
    ? reasoningEffort
    : supportedReasoning.includes("medium") ? "medium" : supportedReasoning[0] || "medium";
  const effectiveCodexModel = selectedCodexModel?.value || codexModel;
  const formatLabel = promptFormatLabel(mode);
  const briefError = attempted && !brief.trim() ? "請先輸入提示詞描述。" : "";
  const providerReady = provider === "ollama"
    ? Boolean(health?.ollama?.online && visibleModels.length)
    : provider === "sglang"
      ? Boolean((health?.sglang?.online || health?.vllm?.online) && vllmModels.length)
      : Boolean(health?.codex?.online && health?.codex?.skill);

  async function refreshHealth() {
    try {
      const response = await fetch(`${BRIDGE_URL}/api/health`);
      if (!response.ok) throw new Error("prompt provider unavailable");
      const payload = (await response.json()) as Health;
      setHealth(payload);
    } catch {
      setHealth(null);
    }
  }

  function selectCodexModel(value: string) {
    setCodexModel(value);
    const nextModel = codexOptions.find((model) => model.value === value);
    const efforts = nextModel?.reasoningEfforts?.length
      ? nextModel.reasoningEfforts
      : REASONING_OPTIONS.map((option) => option.value);
    if (!efforts.includes(reasoningEffort)) {
      setReasoningEffort(efforts.includes("medium") ? "medium" : efforts[0] || "medium");
    }
  }

  async function generatePrompt() {
    setAttempted(true);
    setError("");
    setNotice("");

    if (!brief.trim()) return;

    const assetIssues = validateSingleRenderAssets({
      mode: requestMode,
      referenceImage,
      referenceImages: isCharacterMotion ? referenceImages.filter((_, index) => referenceImageRoles[index] === "character") : referenceImages,
      faceReferenceImages: referenceImages.filter((_, index) => referenceImageRoles[index] === "face"),
      clothingReferenceImages: referenceImages.filter((_, index) => referenceImageRoles[index] === "clothing"),
      ref2vWorkflow: isCharacterMotion ? REF2V_WORKFLOW : undefined,
      clothingMode,
      clothingDescription,
      referenceVideoStart,
      referenceVideoEnd,
      referenceVideoMaxDimension,
      duration,
      lastFrameImage,
      sourceVideo,
    }) as Array<{ field: string; message: string }>;
    if (assetIssues.length) {
      setError(assetIssues[0].message);
      return;
    }

    if (provider === "ollama") {
      if (!health?.ollama?.online) {
        setError("Ollama 尚未連線。");
        return;
      }
      if (!visibleModels.includes(effectiveOllamaModel)) {
        setError(`模型 ${effectiveOllamaModel} 尚未安裝。`);
        return;
      }
    } else if (provider === "sglang") {
      if (!health?.sglang?.online && !health?.vllm?.online) {
        setError("vLLM 尚未連線。");
        return;
      }
      if (!vllmModels.includes(effectiveVllmModel)) {
        setError(`vLLM 模型 ${effectiveVllmModel} 尚未就緒。`);
        return;
      }
    } else {
      if (!health?.codex?.online) {
        setError("Codex CLI 尚未安裝或無法執行。");
        return;
      }
      if (!health?.codex?.skill) {
        setError("找不到 h3-prompt-writing skill。");
        return;
      }
    }

    setBusy(true);
    try {
      const images = await buildPromptImages({
        mode,
        referenceImage,
        referenceImages,
        lastFrameImage,
        sourceVideo,
        referenceVideoStart,
      });
      const response = await fetch(`${BRIDGE_URL}/api/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildSinglePromptRequest({
          provider,
          model: provider === "codex" ? effectiveCodexModel : provider === "sglang" ? effectiveVllmModel : effectiveOllamaModel,
          codexModel: effectiveCodexModel,
          reasoningEffort: effectiveReasoning,
          brief: brief.trim(),
          negativePrompt,
          mode: requestMode,
          duration,
          referenceImageName: referenceImage?.kind === "image" ? referenceImage.name : "",
          referenceImageNames: referenceImages.map((asset) => asset.name).slice(0, MAX_REF2V_IMAGES),
          referenceImageRoles: isCharacterMotion ? referenceImageRoles : [],
          ref2vWorkflow: isCharacterMotion ? REF2V_WORKFLOW : "",
          clothingMode: isCharacterMotion ? clothingMode : "character",
          clothingDescription: isCharacterMotion ? clothingDescription : "",
          referenceVideoStart: isCharacterMotion ? referenceVideoStart : 0,
          referenceVideoEnd: isCharacterMotion ? referenceVideoEnd : duration,
          referenceVideoMaxDimension: isCharacterMotion ? referenceVideoMaxDimension : 720,
          lastFrameName: lastFrameImage?.kind === "image" ? lastFrameImage.name : "",
          sourceVideoName: sourceVideo?.kind === "video" ? sourceVideo.name : "",
          images,
          cameraPlan: isRef2VMode && cameraSettingsEnabled ? normalizeRef2VCameraPlan(cameraPlan, {
            duration,
            referenceCount: referenceImages.length,
            hasVideo: Boolean(sourceVideo),
          }) : undefined,
        })),
      });
      const payload = (await response.json().catch(() => ({}))) as ApiErrorPayload & {
        prompt?: string;
        negativePrompt?: string;
      };

      if (!response.ok) {
        const candidatePrompt = payload.candidatePrompt || payload.details?.candidatePrompt || "";
        const validation = payload.details?.finalValidation || payload.details?.secondValidation;
        if (candidatePrompt) onPromptGenerated(candidatePrompt);
        const validationMessage = [validation?.code, validation?.message].filter(Boolean).join(": ");
        const attempts = payload.details?.repairAttempts;
        const repairNote = Number.isInteger(attempts) ? `（已自動修正 ${attempts} 次）` : "";
        const candidateNote = candidatePrompt ? " 候選提示詞已保留，可直接編輯。" : "";
        throw new Error(
          validationMessage
            ? `${validationMessage}${repairNote}${candidateNote}`
            : apiErrorMessage(payload, `${providerLabel(provider)} 沒有回應`),
        );
      }

      if (payload.prompt) {
        const receipt = typeof payload.ollamaPromptReceipt === "string"
          ? payload.ollamaPromptReceipt
          : payload.ollamaPromptReceipt?.id || "";
        onPromptGenerated(payload.prompt, receipt);
      }
      if (payload.negativePrompt) onNegativePromptGenerated(payload.negativePrompt);
      setNotice(`${providerLabel(provider)} 已產生 ${formatLabel} 提示詞。`);
    } catch (promptError) {
      setError(promptError instanceof Error ? promptError.message : `${providerLabel(provider)} 連線失敗。`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.assistant} aria-labelledby="single-prompt-assistant-title">
      <div className={styles.header}>
        <div>
          <span className={styles.eyebrow}>提示詞助理（Prompt）</span>
          <h3 id="single-prompt-assistant-title" className={styles.title}>從描述產生 {formatLabel} 提示詞</h3>
        </div>
        <button type="button" className={styles.refreshButton} onClick={() => void refreshHealth()} aria-label="重新檢查提示詞提供者狀態" title="重新檢查提示詞提供者">
          <Icon name="refresh" />
        </button>
      </div>

      <label className={`${styles.field} ${briefError ? styles.invalid : ""}`}>
        <span className={styles.label}>提示詞描述</span>
        <textarea
          className={styles.brief}
          value={brief}
          aria-invalid={Boolean(briefError)}
          aria-describedby="single-prompt-brief-helper single-prompt-brief-error"
          placeholder="例如：一個人在月台等待，風吹動他的外套…"
          onChange={(event) => {
            onBriefChange(event.target.value);
            if (attempted) setError("");
          }}
        />
        <span id="single-prompt-brief-helper" className={styles.helper}>可用中文描述；產出後仍可直接編輯下方 H3 提示詞。</span>
        {briefError && <p id="single-prompt-brief-error" className={styles.error} role="alert"><Icon name="close" />{briefError}</p>}
      </label>

      {isRef2VMode && <>
        <div className={styles.cameraToggleRow}>
          <span className={styles.cameraToggleCopy}>
            <strong>{locale === "en" ? "Camera settings" : "鏡頭設定"}</strong>
            <small>{locale === "en" ? "Only send camera planning instructions when enabled." : "開啟後才會送出鏡頭規劃指令。"}</small>
          </span>
          <label className={styles.cameraToggle}>
            <input
              type="checkbox"
              role="switch"
              checked={cameraSettingsEnabled}
              aria-label={locale === "en" ? "Enable camera settings" : "啟用鏡頭設定"}
              aria-controls="ref2v-camera-settings-panel"
              onChange={(event) => setCameraSettingsEnabled(event.target.checked)}
            />
            <span aria-hidden="true" />
          </label>
        </div>
        {cameraSettingsEnabled && <div id="ref2v-camera-settings-panel">
          <Ref2VCameraPlanner
            locale={locale}
            duration={duration}
            referenceCount={referenceImages.length}
            hasVideo={Boolean(sourceVideo)}
            value={cameraPlan}
            onChange={setCameraPlan}
          />
        </div>}
      </>}

      <div className={styles.providerRow}>
        <div className={styles.providerSwitch} role="group" aria-label="提示詞生成來源">
          <button type="button" className={provider === "ollama" ? styles.providerActive : ""} aria-pressed={provider === "ollama"} onClick={() => { setProvider("ollama"); setError(""); }}>
            Ollama
          </button>
          <button type="button" className={provider === "sglang" ? styles.providerActive : ""} aria-pressed={provider === "sglang"} onClick={() => { setProvider("sglang"); setError(""); }}>
            vLLM
          </button>
          <button type="button" className={provider === "codex" ? styles.providerActive : ""} aria-pressed={provider === "codex"} onClick={() => { setProvider("codex"); setError(""); }}>
            Codex CLI
          </button>
        </div>
        <span className={`${styles.status} ${providerReady ? styles.statusReady : ""}`}>
          <span className={styles.statusDot} aria-hidden="true" />
          {providerReady ? "已就緒" : "無法使用"}
        </span>
      </div>

      {provider === "ollama" ? (
        <label className={styles.field}>
          <span className={styles.label}>Ollama 模型</span>
          <select className={styles.select} value={visibleModels.length ? effectiveOllamaModel : ""} disabled={!visibleModels.length || busy} onChange={(event) => setOllamaModel(event.target.value)}>
            {!visibleModels.length && <option value="">沒有可用模型</option>}
            {ollamaOptions.map((model) => <option key={model.value} value={model.value}>{model.label} · {model.note}</option>)}
          </select>
        </label>
      ) : provider === "sglang" ? (
        <label className={styles.field}>
          <span className={styles.label}>vLLM 模型</span>
          <select className={styles.select} value={vllmModels.length ? effectiveVllmModel : ""} disabled={!vllmModels.length || busy} onChange={(event) => setVllmModel(event.target.value)}>
            {!vllmModels.length && <option value="">vLLM 尚未回報模型</option>}
            {vllmModels.map((model) => <option key={model} value={model}>{model}</option>)}
          </select>
        </label>
      ) : (
        <div className={styles.providerFields}>
          <label className={styles.field}>
            <span className={styles.label}>Codex 模型</span>
            <select className={styles.select} value={effectiveCodexModel} disabled={busy} onChange={(event) => selectCodexModel(event.target.value)}>
              {codexOptions.map((model) => <option key={model.value} value={model.value}>{model.label} · {model.note}</option>)}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.label}>{FIELD_LABELS.reasoning}</span>
            <select className={styles.select} value={effectiveReasoning} disabled={busy} onChange={(event) => setReasoningEffort(event.target.value)}>
              {REASONING_OPTIONS.filter((option) => supportedReasoning.includes(option.value)).map((option) => (
                <option key={option.value} value={option.value}>{option.label} · {option.note}</option>
              ))}
            </select>
          </label>
        </div>
      )}

      <button type="button" className={styles.generateButton} disabled={busy || !providerReady} onClick={() => void generatePrompt()}>
        <Icon name="spark" />
        <span>{busy ? `${providerLabel(provider)} 生成中…` : `產生 ${formatLabel} 提示詞`}</span>
      </button>

      {error && <p className={styles.errorBox} role="alert"><Icon name="close" />{error}</p>}
      {notice && <p className={styles.notice} role="status"><Icon name="check" />{notice}</p>}
    </section>
  );
}

async function buildPromptImages({
  mode,
  referenceImage,
  referenceImages,
  lastFrameImage,
  sourceVideo,
  referenceVideoStart,
}: {
  mode: Mode;
  referenceImage: Asset | null;
  referenceImages: Asset[];
  lastFrameImage: Asset | null;
  sourceVideo: Asset | null;
  referenceVideoStart: number;
}) {
  const images: Array<{ role: string; data: string }> = [];
  if ((mode === "i2v" || mode === "replace") && referenceImage?.kind === "image") {
    images.push({ role: "reference_image", data: await assetToPromptImage(referenceImage) });
  }
  if (mode === "ref2v" || mode === "ref2v_motion") {
    for (const [index, asset] of referenceImages.slice(0, MAX_REF2V_IMAGES).entries()) {
      images.push({ role: `picture_${index + 1}`, data: await assetToPromptImage(asset) });
    }
  }
  if (mode === "fl2v" && referenceImage?.kind === "image") {
    images.push({ role: "first_frame", data: await assetToPromptImage(referenceImage) });
  }
  if ((mode === "fl2v" || mode === "l2v") && lastFrameImage?.kind === "image") {
    images.push({ role: "last_frame", data: await assetToPromptImage(lastFrameImage) });
  }
  if (mode === "replace" && sourceVideo?.kind === "video") {
    images.push({ role: "source_video_first_frame", data: await assetToPromptImage(sourceVideo) });
  }
  if ((mode === "ref2v" || mode === "ref2v_motion") && sourceVideo?.kind === "video") {
    images.push({ role: "video_1_preview_frame", data: await assetToPromptImage(sourceVideo, mode === "ref2v_motion" ? referenceVideoStart : 0) });
  }
  return images;
}

async function assetToPromptImage(asset: Asset, videoTime = 0) {
  const response = await fetch(assetUrl(asset));
  if (!response.ok) throw new Error("無法讀取參考素材。");
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const canvas = document.createElement("canvas");
    const maxDimension = 1024;
    if (asset.kind === "image") {
      const image = new Image();
      image.src = objectUrl;
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("無法解碼參考圖片。"));
      });
      const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
    } else {
      const video = document.createElement("video");
      video.src = objectUrl;
      video.muted = true;
      video.playsInline = true;
      video.preload = "metadata";
      await new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () => reject(new Error("無法讀取來源影片首幀。"));
      });
      if (videoTime > 0 && Number.isFinite(video.duration)) {
        video.currentTime = Math.min(videoTime, Math.max(0, video.duration - 0.05));
        await new Promise<void>((resolve, reject) => {
          video.onseeked = () => resolve();
          video.onerror = () => reject(new Error("無法讀取參考影片選定片段。"));
        });
      }
      const scale = Math.min(1, maxDimension / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
      video.removeAttribute("src");
      video.load();
    }
    const dataUrl = canvas.toDataURL("image/jpeg", 0.86);
    return dataUrl.slice(dataUrl.indexOf(",") + 1);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function promptFormatLabel(mode: Mode) {
  if (mode === "t2v") return "T2VA";
  if (mode === "i2v") return "I2VA";
  if (mode === "fl2v") return "FL2VA";
  if (mode === "l2v") return "L2VA";
  if (mode === "ref2v" || mode === "ref2v_motion") return "Ref2VA";
  return "Wan Animate";
}

function providerLabel(provider: PromptProvider) {
  return provider === "codex" ? "Codex CLI" : provider === "sglang" ? "vLLM" : "Ollama";
}

function assetUrl(asset: Asset) {
  return `${BRIDGE_URL}${asset.url}`;
}

function apiErrorMessage(payload: ApiErrorPayload, fallback: string) {
  const message = typeof payload.error === "string" ? payload.error : payload.error?.message || fallback;
  const code = payload.code || (typeof payload.error === "object" ? payload.error?.code : "");
  return code ? `${code}: ${message}` : message;
}

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    spark: <><path d="M12 2.8 13.5 8l5.2 1.5-5.2 1.5L12 16.2 10.5 11 5.3 9.5 10.5 8 12 2.8Z" /><path d="m18.5 15 .7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3Z" /></>,
    refresh: <><path d="M20 7v5h-5" /><path d="M4 17v-5h5" /><path d="M6.1 8.5A7 7 0 0 1 18.7 7L20 12" /><path d="M17.9 15.5A7 7 0 0 1 5.3 17L4 12" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    close: <><path d="m7 7 10 10" /><path d="M17 7 7 17" /></>,
  };
  return <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}
