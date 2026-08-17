"use client";

import { useEffect, useRef, useState } from "react";
import {
  parseSingleCreateDraft,
  SINGLE_CREATE_DRAFT_STORAGE_KEY,
} from "../../lib/single-create-draft.mjs";
import { SingleCreateForm } from "./SingleCreateForm";
import styles from "./SingleCreateProgressiveShell.module.css";

type DisclosureState = {
  negativePrompt: boolean;
  promptSettings: boolean;
  scriptLibrary: boolean;
  advancedGeneration: boolean;
  modeAdvanced: boolean;
};

type DisclosureKey = keyof DisclosureState;

type StoredDraft = {
  negativePrompt?: string;
  width?: number | "";
  height?: number | "";
  steps?: number | "";
  seed?: number | "";
  renderCount?: number | "";
  outputName?: string;
  characterLoraName?: string;
  characterLoraStrength?: number | "";
  h3LoraEnabled?: boolean;
  h3LoraStrength?: number | "";
  referenceVideoStart?: number;
  referenceVideoEnd?: number;
  referenceVideoMaxDimension?: number;
  duration?: number;
};

const DEFAULT_DISCLOSURE: DisclosureState = {
  negativePrompt: false,
  promptSettings: false,
  scriptLibrary: false,
  advancedGeneration: false,
  modeAdvanced: false,
};

const ADVANCED_FIELD_IDS = new Set([
  "single-h3-lora",
  "single-h3-lora-strength",
  "single-character-lora",
  "single-character-lora-strength",
  "single-width",
  "single-height",
  "single-steps",
  "single-seed",
  "single-render-count",
  "single-resolution-scale",
]);

const MODE_ADVANCED_FIELD_IDS = new Set([
  "single-reference-video-start",
  "single-reference-video-end",
  "single-reference-video-resolution",
]);

export function SingleCreateProgressiveShell() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [disclosure, setDisclosure] = useState<DisclosureState>(DEFAULT_DISCLOSURE);
  const [hasModeAdvanced, setHasModeAdvanced] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const draft = parseSingleCreateDraft(
          window.localStorage.getItem(SINGLE_CREATE_DRAFT_STORAGE_KEY),
        ) as StoredDraft | null;
        if (!draft) return;

        setDisclosure((current) => ({
          ...current,
          negativePrompt: Boolean(draft.negativePrompt?.trim()),
          advancedGeneration: hasAdvancedGenerationValues(draft),
          modeAdvanced: hasModeAdvancedValues(draft),
        }));
      } catch {
        // UI disclosure must never block the existing Create form from loading.
      }
    }, 0);

    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const syncModeAdvancedAvailability = () => {
      setHasModeAdvanced(Boolean(root.querySelector("#single-reference-video-start")));
    };
    syncModeAdvancedAvailability();

    const observer = new MutationObserver(syncModeAdvancedAvailability);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const revealInvalidDisclosure = () => {
      const invalidElements = Array.from(
        root.querySelectorAll<HTMLElement>("[aria-invalid='true']"),
      );
      if (!invalidElements.length) return;

      const invalidIds = new Set(invalidElements.map((element) => element.id).filter(Boolean));
      const shouldOpenAdvanced = [...invalidIds].some((id) => ADVANCED_FIELD_IDS.has(id));
      const shouldOpenModeAdvanced = [...invalidIds].some((id) => MODE_ADVANCED_FIELD_IDS.has(id));

      if (shouldOpenAdvanced || shouldOpenModeAdvanced) {
        setDisclosure((current) => ({
          ...current,
          advancedGeneration: current.advancedGeneration || shouldOpenAdvanced,
          modeAdvanced: current.modeAdvanced || shouldOpenModeAdvanced,
        }));
      }
    };

    const observer = new MutationObserver(revealInvalidDisclosure);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["aria-invalid"],
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, []);

  function toggle(key: DisclosureKey) {
    setDisclosure((current) => ({ ...current, [key]: !current[key] }));
  }

  return (
    <div
      ref={rootRef}
      className={styles.root}
      data-show-negative-prompt={disclosure.negativePrompt}
      data-show-prompt-settings={disclosure.promptSettings}
      data-show-script-library={disclosure.scriptLibrary}
      data-show-advanced-generation={disclosure.advancedGeneration}
      data-show-mode-advanced={disclosure.modeAdvanced}
    >
      <section className={styles.optionalControls} aria-label="單次影片選填設定">
        <div className={styles.optionalHeading}>
          <div>
            <strong>選填設定</strong>
            <span>預設只顯示常用項目，需要時再打開。</span>
          </div>
        </div>
        <div className={styles.toggleGrid}>
          <DisclosureToggle
            label="負面提示詞"
            note="限制不希望出現的內容"
            enabled={disclosure.negativePrompt}
            onToggle={() => toggle("negativePrompt")}
          />
          <DisclosureToggle
            label="提示詞 AI 設定"
            note="切換 Provider、模型與 Reasoning"
            enabled={disclosure.promptSettings}
            onToggle={() => toggle("promptSettings")}
          />
          <DisclosureToggle
            label="劇本庫"
            note="載入、儲存或管理既有提示詞"
            enabled={disclosure.scriptLibrary}
            onToggle={() => toggle("scriptLibrary")}
          />
          <DisclosureToggle
            label="進階生成設定"
            note="模型、LoRA、解析度、Steps、Seed 等"
            enabled={disclosure.advancedGeneration}
            onToggle={() => toggle("advancedGeneration")}
          />
          {hasModeAdvanced && (
            <DisclosureToggle
              label="模式進階設定"
              note="參考影片片段與預處理"
              enabled={disclosure.modeAdvanced}
              onToggle={() => toggle("modeAdvanced")}
            />
          )}
        </div>
      </section>

      <SingleCreateForm />
    </div>
  );
}

