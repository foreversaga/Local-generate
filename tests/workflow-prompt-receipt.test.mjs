import assert from "node:assert/strict";
import test from "node:test";
import { updateWorkflowNodeConfig } from "../app/lib/workflow-graph.mjs";
import { createWorkflowProject, WORKFLOW_NODE_TYPES } from "../app/lib/workflow-project.mjs";
import { buildWorkflowH3RenderInput } from "../app/lib/workflow-render-input.mjs";

test("workflow H3 input forwards the upstream Ollama prompt receipt", () => {
    const ids = ["brief", "prompt", "video", "output"];
    let index = 0;
    let project = createWorkflowProject({
        id: "receipt-project",
        brief: "A test brief",
        idFactory: () => ids[index++],
    });
    const prompt = project.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.prompt);
    const h3 = project.nodes.find((node) => node.type === WORKFLOW_NODE_TYPES.h3Video);
    project = updateWorkflowNodeConfig(project, prompt.id, {
        prompt: "A valid generated H3 prompt.",
        ollamaPromptReceipt: "receipt-123",
    });
    project = updateWorkflowNodeConfig(project, h3.id, {
        mode: "t2v",
        modelProfile: "nvfp4_blackwell",
        width: 736,
        height: 416,
        duration: 5,
        steps: 20,
        seed: 1,
    });

    const input = buildWorkflowH3RenderInput(project, h3.id);
    assert.equal(input.prompt, "A valid generated H3 prompt.");
    assert.equal(input.ollamaPromptReceipt, "receipt-123");
});
