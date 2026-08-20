import { createWorkflowId } from "./workflow-project.mjs";

export const WORKFLOW_CHECKPOINT_TYPES = Object.freeze([
    "prompt-review",
    "render-ready",
    "media-review",
    "pre-upscale",
]);

export function createWorkflowCheckpoint(project, options = {}, now = new Date().toISOString()) {
    assertProject(project);
    const type = normalizeCheckpointType(options.type || "render-ready");
    const checkpoint = {
        id: normalizeText(options.id) || createWorkflowId("checkpoint"),
        type,
        label: normalizeText(options.label) || defaultCheckpointLabel(type),
        note: normalizeText(options.note),
        status: "pending",
        createdAt: now,
        approvedAt: "",
        snapshot: snapshotProject(project),
    };
    return {
        ...project,
        checkpoints: [...project.checkpoints, checkpoint],
        updatedAt: now,
    };
}

export function approveWorkflowCheckpoint(project, checkpointId, now = new Date().toISOString()) {
    assertProject(project);
    const id = requireCheckpointId(project, checkpointId);
    return {
        ...project,
        checkpoints: project.checkpoints.map((checkpoint) => checkpoint.id === id
            ? { ...checkpoint, status: "approved", approvedAt: now }
            : checkpoint),
        updatedAt: now,
    };
}

export function reopenWorkflowCheckpoint(project, checkpointId, now = new Date().toISOString()) {
    assertProject(project);
    const id = requireCheckpointId(project, checkpointId);
    return {
        ...project,
        checkpoints: project.checkpoints.map((checkpoint) => checkpoint.id === id
            ? { ...checkpoint, status: "pending", approvedAt: "" }
            : checkpoint),
        updatedAt: now,
    };
}

export function restoreWorkflowCheckpoint(project, checkpointId, now = new Date().toISOString()) {
    assertProject(project);
    const id = requireCheckpointId(project, checkpointId);
    const checkpoint = project.checkpoints.find((item) => item.id === id);
    const snapshot = checkpoint.snapshot;
    return {
        ...project,
        name: snapshot.name,
        brief: snapshot.brief,
        nodes: deepClone(snapshot.nodes),
        edges: deepClone(snapshot.edges),
        assets: deepClone(snapshot.assets),
        checkpoints: project.checkpoints,
        updatedAt: now,
    };
}

export function latestApprovedCheckpoint(project, type) {
    assertProject(project);
    const normalizedType = type ? normalizeCheckpointType(type) : "";
    return [...project.checkpoints]
        .reverse()
        .find((checkpoint) => checkpoint.status === "approved" && (!normalizedType || checkpoint.type === normalizedType)) || null;
}

function snapshotProject(project) {
    return {
        name: project.name,
        brief: project.brief,
        nodes: deepClone(project.nodes),
        edges: deepClone(project.edges),
        assets: deepClone(project.assets),
    };
}

function defaultCheckpointLabel(type) {
    return ({
        "prompt-review": "Prompt review",
        "render-ready": "Render ready",
        "media-review": "Media review",
        "pre-upscale": "Pre-upscale review",
    })[type] || "Review checkpoint";
}

function normalizeCheckpointType(type) {
    const value = normalizeText(type);
    if (!WORKFLOW_CHECKPOINT_TYPES.includes(value)) throw new TypeError(`Unknown workflow checkpoint type: ${value}`);
    return value;
}

function requireCheckpointId(project, checkpointId) {
    const id = normalizeText(checkpointId);
    if (!id || !project.checkpoints.some((checkpoint) => checkpoint.id === id)) {
        throw new Error(`Workflow checkpoint ${id || "<empty>"} does not exist.`);
    }
    return id;
}

function assertProject(project) {
    if (!project || typeof project !== "object" || !Array.isArray(project.checkpoints)) {
        throw new TypeError("Workflow checkpoint operation requires a valid project.");
    }
}

function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}

function normalizeText(value) {
    return typeof value === "string" ? value.trim() : "";
}
