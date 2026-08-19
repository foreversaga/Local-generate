import assert from "node:assert/strict";
import test from "node:test";
import { addWorkflowNode } from "../app/lib/workflow-graph.mjs";
import {
    approveWorkflowCheckpoint,
    createWorkflowCheckpoint,
    latestApprovedCheckpoint,
    reopenWorkflowCheckpoint,
    restoreWorkflowCheckpoint,
} from "../app/lib/workflow-checkpoints.mjs";
import { createWorkflowProject, WORKFLOW_NODE_TYPES } from "../app/lib/workflow-project.mjs";

function idFactory() {
    let index = 0;
    return (prefix) => `${prefix}-${++index}`;
}

function project() {
    return createWorkflowProject({
        id: "checkpoint-project",
        brief: "Original brief",
        idFactory: idFactory(),
        now: "2026-08-19T12:00:00.000Z",
    });
}

test("workflow checkpoints capture a deep project snapshot", () => {
    const created = createWorkflowCheckpoint(project(), {
        id: "checkpoint-1",
        type: "prompt-review",
        label: "Prompt v1",
    }, "2026-08-19T12:01:00.000Z");

    assert.equal(created.checkpoints.length, 1);
    assert.equal(created.checkpoints[0].status, "pending");
    assert.equal(created.checkpoints[0].snapshot.brief, "Original brief");
    assert.notEqual(created.checkpoints[0].snapshot.nodes, created.nodes);
});

test("workflow checkpoints approve, reopen and query the latest approved checkpoint", () => {
    const created = createWorkflowCheckpoint(project(), { id: "checkpoint-1", type: "render-ready" });
    const approved = approveWorkflowCheckpoint(created, "checkpoint-1", "2026-08-19T12:02:00.000Z");

    assert.equal(approved.checkpoints[0].status, "approved");
    assert.equal(latestApprovedCheckpoint(approved, "render-ready")?.id, "checkpoint-1");

    const reopened = reopenWorkflowCheckpoint(approved, "checkpoint-1", "2026-08-19T12:03:00.000Z");
    assert.equal(reopened.checkpoints[0].status, "pending");
    assert.equal(reopened.checkpoints[0].approvedAt, "");
});

test("restoring a checkpoint restores graph state while preserving checkpoint history", () => {
    const original = project();
    const withCheckpoint = createWorkflowCheckpoint(original, { id: "checkpoint-1", type: "media-review" });
    const modified = addWorkflowNode(withCheckpoint, WORKFLOW_NODE_TYPES.upscale, { id: "upscale-later" });
    modified.brief = "Changed brief";

    const restored = restoreWorkflowCheckpoint(modified, "checkpoint-1", "2026-08-19T12:04:00.000Z");

    assert.equal(restored.brief, "Original brief");
    assert.equal(restored.nodes.some((node) => node.id === "upscale-later"), false);
    assert.equal(restored.checkpoints.length, 1);
    assert.equal(restored.checkpoints[0].id, "checkpoint-1");
});
