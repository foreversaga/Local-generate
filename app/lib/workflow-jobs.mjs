import { WORKFLOW_NODE_TYPES } from "./workflow-project.mjs";

export const WORKFLOW_NODE_JOB_SOURCES = Object.freeze({
    [WORKFLOW_NODE_TYPES.h3Video]: Object.freeze(["video"]),
    [WORKFLOW_NODE_TYPES.openPose]: Object.freeze(["img2img"]),
    [WORKFLOW_NODE_TYPES.upscale]: Object.freeze(["upscale"]),
});

export function supportedJobSourcesForNode(nodeType) {
    return WORKFLOW_NODE_JOB_SOURCES[nodeType] || Object.freeze([]);
}

export function workflowNodeSupportsJobSource(node, source) {
    return supportedJobSourcesForNode(node?.type).includes(normalizeText(source));
}

export function bindWorkflowNodeJob(project, nodeId, job, now = new Date().toISOString()) {
    assertProject(project);
    const node = requireNode(project, nodeId);
    const jobId = normalizeText(job?.id);
    const source = normalizeText(job?.source);
    if (!jobId || !source) throw new TypeError("Workflow job binding requires job id and source.");
    if (!workflowNodeSupportsJobSource(node, source)) {
        throw new Error(`${node.type} nodes do not support ${source} jobs.`);
    }
    return {
        ...project,
        nodes: project.nodes.map((item) => item.id === node.id
            ? { ...item, config: { ...item.config, jobId, jobSource: source } }
            : item),
        updatedAt: now,
    };
}

export function unbindWorkflowNodeJob(project, nodeId, now = new Date().toISOString()) {
    assertProject(project);
    const node = requireNode(project, nodeId);
    const nextConfig = { ...node.config };
    delete nextConfig.jobId;
    delete nextConfig.jobSource;
    return {
        ...project,
        nodes: project.nodes.map((item) => item.id === node.id ? { ...item, config: nextConfig } : item),
        updatedAt: now,
    };
}

export function workflowJobBinding(node) {
    const jobId = normalizeText(node?.config?.jobId);
    const source = normalizeText(node?.config?.jobSource);
    return jobId && source ? { jobId, source } : null;
}

export function workflowJobForNode(node, jobs) {
    const binding = workflowJobBinding(node);
    if (!binding || !Array.isArray(jobs)) return null;
    return jobs.find((job) => String(job?.id) === binding.jobId && String(job?.source) === binding.source) || null;
}

export function workflowExecutionState(node, jobs) {
    const binding = workflowJobBinding(node);
    if (!binding) return null;
    const job = workflowJobForNode(node, jobs);
    if (!job) {
        return {
            jobId: binding.jobId,
            source: binding.source,
            status: "waiting",
            progress: 0,
            etaMs: null,
            error: "",
            missing: true,
        };
    }
    return {
        jobId: binding.jobId,
        source: binding.source,
        status: normalizeExecutionStatus(job.status),
        progress: clampProgress(job.progress),
        etaMs: finiteOrNull(job.etaMs),
        error: normalizeText(job.error),
        missing: false,
    };
}

function normalizeExecutionStatus(status) {
    const value = normalizeText(status).toLowerCase();
    if (["queued", "running", "complete", "partial", "error", "cancelled"].includes(value)) return value;
    return "waiting";
}

function clampProgress(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(0, Math.min(100, Math.round(numeric)));
}

function finiteOrNull(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function requireNode(project, nodeId) {
    const id = normalizeText(nodeId);
    const node = project.nodes.find((item) => item.id === id);
    if (!node) throw new Error(`Workflow node ${id || "<empty>"} does not exist.`);
    return node;
}

function assertProject(project) {
    if (!project || typeof project !== "object" || !Array.isArray(project.nodes)) {
        throw new TypeError("Workflow job operation requires a valid project.");
    }
}

function normalizeText(value) {
    return typeof value === "string" ? value.trim() : "";
}
