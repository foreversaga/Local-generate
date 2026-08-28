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
    assert.match(source, /setOllamaModel\(stored\.ollamaModel/);
    assert.match(source, /setCodexModel\(stored\.codexModel/);
    assert.match(source, /set(?:ReasoningEffort|reasoningEffort)\(stored\.codexReasoningEffort/);
  }

  assert.match(longForm, /set(?:Prompt)?Provider\(stored\.promptProvider/);
  assert.match(singleAssistant, /preferredProviderRef\.current = stored\.promptProvider/);
  assert.match(singleAssistant, /const providerAvailability = useMemo<Record<PromptProvider, boolean>>/);
  assert.match(singleAssistant, /const PROVIDER_FALLBACK_ORDER/);
  assert.match(singleAssistant, /if \(!settingsHydrated \|\| !health\) return/);
  assert.match(singleAssistant, /return providerAvailability\[preferred\] \? preferred : availableProviders\[0\] \|\| ""/);
  assert.match(singleAssistant, /disabled=\{!providerAvailability\.ollama \|\| busy\}/);
  assert.match(singleAssistant, /disabled=\{!providerAvailability\.sglang \|\| busy\}/);
  assert.match(singleAssistant, /disabled=\{!providerAvailability\.codex \|\| busy\}/);
  assert.match(singleAssistant, /if \(!provider\)/);
  assert.match(singleAssistant, /if \(!providerAvailability\[provider\]\)/);
  assert.match(singleAssistant, /new Map<string, \(typeof PROMPT_MODEL_CATALOG\)\[number\]>/);
  assert.match(singleAssistant, /Gemma4-26B-A4B-QAT-Uncensored-HauhauCS-Balanced-MTP:Q4_K_M/);
  assert.match(singleAssistant, /Gemma 4 26B-A4B QAT Balanced MTP Q4_K_M/);
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

test("clearing a retry reference video preserves the restored prompt", async () => {
  const singleForm = await readFile(new URL("../app/components/create/SingleCreateForm.tsx", import.meta.url), "utf8");
  const clearVideoHandler = singleForm.match(/onClearVideo=\{\(\) => \{([\s\S]*?)\n\s*\}\}/)?.[1] || "";

  assert.match(clearVideoHandler, /setSourceVideo\(null\)/);
  assert.match(clearVideoHandler, /setOllamaPromptReceipt\(""\)/);
  assert.doesNotMatch(clearVideoHandler, /setPrompt\(""\)/);
});
