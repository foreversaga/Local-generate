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
