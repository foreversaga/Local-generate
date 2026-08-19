export const WORKFLOW_PROJECT_VERSION = 1;

export const WORKFLOW_NODE_TYPES = Object.freeze({
    brief: "brief",
    asset: "asset",
    prompt: "prompt",
    h3Video: "h3-video",
    openPose: "openpose",
    upscale: "upscale",
    output: "output",
});

export const WORKFLOW_NODE_STATUS = Object.freeze({
    ready: "ready",
    waiting: "waiting",
    running: "running",
    complete: "complete",
    error: "error",
});

const STARTER_NODE_DEFINITIONS = Object.freeze([
    Object.freeze({ key: "brief", type: WORKFLOW_NODE_TYPES.brief, title: "Brief", x: 56, y: 212 }),
    Object.freeze({ key: "prompt", type: WORKFLOW_NODE_TYPES.prompt, title: "Prompt", x: 286, y: 212 }),
    Object.freeze({ key: "video", type: WORKFLOW_NODE_TYPES.h3Video, title: "H3 Video", x: 516, y: 212 }),
    Object.freeze({ key: "output", type: WORKFLOW_NODE_TYPES.output, title: "Output", x: 746, y: 212 }),
]);

/**
 * @param {{ id?: string, name?: string, brief?: string, now?: string, idFactory?: (prefix?: string) => string }} [options]
 */
export function createWorkflowProject({
    id,
    name,
    brief,
    now = new Date().toISOString(),
    idFactory = createWorkflowId,
} = {}) {
    const projectId = normalizeText(id) || idFactory("project");
    const normalizedBrief = normalizeText(brief);
    const projectName = normalizeText(name) || defaultProjectName(normalizedBrief);
    const nodeIds = Object.fromEntries(STARTER_NODE_DEFINITIONS.map(({ key }) => [key, idFactory(key)]));
    const nodes = STARTER_NODE_DEFINITIONS.map((definition) => ({
        id: nodeIds[definition.key],
        type: definition.type,
        title: definition.title,
        position: { x: definition.x, y: definition.y },
        status: definition.type === WORKFLOW_NODE_TYPES.brief && normalizedBrief
            ? WORKFLOW_NODE_STATUS.ready
            : WORKFLOW_NODE_STATUS.waiting,
        config: definition.type === WORKFLOW_NODE_TYPES.brief ? { brief: normalizedBrief } : {},
    }));
    const edges = [
        createWorkflowEdge(nodeIds.brief, nodeIds.prompt),
        createWorkflowEdge(nodeIds.prompt, nodeIds.video),
        createWorkflowEdge(nodeIds.video, nodeIds.output),
    ];

    return {
        version: WORKFLOW_PROJECT_VERSION,
        id: projectId,
        name: projectName,
        brief: normalizedBrief,
        createdAt: now,
        updatedAt: now,
        nodes,
        edges,
        assets: [],
        checkpoints: [],
    };
}

/**
 * @param {any} project
 * @param {string} brief
 * @param {string} [now]
 */
export function updateWorkflowProjectBrief(project, brief, now = new Date().toISOString()) {
    const normalizedBrief = normalizeText(brief);
    return {
        ...project,
        brief: normalizedBrief,
        updatedAt: now,
        nodes: project.nodes.map((node) => node.type === WORKFLOW_NODE_TYPES.brief
            ? {
                ...node,
                status: normalizedBrief ? WORKFLOW_NODE_STATUS.ready : WORKFLOW_NODE_STATUS.waiting,
                config: { ...node.config, brief: normalizedBrief },
            }
            : node),
    };
}

export function isWorkflowProject(value) {
    return Boolean(
        value
        && typeof value === "object"
        && value.version === WORKFLOW_PROJECT_VERSION
        && normalizeText(value.id)
        && Array.isArray(value.nodes)
        && Array.isArray(value.edges),
    );
}

export function createWorkflowEdge(source, target) {
    const sourceId = normalizeText(source);
    const targetId = normalizeText(target);
    if (!sourceId || !targetId) throw new Error("Workflow edge requires source and target node ids.");
    return {
        id: `edge-${sourceId}-${targetId}`,
        source: sourceId,
        target: targetId,
    };
}

export function createWorkflowId(prefix = "node") {
    const normalizedPrefix = normalizeText(prefix) || "node";
    const randomPart = typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    return `${normalizedPrefix}-${randomPart}`;
}

function defaultProjectName(brief) {
    if (!brief) return "Untitled project";
    const firstLine = brief.split(/\r?\n/, 1)[0].trim();
    return firstLine.length > 42 ? `${firstLine.slice(0, 42).trim()}…` : firstLine;
}

function normalizeText(value) {
    return typeof value === "string" ? value.trim() : "";
}
