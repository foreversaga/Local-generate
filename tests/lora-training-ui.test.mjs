import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (relativePath) => readFile(new URL(relativePath, import.meta.url), "utf8");

test("LoRA Trainer is discoverable from Tools and mounts its workspace route", async () => {
  const [tools, page, routes] = await Promise.all([
    read("../app/(studio)/tools/page.tsx"),
    read("../app/(studio)/tools/lora-trainer/page.tsx"),
    read("../app/lib/webui-routes.mjs"),
  ]);

  assert.match(tools, /title="LoRA Trainer"[\s\S]*href="\/app\/tools\/lora-trainer"[\s\S]*actionLabel="Open trainer"/);
  assert.match(page, /import \{ LoraTrainerWorkspace \}/);
  assert.match(page, /<LoraTrainerWorkspace \/>/);
  assert.match(routes, /normalizedPath === "\/app\/tools\/lora-trainer"\) return "LoRA Trainer"/);
});

test("LoRA Trainer keeps the multi-image, auto/manual, and one-click start contract", async () => {
  const workspace = await read("../app/components/tools/lora-trainer/LoraTrainerWorkspace.tsx");

  assert.match(workspace, /<AssetPickerButton kind="image" multiple max=\{50\}/);
  assert.match(workspace, /type="file" accept="image\/jpeg,image\/png,image\/webp" multiple/);
  assert.match(workspace, /type="radio" name="caption-mode" value="auto"/);
  assert.match(workspace, /type="radio" name="caption-mode" value="manual"/);

  const start = workspace.slice(workspace.indexOf("async function beginTraining()"), workspace.indexOf("async function saveCaption"));
  assert.match(start, /createLoraJob\(\{ sourceAssetIds: assets\.map\(assetKey\), captionReviewMode: mode, config \}\)/);
  assert.match(start, /startLoraJob\(created\.id, \{ revision: created\.revision, captionReviewMode: mode, config \}\)/);
  assert.match(workspace, /onClick=\{beginTraining\} disabled=\{Boolean\(busy\) \|\| !assets\.length \|\| healthBlocked\}/);
  assert.match(workspace, /const currentHealth = healthResource\?\.key === healthKey && healthResource\.status === "loaded" \? healthResource\.health : null;[\s\S]*const healthNetworkWarning = healthResource\?\.key === healthKey && healthResource\.status === "error" \? healthResource\.error : "";[\s\S]*const healthBlocked = currentHealth\?\.ok === false;/);
});

test("LoRA Trainer exposes caption, progress, artifact, consumer, and accessibility contracts", async () => {
  const [workspace, client] = await Promise.all([
    read("../app/components/tools/lora-trainer/LoraTrainerWorkspace.tsx"),
    read("../app/components/tools/lora-trainer/lora-training-client.ts"),
  ]);

  assert.match(workspace, /<label htmlFor=\{fieldId\}>Caption<\/label><textarea id=\{fieldId\}/);
  assert.match(workspace, /aria-invalid=\{record\.status === "failed"\}/);
  assert.match(workspace, /aria-describedby=\{record\.error \? errorId : undefined\}/);
  assert.match(workspace, /onClick=\{confirmCaptionReview\}/);
  assert.match(workspace, /className=\{styles\.feedback\} aria-live="polite"/);
  assert.match(workspace, /aria-labelledby="progress-title" aria-live="polite"/);
  assert.match(workspace, /role="progressbar"/);
  assert.match(workspace, /aria-valuemin=\{0\} aria-valuemax=\{100\} aria-valuenow=\{progress\}/);
  for (const label of ["Step", "Epoch", "Loss", "ETA"]) assert.match(workspace, new RegExp(`<dt>${label}</dt>`));

  assert.match(workspace, /<Meta label="Registry ID"/);
  assert.match(workspace, /<Meta label="SHA-256"/);
  assert.match(workspace, /<summary>Provenance<\/summary>/);
  assert.match(workspace, /artifactDownloadUrl\(job\.id\)/);
  assert.match(workspace, /href=\{`\/app\/tools\/image-to-image\$\{[\s\S]*`\}/);
  assert.match(workspace, /\?lora=\$\{encodeURIComponent\(/);

  assert.match(client, /const API_ROOT = "\/app\/api\/lora-training"/);
  assert.match(client, /request\("\/jobs", \{ method: "POST"/);
  assert.match(client, /\/jobs\/\$\{encodeURIComponent\(id\)\}\/start/);
  assert.match(client, /\/jobs\/\$\{encodeURIComponent\(id\)\}\/artifact/);
});
