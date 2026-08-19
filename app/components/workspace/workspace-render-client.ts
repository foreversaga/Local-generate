import { adaptJob } from "../../lib/job-adapter.mjs";
import { prepareWorkflowH3Render } from "../../lib/workflow-render-input.mjs";
import type { UnifiedJob } from "../jobs/job-client";
import type { WorkflowProject } from "./workflow-types";

const BRIDGE_URL = "/app";

type ValidationIssue = { field: string; message: string };
type JobPayload = { id?: string } & Record<string, unknown>;
type ApiPayload = {
    job?: JobPayload;
    error?: string | { code?: string; message?: string };
    code?: string;
};

export type WorkflowH3ExecutionResult = {
    issues: ValidationIssue[];
    jobs: UnifiedJob[];
};

export async function executeWorkflowH3Node(
    project: WorkflowProject,
    nodeId: string,
    upstreamJobs: UnifiedJob[] = [],
    fetchImpl: typeof fetch = globalThis.fetch,
): Promise<WorkflowH3ExecutionResult> {
    const prepared = prepareWorkflowH3Render(project, nodeId, { jobs: upstreamJobs }) as {
        issues: ValidationIssue[];
        requests: Record<string, unknown>[];
    };
    if (prepared.issues.length) return { issues: prepared.issues, jobs: [] };

    const jobs = await Promise.all(prepared.requests.map(async (request) => {
        const response = await fetchImpl(`${BRIDGE_URL}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(request),
        });
        const payload = await response.json().catch(() => ({})) as ApiPayload;
        if (!response.ok || !payload.job?.id) throw new Error(apiErrorMessage(payload, "無法建立生成工作"));
        return adaptJob(payload.job, "video") as UnifiedJob;
    }));

    return { issues: [], jobs };
}

function apiErrorMessage(payload: ApiPayload, fallback: string) {
    const message = typeof payload.error === "string" ? payload.error : payload.error?.message || fallback;
    const code = payload.code || (typeof payload.error === "object" ? payload.error?.code : "");
    return code ? `${code}: ${message}` : message;
}
