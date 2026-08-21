import assert from "node:assert/strict";
import test from "node:test";

import {
  createStudioSettings,
  parseStudioSettings,
  reconcileStudioSettings,
  serializeStudioSettings,
  STUDIO_SETTINGS_DEFAULTS,
  STUDIO_SETTINGS_STORAGE_KEY,
  STUDIO_SETTINGS_VERSION,
} from "../app/lib/studio-settings.mjs";

test("studio settings use a versioned tolerant storage contract", () => {
  assert.equal(STUDIO_SETTINGS_STORAGE_KEY, "h3-studio.settings.v1");
  assert.equal(STUDIO_SETTINGS_VERSION, 1);
  assert.deepEqual(parseStudioSettings(null), STUDIO_SETTINGS_DEFAULTS);
  assert.deepEqual(parseStudioSettings("not json"), STUDIO_SETTINGS_DEFAULTS);
  assert.deepEqual(parseStudioSettings(JSON.stringify({ version: 99 })), STUDIO_SETTINGS_DEFAULTS);
  const parsed = parseStudioSettings(serializeStudioSettings({ promptProvider: "codex", codexModel: "gpt-test", codexReasoningEffort: "high" }));
  assert.equal(parsed.promptProvider, "codex");
  assert.equal(parsed.codexModel, "gpt-test");
  assert.equal(parsed.codexReasoningEffort, "high");
  const sglang = parseStudioSettings(serializeStudioSettings({ promptProvider: "sglang", vllmModel: "qwen3.8-27b-uncensored-nvfp4" }));
  assert.equal(sglang.promptProvider, "sglang");
  assert.equal(sglang.vllmModel, "qwen3.8-27b-uncensored-nvfp4");
  const migratedVllm = createStudioSettings({ promptProvider: "vllm", vllmModel: "legacy-vllm-model" });
  assert.equal(migratedVllm.promptProvider, "sglang");
  assert.equal(migratedVllm.vllmModel, "legacy-vllm-model");
  const migrated = createStudioSettings({ promptProvider: "hermes", hermesModel: "legacy-model" });
  assert.equal(migrated.promptProvider, "sglang");
  assert.equal(migrated.vllmModel, "legacy-model");
});

test("health model lists reconcile stored defaults without changing provider intent", () => {
  const reconciled = reconcileStudioSettings(createStudioSettings({ promptProvider: "codex", ollamaModel: "missing", codexModel: "missing", codexReasoningEffort: "ultra" }), {
    ollama: { models: ["local-model"] },
    codex: { models: [{ value: "gpt-5.6-luna", reasoningEfforts: ["low", "medium"] }] },
  });
  assert.equal(reconciled.promptProvider, "codex");
  assert.equal(reconciled.ollamaModel, "local-model");
  assert.equal(reconciled.codexModel, "gpt-5.6-luna");
  assert.equal(reconciled.codexReasoningEffort, "medium");
});

test("missing stored Ollama model prefers the configured default when installed", () => {
  const reconciled = reconcileStudioSettings(createStudioSettings({ ollamaModel: "removed-model" }), {
    ollama: { models: ["another-model", STUDIO_SETTINGS_DEFAULTS.ollamaModel] },
  });

  assert.equal(reconciled.ollamaModel, STUDIO_SETTINGS_DEFAULTS.ollamaModel);
});

test("vLLM model selection reconciles against the Docker server model", () => {
  const reconciled = reconcileStudioSettings(createStudioSettings({ promptProvider: "sglang", vllmModel: "missing" }), {
    sglang: { models: ["qwen3.8-27b-uncensored-nvfp4"] },
  });

  assert.equal(reconciled.promptProvider, "sglang");
  assert.equal(reconciled.vllmModel, "qwen3.8-27b-uncensored-nvfp4");
});
