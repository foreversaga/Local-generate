import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Library and Create picker keep asset contract and accessible dialogs", async () => {
    const [library, picker, pickerStyles, landing, route] = await Promise.all([
        readFile(new URL("../app/components/library/LibraryWorkspace.tsx", import.meta.url), "utf8"),
        readFile(new URL("../app/components/library/AssetPickerButton.tsx", import.meta.url), "utf8"),
        readFile(new URL("../app/components/library/AssetPickerButton.module.css", import.meta.url), "utf8"),
        readFile(new URL("../app/components/create/CreateLanding.tsx", import.meta.url), "utf8"),
        readFile(new URL("../app/(studio)/library/page.tsx", import.meta.url), "utf8"),
    ]);
    assert.match(route, /<LibraryWorkspace\s*\/>/);
    assert.match(library, /fetchAssets/);
    assert.match(library, /uploadAssets/);
    assert.match(library, /deleteAsset/);
    assert.match(library, /download/);
    assert.match(library, /role="dialog"/);
    assert.match(library, /trapFocus/);
    assert.match(picker, /root\?: "input" \| "output"/);
    assert.match(picker, /\(!root \|\| asset\.root === root\)/);
    assert.match(picker, /role="dialog"/);
    assert.match(picker, /trapFocus/);
    assert.match(picker, /\.catch\(\(reason\) => setError/);
    assert.match(pickerStyles, /@media\(max-width:700px\)/);
    assert.match(landing, /<AssetPickerButton root="input"/);
    assert.match(landing, /SINGLE_CREATE_DRAFT_STORAGE_KEY/);
    assert.match(landing, /draftForCreateAsset/);
});
