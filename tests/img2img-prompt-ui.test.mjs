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

test("fixed Qwen provider adopts the model reported by health instead of requiring stale browser storage", async () => {
  const workspace = await readFile(
    new URL("../app/components/tools/ImageToImageWorkspace.tsx", import.meta.url),
    "utf8",
  );

  assert.match(workspace, /const reportedModel = providerHealth\?\.model\?\.trim\(\) \|\| ""/);
  assert.match(workspace, /return storedModel \|\| fixedProviderModel/);
  assert.match(workspace, /const reportedPromptModel = promptProviderHealth\?\.model\?\.trim\(\) \|\| ""/);
  assert.match(workspace, /: fixedProviderPromptModel/);
  assert.match(workspace, /promptProvider === "sglang"[\s\S]*availableModels\.length === 1 \? availableModels\[0\] : ""/);
});
