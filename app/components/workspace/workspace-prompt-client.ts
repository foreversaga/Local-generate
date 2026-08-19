import { buildSinglePromptRequest } from "../../lib/single-prompt-request.mjs";
import { validateSingleRenderAssets } from "../../lib/single-render-validation.mjs";
import { loadStudioSettings } from "../../lib/studio-settings.mjs";
import { buildWorkflowH3RenderInput } from "../../lib/workflow-render-input.mjs";
import { WORKFLOW_NODE_TYPES } from "../../lib/workflow-project.mjs";
import type { WorkflowProject } from "./workflow-types";

const BRIDGE_URL = "/app";
const REF2V_WORKFLOW = "character_motion";

type PromptPayload = {
    prompt?: string;
    negativePrompt?: string;
    ollamaPromptReceipt?: string | { id?: string };
    error?: string | { code?: string; message?: string };
    code?: string;
    candidatePrompt?: string;
    details?: { candidatePrompt?: string };
};

type PromptResult = {
    prompt: string;
    negativePrompt: string;
    ollamaPromptReceipt: string;
};

export async function executeWorkflowPromptNode(
    project: WorkflowProject,
    promptNodeId: string,
    fetchImpl: typeof fetch = globalThis.fetch,
): Promise<PromptResult> {
    const promptNode = project.nodes.find((node) => node.id === promptNodeId);
    if (!promptNode || promptNode.type !== WORKFLOW_NODE_TYPES.prompt) throw new Error("Prompt node not found.");
    if (!project.brief.trim()) throw new Error("請先填寫 Project Brief。");

    const h3Node = nearestDownstreamH3Node(project, promptNode.id)
        || project.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.h3Video);
    if (!h3Node) throw new Error("找不到可使用此提示詞的 H3 Video node。");

    const input = buildWorkflowH3RenderInput(project, h3Node.id) as Record<string, any>;
    const requestMode = input.mode === "ref2v_motion" ? "ref2v" : input.mode;
    const characterMotion = input.mode === "ref2v_motion";
    const assetIssues = validateSingleRenderAssets({
        mode: requestMode,
        referenceImage: input.referenceImage,
        referenceImages: input.referenceImages,
        faceReferenceImages: input.faceReferenceImages,
        clothingReferenceImages: input.clothingReferenceImages,
        ref2vWorkflow: characterMotion ? REF2V_WORKFLOW : undefined,
        clothingMode: input.clothingMode,
        clothingDescription: input.clothingDescription,
        referenceVideoStart: input.referenceVideoStart,
        referenceVideoEnd: input.referenceVideoEnd,
        referenceVideoMaxDimension: input.referenceVideoMaxDimension,
        duration: input.duration,
        lastFrameImage: input.lastFrameImage,
        sourceVideo: input.sourceVideo,
    }) as Array<{ message: string }>;
    if (assetIssues.length) throw new Error(assetIssues[0].message);

    const settings = loadStudioSettings();
    const configuredProvider = text(promptNode.config?.provider);
    const provider = configuredProvider === "ollama" || configuredProvider === "codex"
        ? configuredProvider
        : configuredProvider === "hermes"
            ? "hermes"
            : settings.promptProvider;
    if (provider === "hermes") throw new Error("Hermes provider 尚未接入現有 /app/api/prompt contract，請先選 Auto、Ollama 或 Codex CLI。");

    const referenceImages = characterMotion
        ? [...input.referenceImages, ...input.faceReferenceImages, ...(input.clothingMode === "reference" ? input.clothingReferenceImages : [])]
        : input.referenceImages;
    const referenceImageRoles = characterMotion
        ? [
            ...input.referenceImages.map(() => "character"),
            ...input.faceReferenceImages.map(() => "face"),
            ...(input.clothingMode === "reference" ? input.clothingReferenceImages.map(() => "clothing") : []),
        ]
        : [];
    const images = await buildPromptImages(input, referenceImages, fetchImpl);
    const model = provider === "codex" ? settings.codexModel : settings.ollamaModel;
    const response = await fetchImpl(`${BRIDGE_URL}/api/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildSinglePromptRequest({
            provider,
            model,
            codexModel: settings.codexModel,
            reasoningEffort: settings.codexReasoningEffort,
            brief: project.brief.trim(),
            negativePrompt: text(promptNode.config?.negativePrompt),
            mode: requestMode,
            duration: Number(input.duration),
            referenceImageName: input.referenceImage?.kind === "image" ? input.referenceImage.name : "",
            referenceImageNames: referenceImages.map((asset: any) => asset.name),
            referenceImageRoles,
            ref2vWorkflow: characterMotion ? REF2V_WORKFLOW : "",
            clothingMode: characterMotion ? input.clothingMode : "character",
            clothingDescription: characterMotion ? input.clothingDescription : "",
            referenceVideoStart: characterMotion ? input.referenceVideoStart : 0,
            referenceVideoEnd: characterMotion ? input.referenceVideoEnd : input.duration,
            referenceVideoMaxDimension: characterMotion ? input.referenceVideoMaxDimension : 720,
            lastFrameName: input.lastFrameImage?.kind === "image" ? input.lastFrameImage.name : "",
            sourceVideoName: input.sourceVideo?.kind === "video" ? input.sourceVideo.name : "",
            images,
        })),
    });
    const payload = await response.json().catch(() => ({})) as PromptPayload;
    if (!response.ok) {
        const candidate = payload.candidatePrompt || payload.details?.candidatePrompt || "";
        throw new Error(apiErrorMessage(payload, candidate ? `提示詞生成失敗；候選內容：${candidate}` : "提示詞生成失敗。"));
    }
    if (!payload.prompt?.trim()) throw new Error("提示詞服務沒有回傳 prompt。");
    const receipt = typeof payload.ollamaPromptReceipt === "string"
        ? payload.ollamaPromptReceipt
        : payload.ollamaPromptReceipt?.id || "";
    return {
        prompt: payload.prompt,
        negativePrompt: payload.negativePrompt || text(promptNode.config?.negativePrompt),
        ollamaPromptReceipt: receipt,
    };
}

async function buildPromptImages(input: Record<string, any>, referenceImages: any[], fetchImpl: typeof fetch) {
    const images: Array<{ role: string; data: string }> = [];
    if ((input.mode === "i2v" || input.mode === "replace") && input.referenceImage?.kind === "image") {
        images.push({ role: "reference_image", data: await assetToPromptImage(input.referenceImage, 0, fetchImpl) });
    }
    if (input.mode === "ref2v" || input.mode === "ref2v_motion") {
        for (const [index, asset] of referenceImages.slice(0, 9).entries()) {
            images.push({ role: `picture_${index + 1}`, data: await assetToPromptImage(asset, 0, fetchImpl) });
        }
    }
    if (input.mode === "fl2v" && input.referenceImage?.kind === "image") {
        images.push({ role: "first_frame", data: await assetToPromptImage(input.referenceImage, 0, fetchImpl) });
    }
    if ((input.mode === "fl2v" || input.mode === "l2v") && input.lastFrameImage?.kind === "image") {
        images.push({ role: "last_frame", data: await assetToPromptImage(input.lastFrameImage, 0, fetchImpl) });
    }
    if ((input.mode === "replace" || input.mode === "ref2v" || input.mode === "ref2v_motion") && input.sourceVideo?.kind === "video") {
        const role = input.mode === "replace" ? "source_video_first_frame" : "video_1_preview_frame";
        const time = input.mode === "ref2v_motion" ? Number(input.referenceVideoStart || 0) : 0;
        images.push({ role, data: await assetToPromptImage(input.sourceVideo, time, fetchImpl) });
    }
    return images;
}

async function assetToPromptImage(asset: { root: string; name: string; kind: string }, videoTime: number, fetchImpl: typeof fetch) {
    const url = `${BRIDGE_URL}/media?root=${encodeURIComponent(asset.root)}&name=${encodeURIComponent(asset.name)}`;
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`無法讀取參考素材 ${asset.name}。`);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    try {
        const canvas = document.createElement("canvas");
        const maxDimension = 1024;
        if (asset.kind === "image") {
            const image = new Image();
            image.src = objectUrl;
            await new Promise<void>((resolve, reject) => {
                image.onload = () => resolve();
                image.onerror = () => reject(new Error(`無法解碼圖片 ${asset.name}。`));
            });
            const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
            canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
            canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
        } else {
            const video = document.createElement("video");
            video.src = objectUrl;
            video.muted = true;
            video.preload = "metadata";
            await new Promise<void>((resolve, reject) => {
                video.onloadedmetadata = () => resolve();
                video.onerror = () => reject(new Error(`無法解碼影片 ${asset.name}。`));
            });
            if (Number.isFinite(video.duration) && video.duration > 0) {
                video.currentTime = Math.min(Math.max(0, videoTime), Math.max(0, video.duration - 0.05));
                await new Promise<void>((resolve) => {
                    video.onseeked = () => resolve();
                    window.setTimeout(resolve, 500);
                });
            }
            const width = video.videoWidth || 1;
            const height = video.videoHeight || 1;
            const scale = Math.min(1, maxDimension / Math.max(width, height));
            canvas.width = Math.max(1, Math.round(width * scale));
            canvas.height = Math.max(1, Math.round(height * scale));
            canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
        }
        return canvas.toDataURL("image/jpeg", 0.88).replace(/^data:image\/jpeg;base64,/, "");
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

function nearestDownstreamH3Node(project: WorkflowProject, nodeId: string) {
    const outgoing = new Map<string, string[]>();
    for (const edge of project.edges) {
        const list = outgoing.get(edge.source) || [];
        list.push(edge.target);
        outgoing.set(edge.source, list);
    }
    const queue = [...(outgoing.get(nodeId) || [])];
    const seen = new Set<string>();
    while (queue.length) {
        const candidateId = queue.shift();
        if (!candidateId || seen.has(candidateId)) continue;
        seen.add(candidateId);
        const candidate = project.nodes.find((node) => node.id === candidateId);
        if (!candidate) continue;
        if (candidate.type === WORKFLOW_NODE_TYPES.h3Video) return candidate;
        queue.push(...(outgoing.get(candidateId) || []));
    }
    return null;
}

function apiErrorMessage(payload: PromptPayload, fallback: string) {
    const message = typeof payload.error === "string" ? payload.error : payload.error?.message || fallback;
    const code = payload.code || (typeof payload.error === "object" ? payload.error?.code : "");
    return code ? `${code}: ${message}` : message;
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}
