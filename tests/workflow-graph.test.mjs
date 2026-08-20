import assert from "node:assert/strict";
import test from "node:test";
import {
    addWorkflowNode,
    connectWorkflowNodes,
    duplicateWorkflowNode,
    moveWorkflowNode,
    removeWorkflowNode,
    updateWorkflowNodeConfig,
    validateWorkflowConnection,
} from "../app/lib/workflow-graph.mjs";
import { createWorkflowProject, WORKFLOW_NODE_TYPES } from "../app/lib/workflow-project.mjs";

function idFactory() {
    let index = 0;
    return (prefix) => `${prefix}-${++index}`;
}

function project() {
    return createWorkflowProject({
        id: "project-graph",
        brief: "Graph test",
        now: "2026-08-19T12:00:00.000Z",
        idFactory: idFactory(),
    });
}

test("workflow graph adds, moves, duplicates and removes nodes immutably", () => {
    const original = project();
    const withAsset = addWorkflowNode(original, WORKFLOW_NODE_TYPES.asset, {
        id: "asset-extra",
        position: { x: 80.4, y: 90.8 },
        config: { role: "character" },
    }, "2026-08-19T12:01:00.000Z");

    assert.equal(original.nodes.length, 4);
    assert.equal(withAsset.nodes.length, 5);
    assert.deepEqual(withAsset.nodes.at(-1)?.position, { x: 80, y: 91 });

    const moved = moveWorkflowNode(withAsset, "asset-extra", { x: 200, y: 240 }, "2026-08-19T12:02:00.000Z");
    assert.deepEqual(moved.nodes.find((node) => node.id === "asset-extra")?.position, { x: 200, y: 240 });

    const duplicated = duplicateWorkflowNode(moved, "asset-extra", {
        id: "asset-copy",
        offset: 20,
    }, "2026-08-19T12:03:00.000Z");
    const copy = duplicated.nodes.find((node) => node.id === "asset-copy");
    assert.equal(copy?.title, "Asset copy");
    assert.deepEqual(copy?.config, { role: "character" });
    assert.deepEqual(copy?.position, { x: 220, y: 260 });

    const removed = removeWorkflowNode(duplicated, "asset-extra", "2026-08-19T12:04:00.000Z");
    assert.equal(removed.nodes.some((node) => node.id === "asset-extra"), false);
    assert.equal(removed.nodes.some((node) => node.id === "asset-copy"), true);
});

test("workflow graph protects the root Brief node", () => {
    const current = project();
    const brief = current.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.brief);
    assert.throws(() => removeWorkflowNode(current, brief.id), /Brief node cannot be deleted/);
});

test("workflow graph validates connection direction and duplicate edges", () => {
    const current = project();
    const prompt = current.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.prompt);
    const video = current.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.h3Video);
    const output = current.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.output);

    assert.equal(validateWorkflowConnection(current, output.id, video.id).code, "incompatible-types");
    assert.equal(validateWorkflowConnection(current, video.id, video.id).code, "self-loop");
    assert.equal(validateWorkflowConnection(current, prompt.id, video.id).code, "duplicate-edge");
});

test("workflow graph connects compatible newly-added nodes and removes attached edges with the node", () => {
    const current = project();
    const output = current.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.output);
    const withUpscale = addWorkflowNode(current, WORKFLOW_NODE_TYPES.upscale, { id: "upscale-extra" });
    const connected = connectWorkflowNodes(withUpscale, "upscale-extra", output.id, "2026-08-19T12:05:00.000Z");

    assert.equal(connected.edges.some((edge) => edge.source === "upscale-extra" && edge.target === output.id), true);
    const removed = removeWorkflowNode(connected, "upscale-extra");
    assert.equal(removed.edges.some((edge) => edge.source === "upscale-extra" || edge.target === "upscale-extra"), false);
});

test("workflow graph updates only the selected node config", () => {
    const current = project();
    const prompt = current.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.prompt);
    const updated = updateWorkflowNodeConfig(current, prompt.id, { provider: "ollama", model: "local" });

    assert.deepEqual(updated.nodes.find((node) => node.id === prompt.id)?.config, { provider: "ollama", model: "local" });
    assert.deepEqual(current.nodes.find((node) => node.id === prompt.id)?.config, {});
});
