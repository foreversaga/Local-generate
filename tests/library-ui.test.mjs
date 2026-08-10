import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("library picker and preview dialogs preserve keyboard/a11y contracts", async () => {
  const [picker, library, styles] = await Promise.all([
    readFile(new URL("../app/components/library/AssetPickerButton.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/library/LibraryWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/library/LibraryWorkspace.module.css", import.meta.url), "utf8"),
  ]);

  assert.match(picker, /aria-haspopup="dialog" aria-expanded=\{open\}/);
  assert.match(picker, /role="dialog" aria-modal="true"/);
  assert.match(picker, /onClick=\{\(event\) => event\.target === event\.currentTarget && closeDialog\(\)\}/);
  assert.match(library, /role="dialog" aria-modal="true"/);
  assert.match(library, /onClick=\{\(event\) => event\.target === event\.currentTarget && closePreview\(\)\}/);
  assert.match(styles, /\.copy\{grid-template-columns:44px minmax\(0,1fr\)\}\.checkbox\{width:44px;height:44px\}/);
});
