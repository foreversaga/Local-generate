import { assetUrl, type StudioAsset } from "../library/asset-client";

export const UPSCALE_SCALE = 2 as const;
export const SEEDVR2_SCALE_MIN = 1;
export const SEEDVR2_SCALE_MAX = 4;
const BRIDGE_URL = "/app";

export const SEEDVR2_RESIZE_METHODS = [
    { id: "lanczos", label: "Lanczos（細節清晰）" },
    { id: "bicubic", label: "Bicubic（較柔和）" },
    { id: "bilinear", label: "Bilinear（速度優先）" },
    { id: "area", label: "Area（縮放穩定）" },
    { id: "nearest-exact", label: "Nearest（像素風格）" },
] as const;

export const SEEDVR2_COLOR_CORRECTIONS = [
    { id: "wavelet", label: "Wavelet（保留高頻細節）" },
    { id: "lab", label: "LAB（色彩最貼近原圖）" },
    { id: "adain", label: "AdaIN（快速全域校色）" },
    { id: "none", label: "不校色" },
] as const;

export const SEEDVR2_SAMPLERS = [
    { id: "euler", label: "Euler（官方預設）" },
    { id: "euler_ancestral", label: "Euler Ancestral" },
    { id: "heun", label: "Heun" },
    { id: "dpmpp_2m", label: "DPM++ 2M" },
    { id: "dpmpp_2m_sde", label: "DPM++ 2M SDE" },
    { id: "dpmpp_3m_sde", label: "DPM++ 3M SDE" },
    { id: "res_multistep", label: "RES Multistep" },
] as const;

export const SEEDVR2_SCHEDULERS = [
    { id: "simple", label: "Simple（官方預設）" },
    { id: "normal", label: "Normal" },
    { id: "karras", label: "Karras" },
    { id: "exponential", label: "Exponential" },
    { id: "sgm_uniform", label: "SGM Uniform" },
    { id: "ddim_uniform", label: "DDIM Uniform" },
    { id: "beta", label: "Beta" },
] as const;

export const SEEDVR2_DETAIL_PRESETS = [
    { id: "default", label: "預設" },
    { id: "skin_detail", label: "皮膚細節" },
] as const;

export const SEEDVR2_BLENDING_METHODS = [
    { id: "multiband", label: "Multiband" },
    { id: "linear", label: "Linear" },
    { id: "gaussian", label: "Gaussian" },
] as const;

export const SEEDVR2_TILING_STRATEGIES = [
    { id: "chess", label: "Chess" },
    { id: "grid", label: "Grid" },
] as const;

export const SEEDVR2_DEFAULT_SAMPLING = {
    steps: 1,
    cfg: 1,
    samplerName: "euler",
    scheduler: "simple",
    denoise: 1,
} as const;

export const SEEDVR2_DEFAULT_DETAIL = {
    detailPreset: "default",
    inputNoiseScale: 0,
    latentNoiseScale: 0,
    tileWidth: 1024,
    tileHeight: 1024,
    tilePadding: 64,
    tileUpscaleResolution: 2048,
    blendingMethod: "multiband",
    antiAliasingStrength: 0,
    maskBlur: 0,
    tilingStrategy: "chess",
} as const;

export const SEEDVR2_SKIN_DETAIL_PRESET = {
    scale: 2,
    resizeMethod: "lanczos",
    colorCorrection: "wavelet",
    ...SEEDVR2_DEFAULT_SAMPLING,
    detailPreset: "skin_detail",
    inputNoiseScale: 0.035,
    latentNoiseScale: 0,
    tileWidth: 1024,
    tileHeight: 1024,
    tilePadding: 64,
    tileUpscaleResolution: 2048,
    blendingMethod: "multiband",
    antiAliasingStrength: 0,
    maskBlur: 0,
    tilingStrategy: "chess",
} as const;

export type SeedVR2ResizeMethod = typeof SEEDVR2_RESIZE_METHODS[number]["id"];
export type SeedVR2ColorCorrection = typeof SEEDVR2_COLOR_CORRECTIONS[number]["id"];
export type SeedVR2SamplerName = typeof SEEDVR2_SAMPLERS[number]["id"];
export type SeedVR2Scheduler = typeof SEEDVR2_SCHEDULERS[number]["id"];
export type SeedVR2DetailPreset = typeof SEEDVR2_DETAIL_PRESETS[number]["id"];
export type SeedVR2BlendingMethod = typeof SEEDVR2_BLENDING_METHODS[number]["id"];
export type SeedVR2TilingStrategy = typeof SEEDVR2_TILING_STRATEGIES[number]["id"];