function DisclosureToggle({
  label,
  note,
  enabled,
  onToggle,
}: {
  label: string;
  note: string;
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      className={`${styles.toggle} ${enabled ? styles.toggleActive : ""}`}
      onClick={onToggle}
    >
      <span className={styles.toggleCopy}>
        <strong>{label}</strong>
        <small>{note}</small>
      </span>
      <span className={styles.switchTrack} aria-hidden="true">
        <span className={styles.switchThumb} />
      </span>
    </button>
  );
}

function hasAdvancedGenerationValues(draft: StoredDraft) {
  return Boolean(
    draft.outputName?.trim()
    || draft.characterLoraName?.trim()
    || draft.h3LoraEnabled
    || (draft.width !== undefined && draft.width !== "" && Number(draft.width) !== 736)
    || (draft.height !== undefined && draft.height !== "" && Number(draft.height) !== 416)
    || (draft.renderCount !== undefined && draft.renderCount !== "" && Number(draft.renderCount) !== 1)
    || (draft.steps !== undefined && draft.steps !== "" && Number(draft.steps) !== 20)
    || (draft.seed !== undefined && draft.seed !== "" && Number(draft.seed) !== 12345)
    || (draft.characterLoraStrength !== undefined && draft.characterLoraStrength !== "" && Number(draft.characterLoraStrength) !== 0.75)
    || (draft.h3LoraStrength !== undefined && draft.h3LoraStrength !== "" && Number(draft.h3LoraStrength) !== 0.8)
  );
}

function hasModeAdvancedValues(draft: StoredDraft) {
  const start = Number(draft.referenceVideoStart ?? 0);
  const end = Number(draft.referenceVideoEnd ?? draft.duration ?? 5);
  const duration = Number(draft.duration ?? 5);
  const maxDimension = Number(draft.referenceVideoMaxDimension ?? 720);
  return start !== 0 || maxDimension !== 720 || Math.abs(end - duration) > 0.001;
}
