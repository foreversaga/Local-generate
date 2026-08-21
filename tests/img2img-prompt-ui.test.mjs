import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("img2img prompt request identifies the selected target image model", async () => {
  const workspace = await readFile(
    new URL("../app/components/tools/ImageToImageWorkspace.tsx", import.meta.url),
    "utf8",
  );

  assert.match(workspace, /model: effectivePromptModel,\s+imageModel: model,\s+mode: "img2img"/);
});
