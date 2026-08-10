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
});
