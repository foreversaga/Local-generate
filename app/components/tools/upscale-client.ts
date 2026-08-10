import { assetUrl, type StudioAsset } from "../library/asset-client";

export const UPSCALE_SCALE = 2 as const;
const BRIDGE_URL = "/app";

export type UpscaleJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type UpscaleJob = {
    id: string;
    status: UpscaleJobStatus;
    progress: number;
    stage: string;
    sourceName: string;
    sourceRoot?: "input" | "output";
    scale: number;
    output?: StudioAsset;
    error?: string;
    createdAt?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
};

export type UpscaleHealth = {
    ready: boolean;
    comfyUi: boolean;
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

export async function fetchUpscaleHealth(): Promise<UpscaleHealth> {
    const response = await fetch(`${BRIDGE_URL}/api/upscale/health`, { cache: "no-store" });
    return (await readJson<{ ready?: boolean; comfyUi?: boolean; models?: UpscaleHealth["models"]; nodes?: UpscaleHealth["nodes"] }>(response)) as UpscaleHealth;
}

export async function submitUpscale(source: Pick<StudioAsset, "name" | "root">): Promise<UpscaleJob> {
    const response = await fetch(`${BRIDGE_URL}/api/upscale`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceName: source.name, sourceRoot: source.root, scale: UPSCALE_SCALE }),
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

export function upscaleAssetHref(asset: Pick<StudioAsset, "root" | "name" | "url">) {
    if (asset.url) return assetUrl(asset as StudioAsset);
    return `${BRIDGE_URL}/media?root=${encodeURIComponent(asset.root)}&name=${encodeURIComponent(asset.name)}`;
}
