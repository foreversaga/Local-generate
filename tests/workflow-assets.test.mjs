import assert from "node:assert/strict";
import test from "node:test";
import {
    attachWorkflowAssetNode,
    registerWorkflowAsset,
    removeWorkflowAsset,
    updateWorkflowAssetRole,
    workflowAssetForNode,
} from "../app/lib/workflow-assets.mjs";
import { createWorkflowProject, WORKFLOW_NODE_TYPES } from "../app/lib/workflow-project.mjs";

function idFactory() {
    let index = 0;
    return (prefix) => `${prefix}-${++index}`;
}

function project() {
    return createWorkflowProject({
        id: "asset-project",
        brief: "Asset test",
        now: "2026-08-19T12:00:00.000Z",
        idFactory: idFactory(),
    });
}

const imageAsset = {
    name: "character/front.png",
    root: "input",
    kind: "image",
    mime: "image/png",
    size: 2048,
    modified: "2026-08-19T11:00:00.000Z",
    url: "/media/input/character/front.png",
};

test("workflow asset registration reuses the same project asset by root and name", () => {
    const first = registerWorkflowAsset(project(), imageAsset, "character", "2026-08-19T12:01:00.000Z");
    const second = registerWorkflowAsset(first, { ...imageAsset, size: 4096 }, "face", "2026-08-19T12:02:00.000Z");

    assert.equal(second.assets.length, 1);
    assert.equal(second.assets[0].id, first.assets[0].id);
    assert.equal(second.assets[0].size, 4096);
    assert.equal(second.assets[0].role, "face");
});

test("workflow asset attachment creates an Asset node that references Library metadata", () => {
    const attached = attachWorkflowAssetNode(project(), imageAsset, {
        nodeId: "character-node",
        role: "character",
        position: { x: 120, y: 160 },
    }, "2026-08-19T12:03:00.000Z");
    const node = attached.nodes.find((item) => item.id === "character-node");

    assert.equal(node?.type, WORKFLOW_NODE_TYPES.asset);
    assert.equal(node?.config.assetName, imageAsset.name);
    assert.equal(node?.config.role, "character");
    assert.equal(workflowAssetForNode(attached, node)?.name, imageAsset.name);
});

test("workflow asset role updates stay synchronized between the project asset and its nodes", () => {
    const attached = attachWorkflowAssetNode(project(), imageAsset, { nodeId: "asset-node", role: "reference" });
    const updated = updateWorkflowAssetRole(attached, "input:character/front.png", "face", "2026-08-19T12:04:00.000Z");

    assert.equal(updated.assets[0].role, "face");
    assert.equal(updated.nodes.find((item) => item.id === "asset-node")?.config.role, "face");
});

test("removing a project asset keeps the graph node but clears its binding", () => {
    const attached = attachWorkflowAssetNode(project(), imageAsset, { nodeId: "asset-node" });
    const removed = removeWorkflowAsset(attached, "input:character/front.png");
    const node = removed.nodes.find((item) => item.id === "asset-node");

    assert.equal(removed.assets.length, 0);
    assert.equal(node?.config.projectAssetKey, "");
    assert.equal(node?.config.assetName, imageAsset.name);
});
