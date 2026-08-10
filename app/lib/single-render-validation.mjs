/** @typedef {number | ""} NumberDraft */

/**
 * @typedef {{ name: string }} SingleRenderAssetRef
 */

/**
 * @typedef {{
 *   mode: string;
 *   prompt: string;
 *   promptMaxChars?: number;
 *   enforcePromptMaxChars?: boolean;
 *   width: NumberDraft;
 *   height: NumberDraft;
 *   steps: NumberDraft;
 *   seed: NumberDraft;
 *   renderCount: NumberDraft;
 *   referenceImage: SingleRenderAssetRef | null;
 *   referenceImages: SingleRenderAssetRef[];
 *   lastFrameImage: SingleRenderAssetRef | null;
 *   sourceVideo: SingleRenderAssetRef | null;
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

  issues.push(...validateRequiredAssets(input));

  const dimensionGrid = input.mode === "replace" ? 16 : 32;
  issues.push(...validateDimension(input.width, "width", "影片寬度", dimensionGrid));
  issues.push(...validateDimension(input.height, "height", "影片高度", dimensionGrid));
  issues.push(...validateNumber(input.steps, "steps", {
    label: "Steps",
    min: 1,
    max: 80,
    integer: true,
  }));
  issues.push(...validateNumber(input.seed, "seed", {
    label: "Seed",
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

  return issues;
}

/**
 * @param {SingleRenderValidationInput} input
 * @returns {ValidationIssue[]}
 */
function validateRequiredAssets(input) {
  const issues = [];

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
