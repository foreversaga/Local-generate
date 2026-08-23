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

export type SeedVR2ResizeMethod = typeof SEEDVR2_RESIZE_METHODS[number]["id"];
export type SeedVR2ColorCorrection = typeof SEEDVR2_COLOR_CORRECTIONS[number]["id"];
export type SeedVR2Settings = {
    scale: number;
    seed?: number;
    resizeMethod: SeedVR2ResizeMethod;
    colorCorrection: SeedVR2ColorCorrection;
};

export const UPSCALE_PROFILES = [
    {
        id: "seedvr2_7b_sharp_nvfp4",
        label: "SeedVR2 7B Sharp NVFP4",
        description: "高品質圖片與影片重建，使用原生 SeedVR2 workflow 與 wavelet 色彩校正。",
        supportsImages: true,
    },
    {
        id: "h3_latent_2x",
        label: "MiniMax H3 Latent 2x · 社群雙採樣",
        description: "完整跑 H3 Ref2VA 低解析度採樣 → latent 2× → 重加噪 → 高解析度第二次採樣，保留來源影片與音訊。",
        supportsImages: false,
    },
] as const;

export type UpscaleProfile = typeof UPSCALE_PROFILES[number]["id"];
export const DEFAULT_UPSCALE_PROFILE: UpscaleProfile = "h3_latent_2x";

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

export async function fetchUpscaleHealth(profile: UpscaleProfile = DEFAULT_UPSCALE_PROFILE, kind: "image" | "video" = "video"): Promise<UpscaleHealth> {
    const query = new URLSearchParams({ profile, kind });
    const response = await fetch(`${BRIDGE_URL}/api/upscale/health?${query.toString()}`, { cache: "no-store" });
    return (await readJson<{ ready?: boolean; comfyUi?: boolean; models?: UpscaleHealth["models"]; nodes?: UpscaleHealth["nodes"] }>(response)) as UpscaleHealth;
}

export async function submitUpscale(
    source: Pick<StudioAsset, "name" | "root" | "kind">,
    profile: UpscaleProfile = DEFAULT_UPSCALE_PROFILE,
    settings?: SeedVR2Settings,
): Promise<UpscaleJob> {
    const parameters = profile === "seedvr2_7b_sharp_nvfp4"
        ? settings
        : { scale: UPSCALE_SCALE };
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