export type SeedVR2Settings = {
    scale: number;
    seed?: number;
    resizeMethod: SeedVR2ResizeMethod;
    colorCorrection: SeedVR2ColorCorrection;
    steps?: number;
    cfg?: number;
    samplerName?: SeedVR2SamplerName;
    scheduler?: SeedVR2Scheduler;
    denoise?: number;
    detailPreset?: SeedVR2DetailPreset;
    inputNoiseScale?: number;
    latentNoiseScale?: number;
    tileWidth?: number;
    tileHeight?: number;
    tilePadding?: number;
    tileUpscaleResolution?: number;
    blendingMethod?: SeedVR2BlendingMethod;
    antiAliasingStrength?: number;
    maskBlur?: number;
    tilingStrategy?: SeedVR2TilingStrategy;
};

export const UPSCALE_PROFILES = [
    {
        id: "seedvr2_7b_sharp_fp16",
        label: "SeedVR2 7B Sharp FP16 · 高品質預設",
        description: "最高品質的 SeedVR2 7B Sharp FP16；適合追求肌膚、髮絲與材質細節。",
        supportsImages: true,
    },
    {
        id: "seedvr2_7b_sharp_nvfp4",
        label: "SeedVR2 7B Sharp NVFP4",
        description: "較省記憶體的高品質圖片與影片重建；支援 wavelet 色彩校正，但不支援 Tiled Detail / Skin Detail。",
        supportsImages: true,
    },
] as const;

export type UpscaleProfile = typeof UPSCALE_PROFILES[number]["id"];
export const DEFAULT_UPSCALE_UI_PROFILE: UpscaleProfile = "seedvr2_7b_sharp_fp16";
export const DEFAULT_UPSCALE_PROFILE: UpscaleProfile = "seedvr2_7b_sharp_fp16";

export type UpscaleJobStatus = "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled" | "interrupted";

export type UpscaleJobRecovery = {
    reason?: string;
    previousStatus?: string;
    recoveredBy?: string;
    recoveredAt?: string | null;
};

export type UpscaleJob = {
    id: string;
    status: UpscaleJobStatus;
    progress: number;
    stage: string;
    sourceName: string;
    sourceRoot?: "input" | "output";
    source?: { name: string; root: "input" | "output" };
    scale: number;
    profile?: string;
    seed?: number;
    resizeMethod?: SeedVR2ResizeMethod;
    colorCorrection?: SeedVR2ColorCorrection;
    steps?: number;
    cfg?: number;
    samplerName?: SeedVR2SamplerName;
    scheduler?: SeedVR2Scheduler;
    denoise?: number;
    detailPreset?: SeedVR2DetailPreset;
    inputNoiseScale?: number;
    latentNoiseScale?: number;
    tileWidth?: number;
    tileHeight?: number;
    tilePadding?: number;
    tileUpscaleResolution?: number;
    blendingMethod?: SeedVR2BlendingMethod;
    antiAliasingStrength?: number;
    maskBlur?: number;
    tilingStrategy?: SeedVR2TilingStrategy;
    prompt?: Record<string, unknown> | null;
    promptId?: string;
    output?: StudioAsset | null;
    error?: string;
    cancelReason?: string;
    attempt?: number;
    retryOf?: string;
    recoverable?: boolean;
    recovery?: UpscaleJobRecovery | null;
    provenance?: Record<string, unknown> | null;
    createdAt?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
    cancelledAt?: string | null;
    updatedAt?: string | null;
    timestamps?: Record<string, string | null>;
};

export type UpscaleHealth = {
    ready: boolean;
    comfyUi: boolean;
    profile?: UpscaleProfile | string;
    profileLabel?: string;
    sourceKind?: "image" | "video";
    models: Record<string, { name?: string; available?: boolean }>;
    nodes: Record<string, boolean>;
    detail?: {
        requested: boolean;
        node: string;
        available: boolean;
        missingInputs: string[];
        invalidInputs: string[];
        unsupported: Record<string, string[]>;
    };
};

export type UpscaleHealthOptions = {
    detailMode?: boolean;
    detailPreset?: SeedVR2DetailPreset;
    blendingMethod?: SeedVR2BlendingMethod;
    tilingStrategy?: SeedVR2TilingStrategy;
};

