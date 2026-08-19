import { addWorkflowNode } from "./workflow-graph.mjs";
import { createWorkflowId, WORKFLOW_NODE_TYPES } from "./workflow-project.mjs";

export const WORKFLOW_ASSET_ROLES = Object.freeze([
    "character",
    "face",
    "clothing",
    "pose",
    "scene",
    "video",
    "audio",
    "reference",
    "output",
]);

export function workflowAssetKey(asset) {
    const root = normalizeText(asset?.root);
    const name = normalizeText(asset?.name);
    if (!root || !name) throw new TypeError("Workflow asset requires root and name.");
    return `${root}:${name}`;
}

export function registerWorkflowAsset(project, asset, role = defaultAssetRole(asset), now = new Date().toISOString()) {
    assertProject(project);
    const normalized = normalizeStudioAsset(asset);
    const normalizedRole = normalizeRole(role);
    const key = workflowAssetKey(normalized);
    const existing = project.assets.find((item) => item.key === key);
    const entry = {
        id: existing?.id || createWorkflowId("project-asset"),
        key,
        root: normalized.root,
        name: normalized.name,
        kind: normalized.kind,
        mime: normalized.mime,
        size: normalized.size,
        modified: normalized.modified,
        url: normalized.url,
        role: normalizedRole,
        addedAt: existing?.addedAt || now,
    };
    return {
        ...project,
        assets: existing
            ? project.assets.map((item) => item.key === key ? entry : item)
            : [...project.assets, entry],
        updatedAt: now,
    };
}

export function updateWorkflowAssetRole(project, assetKey, role, now = new Date().toISOString()) {
    assertProject(project);
    const key = normalizeText(assetKey);
    const normalizedRole = normalizeRole(role);
    if (!key || !project.assets.some((asset) => asset.key === key)) return project;
    return {
        ...project,
        assets: project.assets.map((asset) => asset.key === key ? { ...asset, role: normalizedRole } : asset),
        nodes: project.nodes.map((node) => node.type === WORKFLOW_NODE_TYPES.asset && node.config?.projectAssetKey === key
            ? { ...node, config: { ...node.config, role: normalizedRole } }
            : node),
        updatedAt: now,
    };
}

export function removeWorkflowAsset(project, assetKey, now = new Date().toISOString()) {
    assertProject(project);
    const key = normalizeText(assetKey);
    if (!key) return project;
    const nextAssets = project.assets.filter((item) => item.key !== key);
    if (nextAssets.length === project.assets.length) return project;
    return {
        ...project,
        assets: nextAssets,
        nodes: project.nodes.map((node) => node.type === WORKFLOW_NODE_TYPES.asset && node.config?.projectAssetKey === key
            ? { ...node, config: { ...node.config, projectAssetKey: "" } }
            : node),
        updatedAt: now,
    };
}

export function attachWorkflowAssetNode(project, asset, options = {}, now = new Date().toISOString()) {
    const role = normalizeRole(options.role || defaultAssetRole(asset));
    const registered = registerWorkflowAsset(project, asset, role, now);
    const key = workflowAssetKey(asset);
    const entry = registered.assets.find((item) => item.key === key);
    return addWorkflowNode(registered, WORKFLOW_NODE_TYPES.asset, {
        id: options.nodeId,
        title: normalizeText(options.title) || asset.name,
        position: options.position,
        config: {
            projectAssetKey: key,
            assetName: asset.name,
            assetRoot: asset.root,
            assetKind: asset.kind,
            assetUrl: asset.url,
            role,
            projectAssetId: entry?.id || "",
        },
    }, now);
}

export function workflowAssetForNode(project, node) {
    const key = normalizeText(node?.config?.projectAssetKey);
    if (!key) return null;
    return project.assets.find((asset) => asset.key === key) || null;
}

function defaultAssetRole(asset) {
    if (asset?.kind === "video") return "video";
    return "reference";
}

function normalizeRole(role) {
    const value = normalizeText(role) || "reference";
    if (!WORKFLOW_ASSET_ROLES.includes(value)) throw new TypeError(`Unknown workflow asset role: ${value}`);
    return value;
}

function normalizeStudioAsset(asset) {
    const root = normalizeText(asset?.root);
    const name = normalizeText(asset?.name);
    const kind = normalizeText(asset?.kind);
    if (!root || !name || !["image", "video"].includes(kind)) {
        throw new TypeError("Workflow asset must be a valid image or video Library asset.");
    }
    return {
        root,
        name,
        kind,
        mime: normalizeText(asset.mime),
        size: Number.isFinite(Number(asset.size)) ? Number(asset.size) : 0,
        modified: normalizeText(asset.modified),
        url: normalizeText(asset.url),
    };
}

function assertProject(project) {
    if (!project || typeof project !== "object" || !Array.isArray(project.assets) || !Array.isArray(project.nodes)) {
        throw new TypeError("Workflow asset operation requires a valid project.");
    }
}

function normalizeText(value) {
    return typeof value === "string" ? value.trim() : "";
}
