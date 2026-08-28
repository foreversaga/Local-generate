import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("single-video Create exposes one professional-settings disclosure", async () => {
  const [page, shell, css] = await Promise.all([
    readFile(new URL("../app/(studio)/create/single/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/create/SingleCreateProgressiveShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/create/SingleCreateProgressiveShell.module.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /SingleCreateProgressiveShell/);
  assert.doesNotMatch(page, /<SingleCreateForm\s*\/>/);

  assert.match(shell, /const \[professional, setProfessional\] = useState\(false\)/);
  assert.match(shell, /role="switch"/);
  assert.match(shell, /aria-checked=\{professional\}/);
  assert.match(shell, /專業設定/);
  assert.doesNotMatch(shell, /promptSettings: false/);
  assert.doesNotMatch(shell, /advancedGeneration: false/);

  assert.match(shell, /parseSingleCreateDraft/);
  assert.match(shell, /hasProfessionalValues\(draft\)/);
  assert.match(shell, /\[aria-invalid='true'\]/);
  assert.match(shell, /PROFESSIONAL_FIELD_IDS/);

  assert.match(css, /data-professional="false"/);
  assert.match(css, /#single-setup-section/);
  assert.match(css, /#single-source-fields/);
  assert.match(css, /section\[aria-labelledby="script-library-title"\]/);
  assert.doesNotMatch(css, /data-show-prompt-settings/);
  assert.doesNotMatch(css, /data-show-advanced-generation/);
  assert.match(css, /background:\s*linear-gradient/);
  assert.match(css, /color:\s*var\(--text\)/);
});

test("single-video professional values automatically reopen advanced controls", async () => {
  const shell = await readFile(
    new URL("../app/components/create/SingleCreateProgressiveShell.tsx", import.meta.url),
    "utf8",
  );

  assert.match(shell, /draft\.negativePrompt\?\.trim\(\)/);
  assert.match(shell, /draft\.h3LoraEnabled/);
  assert.match(shell, /Number\(draft\.steps\) !== 20/);
  assert.match(shell, /Number\(draft\.seed\) !== 12345/);
  assert.match(shell, /Math\.abs\(end - duration\) > 0\.001/);
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
