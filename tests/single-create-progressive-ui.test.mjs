import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("single-video Create uses progressive disclosure for optional settings", async () => {
  const [page, shell, css] = await Promise.all([
    readFile(new URL("../app/(studio)/create/single/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/create/SingleCreateProgressiveShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/create/SingleCreateProgressiveShell.module.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /SingleCreateProgressiveShell/);
  assert.doesNotMatch(page, /<SingleCreateForm\s*\/>/);

  assert.match(shell, /negativePrompt: false/);
  assert.match(shell, /promptSettings: false/);
  assert.match(shell, /scriptLibrary: false/);
  assert.match(shell, /advancedGeneration: false/);
  assert.match(shell, /modeAdvanced: false/);
  assert.match(shell, /role="switch"/);

  assert.match(shell, /parseSingleCreateDraft/);
  assert.match(shell, /negativePrompt: Boolean\(draft\.negativePrompt\?\.trim\(\)\)/);
  assert.match(shell, /advancedGeneration: hasAdvancedGenerationValues\(draft\)/);
  assert.match(shell, /modeAdvanced: hasModeAdvancedValues\(draft\)/);
  assert.match(shell, /\[aria-invalid='true'\]/);

  assert.match(css, /data-show-negative-prompt="false"/);
  assert.match(css, /data-show-prompt-settings="false"/);
  assert.match(css, /data-show-script-library="false"/);
  assert.match(css, /data-show-advanced-generation="false"/);
  assert.match(css, /data-show-mode-advanced="false"/);
  assert.match(css, /#single-review-section > section:first-child/);
  assert.match(css, /#single-validation-summary > ul:not\(:has\(button\)\)/);
  assert.doesNotMatch(css, /\bCanvas(?:Text)?\b/);
  assert.match(css, /background:\s*var\(--panel\)/);
  assert.match(css, /color:\s*var\(--text\)/);
});

test("single-video advanced controls stay mounted when collapsed", async () => {
  const css = await readFile(
    new URL("../app/components/create/SingleCreateProgressiveShell.module.css", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(css, /visibility:\s*collapse/i);
  assert.match(css, /display:\s*none/);
  assert.match(css, /#single-setup-section/);
  assert.match(css, /section\[aria-labelledby="script-library-title"\]/);
  assert.match(css, /section\[aria-labelledby="single-prompt-assistant-title"\]/);
});

test("single-video UI disables modes and profiles that runtime health marks unavailable", async () => {
  const form = await readFile(
    new URL("../app/components/create/SingleCreateForm.tsx", import.meta.url),
    "utf8",
  );

  assert.match(form, /\/api\/video\/health/);
  assert.match(form, /const runtimeReady = !healthLoading/);
  assert.match(form, /disabled=\{!canInteract \|\| unavailable\}/);
  assert.match(form, /serviceState\.profiles\[option\.value\]\?\.available === false/);
  assert.match(form, /if \(!runtimeReady\)/);
  assert.match(form, /GenerateButton canInteract=\{canGenerate\}/);
  assert.match(form, /所選模式與模型已就緒/);
});
