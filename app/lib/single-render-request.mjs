const MAX_REF2V_IMAGES = 9;
const SEED_MODULUS = 2147483648;

/**
 * @typedef {{
 *   mode: string;
 *   prompt: string;
 *   negativePrompt: string;
 *   referenceImageName?: string;
 *   referenceImageNames?: string[];
 *   lastFrameName?: string;
 *   sourceVideoName?: string;
 *   modelProfile: string;
 *   width: number;
 *   height: number;
 *   duration: number;
 *   steps: number;
 *   seed: number;
 *   outputName?: string;
 *   batchId?: string;
 *   batchIndex?: number;
 *   batchTotal?: number;
 * }} SingleRenderRequestInput
 */

/**
 * Build the payload sent to the existing /app/api/generate bridge endpoint.
 * Keep this shape aligned with the legacy Single render flow so the routed UI
 * can migrate without changing backend semantics.
 *
 * @param {SingleRenderRequestInput} input
 */
export function buildSingleRenderRequest(input) {
  const referenceImageName = input.referenceImageName || "";
  const sourceVideoName = input.sourceVideoName || "";
  const payload = {
    mode: input.mode,
    prompt: input.prompt,
    negativePrompt: input.negativePrompt,
    inputImageName: input.mode === "i2v" || input.mode === "fl2v" ? referenceImageName : "",
    lastImageName: input.mode === "fl2v" || input.mode === "l2v" ? input.lastFrameName || "" : "",
    inputVideoName: sourceVideoName,
    referenceImageName,
    modelProfile: input.modelProfile,
    width: input.width,
    height: input.height,
    duration: input.duration,
    steps: input.steps,
    seed: input.seed,
    outputName: input.outputName || "",
    batchId: input.batchId || "",
    batchIndex: input.batchIndex ?? 1,
    batchTotal: input.batchTotal ?? 1,
  };

  if (input.mode === "ref2v") {
    payload.referenceImageNames = (input.referenceImageNames || []).slice(0, MAX_REF2V_IMAGES);
  }

  return payload;
}

/**
 * @param {number} baseSeed
 * @param {number} index
 */
export function batchSeed(baseSeed, index) {
  return (baseSeed + index) % SEED_MODULUS;
}

/**
 * @param {string} value
 * @param {number} index
 * @param {number} total
 */
export function batchOutputName(value, index, total) {
  if (total <= 1) return value;
  const stem = value.trim().replace(/\.[^.]+$/, "") || "h3-render";
  const suffix = String(index + 1).padStart(String(total).length, "0");
  return `${stem}-${suffix}`;
}
