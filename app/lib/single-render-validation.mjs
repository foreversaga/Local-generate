/** @typedef {number | ""} NumberDraft */

const H3_LORA_SUPPORTED_MODES = new Set(["t2v", "i2v", "fl2v", "l2v", "ref2v"]);

import {
  SINGLE_RENDER_DURATION_MAX_SECONDS,
  SINGLE_RENDER_DURATION_UI_MIN_SECONDS,
} from "./single-duration.mjs";

/**
 * @typedef {{ name: string }} SingleRenderAssetRef
 */

/**
 * @typedef {{
 *   mode: string;
 *   referenceImage: SingleRenderAssetRef | null;
 *   referenceImages: SingleRenderAssetRef[];
 *   faceReferenceImages?: SingleRenderAssetRef[];
 *   clothingReferenceImages?: SingleRenderAssetRef[];
 *   ref2vWorkflow?: string;
 *   clothingMode?: string;
 *   clothingDescription?: string;
 *   referenceVideoStart?: NumberDraft;
 *   referenceVideoEnd?: NumberDraft;
 *   referenceVideoMaxDimension?: NumberDraft;
 *   duration?: NumberDraft;
 *   lastFrameImage: SingleRenderAssetRef | null;
 *   sourceVideo: SingleRenderAssetRef | null;
 *   characterLoraName?: string;
 *   characterLoraStrength?: NumberDraft;
 *   h3LoraEnabled?: boolean;
 *   h3LoraStrength?: NumberDraft;
 * }} SingleRenderAssetValidationInput
 */

/**
 * @typedef {SingleRenderAssetValidationInput & {
 *   prompt: string;
 *   promptMaxChars?: number;
 *   enforcePromptMaxChars?: boolean;
 *   width: NumberDraft;
 *   height: NumberDraft;
 *   duration: NumberDraft;
 *   steps: NumberDraft;
 *   seed: NumberDraft;
 *   renderCount: NumberDraft;
 * }} SingleRenderValidationInput
 */

/**
 * @typedef {{ field: string; message: string }} ValidationIssue
 */

/**
 * @typedef {{ label: string; min: number; max: number; integer?: boolean }} NumericRule
 */

/**
 * Validate a Single render without mutating UI state.
 * The same result can be reused by CTA gating and the submit handler.
 *
 * @param {SingleRenderValidationInput} input
 * @returns {ValidationIssue[]}
 */
export function validateSingleRender(input) {
  const issues = [];
  const prompt = input.prompt.trim();

  if (!prompt) {
    issues.push(issue("prompt", "請先填入提示詞。"));
  } else if (
    input.mode !== "replace"
    && input.enforcePromptMaxChars
    && Number.isFinite(input.promptMaxChars)
    && input.prompt.length > input.promptMaxChars
  ) {
    issues.push(issue(
      "prompt",
      `H3 提示詞不可超過 ${input.promptMaxChars} 字元，目前為 ${input.prompt.length} 字元。`,
    ));
  }

  issues.push(...validateSingleRenderAssets(input));

  const dimensionGrid = input.mode === "replace" ? 16 : 32;
  issues.push(...validateDimension(input.width, "width", "影片寬度", dimensionGrid));
  issues.push(...validateDimension(input.height, "height", "影片高度", dimensionGrid));
  issues.push(...validateNumber(input.duration, "duration", {
    label: "影片時長（秒）",
    min: SINGLE_RENDER_DURATION_UI_MIN_SECONDS,
    max: SINGLE_RENDER_DURATION_MAX_SECONDS,
  }));
  issues.push(...validateNumber(input.steps, "steps", {
    label: "採樣步數（Steps）",
    min: 1,
    max: 80,
    integer: true,
  }));
  issues.push(...validateNumber(input.seed, "seed", {
    label: "隨機種子（Seed）",
    min: 0,
    max: 2147483647,
    integer: true,
  }));
  issues.push(...validateNumber(input.renderCount, "renderCount", {
    label: "影片數量",
    min: 1,
    max: 20,
    integer: true,
  }));

  if (input.mode === "replace") {
    const characterLoraName = typeof input.characterLoraName === "string" ? input.characterLoraName.trim() : "";
    if (characterLoraName) {
      issues.push(...validateCharacterLoraName(characterLoraName));
      issues.push(...validateCharacterLoraStrength(input.characterLoraStrength));
    }
  }

  if (input.mode !== "replace" && H3_LORA_SUPPORTED_MODES.has(input.mode) && input.h3LoraEnabled === true) {
    issues.push(...validateCharacterLoraStrength(input.h3LoraStrength));
  }

  return issues;
}

/**
 * @param {SingleRenderAssetValidationInput} input
 * @returns {ValidationIssue[]}
 */
