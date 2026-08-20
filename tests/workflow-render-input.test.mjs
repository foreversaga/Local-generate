import assert from "node:assert/strict";
import test from "node:test";
import { attachWorkflowAssetNode, WORKFLOW_ASSET_ROLES } from "../app/lib/workflow-assets.mjs";
import { updateWorkflowNodeConfig } from "../app/lib/workflow-graph.mjs";
import { createWorkflowProject, WORKFLOW_NODE_TYPES } from "../app/lib/workflow-project.mjs";
import { buildWorkflowH3RenderInput, prepareWorkflowH3Render } from "../app/lib/workflow-render-input.mjs";

function idFactory() {
    let index = 0;
    return (prefix) => `${prefix}-${++index}`;
}

function project() {
    return createWorkflowProject({
        id: "render-project",
        brief: "Keep the same adult character and follow the motion naturally.",
        now: "2026-08-19T12:00:00.000Z",
        idFactory: idFactory(),
    });
}

function asset(name, kind = "image") {
    return {
        name,
        root: "input",
        kind,
        mime: kind === "video" ? "video/mp4" : "image/png",
        size: 100,
        modified: "2026-08-19T12:00:00.000Z",
        url: `/media?root=input&name=${encodeURIComponent(name)}`,
    };
}

test("workflow asset roles include explicit first frame, last frame, and motion video semantics", () => {
    assert.equal(WORKFLOW_ASSET_ROLES.includes("first-frame"), true);
    assert.equal(WORKFLOW_ASSET_ROLES.includes("last-frame"), true);
    assert.equal(WORKFLOW_ASSET_ROLES.includes("motion-video"), true);
});

test("workflow H3 input maps first and last frame roles into FL2V", () => {
    let value = project();
    const h3 = value.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.h3Video);
    const prompt = value.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.prompt);
    value = updateWorkflowNodeConfig(value, prompt.id, { prompt: "Transition naturally from the first frame to the last frame." });
    value = updateWorkflowNodeConfig(value, h3.id, { mode: "fl2v", modelProfile: "nvfp4_blackwell", duration: 5, width: 736, height: 416, steps: 20, seed: 1 });
    value = attachWorkflowAssetNode(value, asset("first.png"), { role: "first-frame", nodeId: "first" });
    value = attachWorkflowAssetNode(value, asset("last.png"), { role: "last-frame", nodeId: "last" });

    const input = buildWorkflowH3RenderInput(value, h3.id);
    const prepared = prepareWorkflowH3Render(value, h3.id);

    assert.equal(input.referenceImage?.name, "first.png");
    assert.equal(input.lastFrameImage?.name, "last.png");
    assert.equal(prepared.issues.length, 0);
    assert.equal(prepared.requests[0].inputImageName, "first.png");
    assert.equal(prepared.requests[0].lastImageName, "last.png");
});

test("workflow H3 input maps character, face, clothing, and motion roles into Ref2V Motion", () => {
    let value = project();
    const h3 = value.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.h3Video);
    const prompt = value.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.prompt);
    value = updateWorkflowNodeConfig(value, prompt.id, { prompt: "Keep identity, face, clothing, and reproduce the reference motion." });
    value = updateWorkflowNodeConfig(value, h3.id, {
        mode: "ref2v_motion",
        modelProfile: "ref2va_pruned_nvfp4",
        duration: 5,
        width: 736,
        height: 416,
        steps: 20,
        seed: 9,
        referenceVideoStart: 1,
        referenceVideoEnd: 6,
        referenceVideoMaxDimension: 720,
        clothingMode: "reference",
    });
    value = attachWorkflowAssetNode(value, asset("character.png"), { role: "character", nodeId: "character" });
    value = attachWorkflowAssetNode(value, asset("face.png"), { role: "face", nodeId: "face" });
    value = attachWorkflowAssetNode(value, asset("clothing.png"), { role: "clothing", nodeId: "clothing" });
    value = attachWorkflowAssetNode(value, asset("motion.mp4", "video"), { role: "motion-video", nodeId: "motion" });

    const input = buildWorkflowH3RenderInput(value, h3.id);
    const prepared = prepareWorkflowH3Render(value, h3.id);

    assert.deepEqual(input.referenceImages.map((item) => item.name), ["character.png"]);
    assert.deepEqual(input.faceReferenceImages.map((item) => item.name), ["face.png"]);
    assert.deepEqual(input.clothingReferenceImages.map((item) => item.name), ["clothing.png"]);
    assert.equal(input.sourceVideo?.name, "motion.mp4");
    assert.equal(prepared.issues.length, 0);
    assert.deepEqual(prepared.requests[0].referenceImageNames, ["character.png", "face.png", "clothing.png"]);
    assert.deepEqual(prepared.requests[0].referenceImageRoles, ["character", "face", "clothing"]);
    assert.equal(prepared.requests[0].inputVideoName, "motion.mp4");
    assert.equal(prepared.requests[0].referenceVideoStart, 1);
    assert.equal(prepared.requests[0].referenceVideoEnd, 6);
});

test("workflow H3 input uses the nearest upstream Prompt node and falls back to compatible model defaults", () => {
    let value = project();
    const h3 = value.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.h3Video);
    const prompt = value.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.prompt);
    value = updateWorkflowNodeConfig(value, prompt.id, { prompt: "A natural handheld beach walk.", negativePrompt: "flicker" });
    value = updateWorkflowNodeConfig(value, h3.id, { mode: "t2v", modelProfile: "wan22_animate_fp8", duration: 5, width: 736, height: 416, steps: 20, seed: 3 });

    const input = buildWorkflowH3RenderInput(value, h3.id);

    assert.equal(input.prompt, "A natural handheld beach walk.");
    assert.equal(input.negativePrompt, "flicker");
    assert.equal(input.modelProfile, "nvfp4_blackwell");
});
