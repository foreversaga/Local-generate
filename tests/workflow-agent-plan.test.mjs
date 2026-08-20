import assert from "node:assert/strict";
import test from "node:test";
import { applyWorkflowAgentPlan } from "../app/lib/workflow-agent-plan.mjs";
import { attachWorkflowAssetNode } from "../app/lib/workflow-assets.mjs";
import { createWorkflowProject, WORKFLOW_NODE_TYPES } from "../app/lib/workflow-project.mjs";
import { createHermesWorkflowPlanner, parseWorkflowPlan } from "../server/workflow/hermes-workflow-planner.mjs";

const ids = (() => {
    let value = 0;
    return (prefix = "node") => `${prefix}-${++value}`;
})();

function imageAsset(name = "person.png") {
    return { root: "input", name, kind: "image", mime: "image/png", size: 100, modified: "2026-08-20T00:00:00.000Z", url: `/media?root=input&name=${name}` };
}

test("Hermes workflow planner accepts only allow-listed graph decisions and existing asset keys", async () => {
    const client = {
        skillName: "h3-prompt-writing",
        async complete({ system, prompt }) {
            assert.match(system, /h3-prompt-writing/);
            assert.match(prompt, /input:person.png/);
            return JSON.stringify({
                mode: "ref2v_motion",
                duration: 7.2,
                promptSkill: "ref2v-prompt",
                useOpenPose: true,
                useUpscale: true,
                assetRoles: [
                    { key: "input:person.png", role: "character" },
                    { key: "input:invented.png", role: "face" },
                ],
                reason: "Keep identity from the still and motion from video.",
            });
        },
    };
    const planner = createHermesWorkflowPlanner({ hermesClient: client });
    const result = await planner.plan({
        brief: "Use the reference character for a short motion clip.",
        assets: [{ key: "input:person.png", kind: "image", role: "reference" }],
    });
    assert.equal(result.mode, "ref2v_motion");
    assert.equal(result.duration, 7);
    assert.equal(result.useOpenPose, true);
    assert.equal(result.useUpscale, true);
    assert.deepEqual(result.assetRoles, [{ key: "input:person.png", role: "character" }]);
});

test("workflow plan parser rejects arbitrary modes instead of applying them", () => {
    assert.throws(
        () => parseWorkflowPlan(JSON.stringify({ mode: "shell", duration: 5 }), []),
        (error) => error?.code === "WORKFLOW_PLAN_MODE_INVALID",
    );
});

test("agent plan updates starter nodes, asset roles, and inserts reversible OpenPose/Upscale stages", () => {
    let project = createWorkflowProject({ brief: "Animate this person", idFactory: ids });
    project = attachWorkflowAssetNode(project, imageAsset(), { role: "reference", nodeId: "asset-person", position: { x: 80, y: 360 } });
    const next = applyWorkflowAgentPlan(project, {
        mode: "i2v",
        duration: 6,
        promptSkill: "h3-prompt",
        useOpenPose: true,
        useUpscale: true,
        assetRoles: [{ key: "input:person.png", role: "pose" }],
        reason: "Use the supplied pose and upscale the result.",
    });

    const prompt = next.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.prompt);
    const h3 = next.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.h3Video);
    const brief = next.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.brief);
    const openPose = next.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.openPose);
    const upscale = next.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.upscale);
    const output = next.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.output);

    assert.equal(prompt.config.provider, "hermes");
    assert.equal(prompt.config.skill, "h3-prompt");
    assert.equal(h3.config.mode, "i2v");
    assert.equal(h3.config.duration, 6);
    assert.equal(brief.config.agentPlanReason, "Use the supplied pose and upscale the result.");
    assert.equal(next.assets[0].role, "pose");
    assert.ok(openPose);
    assert.ok(upscale);
    assert.ok(next.edges.some((edge) => edge.source === prompt.id && edge.target === openPose.id));
    assert.ok(next.edges.some((edge) => edge.source === openPose.id && edge.target === h3.id));
    assert.ok(next.edges.some((edge) => edge.source === h3.id && edge.target === upscale.id));
    assert.ok(next.edges.some((edge) => edge.source === upscale.id && edge.target === output.id));
    assert.equal(next.edges.some((edge) => edge.source === prompt.id && edge.target === h3.id), false);
    assert.equal(next.edges.some((edge) => edge.source === h3.id && edge.target === output.id), false);
});
