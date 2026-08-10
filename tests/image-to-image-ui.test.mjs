import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Image to Image route mounts the real workspace", async () => {
  const [page, workspace] = await Promise.all([
    readFile(new URL("../app/(studio)/tools/image-to-image/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/tools/ImageToImageWorkspace.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(page, /ImageToImageWorkspace/);
  assert.doesNotMatch(page, /MigrationPanel/);
  assert.match(workspace, /AssetPickerButton/);
  assert.match(workspace, /uploadAssets/);
  assert.match(workspace, /開始以圖生圖/);
  assert.match(workspace, /Saved to Library/);
});

test("Image to Image UI preserves readiness, submit, poll and retry contracts", async () => {
  const [workspace, client] = await Promise.all([
    readFile(new URL("../app/components/tools/ImageToImageWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/tools/img2img-client.ts", import.meta.url), "utf8"),
  ]);
  assert.match(client, /\/api\/img2img\/health/);
  assert.match(client, /\/api\/health/);
  assert.match(client, /\/api\/img2img`/);
  assert.match(client, /\/api\/img2img\/jobs\/\$\{encodeURIComponent\(id\)\}/);
  assert.match(workspace, /setInterval\(\(\) => void poll\(\), 1500\)/);
  assert.match(workspace, /isImg2ImgRetryable/);
  assert.match(workspace, /sourceName/);
  assert.match(workspace, /negativePrompt/);
  assert.match(workspace, /readinessMessage[\s\S]*aria-live="polite" aria-atomic="true"/);
  assert.match(workspace, /denoise/);
  assert.match(workspace, /steps/);
  assert.match(workspace, /cfg/);
  assert.match(workspace, /seed/);
  assert.match(workspace, /z_image_turbo_bf16\.safetensors/);
  assert.match(workspace, /Z-Image Turbo／真人/);
  assert.match(workspace, /waiIllustriousSDXL_v170\.safetensors/);
  assert.match(workspace, /WAI Illustrious SDXL／動漫/);
  assert.match(workspace, /localOnly: true/);
  assert.match(workspace, /fetchImg2ImgRuntime/);
  assert.match(workspace, /runtimeMode === "local"/);
  assert.match(workspace, /modelAllowedForRuntime/);
  assert.match(workspace, /setDenoise\(next\.denoise\)/);
  assert.match(workspace, /health\.models\?\.\[model\] === true/);
  assert.match(workspace, /const sourceReady = Boolean\(source && source\.kind === "image"\)/);
  assert.match(workspace, /const promptReady = Boolean\(prompt\.trim\(\)\)/);
  assert.match(workspace, /const readinessReady = !healthLoading && health\?\.ready === true && modelReady/);
  assert.match(workspace, /const canStart = !active && !submitting && !retrying && !uploading && sourceReady && promptReady && modelRuntimeReady && readinessReady/);
  assert.match(workspace, /if \(!source \|\| source\.kind !== "image"\)/);
  assert.match(workspace, /if \(!prompt\.trim\(\)\)/);
  assert.match(workspace, /if \(!readinessReady\) return readinessBlockingMessage/);
  assert.match(workspace, /health\?\.models\?\.\[value\] === true/);
  assert.match(workspace, /disabled=\{!available\}/);
  assert.match(workspace, /Unavailable/);
  assert.match(workspace, /disabled=\{!canStart\}/);
  assert.doesNotMatch(client, /img2img\/jobs\/.*cancel/);
});
