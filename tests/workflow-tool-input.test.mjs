import assert from "node:assert/strict";
import test from "node:test";
import { attachWorkflowAssetNode } from "../app/lib/workflow-assets.mjs";
import { addWorkflowNode, connectWorkflowNodes, updateWorkflowNodeConfig } from "../app/lib/workflow-graph.mjs";
import { createWorkflowProject, WORKFLOW_NODE_TYPES } from "../app/lib/workflow-project.mjs";
import { buildWorkflowH3RenderInput } from "../app/lib/workflow-render-input.mjs";
import { buildWorkflowOpenPoseInput, resolveWorkflowUpscaleSource, workflowExecutionOutputAssets } from "../app/lib/workflow-tool-input.mjs";

function baseProject() {
    return createWorkflowProject({ id: "tools-project", brief: "Create a realistic character following the reference pose." });
}

function imageAsset(name = "pose.png") {
    return { name, root: "input", kind: "image", mime: "image/png", size: 100, modified: "2026-08-19T12:00:00Z", url: `/media?root=input&name=${name}` };
}

test("OpenPose workflow input reuses upstream Asset and Prompt with existing img2img defaults", () => {
    let project = baseProject();
    const prompt = project.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.prompt);
    project = updateWorkflowNodeConfig(project, prompt.id, { prompt: "A person doing the same pose.", negativePrompt: "flicker", ollamaPromptReceipt: "receipt-1" });
    project = attachWorkflowAssetNode(project, imageAsset(), { role: "pose", nodeId: "pose-asset" });
    project = addWorkflowNode(project, WORKFLOW_NODE_TYPES.openPose, { id: "pose-node", config: { strength: 1.2 } });
    project = connectWorkflowNodes(project, "pose-asset", "pose-node");
    project = connectWorkflowNodes(project, prompt.id, "pose-node");

    const input = buildWorkflowOpenPoseInput(project, "pose-node");
    assert.equal(input.sourceName, "pose.png");
    assert.equal(input.poseName, "pose.png");
    assert.equal(input.prompt, "A person doing the same pose.");
    assert.equal(input.negativePrompt, "flicker");
    assert.equal(input.ollamaPromptReceipt, "receipt-1");
    assert.equal(input.poseControlStrength, 1.2);
    assert.equal(input.poseResolution, 768);
    assert.equal(input.denoise, 1);
    assert.equal(input.steps, 35);
    assert.equal(input.cfg, 5);
    assert.equal(input.model, "Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors");
});

test("Upscale resolves a completed upstream H3 output before project video assets", () => {
    let project = baseProject();
    const h3 = project.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.h3Video);
    project = updateWorkflowNodeConfig(project, h3.id, { jobId: "video-job", jobSource: "video" });
    project = addWorkflowNode(project, WORKFLOW_NODE_TYPES.upscale, { id: "upscale-node" });
    project = connectWorkflowNodes(project, h3.id, "upscale-node");

    const source = resolveWorkflowUpscaleSource(project, "upscale-node", [{ id: "video-job", source: "video", status: "complete", output: { root: "output", name: "render.mp4" } }]);
    assert.deepEqual(source, { root: "output", name: "render.mp4" });
});

test("completed OpenPose output becomes a transient upstream image for connected H3", () => {
    let project = baseProject();
    const h3 = project.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.h3Video);
    const prompt = project.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.prompt);
    project = updateWorkflowNodeConfig(project, prompt.id, { prompt: "Animate the generated pose image naturally." });
    project = updateWorkflowNodeConfig(project, h3.id, { mode: "i2v", modelProfile: "nvfp4_blackwell", width: 736, height: 416, duration: 5, steps: 20, seed: 10 });
    project = addWorkflowNode(project, WORKFLOW_NODE_TYPES.openPose, { id: "pose-node", config: { jobId: "pose-job", jobSource: "img2img" } });
    project = connectWorkflowNodes(project, prompt.id, "pose-node");
    project = connectWorkflowNodes(project, "pose-node", h3.id);
    const jobs = [{ id: "pose-job", source: "img2img", status: "complete", output: { root: "output", name: "pose-result.png" } }];

    const executionAssets = workflowExecutionOutputAssets(project, h3.id, jobs);
    const input = buildWorkflowH3RenderInput(project, h3.id, { jobs });
    assert.deepEqual(executionAssets, [{ root: "output", name: "pose-result.png", kind: "image", role: "reference" }]);
    assert.equal(input.referenceImage?.name, "pose-result.png");
    assert.equal(input.referenceImage?.root, "output");
});

test("OpenPose workflow input rejects missing upstream image", () => {
    let project = baseProject();
    project = addWorkflowNode(project, WORKFLOW_NODE_TYPES.openPose, { id: "pose-node" });
    assert.throws(() => buildWorkflowOpenPoseInput(project, "pose-node"), /上游圖片素材/);
});
