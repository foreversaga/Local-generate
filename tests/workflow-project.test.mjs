import assert from "node:assert/strict";
import test from "node:test";
import {
    createWorkflowProject,
    updateWorkflowProjectBrief,
    WORKFLOW_NODE_STATUS,
    WORKFLOW_NODE_TYPES,
} from "../app/lib/workflow-project.mjs";
import {
    deleteWorkflowProject,
    getWorkflowProject,
    listWorkflowProjects,
    saveWorkflowProject,
} from "../app/lib/workflow-project-store.mjs";

function deterministicIdFactory() {
    let index = 0;
    return (prefix) => `${prefix}-${++index}`;
}

function memoryStorage() {
    const values = new Map();
    return {
        getItem(key) { return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { values.set(key, String(value)); },
    };
}

test("createWorkflowProject builds the starter brief-to-output graph", () => {
    const project = createWorkflowProject({
        brief: "Use four character references to create a beach walking video.",
        now: "2026-08-19T10:00:00.000Z",
        idFactory: deterministicIdFactory(),
    });

    assert.equal(project.name, "Use four character references to create a…");
    assert.deepEqual(project.nodes.map((node) => node.type), [
        WORKFLOW_NODE_TYPES.brief,
        WORKFLOW_NODE_TYPES.prompt,
        WORKFLOW_NODE_TYPES.h3Video,
        WORKFLOW_NODE_TYPES.output,
    ]);
    assert.equal(project.nodes[0].status, WORKFLOW_NODE_STATUS.ready);
    assert.equal(project.edges.length, 3);
    assert.equal(project.assets.length, 0);
    assert.equal(project.checkpoints.length, 0);
});

test("updateWorkflowProjectBrief keeps the brief node and project summary synchronized", () => {
    const project = createWorkflowProject({
        brief: "Initial brief",
        idFactory: deterministicIdFactory(),
        now: "2026-08-19T10:00:00.000Z",
    });
    const updated = updateWorkflowProjectBrief(project, "Updated brief", "2026-08-19T10:05:00.000Z");

    assert.equal(updated.brief, "Updated brief");
    assert.equal(updated.updatedAt, "2026-08-19T10:05:00.000Z");
    assert.equal(updated.nodes[0].config.brief, "Updated brief");
    assert.equal(updated.nodes[0].status, WORKFLOW_NODE_STATUS.ready);
});

test("workflow project storage saves, sorts, loads and deletes projects", () => {
    const storage = memoryStorage();
    const first = createWorkflowProject({ id: "first", brief: "First", now: "2026-08-19T09:00:00.000Z", idFactory: deterministicIdFactory() });
    const second = createWorkflowProject({ id: "second", brief: "Second", now: "2026-08-19T10:00:00.000Z", idFactory: deterministicIdFactory() });

    saveWorkflowProject(storage, first);
    saveWorkflowProject(storage, second);

    assert.deepEqual(listWorkflowProjects(storage).map((project) => project.id), ["second", "first"]);
    assert.equal(getWorkflowProject(storage, "first")?.brief, "First");
    assert.equal(deleteWorkflowProject(storage, "first"), true);
    assert.equal(getWorkflowProject(storage, "first"), null);
});

test("workflow project storage ignores corrupt persisted data", () => {
    const storage = memoryStorage();
    storage.setItem("h3-studio.workflow-projects.v1", "{not-json");
    assert.deepEqual(listWorkflowProjects(storage), []);
});
