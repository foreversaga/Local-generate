import type { StudioAsset } from "../library/asset-client";

const BRIDGE_URL = "/app";

export type Img2ImgStatus = "queued" | "running" | "cancelling" | "completed" | "failed" | "partial" | "cancelled" | "interrupted";
export type Img2ImgProgressSource = "estimated" | "native" | string;

export type Img2ImgRandomRange = {
    min: number;
    max: number;
};

export type Img2ImgRandomRanges = {
    denoise: Img2ImgRandomRange;
    steps: Img2ImgRandomRange;
    cfg: Img2ImgRandomRange;
    /** Legacy persisted range; batch execution now always randomizes Seed. */
    seed?: Img2ImgRandomRange;
};

export type Img2ImgParameters = {
    denoise: number;
    steps: number;
    cfg: number;
    seed: number;
};

export type Img2ImgItem = {
    index: number;
    status: Img2ImgStatus | string;
    parameters?: Partial<Img2ImgParameters>;
    output?: StudioAsset;
    error?: string;
    progress?: number;
    stage?: string;
    progressSource?: Img2ImgProgressSource;
    connectionState?: string;
    comfyNode?: string;
    comfyNodeId?: string;
    comfyNodeTitle?: string;
    nativeCurrent?: number;
    nativeMaximum?: number;
    startedAt?: string | null;
    completedAt?: string | null;
    promptId?: string;
};

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
    profiles?: Record<string, {
        loraLoader?: string | null;
        loraAvailable?: boolean;
    }>;
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
    progressSource?: Img2ImgProgressSource;
    connectionState?: string;
    comfyNode?: string;
    comfyNodeId?: string;
    comfyNodeTitle?: string;
    nativeCurrent?: number;
    nativeMaximum?: number;
    comfyQueueRemaining?: number;
    sourceName: string;
    sourceRoot: "input" | "output";
    /** Optional pose/control reference image. The source image remains the required character reference. */
    poseName?: string;
    poseRoot?: "input" | "output";
    poseControlStrength?: number;
    poseResolution?: number;
    prompt: string;
    negativePrompt: string;
    model: string;
    characterLoraName?: string;
    characterLoraStrength?: number;
    denoise: number;
    steps: number;
    cfg: number;
    seed: number;
    output?: StudioAsset;
    error?: string;
    batchCount?: number;
    randomRanges?: Img2ImgRandomRanges;
    completedCount?: number;
    failedCount?: number;
    items?: Img2ImgItem[];
    createdAt?: string;
    startedAt?: string | null;
    completedAt?: string | null;
    cancelReason?: string;
    cancelledAt?: string | null;
    attempt?: number;
    retryOf?: string;
    recoverable?: boolean;
    recovery?: { reason?: string; previousStatus?: string; recoveredAt?: string } | null;
    provenance?: Record<string, unknown> | null;
};

export type Img2ImgSubmitInput = {
    sourceName: string;
    sourceRoot: "input" | "output";
    /** Optional pose/control reference image. The source image remains required. */
    poseName?: string;
    poseRoot?: "input" | "output";
    poseControlStrength?: number;
    poseResolution?: number;
    prompt: string;
    negativePrompt: string;
    ollamaPromptReceipt?: string;
    model: string;
    characterLoraName?: string;
    characterLoraStrength?: number;
    denoise: number;
    steps: number;
    cfg: number;
    seed: number;
    batchCount: number;
    randomRanges: Img2ImgRandomRanges;
};

export type Img2ImgApiPayload = {
    job?: Img2ImgJob;
    jobs?: Img2ImgJob[];
    records?: Img2ImgJob[];
    health?: Img2ImgHealth;
    error?: string | { code?: string; message?: string };
    code?: string;
};

export type Img2ImgLoraPayload = {
    loras?: string[];
    /** Structured entries are optional for backwards-compatible bridge responses. */
    items?: Array<{
        id?: string | null;
        name?: string;
        relativePath?: string;
        displayName?: string;
        family?: string | null;
        baseProfile?: string | null;
        comfyLoaded?: boolean;
    }>;
    available?: boolean;
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

export async function fetchImg2ImgLoras(modelOrProfile: string) {
    const response = await fetch(`${BRIDGE_URL}/api/loras?consumer=img2img&profile=${encodeURIComponent(modelOrProfile)}`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({})) as Img2ImgLoraPayload;
    if (!response.ok) {
        throw new Img2ImgApiError(apiErrorMessage(payload, "Unable to load available character LoRAs."), response.status, payload);
    }
    if (payload.available === false) {
        throw new Img2ImgApiError(apiErrorMessage(payload, "Character LoRA discovery is unavailable."), 503, payload);
    }
    if (!Array.isArray(payload.loras)) {
        throw new Img2ImgApiError("Character LoRA discovery returned an invalid response.", 502, payload);
    }
    return payload.loras.filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
}

export async function fetchImg2ImgJob(id: string) {
    const response = await fetch(`${BRIDGE_URL}/api/img2img/jobs/${encodeURIComponent(id)}`, { cache: "no-store" });
    const payload = await readPayload(response);
    if (!response.ok || !payload.job) {
        throw new Img2ImgApiError(apiErrorMessage(payload, "Unable to load image-to-image job."), response.status, payload);
    }
    return payload.job;
}

export async function fetchImg2ImgJobs(query = "") {
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    const suffix = params.toString() ? `?${params.toString()}` : "";
    const response = await fetch(`${BRIDGE_URL}/api/img2img/jobs${suffix}`, { cache: "no-store" });
    const payload = await readPayload(response);
    if (!response.ok) {
        throw new Img2ImgApiError(apiErrorMessage(payload, "Unable to load image-to-image history."), response.status, payload);
    }
    if (Array.isArray(payload.jobs)) return payload.jobs;
    if (Array.isArray(payload.records)) return payload.records;
    return payload.job ? [payload.job] : [];
}

export async function cancelImg2ImgJob(id: string, reason = "Cancelled by user.") {
    const response = await fetch(`${BRIDGE_URL}/api/img2img/jobs/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
    });
    const payload = await readPayload(response);
    if (!response.ok || !payload.job) throw new Img2ImgApiError(apiErrorMessage(payload, "Unable to cancel image-to-image job."), response.status, payload);
    return payload.job;
}

export async function retryImg2ImgJob(id: string) {
    const response = await fetch(`${BRIDGE_URL}/api/img2img/jobs/${encodeURIComponent(id)}/retry`, { method: "POST" });
    const payload = await readPayload(response);
    if (!response.ok || !payload.job) throw new Img2ImgApiError(apiErrorMessage(payload, "Unable to retry image-to-image job."), response.status, payload);
    return payload.job;
}

export function isImg2ImgActive(job?: Img2ImgJob | null) {
    return Boolean(job && (job.status === "queued" || job.status === "running" || job.status === "cancelling"));
}

export function isImg2ImgRetryable(job?: Img2ImgJob | null) {
    return Boolean(job && (job.status === "failed" || job.status === "partial" || job.status === "cancelled" || job.status === "interrupted"));
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
