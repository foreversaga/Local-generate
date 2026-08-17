import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createScriptLibrary, ScriptLibraryError } from "../server/scripts/script-library.mjs";

test("script library persists named prompt pairs and supports update and delete", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-script-library-"));
  const filePath = path.join(root, "scripts.json");
  let tick = 0;
  const library = createScriptLibrary({
    filePath,
    idFactory: () => "11111111-1111-4111-8111-111111111111",
    clock: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
  });

  const created = await library.create({ name: "雨夜追逐", prompt: "Rainy chase", negativePrompt: "watermark" });
  assert.equal(created.name, "雨夜追逐");
  assert.deepEqual((await library.list()).map(({ name, prompt, negativePrompt }) => ({ name, prompt, negativePrompt })), [
    { name: "雨夜追逐", prompt: "Rainy chase", negativePrompt: "watermark" },
  ]);

  const updated = await library.update(created.id, { name: "雨夜街頭", prompt: "Neon rainy chase", negativePrompt: "text" });
  assert.equal(updated.prompt, "Neon rainy chase");
  assert.match(await readFile(filePath, "utf8"), /"version": 1/);

  await library.remove(created.id);
  assert.deepEqual(await library.list(), []);
});

test("script library rejects empty prompts and duplicate names", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-script-library-validation-"));
  let id = 0;
  const library = createScriptLibrary({ filePath: path.join(root, "scripts.json"), idFactory: () => `${String(++id).padStart(8, "0")}-1111-4111-8111-111111111111` });
  await assert.rejects(() => library.create({ name: "Empty", prompt: "" }), (error) => error instanceof ScriptLibraryError && error.code === "SCRIPT_INVALID");
  await library.create({ name: "Chase", prompt: "Run" });
  await assert.rejects(() => library.create({ name: "Chase", prompt: "Run again" }), (error) => error instanceof ScriptLibraryError && error.code === "SCRIPT_NAME_EXISTS");
});

test("Library exposes a dedicated script category with create, edit, and delete controls", async () => {
  const [libraryWorkspace, manager] = await Promise.all([
    readFile(new URL("../app/components/library/LibraryWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/library/ScriptLibraryManager.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(libraryWorkspace, /\["all", "input", "output", "scripts", "long-scripts"\]/);
  assert.match(libraryWorkspace, /root === "scripts" \? <ScriptLibraryManager/);
  assert.match(manager, /method: draft\.id \? "PUT" : "POST"/);
  assert.match(manager, /method: "DELETE"/);
  assert.match(manager, /"儲存變更"/);
});
