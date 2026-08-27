import type { StudioAsset } from "../library/asset-client";

const BRIDGE_URL = "/app";

export type VideoCharacterMode = "replace" | "dwpose";
export type VideoCharacterJob = {
    id: string;
    mode: VideoCharacterMode;
    status: string;
    stage: string;
    progress: number;
    createdAt: string;
    updatedAt: string;
    finishedAt?: string | null;
    /** Actual runner telemetry. These are absent until the runner reports it. */
    progressSource?: "runner" | "completed" | "unknown";
    phase?: "prepare" | "mask" | "generation" | "mux" | "complete" | string;
    nativeCurrent?: number | null;
    nativeMaximum?: number | null;
    chunkIndex?: number | null;
    chunkCount?: number | null;
    source: Pick<StudioAsset, "root" | "name">;
    references: Array<Pick<StudioAsset, "root" | "name">>;
    settings: {
        width: number;
        height: number;
        fps: number;
        steps: number;
        seed: number;
        prompt: string;
        negativePrompt: string;
        targetPrompt: string;
        targetIndex: number;
        targetOrder: string;
    };
    output?: StudioAsset | null;
    error?: string;
    workspace: { path: string; exists: boolean; clearedAt?: string | null };
    memory: Array<{ at: string; rssBytes: number | null; vramUsedBytes: number | null; vramTotalBytes: number | null }>;
};

export type VideoCharacterHealth = {
    ready: boolean;
    runner: boolean;
    comfy: boolean;
    modes: Record<VideoCharacterMode, boolean>;
    workspaceRoot: string;
};

async function request(path: string, init?: RequestInit) {
    const response = await fetch(`${BRIDGE_URL}${path}`, { ...init, cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const message = typeof payload.error === "string" ? payload.error : payload.error?.message || "影片人物工作流程失敗。";
        throw new Error(payload.code ? `${payload.code}: ${message}` : message);
    }
    return payload;
}

export async function fetchVideoCharacterHealth() {
    return await request("/api/video-character/health") as VideoCharacterHealth;
}

export async function submitVideoCharacter(input: {
    mode: VideoCharacterMode;
    source: Pick<StudioAsset, "root" | "name">;
    references: Array<Pick<StudioAsset, "root" | "name">>;
    prompt: string;
    negativePrompt: string;
    width: number;
    height: number;
    fps: number;
    steps: number;
    seed?: number;
    targetPrompt: string;
    targetIndex: number;
    targetOrder: string;
}) {
    const payload = await request("/api/video-character/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
    });
    return payload.job as VideoCharacterJob;
}

export async function fetchVideoCharacterJob(id: string) {
    const payload = await request(`/api/video-character/jobs/${encodeURIComponent(id)}`);
    return payload.job as VideoCharacterJob;
}

export async function fetchVideoCharacterJobs() {
    const payload = await request("/api/video-character/jobs");
    return (Array.isArray(payload.jobs) ? payload.jobs : []) as VideoCharacterJob[];
}

export async function clearVideoCharacterWorkspace(id: string) {
    const payload = await request(`/api/video-character/jobs/${encodeURIComponent(id)}/clear`, { method: "POST" });
    return payload.job as VideoCharacterJob;
}

export async function cancelVideoCharacterJob(id: string) {
    const payload = await request(`/api/video-character/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
    return payload.job as VideoCharacterJob;
}
