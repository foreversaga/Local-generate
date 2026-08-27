const MAX_REF2V_IMAGES = 9;
const SEED_MODULUS = 2147483648;

export const H3_REALISM_PEOPLE_LORA_NAME = "h3-realism-people-t2v-i2v-r2v.safetensors";
export const H3_REALISM_PEOPLE_LORA_TRIGGER = "r34l1sm";
export const H3_REALISM_PEOPLE_DEFAULT_STRENGTH = 0.8;
export const H3_LORA_SUPPORTED_MODES = Object.freeze(["t2v", "i2v", "fl2v", "l2v", "ref2v"]);

/**
 * @typedef {{
 *   mode: string;
 *   initialDescription?: string;
 *   prompt: string;
 *   negativePrompt: string;
 *   referenceImageName?: string;
 *   referenceImageRoot?: "input" | "output";
 *   referenceImageNames?: string[];
 *   referenceImageRoots?: Array<"input" | "output">;
 *   referenceImageRoles?: string[];
 *   ref2vWorkflow?: string;
 *   clothingMode?: string;
 *   clothingDescription?: string;
 *   referenceVideoStart?: number;
 *   referenceVideoEnd?: number;
 *   referenceVideoMaxDimension?: number;
 *   lastFrameName?: string;
 *   lastFrameRoot?: "input" | "output";
 *   sourceVideoName?: string;
 *   sourceVideoRoot?: "input" | "output";
 *   characterLoraName?: string;
 *   characterLoraId?: string;
 *   characterLoraStrength?: number;
 *   h3LoraEnabled?: boolean;
 *   h3LoraStrength?: number;
 *   h3LoraPreset?: string | null;
 *   characterLoraTrigger?: string | null;
 *   modelProfile: string;
 *   accelerationProfile?: "standard" | "alpha_t1_fast";
 *   width: number;
 *   height: number;
 *   duration: number;
 *   steps: number;
 *   seed: number;
 *   outputName?: string;
 *   batchId?: string;
 *   batchIndex?: number;
 *   batchTotal?: number;
 *   ollamaPromptReceipt?: string;
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
  const characterLoraId = input.mode === "replace" ? String(input.characterLoraId || "").trim() : "";
  const characterLoraName = input.mode === "replace" ? String(input.characterLoraName || "").trim() : "";
  const h3LoraEnabled = input.mode !== "replace" && H3_LORA_SUPPORTED_MODES.includes(input.mode) && input.h3LoraEnabled === true;
  const payload = {
    mode: input.mode,
    initialDescription: String(input.initialDescription || ""),
    prompt: input.prompt,
    negativePrompt: input.negativePrompt,
    inputImageName: input.mode === "i2v" || input.mode === "fl2v" ? referenceImageName : "",
    inputImageRoot: input.mode === "i2v" || input.mode === "fl2v" ? input.referenceImageRoot || "" : "",
    lastImageName: input.mode === "fl2v" || input.mode === "l2v" ? input.lastFrameName || "" : "",
    lastImageRoot: input.mode === "fl2v" || input.mode === "l2v" ? input.lastFrameRoot || "" : "",
    inputVideoName: sourceVideoName,
    inputVideoRoot: input.sourceVideoRoot || "",
    referenceImageName,
    referenceImageRoot: input.referenceImageRoot || "",
    modelProfile: input.modelProfile,
    ...(input.accelerationProfile && input.accelerationProfile !== "standard"
      ? { accelerationProfile: input.accelerationProfile }
      : {}),
    width: input.width,
    height: input.height,
    duration: input.duration,
    steps: input.steps,
    seed: input.seed,
    outputName: input.outputName || "",
    batchId: input.batchId || "",
    batchIndex: input.batchIndex ?? 1,
    batchTotal: input.batchTotal ?? 1,
    ...(input.ollamaPromptReceipt ? { ollamaPromptReceipt: input.ollamaPromptReceipt } : {}),
  };

  if (input.mode === "ref2v") {
    payload.referenceImageNames = (input.referenceImageNames || []).slice(0, MAX_REF2V_IMAGES);
    payload.referenceImageRoots = (input.referenceImageRoots || []).slice(0, MAX_REF2V_IMAGES);
    payload.referenceImageRoles = (input.referenceImageRoles || []).slice(0, MAX_REF2V_IMAGES);
    payload.ref2vWorkflow = input.ref2vWorkflow || "";
    payload.clothingMode = input.clothingMode || "character";
    payload.clothingDescription = input.clothingDescription || "";
    payload.referenceVideoStart = input.referenceVideoStart ?? 0;
    payload.referenceVideoEnd = input.referenceVideoEnd ?? input.duration;
    payload.referenceVideoMaxDimension = input.referenceVideoMaxDimension ?? 720;
  }

  if (characterLoraId) {
    payload.characterLoraId = characterLoraId;
    payload.characterLoraStrength = input.characterLoraStrength ?? 0.75;
  } else if (characterLoraName) {
    payload.characterLoraName = characterLoraName;
    payload.characterLoraStrength = input.characterLoraStrength ?? 0.75;
  }

  if (input.mode !== "replace" && H3_LORA_SUPPORTED_MODES.includes(input.mode) && typeof input.h3LoraEnabled === "boolean") {
    if (h3LoraEnabled) {
      payload.h3LoraEnabled = true;
      payload.h3LoraPreset = H3_REALISM_PEOPLE_LORA_NAME;
      payload.characterLoraName = H3_REALISM_PEOPLE_LORA_NAME;
      payload.characterLoraTrigger = H3_REALISM_PEOPLE_LORA_TRIGGER;
      payload.characterLoraStrength = input.h3LoraStrength ?? input.characterLoraStrength ?? H3_REALISM_PEOPLE_DEFAULT_STRENGTH;
    } else {
      payload.h3LoraEnabled = false;
      payload.h3LoraPreset = null;
      payload.characterLoraName = null;
      payload.characterLoraTrigger = null;
      payload.characterLoraStrength = null;
    }
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
