import {
    SEEDVR2_DEFAULT_DETAIL,
    SEEDVR2_SKIN_DETAIL_PRESET,
    type SeedVR2BlendingMethod,
    type SeedVR2DetailPreset,
    type SeedVR2Settings,
    type SeedVR2TilingStrategy,
} from "./upscale-client";

export type SeedVR2DetailDraft = {
    detailPreset: SeedVR2DetailPreset;
    inputNoiseScale: string;
    latentNoiseScale: string;
    tileWidth: string;
    tileHeight: string;
    tilePadding: string;
    tileUpscaleResolution: string;
    blendingMethod: SeedVR2BlendingMethod;
    antiAliasingStrength: string;
    maskBlur: string;
    tilingStrategy: SeedVR2TilingStrategy;
};

export type SeedVR2DetailValidationMessages = {
    inputNoiseScale: string;
    latentNoiseScale: string;
    tileWidth: string;
    tileHeight: string;
    tilePadding: string;
    tileUpscaleResolution: string;
    antiAliasingStrength: string;
    maskBlur: string;
};

type ParsedSeedVR2DetailSettings = Required<Pick<
    SeedVR2Settings,
    | "detailPreset"
    | "inputNoiseScale"
    | "latentNoiseScale"
    | "tileWidth"
    | "tileHeight"
    | "tilePadding"
    | "tileUpscaleResolution"
    | "blendingMethod"
    | "antiAliasingStrength"
    | "maskBlur"
    | "tilingStrategy"
>>;

function detailDraftFrom(values: typeof SEEDVR2_DEFAULT_DETAIL | typeof SEEDVR2_SKIN_DETAIL_PRESET): SeedVR2DetailDraft {
    return {
        detailPreset: values.detailPreset,
        inputNoiseScale: String(values.inputNoiseScale),
        latentNoiseScale: String(values.latentNoiseScale),
        tileWidth: String(values.tileWidth),
        tileHeight: String(values.tileHeight),
        tilePadding: String(values.tilePadding),
        tileUpscaleResolution: String(values.tileUpscaleResolution),
        blendingMethod: values.blendingMethod,
        antiAliasingStrength: String(values.antiAliasingStrength),
        maskBlur: String(values.maskBlur),
        tilingStrategy: values.tilingStrategy,
    };
}

export function createDefaultSeedVR2DetailDraft(): SeedVR2DetailDraft {
    return detailDraftFrom(SEEDVR2_DEFAULT_DETAIL);
}

export function createSkinDetailSeedVR2Draft(): SeedVR2DetailDraft {
    return detailDraftFrom(SEEDVR2_SKIN_DETAIL_PRESET);
}

export function isSeedVR2DetailDraftDefault(draft: SeedVR2DetailDraft): boolean {
    const defaults = createDefaultSeedVR2DetailDraft();
    return draft.detailPreset === defaults.detailPreset
        && draft.inputNoiseScale === defaults.inputNoiseScale
        && draft.latentNoiseScale === defaults.latentNoiseScale
        && draft.tileWidth === defaults.tileWidth
        && draft.tileHeight === defaults.tileHeight
        && draft.tilePadding === defaults.tilePadding
        && draft.tileUpscaleResolution === defaults.tileUpscaleResolution
        && draft.blendingMethod === defaults.blendingMethod
        && draft.antiAliasingStrength === defaults.antiAliasingStrength
        && draft.maskBlur === defaults.maskBlur
        && draft.tilingStrategy === defaults.tilingStrategy;
}

function parseDecimal(value: string, min: number, max: number, message: string): number {
    const parsed = Number(value);
    if (value.trim() === "" || !Number.isFinite(parsed) || parsed < min || parsed > max) {
        throw new Error(message);
    }
    return Math.round(parsed * 1000) / 1000;
}

function parseInteger(value: string, min: number, max: number, message: string, multipleOf?: number): number {
    const parsed = Number(value);
    if (value.trim() === "" || !Number.isSafeInteger(parsed) || parsed < min || parsed > max || (multipleOf && parsed % multipleOf !== 0)) {
        throw new Error(message);
    }
    return parsed;
}

export function parseSeedVR2DetailDraft(
    draft: SeedVR2DetailDraft,
    messages: SeedVR2DetailValidationMessages,
): ParsedSeedVR2DetailSettings {
    return {
        detailPreset: draft.detailPreset,
        inputNoiseScale: parseDecimal(draft.inputNoiseScale, 0, 0.2, messages.inputNoiseScale),
        latentNoiseScale: parseDecimal(draft.latentNoiseScale, 0, 0.2, messages.latentNoiseScale),
        tileWidth: parseInteger(draft.tileWidth, 256, 2048, messages.tileWidth, 64),
        tileHeight: parseInteger(draft.tileHeight, 256, 2048, messages.tileHeight, 64),
        tilePadding: parseInteger(draft.tilePadding, 0, 256, messages.tilePadding),
        tileUpscaleResolution: parseInteger(draft.tileUpscaleResolution, 512, 4096, messages.tileUpscaleResolution, 64),
        blendingMethod: draft.blendingMethod,
        antiAliasingStrength: parseDecimal(draft.antiAliasingStrength, 0, 1, messages.antiAliasingStrength),
        maskBlur: parseInteger(draft.maskBlur, 0, 64, messages.maskBlur),
        tilingStrategy: draft.tilingStrategy,
    };
}
