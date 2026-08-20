import {
    batchOutputName,
    batchSeed,
    buildSingleRenderRequest,
    H3_REALISM_PEOPLE_DEFAULT_STRENGTH,
} from "./single-render-request.mjs";
import { validateSingleRender } from "./single-render-validation.mjs";
import { buildRef2VOrderedReferences, REF2V_WORKFLOW } from "./ref2v-reference-plan.mjs";

export const SINGLE_CREATE_MODES = Object.freeze([
    "t2v",
    "i2v",
    "fl2v",
    "l2v",
    "ref2v",
    "ref2v_motion",
    "replace",
]);

export const SINGLE_CREATE_MODEL_PROFILES = Object.freeze([
    "nvfp4_blackwell",
    "int4_convrot_low_vram",
    "official_pruned_int8_convrot",
    "ref2va_pruned_nvfp4",
    "wan22_animate_fp8",
]);

const DEFAULT_PROFILE = Object.freeze({
    modelProfile: "nvfp4_blackwell",
    width: 736,
    height: 416,
    steps: 20,
});

const REF2V_PROFILE = Object.freeze({
    modelProfile: "ref2va_pruned_nvfp4",
    width: 736,
    height: 416,
    steps: 20,
});

const REPLACE_PROFILE = Object.freeze({
    modelProfile: "wan22_animate_fp8",
    width: 832,
    height: 480,
    steps: 6,
});

export function singleCreateModeDefaults(mode) {
    assertMode(mode);
    if (mode === "replace") return { ...REPLACE_PROFILE };
    if (mode === "ref2v" || mode === "ref2v_motion") return { ...REF2V_PROFILE };
    return { ...DEFAULT_PROFILE };
}

export function singleCreateModelProfilesForMode(mode) {
    assertMode(mode);
    if (mode === "replace") return ["wan22_animate_fp8"];
    if (mode === "ref2v" || mode === "ref2v_motion") return ["ref2va_pruned_nvfp4"];
    return ["nvfp4_blackwell", "int4_convrot_low_vram", "official_pruned_int8_convrot"];
}

export function prepareSingleRenderBatch(input, options = {}) {
    assertMode(input?.mode);
    const isRef2VMode = input.mode === "ref2v" || input.mode === "ref2v_motion";
    const isCharacterMotion = input.mode === "ref2v_motion";
    const requestMode = isRef2VMode ? "ref2v" : input.mode;
    const orderedRef2V = isCharacterMotion
        ? buildRef2VOrderedReferences({
            characterImages: input.referenceImages || [],
            faceImages: input.faceReferenceImages || [],
            clothingMode: input.clothingMode || "character",
            clothingImages: input.clothingReferenceImages || [],
        })
        : { references: (input.referenceImages || []).slice(0, 9), roles: [] };

    const issues = validateSingleRender({
        mode: requestMode,
        prompt: String(input.prompt || ""),
        promptMaxChars: input.promptMaxChars ?? 7000,
        enforcePromptMaxChars: input.enforcePromptMaxChars !== false,
        width: input.width,
        height: input.height,
        duration: input.duration,
        steps: input.steps,
        seed: input.seed,
        renderCount: input.renderCount,
        characterLoraName: input.characterLoraName || "",
        characterLoraStrength: input.characterLoraStrength,
        h3LoraEnabled: input.h3LoraEnabled === true,
        h3LoraStrength: input.h3LoraStrength,
        referenceImage: input.referenceImage || null,
        referenceImages: input.referenceImages || [],
        faceReferenceImages: input.faceReferenceImages || [],
        clothingReferenceImages: input.clothingReferenceImages || [],
        ref2vWorkflow: isCharacterMotion ? REF2V_WORKFLOW : undefined,
        clothingMode: input.clothingMode || "character",
        clothingDescription: input.clothingDescription || "",
        referenceVideoStart: input.referenceVideoStart ?? 0,
        referenceVideoEnd: input.referenceVideoEnd ?? input.duration,
        referenceVideoMaxDimension: input.referenceVideoMaxDimension ?? 720,
        lastFrameImage: input.lastFrameImage || null,
        sourceVideo: input.sourceVideo || null,
    });
    if (issues.length) return { issues, requests: [], requestMode, batchId: "", orderedRef2V };

    const count = Number(input.renderCount);
    const baseSeed = Number(input.seed);
    const batchId = count > 1
        ? (typeof options.batchIdFactory === "function" ? options.batchIdFactory() : createBatchId())
        : "";
    const primaryReference = isRef2VMode
        ? orderedRef2V.references[0] || input.referenceImage || null
        : input.referenceImage || null;
    const referenceImageNames = orderedRef2V.references.map((asset) => asset.name).slice(0, 9);
    const referenceImageRoots = orderedRef2V.references.map((asset) => asset.root).slice(0, 9);

    const requests = Array.from({ length: count }, (_, index) => buildSingleRenderRequest({
        mode: requestMode,
        initialDescription: input.initialDescription || "",
        prompt: input.prompt,
        negativePrompt: input.negativePrompt || "",
        referenceImageName: primaryReference?.kind === "image" ? primaryReference.name : "",
        referenceImageRoot: primaryReference?.kind === "image" ? primaryReference.root : undefined,
        referenceImageNames,
        referenceImageRoots,
        referenceImageRoles: isCharacterMotion ? orderedRef2V.roles : [],
        ref2vWorkflow: isCharacterMotion ? REF2V_WORKFLOW : "",
        clothingMode: isCharacterMotion ? input.clothingMode || "character" : "character",
        clothingDescription: isCharacterMotion ? input.clothingDescription || "" : "",
        referenceVideoStart: isCharacterMotion ? Number(input.referenceVideoStart ?? 0) : 0,
        referenceVideoEnd: isCharacterMotion ? Number(input.referenceVideoEnd ?? input.duration) : Number(input.duration),
        referenceVideoMaxDimension: isCharacterMotion ? Number(input.referenceVideoMaxDimension ?? 720) : 720,
        lastFrameName: input.lastFrameImage?.kind === "image" ? input.lastFrameImage.name : "",
        lastFrameRoot: input.lastFrameImage?.kind === "image" ? input.lastFrameImage.root : undefined,
        sourceVideoName: input.sourceVideo?.kind === "video" ? input.sourceVideo.name : "",
        sourceVideoRoot: input.sourceVideo?.kind === "video" ? input.sourceVideo.root : undefined,
        characterLoraName: input.mode === "replace" ? input.characterLoraName || "" : "",
        characterLoraStrength: input.mode === "replace"
            ? Number(input.characterLoraStrength ?? 0.75)
            : Number(input.h3LoraStrength ?? H3_REALISM_PEOPLE_DEFAULT_STRENGTH),
        h3LoraEnabled: input.mode === "replace" ? undefined : input.h3LoraEnabled === true,
        modelProfile: input.modelProfile,
        width: Number(input.width),
        height: Number(input.height),
        duration: Number(input.duration),
        steps: Number(input.steps),
        seed: batchSeed(baseSeed, index),
        outputName: batchOutputName(input.outputName || "", index, count),
        batchId,
        batchIndex: index + 1,
        batchTotal: count,
        ollamaPromptReceipt: input.ollamaPromptReceipt || "",
    }));

    return { issues: [], requests, requestMode, batchId, orderedRef2V };
}

function createBatchId() {
    return `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function assertMode(mode) {
    if (!SINGLE_CREATE_MODES.includes(mode)) throw new TypeError(`Unknown Single create mode: ${mode}`);
}
