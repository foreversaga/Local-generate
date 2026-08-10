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
  const canRetryLine = workspace.match(/const canRetry =[^\n]+/u)?.[0] || "";
  assert.match(canRetryLine, /modelAllowedForRuntime\(model, runtimeMode\)/);
  assert.doesNotMatch(canRetryLine, /job\??\.model/);
  const requestBodyStart = workspace.indexOf("function requestBody()");
  const retryStart = workspace.indexOf("async function retry()");
  assert.ok(requestBodyStart >= 0 && retryStart > requestBodyStart, "request body helper should precede retry");
  const requestBodyBlock = workspace.slice(requestBodyStart, retryStart);
  assert.doesNotMatch(requestBodyBlock, /const current = job/);
  assert.match(requestBodyBlock, /sourceName: source\?\.name/);
  assert.match(requestBodyBlock, /sourceRoot: source\?\.root/);
  assert.match(requestBodyBlock, /prompt: prompt\.trim\(\)/);
  assert.match(requestBodyBlock, /negativePrompt: negativePrompt\.trim\(\)/);
  assert.match(requestBodyBlock, /model,/);
  assert.match(requestBodyBlock, /denoise: Number\(denoise\)/);
  assert.match(requestBodyBlock, /steps: Number\(steps\)/);
  assert.match(requestBodyBlock, /cfg: Number\(cfg\)/);
  assert.match(requestBodyBlock, /seed: Number\(seed\)/);
  const renderStart = workspace.indexOf("    return (", retryStart);
  assert.ok(retryStart >= 0 && renderStart > retryStart, "retry handler should be present before render");
  const retryBlock = workspace.slice(retryStart, renderStart);
  assert.match(retryBlock, /const validationError = validateForm\(\);/);
  assert.match(retryBlock, /if \(validationError\) \{[\s\S]*setError\(validationError\);[\s\S]*return;/);
  assert.doesNotMatch(retryBlock, /modelAllowedForRuntime\(job\.model/);
  assert.match(retryBlock, /submitImg2Img\(requestBody\(\)\)/);
  assert.doesNotMatch(retryBlock, /requestBody\(job\)/);
  assert.doesNotMatch(workspace, /function requestBody\(jobOverride/);
  assert.match(workspace, /sourceName/);
  assert.match(workspace, /negativePrompt/);
  assert.match(workspace, /const \[promptDescription, setPromptDescription\] = useState\(""\)/);
  assert.match(workspace, /async function generatePrompt\(\)/);
  assert.match(workspace, /fetch\("\/app\/api\/prompt"/);
  assert.match(workspace, /mode: "img2img"/);
  assert.match(workspace, /role: "source_image"/);
  assert.match(workspace, /setPrompt\(payload\.prompt\.trim\(\)\)/);
  assert.match(workspace, /setNegativePrompt\(payload\.negativePrompt\.trim\(\)\)/);
  assert.match(workspace, /modelSupportsPromptImages/);
  assert.match(workspace, /disabled=\{promptBusy \|\| uploading \|\| submitting \|\| retrying \|\| active\}/);
  assert.match(workspace, /function randomizeSeed\(\)/);
  assert.match(workspace, /setSeed\(String\(values\[0\] % 2147483648\)\)/);
  assert.match(workspace, /onClick=\{randomizeSeed\}/);
  assert.match(workspace, /aria-label="Randomize Seed"/);
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
