import type { StudioAsset } from "../library/asset-client";

const BRIDGE_URL = "/app";

export type Img2ImgStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type Img2ImgRuntimeMode = "local" | "remote";

export type Img2ImgRuntime = {
    mode?: Img2ImgRuntimeMode;
    remote?: boolean;
};

export type Img2ImgHealth = {
    ready?: boolean;
    comfyUi?: boolean;
    nodes?: Record<string, boolean>;
    models?: Record<string, boolean>;
};

type Img2ImgRuntimePayload = {
    runtime?: Img2ImgRuntime;
    comfy?: { remote?: boolean };
    error?: string | { code?: string; message?: string };
    code?: string;
};

export type Img2ImgJob = {
    id: string;
    status: Img2ImgStatus;
    progress: number;
    stage: string;
    sourceName: string;
    sourceRoot: "input" | "output";
    prompt: string;
    negativePrompt: string;
    model: string;
    denoise: number;
    steps: number;
    cfg: number;
    seed: number;
    output?: StudioAsset;
    error?: string;
    createdAt?: string;
    startedAt?: string | null;
    completedAt?: string | null;
};

export type Img2ImgSubmitInput = {
    sourceName: string;
    sourceRoot: "input" | "output";
    prompt: string;
    negativePrompt: string;
    model: string;
    denoise: number;
    steps: number;
    cfg: number;
    seed: number;
};

export type Img2ImgApiPayload = {
    job?: Img2ImgJob;
    health?: Img2ImgHealth;
    error?: string | { code?: string; message?: string };
    code?: string;
};

export class Img2ImgApiError extends Error {
    readonly status: number;
    readonly payload: Img2ImgApiPayload;

    constructor(message: string, status: number, payload: Img2ImgApiPayload) {
        super(message);
        this.name = "Img2ImgApiError";
        this.status = status;
        this.payload = payload;
    }
}

function apiErrorMessage(payload: Img2ImgApiPayload, fallback: string) {
    const message = typeof payload.error === "string"
        ? payload.error
        : payload.error?.message || fallback;
    const code = payload.code || (typeof payload.error === "object" ? payload.error?.code : "");
    return code ? `${code}: ${message}` : message;
}

async function readPayload(response: Response) {
    return await response.json().catch(() => ({})) as Img2ImgApiPayload;
}

async function readRuntimePayload(response: Response) {
    return await response.json().catch(() => ({})) as Img2ImgRuntimePayload;
}

export async function fetchImg2ImgHealth() {
    const response = await fetch(`${BRIDGE_URL}/api/img2img/health`, { cache: "no-store" });
    const payload = await readPayload(response);
    if (!response.ok) throw new Img2ImgApiError(apiErrorMessage(payload, "Unable to check image-to-image readiness."), response.status, payload);
    return payload as Img2ImgHealth;
}

export async function fetchImg2ImgRuntime() {
    const response = await fetch(`${BRIDGE_URL}/api/health`, { cache: "no-store" });
    const payload = await readRuntimePayload(response);
    if (!response.ok) {
        const errorPayload = payload as Img2ImgApiPayload;
        throw new Img2ImgApiError(apiErrorMessage(errorPayload, "Unable to load model runtime."), response.status, errorPayload);
    }
    const mode = payload.runtime?.mode;
    if (mode === "local" || mode === "remote") return mode;
    if (typeof payload.comfy?.remote === "boolean") return payload.comfy.remote ? "remote" : "local";
    return null;
}

export async function submitImg2Img(input: Img2ImgSubmitInput) {
    const response = await fetch(`${BRIDGE_URL}/api/img2img`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
    });
    const payload = await readPayload(response);
    if (!response.ok || !payload.job) {
        throw new Img2ImgApiError(apiErrorMessage(payload, "Unable to start image-to-image."), response.status, payload);
    }
    return payload.job;
}

export async function fetchImg2ImgJob(id: string) {
    const response = await fetch(`${BRIDGE_URL}/api/img2img/jobs/${encodeURIComponent(id)}`, { cache: "no-store" });
    const payload = await readPayload(response);
    if (!response.ok || !payload.job) {
        throw new Img2ImgApiError(apiErrorMessage(payload, "Unable to load image-to-image job."), response.status, payload);
    }
    return payload.job;
}

export function isImg2ImgActive(job?: Img2ImgJob | null) {
    return Boolean(job && (job.status === "queued" || job.status === "running"));
}

export function isImg2ImgRetryable(job?: Img2ImgJob | null) {
    return Boolean(job && (job.status === "failed" || job.status === "cancelled"));
}

export function img2ImgReadinessMessage(health: Img2ImgHealth | undefined, selectedModel: string) {
    if (!health) return "尚未取得 ComfyUI readiness。";
    if (health.comfyUi === false) return "ComfyUI 未連線。請啟動 ComfyUI（127.0.0.1:8188）後再試。";
    const missingNodes = Object.entries(health.nodes || {})
        .filter(([, available]) => !available)
        .map(([name]) => name);
    if (missingNodes.length) return `ComfyUI 缺少必要節點：${missingNodes.join("、")}。`;
    if (health.models && Object.keys(health.models).length && health.models[selectedModel] !== true) return `未安裝所選 checkpoint：${selectedModel}。`;
    if (health.models && Object.keys(health.models).length && !Object.values(health.models).some(Boolean)) {
        return "ComfyUI 未找到支援的圖生圖 checkpoint。";
    }
    if (health.ready === false) return "圖生圖尚未就緒，請檢查 ComfyUI 節點與 checkpoint。";
    return "";
}
