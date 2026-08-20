import { updateWorkflowAssetRole } from "./workflow-assets.mjs";
import {
    addWorkflowNode,
    connectWorkflowNodes,
    removeWorkflowEdge,
    updateWorkflowNodeConfig,
    validateWorkflowConnection,
} from "./workflow-graph.mjs";
import { singleCreateModeDefaults } from "./single-create-controller.mjs";
import { WORKFLOW_NODE_TYPES } from "./workflow-project.mjs";

export function applyWorkflowAgentPlan(project, plan) {
    assertProject(project);
    const mode = text(plan?.mode);
    const defaults = singleCreateModeDefaults(mode);
    let next = project;

    for (const assignment of Array.isArray(plan?.assetRoles) ? plan.assetRoles : []) {
        next = updateWorkflowAssetRole(next, text(assignment?.key), text(assignment?.role));
    }

    const promptNode = next.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.prompt);
    const h3Node = next.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.h3Video);
    const outputNode = next.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.output);
    const briefNode = next.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.brief);
    if (!promptNode || !h3Node || !outputNode) throw new Error("Workflow planner requires Prompt, H3 Video, and Output nodes.");

    if (briefNode) {
        next = updateWorkflowNodeConfig(next, briefNode.id, {
            agentPlanReason: text(plan?.reason),
            agentPlannedMode: mode,
        });
    }

    next = updateWorkflowNodeConfig(next, promptNode.id, {
        provider: "hermes",
        skill: text(plan?.promptSkill) || (mode.startsWith("ref2v") ? "ref2v-prompt" : "h3-prompt"),
    });
    next = updateWorkflowNodeConfig(next, h3Node.id, {
        mode,
        ...defaults,
        duration: finiteNumber(plan?.duration, 5),
    });

    if (plan?.useOpenPose === true) next = ensureOpenPoseStage(next, promptNode.id, h3Node.id);
    if (plan?.useUpscale === true) next = ensureUpscaleStage(next, h3Node.id, outputNode.id);
    return next;
}

function ensureOpenPoseStage(project, promptNodeId, h3NodeId) {
    let next = project;
    let node = next.nodes.find((candidate) => candidate.type === WORKFLOW_NODE_TYPES.openPose);
    if (!node) {
        next = addWorkflowNode(next, WORKFLOW_NODE_TYPES.openPose, {
            title: "OpenPose",
            position: midpointPosition(next, promptNodeId, h3NodeId, 88),
        });
        node = next.nodes.at(-1);
    }
    if (!node) return next;
    next = removeDirectEdge(next, promptNodeId, h3NodeId);
    next = connectIfValid(next, promptNodeId, node.id);
    next = connectIfValid(next, node.id, h3NodeId);

    const poseAssetNode = next.nodes.find((candidate) => candidate.type === WORKFLOW_NODE_TYPES.asset
        && ["pose", "reference", "character"].includes(text(candidate.config?.role))
        && text(candidate.config?.assetKind) === "image");
    if (poseAssetNode) next = connectIfValid(next, poseAssetNode.id, node.id);
    return next;
}

function ensureUpscaleStage(project, h3NodeId, outputNodeId) {
    let next = project;
    let node = next.nodes.find((candidate) => candidate.type === WORKFLOW_NODE_TYPES.upscale);
    if (!node) {
        next = addWorkflowNode(next, WORKFLOW_NODE_TYPES.upscale, {
            title: "Upscale 2×",
            position: midpointPosition(next, h3NodeId, outputNodeId, -88),
            config: { scale: 2 },
        });
        node = next.nodes.at(-1);
    }
    if (!node) return next;
    next = removeDirectEdge(next, h3NodeId, outputNodeId);
    next = connectIfValid(next, h3NodeId, node.id);
    next = connectIfValid(next, node.id, outputNodeId);
    return next;
}

function removeDirectEdge(project, sourceId, targetId) {
    const edge = project.edges.find((candidate) => candidate.source === sourceId && candidate.target === targetId);
    return edge ? removeWorkflowEdge(project, edge.id) : project;
}

function connectIfValid(project, sourceId, targetId) {
    if (project.edges.some((edge) => edge.source === sourceId && edge.target === targetId)) return project;
    return validateWorkflowConnection(project, sourceId, targetId).valid
        ? connectWorkflowNodes(project, sourceId, targetId)
        : project;
}

function midpointPosition(project, sourceId, targetId, yOffset = 0) {
    const source = project.nodes.find((node) => node.id === sourceId)?.position || { x: 0, y: 0 };
    const target = project.nodes.find((node) => node.id === targetId)?.position || { x: source.x + 230, y: source.y };
    return {
        x: Math.max(0, Math.round((source.x + target.x) / 2)),
        y: Math.max(0, Math.round((source.y + target.y) / 2 + yOffset)),
    };
}

function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function assertProject(project) {
    if (!project || typeof project !== "object" || !Array.isArray(project.nodes) || !Array.isArray(project.edges) || !Array.isArray(project.assets)) {
        throw new TypeError("Workflow agent plan requires a valid project.");
    }
}

function text(value) {
    return typeof value === "string" ? value.trim() : "";
}
