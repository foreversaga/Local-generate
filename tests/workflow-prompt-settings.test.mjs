import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkflowPromptConfiguration } from "../app/lib/workflow-prompt-settings.mjs";

const stored = {
    version: 1,
    promptProvider: "ollama",
    ollamaModel: "missing-model",
    codexModel: "gpt-old",
    codexReasoningEffort: "ultra",
};

test("workflow prompt configuration reconciles stale Ollama settings against current health", () => {
    const resolved = resolveWorkflowPromptConfiguration(stored, {
        ollama: { online: true, models: ["installed-model"] },
        codex: { online: true, skill: true, models: [{ value: "gpt-new", reasoningEfforts: ["medium", "high"] }] },
    }, "auto");

    assert.equal(resolved.provider, "ollama");
    assert.equal(resolved.model, "installed-model");
    assert.equal(resolved.codexModel, "gpt-new");
    assert.equal(resolved.reasoningEffort, "medium");
});

test("workflow prompt configuration respects an explicit Codex provider after reconciliation", () => {
    const resolved = resolveWorkflowPromptConfiguration(stored, {
        ollama: { online: true, models: ["installed-model"] },
        codex: { online: true, skill: true, models: [{ value: "gpt-new", reasoningEfforts: ["high"] }] },
    }, "codex");

    assert.equal(resolved.provider, "codex");
    assert.equal(resolved.model, "gpt-new");
    assert.equal(resolved.reasoningEffort, "high");
});

test("workflow prompt configuration uses Hermes only when its API and H3 skill are ready", () => {
    const resolved = resolveWorkflowPromptConfiguration(stored, {
        ollama: { online: true, models: ["installed-model"] },
        codex: { online: true, skill: true, models: [{ value: "gpt-new", reasoningEfforts: ["high"] }] },
        hermes: { online: true, skill: true, skillName: "h3-prompt-writing", model: "hermes-agent" },
    }, "hermes");

    assert.equal(resolved.provider, "hermes");
    assert.equal(resolved.model, "hermes-agent");
});

test("workflow prompt configuration fails before request creation when the selected provider is unavailable", () => {
    assert.throws(
        () => resolveWorkflowPromptConfiguration(stored, { ollama: { online: false, models: [] } }, "ollama"),
        /Ollama 尚未連線/,
    );
    assert.throws(
        () => resolveWorkflowPromptConfiguration(stored, { codex: { online: true, skill: false, models: [] } }, "codex"),
        /h3-prompt-writing skill/,
    );
    assert.throws(
        () => resolveWorkflowPromptConfiguration(stored, { hermes: { online: false } }, "hermes"),
        /Hermes Agent 尚未連線/,
    );
    assert.throws(
        () => resolveWorkflowPromptConfiguration(stored, { hermes: { online: true, skill: false, skillName: "h3-prompt-writing" } }, "hermes"),
        /h3-prompt-writing skill/,
    );
});
