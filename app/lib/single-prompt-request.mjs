const MAX_REF2V_IMAGES = 9;

/**
 * @typedef {{ role: string; data: string }} PromptImage
 */

/**
 * @typedef {{
 *   provider: "ollama" | "codex" | "hermes";
 *   model: string;
 *   codexModel: string;
 *   reasoningEffort: string;
 *   brief: string;
 *   negativePrompt: string;
 *   mode: string;
 *   duration: number;
 *   referenceImageName?: string;
 *   referenceImageNames?: string[];
 *   referenceImageRoles?: string[];
 *   ref2vWorkflow?: string;
 *   clothingMode?: string;
 *   clothingDescription?: string;
 *   referenceVideoStart?: number;
 *   referenceVideoEnd?: number;
 *   referenceVideoMaxDimension?: number;
 *   lastFrameName?: string;
 *   sourceVideoName?: string;
 *   images?: PromptImage[];
 *   cameraPlan?: object;
 *   skill?: string;
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

  if (input.skill) payload.skill = input.skill;

  if (input.mode === "ref2v") {
    payload.referenceImageNames = referenceImageNames;
    payload.referenceImageRoles = (input.referenceImageRoles || []).slice(0, MAX_REF2V_IMAGES);
    payload.ref2vWorkflow = input.ref2vWorkflow || "";
    payload.clothingMode = input.clothingMode || "character";
    payload.clothingDescription = input.clothingDescription || "";
    payload.referenceVideoStart = input.referenceVideoStart ?? 0;
    payload.referenceVideoEnd = input.referenceVideoEnd ?? input.duration;
    payload.referenceVideoMaxDimension = input.referenceVideoMaxDimension ?? 720;
    if (input.cameraPlan && typeof input.cameraPlan === "object") payload.cameraPlan = input.cameraPlan;
  }

  return payload;
}
