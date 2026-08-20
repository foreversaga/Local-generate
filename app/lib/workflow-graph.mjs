import {
    createWorkflowEdge,
    createWorkflowId,
    WORKFLOW_NODE_STATUS,
    WORKFLOW_NODE_TYPES,
} from "./workflow-project.mjs";

export const WORKFLOW_CREATABLE_NODE_TYPES = Object.freeze([
    WORKFLOW_NODE_TYPES.asset,
    WORKFLOW_NODE_TYPES.prompt,
    WORKFLOW_NODE_TYPES.h3Video,
    WORKFLOW_NODE_TYPES.openPose,
    WORKFLOW_NODE_TYPES.upscale,
    WORKFLOW_NODE_TYPES.output,
]);

const NODE_TITLES = Object.freeze({
    [WORKFLOW_NODE_TYPES.brief]: "Brief",
    [WORKFLOW_NODE_TYPES.asset]: "Asset",
    [WORKFLOW_NODE_TYPES.prompt]: "Prompt",
    [WORKFLOW_NODE_TYPES.h3Video]: "H3 Video",
    [WORKFLOW_NODE_TYPES.openPose]: "OpenPose",
    [WORKFLOW_NODE_TYPES.upscale]: "Upscale",
    [WORKFLOW_NODE_TYPES.output]: "Output",
});

const CONNECTION_TARGETS = Object.freeze({
    [WORKFLOW_NODE_TYPES.brief]: new Set([WORKFLOW_NODE_TYPES.prompt]),
    [WORKFLOW_NODE_TYPES.asset]: new Set([
        WORKFLOW_NODE_TYPES.prompt,
        WORKFLOW_NODE_TYPES.h3Video,
        WORKFLOW_NODE_TYPES.openPose,
        WORKFLOW_NODE_TYPES.upscale,
    ]),
    [WORKFLOW_NODE_TYPES.prompt]: new Set([
        WORKFLOW_NODE_TYPES.h3Video,
        WORKFLOW_NODE_TYPES.openPose,
    ]),
    [WORKFLOW_NODE_TYPES.h3Video]: new Set([
        WORKFLOW_NODE_TYPES.upscale,
        WORKFLOW_NODE_TYPES.output,
    ]),
    [WORKFLOW_NODE_TYPES.openPose]: new Set([
        WORKFLOW_NODE_TYPES.h3Video,
        WORKFLOW_NODE_TYPES.output,
    ]),
    [WORKFLOW_NODE_TYPES.upscale]: new Set([WORKFLOW_NODE_TYPES.output]),
    [WORKFLOW_NODE_TYPES.output]: new Set(),
});

export function addWorkflowNode(project, type, options = {}, now = new Date().toISOString()) {
    assertProject(project);
    assertKnownNodeType(type);
    const id = normalizeText(options.id) || createWorkflowId(type);
    if (project.nodes.some((node) => node.id === id)) throw new Error(`Workflow node ${id} already exists.`);
    const position = normalizePosition(options.position || nextNodePosition(project));
    const node = {
        id,
        type,
        title: normalizeText(options.title) || NODE_TITLES[type] || type,
        position,
        status: normalizeText(options.status) || WORKFLOW_NODE_STATUS.waiting,
        config: isRecord(options.config) ? { ...options.config } : {},
    };
    return touchProject({ ...project, nodes: [...project.nodes, node] }, now);
}

export function moveWorkflowNode(project, nodeId, position, now = new Date().toISOString()) {
    assertProject(project);
    const id = requireNodeId(project, nodeId);
    const nextPosition = normalizePosition(position);
    return touchProject({
        ...project,
        nodes: project.nodes.map((node) => node.id === id ? { ...node, position: nextPosition } : node),
    }, now);
}

export function duplicateWorkflowNode(project, nodeId, options = {}, now = new Date().toISOString()) {
    assertProject(project);
    const sourceId = requireNodeId(project, nodeId);
    const source = project.nodes.find((node) => node.id === sourceId);
    const offset = Number.isFinite(Number(options.offset)) ? Number(options.offset) : 36;
    return addWorkflowNode(project, source.type, {
        id: options.id,
        title: normalizeText(options.title) || `${source.title} copy`,
        position: {
            x: source.position.x + offset,
            y: source.position.y + offset,
        },
        status: WORKFLOW_NODE_STATUS.waiting,
        config: cloneRecord(source.config),
    }, now);
}

export function removeWorkflowNode(project, nodeId, now = new Date().toISOString()) {
    assertProject(project);
    const id = requireNodeId(project, nodeId);
    if (project.nodes.find((node) => node.id === id)?.type === WORKFLOW_NODE_TYPES.brief) {
        throw new Error("The project Brief node cannot be deleted.");
    }
    return touchProject({
        ...project,
        nodes: project.nodes.filter((node) => node.id !== id),
        edges: project.edges.filter((edge) => edge.source !== id && edge.target !== id),
    }, now);
}

