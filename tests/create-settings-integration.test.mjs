import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Create prompt consumers hydrate persisted prompt defaults and reconcile health models", async () => {
  const [singleAssistant, longForm] = await Promise.all([
    readFile(new URL("../app/components/create/SinglePromptAssistant.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/create/LongCreateForm.tsx", import.meta.url), "utf8"),
  ]);

  for (const source of [singleAssistant, longForm]) {
    assert.match(source, /STUDIO_SETTINGS_DEFAULTS/);
    assert.match(source, /loadStudioSettings/);
    assert.match(source, /reconcileStudioSettings/);
    assert.match(source, /settingsHydrated/);
    assert.match(source, /set(?:Prompt)?Provider\(stored\.promptProvider/);
    assert.match(source, /setOllamaModel\(stored\.ollamaModel/);
    assert.match(source, /setCodexModel\(stored\.codexModel/);
    assert.match(source, /set(?:ReasoningEffort|reasoningEffort)\(stored\.codexReasoningEffort/);
  }

  assert.match(singleAssistant, /reconcileStudioSettings\(\{[\s\S]*promptProvider: provider[\s\S]*\}, health\)/);
  assert.match(singleAssistant, /new Map<string, \(typeof PROMPT_MODEL_CATALOG\)\[number\]>/);
  assert.match(longForm, /reconcileStudioSettings\(\{[\s\S]*promptProvider,[\s\S]*\}, health\)/);
});
