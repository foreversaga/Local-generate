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