export function updateWorkflowNodeConfig(project, nodeId, patch, now = new Date().toISOString()) {
    assertProject(project);
    const id = requireNodeId(project, nodeId);
    if (!isRecord(patch)) throw new TypeError("Workflow node config patch must be an object.");
    return touchProject({
        ...project,
        nodes: project.nodes.map((node) => node.id === id
            ? { ...node, config: { ...node.config, ...patch } }
            : node),
    }, now);
}

export function validateWorkflowConnection(project, sourceId, targetId) {
    assertProject(project);
    const source = project.nodes.find((node) => node.id === normalizeText(sourceId));
    const target = project.nodes.find((node) => node.id === normalizeText(targetId));
    if (!source || !target) return invalidConnection("missing-node", "Choose two existing workflow nodes.");
    if (source.id === target.id) return invalidConnection("self-loop", "A node cannot connect to itself.");
    if (project.edges.some((edge) => edge.source === source.id && edge.target === target.id)) {
        return invalidConnection("duplicate-edge", "These nodes are already connected.");
    }
    const allowedTargets = CONNECTION_TARGETS[source.type];
    if (!allowedTargets?.has(target.type)) {
        return invalidConnection(
            "incompatible-types",
            `${NODE_TITLES[source.type] || source.type} cannot feed ${NODE_TITLES[target.type] || target.type}.`,
        );
    }
    if (createsCycle(project, source.id, target.id)) {
        return invalidConnection("cycle", "Workflow connections cannot create a cycle.");
    }
    return { valid: true, code: "ok", message: "" };
}

export function connectWorkflowNodes(project, sourceId, targetId, now = new Date().toISOString()) {
    const validation = validateWorkflowConnection(project, sourceId, targetId);
    if (!validation.valid) throw new Error(validation.message);
    return touchProject({
        ...project,
        edges: [...project.edges, createWorkflowEdge(sourceId, targetId)],
    }, now);
}

export function removeWorkflowEdge(project, edgeId, now = new Date().toISOString()) {
    assertProject(project);
    const id = normalizeText(edgeId);
    if (!id || !project.edges.some((edge) => edge.id === id)) return project;
    return touchProject({ ...project, edges: project.edges.filter((edge) => edge.id !== id) }, now);
}

function nextNodePosition(project) {
    const index = project.nodes.length;
    return {
        x: 56 + (index % 4) * 230,
        y: 84 + Math.floor(index / 4) * 132,
    };
}

function createsCycle(project, sourceId, targetId) {
    const adjacency = new Map();
    for (const node of project.nodes) adjacency.set(node.id, []);
    for (const edge of project.edges) adjacency.get(edge.source)?.push(edge.target);
    adjacency.get(sourceId)?.push(targetId);

    const visiting = new Set();
    const visited = new Set();
    const visit = (nodeId) => {
        if (visiting.has(nodeId)) return true;
        if (visited.has(nodeId)) return false;
        visiting.add(nodeId);
        for (const next of adjacency.get(nodeId) || []) {
            if (visit(next)) return true;
        }
        visiting.delete(nodeId);
        visited.add(nodeId);
        return false;
    };
    return project.nodes.some((node) => visit(node.id));
}

function touchProject(project, now) {
    return { ...project, updatedAt: now };
}

function normalizePosition(position) {
    const x = Number(position?.x);
    const y = Number(position?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError("Workflow node position must contain finite x and y values.");
    return {
        x: Math.max(0, Math.round(x)),
        y: Math.max(0, Math.round(y)),
    };
}

function requireNodeId(project, nodeId) {
    const id = normalizeText(nodeId);
    if (!id || !project.nodes.some((node) => node.id === id)) throw new Error(`Workflow node ${id || "<empty>"} does not exist.`);
    return id;
}

function assertKnownNodeType(type) {
    if (!Object.values(WORKFLOW_NODE_TYPES).includes(type)) throw new TypeError(`Unknown workflow node type: ${type}`);
}

function assertProject(project) {
    if (!project || typeof project !== "object" || !Array.isArray(project.nodes) || !Array.isArray(project.edges)) {
        throw new TypeError("Workflow graph operation requires a valid project.");
    }
}

function invalidConnection(code, message) {
    return { valid: false, code, message };
}

function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cloneRecord(value) {
    return isRecord(value) ? JSON.parse(JSON.stringify(value)) : {};
}

function normalizeText(value) {
    return typeof value === "string" ? value.trim() : "";
}