export class UpscaleApiError extends Error {
    readonly status: number;
    readonly code?: string;
    readonly health?: UpscaleHealth;

    constructor(message: string, status: number, code?: string, health?: UpscaleHealth) {
        super(message);
        this.name = "UpscaleApiError";
        this.status = status;
        this.code = code;
        this.health = health;
    }
}

type ErrorPayload = {
    error?: string | { message?: string };
    code?: string;
    health?: UpscaleHealth;
};

function errorMessage(payload: ErrorPayload, fallback: string) {
    return typeof payload.error === "string" ? payload.error : payload.error?.message || fallback;
}

async function readJson<T extends object>(response: Response): Promise<T> {
    const payload = await response.json().catch(() => ({})) as T & ErrorPayload;
    if (!response.ok) {
        throw new UpscaleApiError(
            errorMessage(payload, "Upscale request failed."),
            response.status,
            payload.code,
            payload.health,
        );
    }
    return payload;
}

export async function fetchUpscaleHealth(
    profile: UpscaleProfile = DEFAULT_UPSCALE_PROFILE,
    kind: "image" | "video" = "video",
    options: UpscaleHealthOptions = {},
): Promise<UpscaleHealth> {
    const query = new URLSearchParams({ profile, kind });
    if (options.detailMode) {
        query.set("detail", "1");
        if (options.detailPreset) query.set("detailPreset", options.detailPreset);
        if (options.blendingMethod) query.set("blendingMethod", options.blendingMethod);
        if (options.tilingStrategy) query.set("tilingStrategy", options.tilingStrategy);
    }
    const response = await fetch(`${BRIDGE_URL}/api/upscale/health?${query.toString()}`, { cache: "no-store" });
    return (await readJson<{ ready?: boolean; comfyUi?: boolean; models?: UpscaleHealth["models"]; nodes?: UpscaleHealth["nodes"] }>(response)) as UpscaleHealth;
}

export async function submitUpscale(
    source: Pick<StudioAsset, "name" | "root" | "kind">,
    profile: UpscaleProfile = DEFAULT_UPSCALE_PROFILE,
    settings?: SeedVR2Settings,
): Promise<UpscaleJob> {
    const isSeedVR2Profile = profile === "seedvr2_7b_sharp_fp16" || profile === "seedvr2_7b_sharp_nvfp4";
    const parameters = isSeedVR2Profile ? settings : { scale: UPSCALE_SCALE };
    const response = await fetch(`${BRIDGE_URL}/api/upscale`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceName: source.name, sourceRoot: source.root, sourceKind: source.kind, profile, ...parameters }),
    });
    const payload = await readJson<{ job?: UpscaleJob }>(response);
    if (!payload.job) throw new UpscaleApiError("Upscale job was not returned.", response.status);
    return payload.job;
}

export async function fetchUpscaleJob(id: string): Promise<UpscaleJob> {
    const response = await fetch(`${BRIDGE_URL}/api/upscale/jobs/${encodeURIComponent(id)}`, { cache: "no-store" });
    const payload = await readJson<{ job?: UpscaleJob }>(response);
    if (!payload.job) throw new UpscaleApiError("Upscale job was not returned.", response.status);
    return payload.job;
}

export async function cancelUpscaleJob(id: string, reason = "Cancelled by user."): Promise<UpscaleJob> {
    const response = await fetch(`${BRIDGE_URL}/api/upscale/jobs/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
    });
    const payload = await readJson<{ job?: UpscaleJob }>(response);
    if (!payload.job) throw new UpscaleApiError("Upscale job was not returned.", response.status);
    return payload.job;
}

export async function retryUpscaleJob(id: string): Promise<UpscaleJob> {
    const response = await fetch(`${BRIDGE_URL}/api/upscale/jobs/${encodeURIComponent(id)}/retry`, { method: "POST" });
    const payload = await readJson<{ job?: UpscaleJob }>(response);
    if (!payload.job) throw new UpscaleApiError("Upscale job was not returned.", response.status);
    return payload.job;
}

export function upscaleAssetHref(asset: Pick<StudioAsset, "root" | "name" | "url">) {
    if (asset.url) return assetUrl(asset as StudioAsset);
    return `${BRIDGE_URL}/media?root=${encodeURIComponent(asset.root)}&name=${encodeURIComponent(asset.name)}`;
}
