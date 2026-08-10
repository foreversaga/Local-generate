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
  { value: "low", label: "Low", note: "最快" },
  { value: "medium", label: "Medium", note: "平衡" },
  { value: "high", label: "High", note: "更完整" },
  { value: "xhigh", label: "XHigh", note: "深度" },
  { value: "max", label: "Max", note: "最高" },
  { value: "ultra", label: "Ultra", note: "自動分工" },
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
    left.codexModel === right.codexModel &&
    left.codexReasoningEffort === right.codexReasoningEffort;
}

function StatusBadge({ value, pending = false }: { value?: boolean; pending?: boolean }) {
  const label = pending ? "Checking" : value ? "Online" : "Offline";
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
    else errors.push(errorMessage(healthResult.reason, "Service health unavailable."));
    if (runtimeResult.status === "fulfilled") {
      setRuntime(runtimeResult.value.runtime || null);
      if (!nextHealth && runtimeResult.value.health) nextHealth = runtimeResult.value.health;
    } else {
      errors.push(errorMessage(runtimeResult.reason, "Runtime status unavailable."));
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
      setRuntimeError(errorMessage(reason, "Runtime switch failed."));
    } finally {
      setSwitching(false);
    }
  }

  return (
    <div className={styles.workspace}>
      <section className={styles.panel} aria-labelledby="runtime-title">
        <div className={styles.sectionHeader}>
          <div>
            <span className={styles.eyebrow}>MODEL RUNTIME</span>
            <h2 id="runtime-title">執行環境</h2>
          </div>
          <StatusBadge value={!statusLoading && Boolean(health?.comfy?.online && health?.ollama?.online)} pending={statusLoading} />
        </div>
        <div className={styles.runtimeGrid}>
          <div className={styles.runtimeCopy}>
            <strong>{runtimeMode === "remote" ? "Vast RTX 5090" : "本機 GPU"}</strong>
            <span>{runtimeMode === "remote" ? "ComfyUI 18188 · Ollama 11435" : "ComfyUI 8188 · Ollama 11434"}</span>
            {activeOperations > 0 && <small>目前有 {activeOperations} 個 runtime operation，切換可能被拒絕。</small>}
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
            <span className={styles.eyebrow}>SERVICE STATUS</span>
            <h2 id="services-title">服務狀態</h2>
          </div>
          <button type="button" className={styles.textButton} onClick={() => void refreshStatus()} disabled={statusLoading}>{statusLoading ? "檢查中…" : "重新檢查"}</button>
        </div>
        {statusError && <p className={styles.error} role="alert">{statusError}</p>}
        <dl className={styles.statusGrid}>
          <div><dt>Bridge</dt><dd><StatusBadge value={health?.bridge} pending={statusLoading} /></dd></div>
          <div><dt>ComfyUI</dt><dd><StatusBadge value={health?.comfy?.online} pending={statusLoading} /></dd><small>{health?.comfy?.url || "—"}</small></div>
          <div><dt>Ollama</dt><dd><StatusBadge value={health?.ollama?.online} pending={statusLoading} /></dd><small>{health?.ollama?.url || "—"}</small></div>
          <div><dt>Codex CLI</dt><dd><StatusBadge value={codexReady} pending={statusLoading} /></dd><small>{health?.codex?.version || (health?.codex?.skill ? "skill ready" : "—")}</small></div>
        </dl>
        <div className={styles.deviceList}>
          <strong>ComfyUI devices</strong>
          {comfyDevices.length ? comfyDevices.map((device, index) => <span key={`${device.name || "device"}-${index}`}>{device.name || `Device ${index + 1}`} · free {formatVram(device.vram_free ?? device.free_memory)} / total {formatVram(device.vram_total ?? device.total_memory)}</span>) : <span>尚未回報 GPU 資訊</span>}
        </div>
      </section>

      <section className={styles.panel} aria-labelledby="defaults-title">
        <div className={styles.sectionHeader}>
          <div>
            <span className={styles.eyebrow}>PROMPT DEFAULTS</span>
            <h2 id="defaults-title">Prompt provider 與模型預設</h2>
          </div>
          <span className={styles.storageNote}>{settingsHydrated ? saveNotice || `Local · ${STUDIO_SETTINGS_STORAGE_KEY}` : "載入中…"}</span>
        </div>
        <p className={styles.helper}>這些偏好會寫入此瀏覽器的 version 1 設定；目前不改變既有 Create payload，供後續 consumer integration 使用。</p>
        <div className={styles.formGrid}>
          <label className={styles.field}>
            <span>Prompt provider</span>
            <select value={settings.promptProvider} onChange={(event) => updateSettings({ promptProvider: event.target.value as "ollama" | "codex" })}>
              <option value="ollama">Ollama</option>
              <option value="codex">Codex CLI</option>
            </select>
            <small>{settings.promptProvider === "ollama" ? (health?.ollama?.online ? "Ollama 在線" : "Ollama 尚未就緒") : (codexReady ? "Codex CLI 與 skill 就緒" : "需要 Codex CLI 與 h3-prompt-writing skill")}</small>
          </label>
          <label className={styles.field}>
            <span>Ollama model</span>
            <select value={settings.ollamaModel} onChange={(event) => updateSettings({ ollamaModel: event.target.value })}>
              {ollamaOptions.map((model) => <option key={model} value={model}>{model}{ollamaModels.includes(model) ? " · installed" : " · default"}</option>)}
            </select>
            <small>{ollamaModels.length ? `${ollamaModels.length} 個 health models` : "尚未取得安裝清單，保留目前預設"}</small>
          </label>
          <label className={styles.field}>
            <span>Codex model</span>
            <select value={settings.codexModel} onChange={(event) => updateSettings({ codexModel: event.target.value })}>
              {codexOptions.map((model) => <option key={model.value} value={model.value}>{model.label || model.value}{model.note ? ` · ${model.note}` : ""}</option>)}
            </select>
            <small>{health?.codex?.models?.length ? `${health.codex.models.length} 個 cache models` : "使用內建 fallback catalog"}</small>
          </label>
          <label className={styles.field}>
            <span>Codex reasoning</span>
            <select value={settings.codexReasoningEffort} onChange={(event) => updateSettings({ codexReasoningEffort: event.target.value })}>
              {reasoningOptions.map((value: string) => <option key={value} value={value}>{REASONING_OPTIONS.find((option) => option.value === value)?.label || value}</option>)}
            </select>
            <small>會依所選 Codex model 支援程度 reconcile。</small>
          </label>
        </div>
      </section>

      <section className={styles.panel} aria-labelledby="runtime-details-title">
        <div className={styles.sectionHeader}>
          <div>
            <span className={styles.eyebrow}>RUNTIME DETAILS</span>
            <h2 id="runtime-details-title">目前端點</h2>
          </div>
        </div>
        <dl className={styles.endpointGrid}>
          <div><dt>Active mode</dt><dd>{runtimeMode}</dd></div>
          <div><dt>ComfyUI</dt><dd>{runtime?.comfyUrl || health?.comfy?.url || "—"}</dd></div>
          <div><dt>Ollama</dt><dd>{runtime?.ollamaUrl || health?.ollama?.url || "—"}</dd></div>
          <div><dt>Runtime operations</dt><dd>{activeOperations}</dd></div>
        </dl>
      </section>
    </div>
  );
}
