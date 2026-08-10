const MAX_REF2V_IMAGES = 9;

/**
 * @typedef {{ role: string; data: string }} PromptImage
 */

/**
 * @typedef {{
 *   provider: "ollama" | "codex";
 *   model: string;
 *   codexModel: string;
 *   reasoningEffort: string;
 *   brief: string;
 *   negativePrompt: string;
 *   mode: string;
 *   duration: number;
 *   referenceImageName?: string;
 *   referenceImageNames?: string[];
 *   lastFrameName?: string;
 *   sourceVideoName?: string;
 *   images?: PromptImage[];
 * }} SinglePromptRequestInput
 */

/**
 * Build the request sent to the existing /app/api/prompt bridge endpoint.
 * This preserves the legacy Single prompt-generation payload shape.
 *
 * @param {SinglePromptRequestInput} input
 */
export function buildSinglePromptRequest(input) {
  const referenceImageNames = (input.referenceImageNames || []).slice(0, MAX_REF2V_IMAGES);
  const referenceImageName = input.mode === "ref2v"
    ? referenceImageNames[0] || ""
    : input.referenceImageName || "";

  const payload = {
    provider: input.provider,
    model: input.model,
    codexModel: input.codexModel,
    reasoningEffort: input.reasoningEffort,
    brief: input.brief,
    negativePrompt: input.negativePrompt,
    mode: input.mode,
    duration: input.duration,
    referenceImageName,
    firstFrameName: input.referenceImageName || "",
    lastFrameName: input.lastFrameName || "",
    sourceVideoName: input.sourceVideoName || "",
    images: input.images || [],
  };

  if (input.mode === "ref2v") {
    payload.referenceImageNames = referenceImageNames;
  }

  return payload;
}