export function validateSingleRenderAssets(input) {
  const issues = [];

  if (input.mode === "ref2v" && input.ref2vWorkflow === "character_motion") {
    const characterImages = Array.isArray(input.referenceImages) ? input.referenceImages : [];
    const faceImages = Array.isArray(input.faceReferenceImages) ? input.faceReferenceImages : [];
    const clothingImages = Array.isArray(input.clothingReferenceImages) ? input.clothingReferenceImages : [];
    const total = characterImages.length + faceImages.length + (input.clothingMode === "reference" ? clothingImages.length : 0);
    if (!characterImages.length) issues.push(issue("referenceImages", "角色動作參考需要至少一張角色參考圖片。"));
    if (!input.sourceVideo) issues.push(issue("sourceVideo", "角色動作參考需要一段動作參考影片。"));
    if (total > 9) issues.push(issue("referenceImages", "角色、臉部與服裝參考圖片合計最多 9 張。"));
    if (input.clothingMode === "reference" && !clothingImages.length) {
      issues.push(issue("clothingReferenceImages", "選擇服裝參考圖片時，請至少加入一張服裝圖片。"));
    }
    if (input.clothingMode === "description" && !String(input.clothingDescription || "").trim()) {
      issues.push(issue("clothingDescription", "選擇自行描述服裝時，請填寫服裝描述。"));
    }
    const clipStart = Number(input.referenceVideoStart);
    const clipEnd = Number(input.referenceVideoEnd);
    if (!Number.isFinite(clipStart) || clipStart < 0) issues.push(issue("referenceVideoStart", "參考影片開始時間必須大於或等於 0。"));
    if (!Number.isFinite(clipEnd) || clipEnd <= clipStart) issues.push(issue("referenceVideoEnd", "參考影片結束時間必須晚於開始時間。"));
    const clipDuration = clipEnd - clipStart;
    if (Number.isFinite(clipDuration) && (clipDuration < 0.5 || clipDuration > 60)) issues.push(issue("referenceVideoEnd", "參考影片片段長度必須介於 0.5–60 秒。"));
    if (Number.isFinite(Number(input.duration)) && Number.isFinite(clipDuration) && Math.abs(Number(input.duration) - clipDuration) > 0.001) {
      issues.push(issue("duration", "輸出影片長度必須與參考影片片段相同。"));
    }
    if (![0, 480, 720, 960].includes(Number(input.referenceVideoMaxDimension))) {
      issues.push(issue("referenceVideoMaxDimension", "請選擇有效的參考影片解析度。"));
    }
    return issues;
  }

  if (input.mode === "ref2v" && input.referenceImages.length === 0 && !input.sourceVideo) {
    issues.push(issue("referenceImages", "Ref2VA 至少需要一個參考圖片或參考影片。"));
  }

  if (input.mode === "i2v" && !input.referenceImage) {
    issues.push(issue("referenceImage", "I2VA 需要參考圖片。"));
  }

  if (input.mode === "fl2v") {
    if (!input.referenceImage) {
      issues.push(issue("referenceImage", "FL2VA 需要首幀圖片。"));
    }
    if (!input.lastFrameImage) {
      issues.push(issue("lastFrameImage", "FL2VA 需要尾幀圖片。"));
    }
  }

  if (input.mode === "l2v" && !input.lastFrameImage) {
    issues.push(issue("lastFrameImage", "L2VA 需要尾幀圖片。"));
  }

  if (input.mode === "replace") {
    if (!input.referenceImage) {
      issues.push(issue("referenceImage", "影片替換需要參考圖片。"));
    }
    if (!input.sourceVideo) {
      issues.push(issue("sourceVideo", "影片替換需要來源影片。"));
    }
  }

  return issues;
}

/**
 * Validate a user-provided relative path under ComfyUI/models/loras.
 * The bridge repeats this check before spawning the generator.
 *
 * @param {unknown} value
 * @returns {ValidationIssue[]}
 */
export function validateCharacterLoraName(value) {
  if (typeof value !== "string") return [issue("characterLoraName", "Character LoRA name must be text.")];
  const normalized = value.trim().replaceAll("\\", "/");
  if (!normalized) return [];
  const segments = normalized.split("/");
  if (
    normalized.length > 512
    || normalized.startsWith("/")
    || /^[A-Za-z]:/.test(normalized)
    || normalized.includes("\0")
    || segments.some((segment) => !segment || segment === "." || segment === ".." || /[<>:"|?*]/.test(segment))
  ) {
    return [issue("characterLoraName", "Character LoRA must be a safe relative path under models/loras.")];
  }
  return [];
}

/**
 * @param {NumberDraft | undefined} value
 * @returns {ValidationIssue[]}
 */
export function validateCharacterLoraStrength(value) {
  if (value === "" || value === undefined || value === null) {
    return [issue("characterLoraStrength", "Character LoRA strength must be between 0 and 2.")];
  }
  if (!Number.isFinite(value) || value < 0 || value > 2) {
    return [issue("characterLoraStrength", "Character LoRA strength must be between 0 and 2.")];
  }
  return [];
}

/**
 * @param {NumberDraft} value
 * @param {string} field
 * @param {string} label
 * @param {number} grid
 * @returns {ValidationIssue[]}
 */
function validateDimension(value, field, label, grid) {
  const numericIssues = validateNumber(value, field, {
    label,
    min: 32,
    max: 2048,
    integer: true,
  });
  if (numericIssues.length) return numericIssues;

  if (value % grid !== 0) {
    return [issue(field, `${label} 必須是 ${grid} 的倍數。`)];
  }

  return [];
}

/**
 * @param {NumberDraft} value
 * @param {string} field
 * @param {NumericRule} rule
 * @returns {ValidationIssue[]}
 */
function validateNumber(value, field, rule) {
  if (value === "") {
    return [issue(field, `${rule.label} 必須填寫。`)];
  }
  if (!Number.isFinite(value)) {
    return [issue(field, `${rule.label} 必須是有效數字。`)];
  }
  if (rule.integer && !Number.isInteger(value)) {
    return [issue(field, `${rule.label} 必須是整數。`)];
  }
  if (value < rule.min || value > rule.max) {
    return [issue(field, `${rule.label} 必須介於 ${rule.min}–${rule.max}。`)];
  }
  return [];
}

/**
 * @param {string} field
 * @param {string} message
 * @returns {ValidationIssue}
 */
function issue(field, message) {
  return { field, message };
}
