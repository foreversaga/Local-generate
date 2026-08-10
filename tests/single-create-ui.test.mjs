import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("routed Single Create keeps field-level validation accessible", async () => {
  const [form, styles] = await Promise.all([
    readFile(new URL("../app/components/create/SingleCreateForm.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/create/SingleCreateForm.module.css", import.meta.url), "utf8"),
  ]);

  assert.match(form, /error=\{errorFor\("lastFrameImage"\)\}/);
  assert.doesNotMatch(form, /error=\{errorFor\("referenceImage"\) \? "" : errorFor\("lastFrameImage"\)\}/);
  assert.match(form, /aria-describedby=\{error \? `\$\{id\}-error` : undefined\}/);
  assert.match(form, /<FieldError id=\{`\$\{id\}-error`\} message=\{error\} \/>/);
  assert.match(form, /className=\{styles\.fileInput\}[\s\S]*type="file"/);
  assert.doesNotMatch(form, /<input\s+hidden\s+type="file"/);
  assert.match(styles, /\.iconButton,[\s\S]*\.secondaryButton,[\s\S]*\.uploadButton,[\s\S]*\.primaryButton \{[\s\S]*min-height: 44px;/);
  assert.match(styles, /\.fileInput \{[\s\S]*clip-path: inset\(50%\)/);
  assert.match(styles, /\.uploadButton:focus-within/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});

test("routed Single Create autosaves drafts and exposes mobile section anchors", async () => {
  const [form, styles, draftHook] = await Promise.all([
    readFile(new URL("../app/components/create/SingleCreateForm.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/create/SingleCreateForm.module.css", import.meta.url), "utf8"),
    readFile(new URL("../app/components/create/useSingleCreateDraft.ts", import.meta.url), "utf8"),
  ]);

  assert.match(form, /useSingleCreateDraft\(\{/);
  assert.match(form, /clearDraft\(\);\s*router\.push\(destination\)/);
  assert.match(form, /<nav className=\{styles\.sectionNav\} aria-label="Single Create sections">/);
  assert.match(form, /href="#single-source-section"/);
  assert.match(form, /href="#single-prompt-section"/);
  assert.match(form, /href="#single-setup-section"/);
  assert.match(form, /href="#single-review-section"/);
  assert.match(form, /role="status" aria-live="polite"/);
  assert.match(styles, /@media \(max-width: 768px\)[\s\S]*\.sectionNav \{[\s\S]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.sectionNav a \{[\s\S]*min-height: 44px/);
  assert.match(form, /const \[assetsLoaded\] = await Promise\.all\(\[refreshAssets\(\), refreshHealth\(\)\]\);/);
  assert.match(form, /setAssetsReady\(assetsLoaded\)/);
  assert.match(draftHook, /try \{[\s\S]*localStorage\.getItem\(SINGLE_CREATE_DRAFT_STORAGE_KEY\)/);
  assert.match(draftHook, /localStorage\.setItem\(SINGLE_CREATE_DRAFT_STORAGE_KEY/);
  assert.match(draftHook, /try \{[\s\S]*localStorage\.removeItem\(SINGLE_CREATE_DRAFT_STORAGE_KEY\)/);
  assert.match(draftHook, /addEventListener\("beforeunload", handleBeforeUnload\)/);
});
