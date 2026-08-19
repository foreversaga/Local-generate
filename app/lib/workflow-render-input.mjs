import { prepareSingleRenderBatch, singleCreateModeDefaults, singleCreateModelProfilesForMode } from "./single-create-controller.mjs";
import { WORKFLOW_NODE_TYPES } from "./workflow-project.mjs";

const IMAGE_REFERENCE_ROLES = Object.freeze([
    "character",
    "face",
    "clothing",
    "scene",
    "pose",
    "reference",
    "first-frame",
    "last-frame",
]);

export function buildWorkflowH3RenderInput(project, nodeId) {
    assertProject(project);
    const node = requireH3Node(project, nodeId);
    const mode = text(node.config?.mode) || "t2v";
    const defaults = singleCreateModeDefaults(mode);
    const allowedProfiles = singleCreateModelProfilesForMode(mode);
    const configuredProfile = text(node.config?.modelProfile);
    const modelProfile = allowedProfiles.includes(configuredProfile) ? configuredProfile : defaults.modelProfile;
    const promptNode = nearestUpstreamNode(project, node.id, WORKFLOW_NODE_TYPES.prompt)
        || project.nodes.find((candidate) => candidate.type === WORKFLOW_NODE_TYPES.prompt)
        || null;
    const prompt = text(node.config?.prompt) || text(promptNode?.config?.prompt);
    const negativePrompt = text(node.config?.negativePrompt) || text(promptNode?.config?.negativePrompt);
    const ollamaPromptReceipt = text(node.config?.ollamaPromptReceipt) || text(promptNode?.config?.ollamaPromptReceipt);
    const assets = normalizeAssets(project.assets);

    const firstFrame = firstImageByRoles(assets, ["first-frame", "reference", "character", "face"]);
    const lastFrame = firstImageByRoles(assets, ["last-frame"]);
    const motionVideo = firstVideoByRoles(assets, ["motion-video", "video"]);
    const genericVideo = firstVideoByRoles(assets, ["video", "motion-video"]);
    const characterImages = imagesByRoles(assets, ["character", "reference"]);
    const faceImages = imagesByRoles(assets, ["face"]);
    const clothingImages = imagesByRoles(assets, ["clothing"]);
    const multiReferences = imagesByRoles(assets, IMAGE_REFERENCE_ROLES).slice(0, 9);
    const clothingMode = text(node.config?.clothingMode)
        || (clothingImages.length ? "reference" : "character");

    return {
        mode,
        initialDescription: text(project.brief),
        prompt,
        negativePrompt,
        ollamaPromptReceipt,
        modelProfile,
        width: numberConfig(node, "width", defaults.width),
        height: numberConfig(node, "height", defaults.height),
        duration: numberConfig(node, "duration", 5),
        steps: numberConfig(node, "steps", defaults.steps),
        seed: numberConfig(node, "seed", 12345),
        renderCount: 1,
        outputName: text(node.config?.outputName),
        h3LoraEnabled: node.config?.h3LoraEnabled === true,
        h3LoraStrength: numberConfig(node, "h3LoraStrength", 0.8),
        characterLoraName: mode === "replace" ? text(node.config?.loraName) : "",
        characterLoraStrength: numberConfig(node, "loraStrength", 0.75),
        referenceImage: referenceImageForMode(mode, firstFrame, multiReferences),
        referenceImages: mode === "ref2v_motion" ? characterImages : multiReferences,
        faceReferenceImages: mode === "ref2v_motion" ? faceImages : [],
        clothingReferenceImages: mode === "ref2v_motion" ? clothingImages : [],
        clothingMode,
        clothingDescription: text(node.config?.clothingDescription),
        referenceVideoStart: numberConfig(node, "referenceVideoStart", 0),
        referenceVideoEnd: numberConfig(node, "referenceVideoEnd", numberConfig(node, "duration", 5)),
        referenceVideoMaxDimension: numberConfig(node, "referenceVideoMaxDimension", 720),
        lastFrameImage: mode === "fl2v" || mode === "l2v" ? lastFrame : null,
        sourceVideo: mode === "ref2v_motion" ? motionVideo : mode === "replace" || mode === "ref2v" ? genericVideo : null,
    };
}

export function prepareWorkflowH3Render(project, nodeId, options = {}) {
    return prepareSingleRenderBatch(buildWorkflowH3RenderInput(project, nodeId), options);
}

function referenceImageForMode(mode, firstFrame, references) {
    if (["i2v", "fl2v", "replace"].includes(mode)) return firstFrame || references[0] || null;
    return null;
}

function normalizeAssets(assets) {
    return (Array.isArray(assets) ? assets : [])
        .filter((asset) => ["input", "output"].includes(text(asset?.root)) && ["image", "video"].includes(text(asset?.kind)))
        .map((asset) => ({
            name: text(asset.name),
            root: text(asset.root),
            kind: text(asset.kind),
            role: text(asset.role) || (asset.kind === "video" ? "video" : "reference"),
        }))
        .filter((asset) => asset.name);
}

function imagesByRoles(assets, roles) {
    const priority = new Map(roles.map((role, index) => [role, index]));
    return assets
        .filter((asset) => asset.kind === "image" && priority.has(asset.role))
        .sort((left, right) => priority.get(left.role) - priority.get(right.role))
        .map(assetReference);
}

function firstImageByRoles(assets, roles) {
    return imagesByRoles(assets, roles)[0] || null;
}

function firstVideoByRoles(assets, roles) {
    const priority = new Map(roles.map((role, index) => [role, index]));
    const asset = assets
        .filter((candidate) => candidate.kind === "video" && priority.has(candidate.role))
        .sort((left, right) => priority.get(left.role) - priority.get(right.role))[0];
    return asset ? assetReference(asset) : null;
}

function assetReference(asset) {
    return { name: asset.name, root: asset.root, kind: asset.kind };
}

function nearestUpstreamNode(project, nodeId, type) {
    const incoming = new Map();
    for (const edge of project.edges || []) {
        const list = incoming.get(edge.target) || [];
        list.push(edge.source);
        incoming.set(edge.target, list);
    }
    const queue = [...(incoming.get(nodeId) || [])];
    const seen = new Set();
    while (queue.length) {
        const candidateId = queue.shift();
        if (!candidateId || seen.has(candidateId)) continue;
        seen.add(candidateId);
        const candidate = project.nodes.find((node) => node.id === candidateId);
        if (!candidate) continue;
        if (candidate.type === type) return candidate;
        queue.push(...(incoming.get(candidateId) || []));
    }
    return null;
}

function requireH3Node(project, nodeId) {
    const id = text(nodeId);
    const node = project.nodes.find((candidate) => candidate.id === id);
    if (!node) throw new Error(`Workflow node ${id || "<empty>"} does not exist.`);
    if (node.type !== WORKFLOW_NODE_TYPES.h3Video) throw new Error(`${node.type} is not an H3 Video node.`);
    return node;
}

function numberConfig(node, key, fallback) {
    const value = Number(node.config?.[key]);
    return Number.isFinite(value) ? value : fallback;
}

function assertProject(project) {
    if (!project || typeof project !== "object" || !Array.isArray(project.nodes) || !Array.isArray(project.edges) || !Array.isArray(project.assets)) {
        throw new TypeError("Workflow H3 render requires a valid project.");
    }
}

function text(value) {
    return typeof value === "string" ? value.trim() : "";
}
