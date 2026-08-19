import assert from "node:assert/strict";
import test from "node:test";
import {
    bindWorkflowNodeJob,
    supportedJobSourcesForNode,
    unbindWorkflowNodeJob,
    workflowExecutionState,
    workflowJobBinding,
} from "../app/lib/workflow-jobs.mjs";
import { createWorkflowProject, WORKFLOW_NODE_TYPES } from "../app/lib/workflow-project.mjs";

function idFactory() {
    let index = 0;
    return (prefix) => `${prefix}-${++index}`;
}

function project() {
    return createWorkflowProject({
        id: "job-project",
        brief: "Job test",
        idFactory: idFactory(),
        now: "2026-08-19T12:00:00.000Z",
    });
}

test("workflow job bindings enforce node/source compatibility", () => {
    const current = project();
    const video = current.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.h3Video);
    const prompt = current.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.prompt);

    assert.deepEqual(supportedJobSourcesForNode(video.type), ["video"]);
    assert.throws(() => bindWorkflowNodeJob(current, video.id, { id: "job-1", source: "upscale" }), /do not support/);
    assert.throws(() => bindWorkflowNodeJob(current, prompt.id, { id: "job-2", source: "video" }), /do not support/);
});

test("workflow job binding and unbinding only mutate the selected node config", () => {
    const current = project();
    const video = current.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.h3Video);
    const bound = bindWorkflowNodeJob(current, video.id, { id: "job-1", source: "video" }, "2026-08-19T12:01:00.000Z");

    assert.deepEqual(workflowJobBinding(bound.nodes.find((node) => node.id === video.id)), { jobId: "job-1", source: "video" });
    assert.equal(workflowJobBinding(current.nodes.find((node) => node.id === video.id)), null);

    const unbound = unbindWorkflowNodeJob(bound, video.id, "2026-08-19T12:02:00.000Z");
    assert.equal(workflowJobBinding(unbound.nodes.find((node) => node.id === video.id)), null);
});

test("workflow execution state derives transient progress without persisting it into the project", () => {
    const current = project();
    const video = current.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.h3Video);
    const bound = bindWorkflowNodeJob(current, video.id, { id: "job-1", source: "video" });
    const node = bound.nodes.find((item) => item.id === video.id);
    const state = workflowExecutionState(node, [{
        id: "job-1",
        source: "video",
        status: "running",
        progress: 63.7,
        etaMs: 42_000,
        error: "",
    }]);

    assert.deepEqual(state, {
        jobId: "job-1",
        source: "video",
        status: "running",
        progress: 64,
        etaMs: 42_000,
        error: "",
        missing: false,
    });
    assert.equal(node.status, "waiting");
});

test("workflow execution state reports a missing persisted job reference without crashing", () => {
    const current = project();
    const video = current.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.h3Video);
    const bound = bindWorkflowNodeJob(current, video.id, { id: "old-job", source: "video" });
    const state = workflowExecutionState(bound.nodes.find((node) => node.id === video.id), []);

    assert.equal(state?.status, "waiting");
    assert.equal(state?.missing, true);
});
