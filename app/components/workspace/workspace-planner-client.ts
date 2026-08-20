import type { WorkflowProject } from "./workflow-types";

const BRIDGE_URL = "/app";

export type WorkflowAgentPlan = {
    mode: string;
    duration: number;
    promptSkill: string;
    useOpenPose: boolean;
    useUpscale: boolean;
    assetRoles: Array<{ key: string; role: string }>;
    reason: string;
};

export async function executeWorkflowPlanner(project: WorkflowProject, fetchImpl: typeof fetch = globalThis.fetch): Promise<WorkflowAgentPlan> {
    if (!project.brief.trim()) throw new Error("請先填寫 Project Brief。");
    const response = await fetchImpl(`${BRIDGE_URL}/api/hermes/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            brief: project.brief.trim(),
            assets: project.assets.map((asset) => ({
                key: asset.key,
                kind: asset.kind,
                role: asset.role,
            })),
        }),
    });
    const payload = await response.json().catch(() => ({})) as WorkflowAgentPlan & { error?: string | { message?: string }; code?: string };
    if (!response.ok) {
        const message = typeof payload.error === "string" ? payload.error : payload.error?.message || "Hermes workflow planner failed.";
        throw new Error(payload.code ? `${payload.code}: ${message}` : message);
    }
    if (!payload.mode) throw new Error("Hermes workflow planner did not return a mode.");
    return payload;
}
