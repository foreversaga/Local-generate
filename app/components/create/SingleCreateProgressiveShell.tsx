"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import {
  parseSingleCreateDraft,
  SINGLE_CREATE_DRAFT_STORAGE_KEY,
} from "../../lib/single-create-draft.mjs";
import { SingleCreateForm } from "./SingleCreateForm";
import styles from "./SingleCreateProgressiveShell.module.css";

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

const PROFESSIONAL_FIELD_IDS = new Set([
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
  "single-reference-video-start",
  "single-reference-video-end",
  "single-reference-video-resolution",
]);

export function SingleCreateProgressiveShell() {
  const { locale } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const [professional, setProfessional] = useState(false);
  const zh = locale.toLowerCase().startsWith("zh");
  const copy = zh
    ? {
      heading: "先完成作品，再調技術參數",
      description: "基本模式保留素材、提示詞、片段長度與檢查；模型、LoRA、解析度、Steps、Seed 與 Provider 收在專業設定。",
      professional: "專業設定",
      open: "已展開完整控制",
      closed: "需要時再展開",
    }
    : {
      heading: "Create first, tune technical controls when needed",
      description: "Basic mode keeps assets, prompts, duration, and validation in focus. Models, LoRA, resolution, steps, seed, and providers live under Professional settings.",
      professional: "Professional settings",
      open: "Full controls expanded",
      closed: "Expand when needed",
    };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const draft = parseSingleCreateDraft(
          window.localStorage.getItem(SINGLE_CREATE_DRAFT_STORAGE_KEY),
        ) as StoredDraft | null;
        if (draft && hasProfessionalValues(draft)) setProfessional(true);
      } catch {
        // Disclosure must never prevent the existing Create form from loading.
      }
    }, 0);

    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const revealHiddenValidation = () => {
      const invalidIds = Array.from(
        root.querySelectorAll<HTMLElement>("[aria-invalid='true']"),
        (element) => element.id,
      ).filter(Boolean);

      if (invalidIds.some((id) => PROFESSIONAL_FIELD_IDS.has(id))) {
        setProfessional(true);
      }
    };

    const observer = new MutationObserver(revealHiddenValidation);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["aria-invalid"],
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={rootRef}
      className={styles.root}
      data-professional={professional}
    >
      <section className={styles.experienceBar} aria-labelledby="single-experience-heading">
        <div className={styles.experienceCopy}>
          <span className={styles.eyebrow}>SINGLE CREATE</span>
          <div>
            <strong id="single-experience-heading">{copy.heading}</strong>
            <span>{copy.description}</span>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={professional}
          aria-controls="single-source-section single-prompt-section single-setup-section single-review-section"
          className={`${styles.professionalToggle} ${professional ? styles.professionalToggleActive : ""}`}
          onClick={() => setProfessional((current) => !current)}
        >
          <span>
            <strong>{copy.professional}</strong>
            <small>{professional ? copy.open : copy.closed}</small>
          </span>
          <span className={styles.switchTrack} aria-hidden="true">
            <span className={styles.switchThumb} />
          </span>
        </button>
      </section>

      <SingleCreateForm />
    </div>
  );
}

function hasProfessionalValues(draft: StoredDraft) {
  const start = Number(draft.referenceVideoStart ?? 0);
  const end = Number(draft.referenceVideoEnd ?? draft.duration ?? 5);
  const duration = Number(draft.duration ?? 5);
  const maxDimension = Number(draft.referenceVideoMaxDimension ?? 720);

  return Boolean(
    draft.negativePrompt?.trim()
    || draft.outputName?.trim()
    || draft.characterLoraName?.trim()
    || draft.h3LoraEnabled
    || (draft.width !== undefined && draft.width !== "" && Number(draft.width) !== 736)
    || (draft.height !== undefined && draft.height !== "" && Number(draft.height) !== 416)
    || (draft.renderCount !== undefined && draft.renderCount !== "" && Number(draft.renderCount) !== 1)
    || (draft.steps !== undefined && draft.steps !== "" && Number(draft.steps) !== 20)
    || (draft.seed !== undefined && draft.seed !== "" && Number(draft.seed) !== 12345)
    || (draft.characterLoraStrength !== undefined && draft.characterLoraStrength !== "" && Number(draft.characterLoraStrength) !== 0.75)
    || (draft.h3LoraStrength !== undefined && draft.h3LoraStrength !== "" && Number(draft.h3LoraStrength) !== 0.8)
    || start !== 0
    || maxDimension !== 720
    || Math.abs(end - duration) > 0.001
  );
}
