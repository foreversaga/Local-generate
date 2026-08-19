import { WORKFLOW_NODE_TYPES } from "./workflow-project.mjs";

const DEFAULT_NEGATIVE_PROMPT = "blurry, low quality, low resolution, bad anatomy, deformed body, extra limbs, missing limbs, malformed hands, malformed feet, extra fingers, fused fingers, distorted face, watermark, text, logo";
const SDXL_MODEL = "Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors";

export function buildWorkflowOpenPoseInput(project, nodeId) {
    assertProject(project);
    const node = requireNode(project, nodeId, WORKFLOW_NODE_TYPES.openPose);
    const source = resolveOpenPoseSource(project, node.id);
    if (!source) throw new Error("OpenPose 節點需要一張上游圖片素材。");
    const promptNode = nearestUpstreamNode(project, node.id, WORKFLOW_NODE_TYPES.prompt)
        || project.nodes.find((candidate) => candidate.type === WORKFLOW_NODE_TYPES.prompt)
        || null;
    const prompt = text(node.config?.prompt) || text(promptNode?.config?.prompt);
    if (!prompt) throw new Error("OpenPose 節點需要提示詞；請先連接或填寫 Prompt node。");
    const negativePrompt = text(node.config?.negativePrompt)
        || text(promptNode?.config?.negativePrompt)
        || DEFAULT_NEGATIVE_PROMPT;
    const receipt = text(node.config?.ollamaPromptReceipt) || text(promptNode?.config?.ollamaPromptReceipt);
    const strength = finiteNumber(node.config?.strength, 1.2);
    const denoise = finiteNumber(node.config?.denoise, 1);
    const steps = finiteNumber(node.config?.steps, 35);
    const cfg = finiteNumber(node.config?.cfg, 5);
    const seed = finiteNumber(node.config?.seed, 12345);

    return {
        sourceName: source.name,
        sourceRoot: source.root,
        poseName: source.name,
        poseRoot: source.root,
        poseControlStrength: strength,
        poseResolution: 768,
        prompt,
        negativePrompt,
        ...(receipt ? { ollamaPromptReceipt: receipt } : {}),
        model: SDXL_MODEL,
        denoise,
        steps,
        cfg,
        seed,
        batchCount: 1,
        randomRanges: {
            denoise: { min: denoise, max: denoise },
            steps: { min: steps, max: steps },
            cfg: { min: cfg, max: cfg },
        },
    };
}

export function resolveWorkflowUpscaleSource(project, nodeId, jobs = []) {
    assertProject(project);
    const node = requireNode(project, nodeId, WORKFLOW_NODE_TYPES.upscale);
    const upstreamIds = upstreamNodeIds(project, node.id);

    for (const upstreamId of upstreamIds) {
        const upstream = project.nodes.find((candidate) => candidate.id === upstreamId);
        if (!upstream) continue;
        const jobId = text(upstream.config?.jobId);
        const jobSource = text(upstream.config?.jobSource);
        if (!jobId || !jobSource) continue;
        const job = jobs.find((candidate) => String(candidate?.id || "") === jobId && String(candidate?.source || "") === jobSource);
        if (!job || job.status !== "complete") continue;
        const output = job.output;
        if (output && typeof output === "object" && (output.root === "input" || output.root === "output") && text(output.name)) {
            return { root: output.root, name: text(output.name) };
        }
    }

    for (const upstreamId of upstreamIds) {
        const upstream = project.nodes.find((candidate) => candidate.id === upstreamId);
        if (upstream?.type !== WORKFLOW_NODE_TYPES.asset) continue;
        const asset = assetForNode(project, upstream);
        if (asset?.kind === "video") return { root: asset.root, name: asset.name };
    }

    const fallback = project.assets.find((asset) => asset.kind === "video" && ["video", "motion-video", "output"].includes(text(asset.role)))
        || project.assets.find((asset) => asset.kind === "video");
    if (fallback && (fallback.root === "input" || fallback.root === "output") && text(fallback.name)) {
        return { root: fallback.root, name: text(fallback.name) };
    }
    return null;
}

export function workflowExecutionOutputAssets(project, targetNodeId, jobs = []) {
    const upstreamIds = upstreamNodeIds(project, targetNodeId);
    const assets = [];
    const seen = new Set();
    for (const upstreamId of upstreamIds) {
        const upstream = project.nodes.find((node) => node.id === upstreamId);
        if (!upstream) continue;
        const jobId = text(upstream.config?.jobId);
        const jobSource = text(upstream.config?.jobSource);
        if (!jobId || !jobSource) continue;
        const job = jobs.find((candidate) => String(candidate?.id || "") === jobId && String(candidate?.source || "") === jobSource);
        const output = job?.status === "complete" ? job.output : null;
        if (!output || typeof output !== "object") continue;
        const root = output.root === "input" || output.root === "output" ? output.root : "";
        const name = text(output.name);
        if (!root || !name) continue;
        const key = `${root}:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        assets.push({
            root,
            name,
            kind: jobSource === "img2img" ? "image" : "video",
            role: jobSource === "img2img" ? "reference" : "video",
        });
    }
    return assets;
}

function resolveOpenPoseSource(project, nodeId) {
    const upstreamIds = upstreamNodeIds(project, nodeId);
    for (const id of upstreamIds) {
        const candidate = project.nodes.find((node) => node.id === id);
        if (candidate?.type !== WORKFLOW_NODE_TYPES.asset) continue;
        const asset = assetForNode(project, candidate);
        if (asset?.kind === "image") return { root: asset.root, name: asset.name };
    }
    const roleOrder = ["pose", "reference", "character", "first-frame", "face", "scene"];
    for (const role of roleOrder) {
        const asset = project.assets.find((candidate) => candidate.kind === "image" && text(candidate.role) === role);
        if (asset && (asset.root === "input" || asset.root === "output")) return { root: asset.root, name: asset.name };
    }
    return null;
}

function assetForNode(project, node) {
    const key = text(node.config?.projectAssetKey);
    if (!key) return null;
    return project.assets.find((asset) => asset.key === key) || null;
}

function nearestUpstreamNode(project, nodeId, type) {
    for (const id of upstreamNodeIds(project, nodeId)) {
        const node = project.nodes.find((candidate) => candidate.id === id);
        if (node?.type === type) return node;
    }
    return null;
}

function upstreamNodeIds(project, nodeId) {
    const incoming = new Map();
    for (const edge of project.edges || []) {
        const list = incoming.get(edge.target) || [];
        list.push(edge.source);
        incoming.set(edge.target, list);
    }
    const queue = [...(incoming.get(nodeId) || [])];
    const result = [];
    const seen = new Set();
    while (queue.length) {
        const current = queue.shift();
        if (!current || seen.has(current)) continue;
        seen.add(current);
        result.push(current);
        queue.push(...(incoming.get(current) || []));
    }
    return result;
}

function requireNode(project, nodeId, type) {
    const id = text(nodeId);
    const node = project.nodes.find((candidate) => candidate.id === id);
    if (!node) throw new Error(`Workflow node ${id || "<empty>"} does not exist.`);
    if (node.type !== type) throw new Error(`${node.type} is not a ${type} node.`);
    return node;
}

function finiteNumber(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

function assertProject(project) {
    if (!project || typeof project !== "object" || !Array.isArray(project.nodes) || !Array.isArray(project.edges) || !Array.isArray(project.assets)) {
        throw new TypeError("Workflow tool operation requires a valid project.");
    }
}

function text(value) {
    return typeof value === "string" ? value.trim() : "";
}
