"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createStudioSettings,
  loadStudioSettings,
  reconcileStudioSettings,
  saveStudioSettings,
  STUDIO_SETTINGS_DEFAULTS,
  STUDIO_SETTINGS_STORAGE_KEY,
} from "../../lib/studio-settings.mjs";
import {
  fetchRuntimeStatus,
  fetchStudioHealth,
  SettingsApiError,
  switchRuntime,
  type RuntimeProbe,
  type StudioHealth,
} from "./settings-client";
import { formatVram } from "./vram.mjs";
import styles from "./SettingsWorkspace.module.css";

const REASONING_OPTIONS = [
  { value: "low", label: "低", note: "最快" },
  { value: "medium", label: "中", note: "平衡" },
  { value: "high", label: "高", note: "更完整" },
  { value: "xhigh", label: "極高", note: "深度" },
  { value: "max", label: "最高", note: "最高" },
  { value: "ultra", label: "極致", note: "自動分工" },
] as const;

const CODEX_FALLBACK = [
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", note: "最高品質", reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra", note: "品質／速度平衡", reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { value: "gpt-5.6-luna", label: "GPT-5.6 Luna", note: "較快、低成本", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
  { value: "gpt-5.5", label: "GPT-5.5", note: "通用 Codex", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
  { value: "gpt-5.4", label: "GPT-5.4", note: "日常 Codex", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
  { value: "gpt-5.4-mini", label: "GPT-5.4 Mini", note: "較快、低成本", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
] as const;
const EMPTY_MODELS: string[] = [];

type SettingsModel = ReturnType<typeof createStudioSettings>;
type CodexOption = {
  value: string;
  label?: string;
  note?: string;
  reasoningEfforts?: readonly string[];
};

function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback;
}

function sameSettings(left: SettingsModel, right: SettingsModel) {
  return left.promptProvider === right.promptProvider &&
    left.ollamaModel === right.ollamaModel &&
    left.vllmModel === right.vllmModel &&
    left.codexModel === right.codexModel &&
    left.codexReasoningEffort === right.codexReasoningEffort;
}

function StatusBadge({ value, pending = false }: { value?: boolean; pending?: boolean }) {
  const label = pending ? "檢查中" : value ? "已連線" : "未連線";
  return <span className={`${styles.statusBadge} ${pending ? styles.pending : value ? styles.online : styles.offline}`}>{label}</span>;
}

export function SettingsWorkspace() {
  const [health, setHealth] = useState<StudioHealth | null>(null);
  const [runtime, setRuntime] = useState<RuntimeProbe | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState("");
  const [runtimeError, setRuntimeError] = useState("");
  const [switching, setSwitching] = useState(false);
  const [settings, setSettings] = useState<SettingsModel>(STUDIO_SETTINGS_DEFAULTS);
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const [saveNotice, setSaveNotice] = useState("");

  const refreshStatus = useCallback(async () => {
    setStatusLoading(true);
    const [healthResult, runtimeResult] = await Promise.allSettled([fetchStudioHealth(), fetchRuntimeStatus()]);
    const errors: string[] = [];
    let nextHealth: StudioHealth | null = null;
    if (healthResult.status === "fulfilled") nextHealth = healthResult.value;
    else errors.push(errorMessage(healthResult.reason, "服務狀態無法取得。"));
    if (runtimeResult.status === "fulfilled") {
      setRuntime(runtimeResult.value.runtime || null);
      if (!nextHealth && runtimeResult.value.health) nextHealth = runtimeResult.value.health;
    } else {
      errors.push(errorMessage(runtimeResult.reason, "執行環境狀態無法取得。"));
    }
    if (nextHealth) setHealth(nextHealth);
    setStatusError(errors.join(" "));
    setStatusLoading(false);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSettings(loadStudioSettings());
      setSettingsHydrated(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const initialTimer = window.setTimeout(() => void refreshStatus(), 0);
    const timer = window.setInterval(() => void refreshStatus(), 10000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, [refreshStatus]);

  useEffect(() => {
    if (!settingsHydrated || !health) return;
    const timer = window.setTimeout(() => {
      setSettings((current) => {
        const next = reconcileStudioSettings(current, health);
        return sameSettings(current, next) ? current : next;
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [health, settingsHydrated]);

  useEffect(() => {
    if (!settingsHydrated) return;
    const timer = window.setTimeout(() => {
      const saved = saveStudioSettings(settings);
      setSaveNotice(saved ? "已儲存於此瀏覽器" : "瀏覽器拒絕儲存，這次變更只在目前頁面有效");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [settings, settingsHydrated]);

  const runtimeMode = health?.runtime?.mode || runtime?.mode || (health?.comfy?.remote ? "remote" : "local");
  const runtimeBusy = switching || Boolean(health?.runtime?.switching);
  const activeOperations = Number(health?.runtime?.activeOperations || 0);
  const ollamaModels = health?.ollama?.models ?? EMPTY_MODELS;
  const ollamaOptions = useMemo(() => Array.from(new Set([...ollamaModels, settings.ollamaModel])), [ollamaModels, settings.ollamaModel]);
  const vllmModels = health?.sglang?.models ?? health?.vllm?.models ?? EMPTY_MODELS;
  const codexModels: CodexOption[] = health?.codex?.models?.length
    ? health.codex.models.map((model): CodexOption => ({
      value: model.value,
      label: model.label,
      note: model.note,
      reasoningEfforts: model.reasoningEfforts,
    }))
    : CODEX_FALLBACK.map((model): CodexOption => model);
  const codexOptions = useMemo<CodexOption[]>(() => {
    const values = new Set(codexModels.map((model) => model.value));
    return values.has(settings.codexModel) ? codexModels : [...codexModels, { value: settings.codexModel, label: settings.codexModel, note: "目前儲存的預設" }];
  }, [codexModels, settings.codexModel]);
  const selectedCodex = codexOptions.find((model) => model.value === settings.codexModel) || codexOptions[0];
  const reasoningValues: readonly string[] = selectedCodex?.reasoningEfforts?.length ? selectedCodex.reasoningEfforts : REASONING_OPTIONS.map((option) => option.value);
  const reasoningOptions = reasoningValues.includes(settings.codexReasoningEffort)
    ? reasoningValues
    : [...reasoningValues, settings.codexReasoningEffort];
  const codexReady = Boolean(health?.codex?.online && health?.codex?.skill);
  const comfyDevices = health?.comfy?.devices || [];

  function updateSettings(patch: Partial<SettingsModel>) {
    setSettings((current) => createStudioSettings({ ...current, ...patch }));
    setSaveNotice("");
  }

  async function handleRuntimeSwitch(mode: "local" | "remote") {
    if (runtimeBusy || mode === runtimeMode) return;
    setSwitching(true);
    setRuntimeError("");
    try {
      const result = await switchRuntime(mode);
      setRuntime(result.runtime || null);
      if (result.health) setHealth(result.health);
      setStatusError("");
    } catch (reason) {
      if (reason instanceof SettingsApiError && reason.payload.health) setHealth(reason.payload.health);
      setRuntimeError(errorMessage(reason, "切換執行環境失敗。"));
    } finally {
      setSwitching(false);
    }
  }

  return (
    <div className={styles.workspace}>
      <section className={styles.panel} aria-labelledby="runtime-title">
        <div className={styles.sectionHeader}>
          <div>
            <span className={styles.eyebrow}>模型執行環境</span>
            <h2 id="runtime-title">執行環境</h2>
          </div>
          <StatusBadge value={!statusLoading && Boolean(health?.comfy?.online && health?.ollama?.online)} pending={statusLoading} />
        </div>
        <div className={styles.runtimeGrid}>
          <div className={styles.runtimeCopy}>
            <strong>{runtimeMode === "remote" ? "Vast RTX 5090" : "本機 GPU"}</strong>
            <span>{runtimeMode === "remote" ? "使用遠端 GPU 執行生成工作" : "使用本機 GPU 執行生成工作"}</span>
            {activeOperations > 0 && <small>目前有 {activeOperations} 個執行中工作，切換可能被拒絕。</small>}
          </div>
          <div className={styles.runtimeButtons} role="group" aria-label="模型執行位置">
            <button type="button" className={runtimeMode === "local" ? styles.activeButton : styles.secondaryButton} onClick={() => void handleRuntimeSwitch("local")} disabled={runtimeBusy || runtimeMode === "local"} aria-pressed={runtimeMode === "local"}>本機</button>
            <button type="button" className={runtimeMode === "remote" ? styles.activeButton : styles.secondaryButton} onClick={() => void handleRuntimeSwitch("remote")} disabled={runtimeBusy || runtimeMode === "remote"} aria-pressed={runtimeMode === "remote"}>{switching ? "切換中…" : "Vast 5090"}</button>
          </div>
        </div>
        {runtimeError && <p className={styles.error} role="alert">{runtimeError}</p>}
      </section>

      <section className={styles.panel} aria-labelledby="services-title">
        <div className={styles.sectionHeader}>
          <div>
            <span className={styles.eyebrow}>服務狀態</span>
            <h2 id="services-title">服務狀態</h2>
          </div>
          <button type="button" className={styles.textButton} onClick={() => void refreshStatus()} disabled={statusLoading}>{statusLoading ? "檢查中…" : "重新檢查"}</button>
        </div>
        {statusError && <p className={styles.error} role="alert">{statusError}</p>}
        <dl className={styles.statusGrid}>
          <div><dt>本機橋接服務</dt><dd><StatusBadge value={health?.bridge} pending={statusLoading} /></dd></div>
          <div><dt>ComfyUI</dt><dd><StatusBadge value={health?.comfy?.online} pending={statusLoading} /></dd></div>
          <div><dt>Ollama</dt><dd><StatusBadge value={health?.ollama?.online} pending={statusLoading} /></dd></div>
          <div><dt>Qwen3.8</dt><dd><StatusBadge value={health?.sglang?.online || health?.vllm?.online} pending={statusLoading} /></dd></div>
          <div><dt>Codex CLI</dt><dd><StatusBadge value={codexReady} pending={statusLoading} /></dd></div>
        </dl>

        <details className={styles.technicalDetails}>
          <summary>
            <span>技術詳情</span>
            <small>端點、模型與 GPU 診斷</small>
          </summary>
          <div className={styles.technicalDetailsBody}>
            <dl className={styles.endpointGrid}>
              <div><dt>目前模式</dt><dd>{runtimeMode === "remote" ? "Vast 遠端" : "本機"}</dd></div>
              <div><dt>ComfyUI</dt><dd>{runtime?.comfyUrl || health?.comfy?.url || "—"}</dd></div>
              <div><dt>Ollama</dt><dd>{runtime?.ollamaUrl || health?.ollama?.url || "—"}</dd></div>
              <div><dt>Qwen3.8</dt><dd>{health?.sglang?.model || health?.vllm?.model || "—"}</dd></div>
              <div><dt>Codex CLI</dt><dd>{health?.codex?.version || (health?.codex?.skill ? "skill ready" : "—")}</dd></div>
              <div><dt>執行中工作</dt><dd>{activeOperations}</dd></div>
            </dl>
            <div className={styles.deviceList}>
              <strong>ComfyUI 裝置</strong>
              {comfyDevices.length ? comfyDevices.map((device, index) => <span key={`${device.name || "device"}-${index}`}>{device.name || `裝置 ${index + 1}`} · 可用 {formatVram(device.vram_free ?? device.free_memory)} / 總計 {formatVram(device.vram_total ?? device.total_memory)}</span>) : <span>尚未回報 GPU 資訊</span>}
            </div>
          </div>
        </details>
      </section>

      <section className={styles.panel} aria-labelledby="defaults-title">
        <div className={styles.sectionHeader}>
          <div>
            <span className={styles.eyebrow}>提示詞預設</span>
            <h2 id="defaults-title">提示詞提供者與模型預設</h2>
          </div>
          <span className={styles.storageNote}>{settingsHydrated ? saveNotice || `本機 · ${STUDIO_SETTINGS_STORAGE_KEY}` : "載入中…"}</span>
        </div>
        <p className={styles.helper}>這些偏好會寫入此瀏覽器的版本 1 設定；目前不改變既有建立工作內容，供後續流程整合使用。</p>
        <div className={styles.formGrid}>
          <label className={styles.field}>
            <span>提示詞提供者</span>
            <select value={settings.promptProvider} onChange={(event) => updateSettings({ promptProvider: event.target.value as "ollama" | "sglang" | "codex" })}>
              <option value="ollama">Ollama</option>
              <option value="sglang">Qwen3.8 · OpenAI API</option>
              <option value="codex">Codex CLI</option>
            </select>
            <small>{settings.promptProvider === "ollama"
              ? (health?.ollama?.online ? "Ollama 在線" : "Ollama 尚未就緒")
              : settings.promptProvider === "sglang"
                ? ((health?.sglang?.online || health?.vllm?.online) ? "Qwen3.8 在線" : "Qwen3.8 尚未就緒")
                : (codexReady ? "Codex CLI 與 skill 就緒" : "需要 Codex CLI 與 h3-prompt-writing skill")}</small>
          </label>
          {settings.promptProvider === "sglang" && <div className={styles.field}>
            <span>Qwen3.8 模型</span>
            <strong>{vllmModels[0] || settings.vllmModel}</strong>
            <small>{vllmModels.length ? "端點已載入此固定模型" : "尚未取得 Qwen3.8 模型"}</small>
          </div>}
          {settings.promptProvider === "ollama" && <label className={styles.field}>
            <span>Ollama 模型</span>
            <select value={settings.ollamaModel} onChange={(event) => updateSettings({ ollamaModel: event.target.value })}>
              {ollamaOptions.map((model) => <option key={model} value={model}>{model}{ollamaModels.includes(model) ? " · 已安裝" : " · 預設"}</option>)}
            </select>
            <small>{ollamaModels.length ? `${ollamaModels.length} 個可用模型` : "尚未取得安裝清單，保留目前預設"}</small>
          </label>}
          {settings.promptProvider === "codex" && <label className={styles.field}>
            <span>Codex 模型</span>
            <select value={settings.codexModel} onChange={(event) => updateSettings({ codexModel: event.target.value })}>
              {codexOptions.map((model) => <option key={model.value} value={model.value}>{model.label || model.value}{model.note ? ` · ${model.note}` : ""}</option>)}
            </select>
            <small>{health?.codex?.models?.length ? `${health.codex.models.length} 個快取模型` : "使用內建備援清單"}</small>
          </label>}
          {settings.promptProvider === "codex" && <label className={styles.field}>
            <span>推理強度（Codex）</span>
            <select value={settings.codexReasoningEffort} onChange={(event) => updateSettings({ codexReasoningEffort: event.target.value })}>
              {reasoningOptions.map((value: string) => <option key={value} value={value}>{REASONING_OPTIONS.find((option) => option.value === value)?.label || value}</option>)}
            </select>
            <small>會依所選 Codex 模型支援程度自動調整。</small>
          </label>}
        </div>
      </section>
    </div>
  );
}
