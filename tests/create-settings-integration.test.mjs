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
  assert.match(singleAssistant, /qwen3\.5-hauhaucs-aggressive:9b-q6_k/);
  assert.match(longForm, /reconcileStudioSettings\(\{[\s\S]*promptProvider,[\s\S]*\}, health\)/);
  assert.match(longForm, /id="long-resolution-scale"/);
  assert.match(longForm, /applyResolutionScale\(Number\(event\.currentTarget\.value\)\)/);
});

test("job Retry returns video work to the corresponding Create editor", async () => {
  const [jobDetail, singleForm, longForm] = await Promise.all([
    readFile(new URL("../app/components/jobs/JobDetailWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/create/SingleCreateForm.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/create/LongCreateForm.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(jobDetail, /createSingleCreateDraftFromJob\(job\.raw\)/);
  assert.match(jobDetail, /router\.push\("\/app\/create\/single"\)/);
  assert.match(jobDetail, /router\.push\(`\/app\/create\/long\?retry=/);
  assert.match(singleForm, /hydratedResolutionRef\.current = draftHasResolutionAsset/);
  assert.match(singleForm, /setWidth\(hydratedResolution\.width\)/);
  assert.match(longForm, /new URLSearchParams\(window\.location\.search\)\.get\("retry"\)/);
  assert.match(longForm, /api\/sequences\/\$\{encodeURIComponent\(jobId\)\}/);
});
