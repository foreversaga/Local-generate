import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Long Create route uses persisted sequence hydration and existing bridge APIs", async () => {
  const [form, page, styles] = await Promise.all([
    readFile(new URL("../app/components/create/LongCreateForm.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/(studio)/create/long/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/create/LongCreateForm.module.css", import.meta.url), "utf8"),
  ]);
  assert.match(page, /<LongCreateForm \/>/);
  assert.doesNotMatch(page, /MigrationPanel/);
  assert.match(form, /fetch\(`\$\{BRIDGE_URL\}\/api\/sequences`\)/);
  assert.match(form, /selectHydratableLongJob\(payload\.jobs\)/);
  assert.match(form, /\/api\/sequences\/plan/);
  assert.match(form, /buildLongPlanRequest/);
  assert.match(form, /buildLongSaveRequest/);
  assert.match(form, /\/start`/);
  assert.match(form, /router\.push\(`\/app\/jobs\/\$\{encodeURIComponent\(payload\.job\.id\)\}`\)/);
  assert.match(styles, /\.primaryButton\{[^}]*min-height:44px|\.planButton,.primaryButton,.secondaryActions button\{[^}]*min-height:44px/);
  assert.match(styles, /@media\(max-width:768px\)/);
  assert.match(styles, /grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(form, /aria-pressed=\{inputType === "text"\}/);
  assert.match(form, /aria-pressed=\{referenceMode === "continuity"\}/);
  assert.match(form, /aria-pressed=\{promptProvider === "ollama"\}/);
  assert.match(form, /aria-pressed=\{timelineMode === "auto"\}/);
  assert.match(form, /const canInteract = !planning && !saving && !uploading && !activeJob/);
  assert.match(form, /disabled=\{!canInteract\}/);
  assert.match(form, /focusLongValidationField/);
  assert.match(form, /id="long-validation-summary"/);
  assert.match(form, /className=\{styles\.validationLink\}/);
  assert.match(form, /aria-invalid/);
  assert.match(styles, /\.segmented button\{min-height:44px\}/);
  assert.match(styles, /\.referenceCard button\{width:44px;height:44px\}/);
  assert.match(styles, /\.layout\{[^}]*min-width:0;width:100%/);
  assert.match(styles, /@media\(max-width:860px\)\{\.layout\{grid-template-columns:minmax\(0,1fr\)/);
  assert.match(styles, /\.summary,.summaryCard,.summaryRow,.summaryRow strong\{min-width:0\}/);
});
