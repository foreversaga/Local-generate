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
  assert.match(workspace, /deleteAsset/);
  assert.match(workspace, /aria-label="刪除以圖生圖結果"/);
  assert.match(workspace, /title="刪除以圖生圖結果"/);
  assert.match(workspace, /刪除中…/);
  assert.match(workspace, /刪除結果/);
});

test("Image to Image UI preserves readiness, submit, poll and retry contracts", async () => {
  const [workspace, client] = await Promise.all([
    readFile(new URL("../app/components/tools/ImageToImageWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/tools/img2img-client.ts", import.meta.url), "utf8"),
  ]);
  assert.match(client, /\/api\/img2img\/health/);
  assert.match(client, /\/api\/health/);
  assert.match(client, /\/api\/loras/);
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
  assert.match(requestBodyBlock, /characterLoraName/);
  assert.match(requestBodyBlock, /characterLoraStrength/);
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
  assert.match(workspace, /img2img-character-lora/);
  assert.match(workspace, /img2img-character-lora-strength/);
  assert.match(workspace, /img2img-character-lora-options/);
  assert.match(workspace, /loraHint/);
  assert.match(workspace, /SDXL LoRA/);
  assert.match(workspace, /SD1\.5 LoRA/);
  assert.match(workspace, /Z-Image-trained LoRA/);
  assert.match(workspace, /characterLoraNameError/);
  assert.match(workspace, /clear the LoRA name to omit both fields/);
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

test("Image to Image output delete clears only the current preview", async () => {
  const workspace = await readFile(new URL("../app/components/tools/ImageToImageWorkspace.tsx", import.meta.url), "utf8");
  const handlerStart = workspace.indexOf("async function removeOutput()");
  const renderStart = workspace.indexOf("    return (", handlerStart);
  assert.ok(handlerStart >= 0 && renderStart > handlerStart, "output delete handler should precede render");
  const handler = workspace.slice(handlerStart, renderStart);
  assert.match(handler, /const output = job\?\.output/);
  assert.match(handler, /await deleteAsset\(output\)/);
  assert.match(handler, /setJob\(null\)/);
  assert.match(handler, /setError\(errorMessage\(reason/);
});

test("Image to Image batch controls, ranges, partial output and history are wired", async () => {
  const [workspace, client] = await Promise.all([
    readFile(new URL("../app/components/tools/ImageToImageWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/tools/img2img-client.ts", import.meta.url), "utf8"),
  ]);
  assert.match(workspace, /生成張數/);
  assert.match(workspace, /batchCount: Number\(batchCount\)/);
  assert.match(workspace, /randomRanges: toRandomRanges\(randomRanges\)/);
  assert.match(workspace, /批次模式會為每張圖片自動產生隨機 Seed/);
  assert.match(workspace, /disabled=\{active \|\| Number\(batchCount\) > 1\}/);
  assert.match(workspace, /第 1 張使用上方設定；第 2 張起於範圍內亂數/);
  assert.match(workspace, /range minimum/);
  assert.match(workspace, /range maximum/);
  assert.match(workspace, /min must be less than or equal to max/);
  assert.match(workspace, /job\.status === "partial"/);
  assert.match(workspace, /itemGallery/);
  assert.match(workspace, /history-title/);
  assert.match(workspace, /fetchImg2ImgJobs/);
  assert.match(client, /batchCount/);
  assert.match(client, /randomRanges/);
  const clientRangesStart = client.indexOf("export type Img2ImgRandomRanges");
  const clientRangesEnd = client.indexOf("export type Img2ImgParameters", clientRangesStart);
  assert.ok(clientRangesStart >= 0 && clientRangesEnd > clientRangesStart, "client random range type should be present");
  assert.doesNotMatch(client.slice(clientRangesStart, clientRangesEnd), /seed:/);
  const workspaceRangesStart = workspace.indexOf("const RANGE_BOUNDS");
  const workspaceRangesEnd = workspace.indexOf("function baseRangeDraft", workspaceRangesStart);
  assert.ok(workspaceRangesStart >= 0 && workspaceRangesEnd > workspaceRangesStart, "workspace random range bounds should be present");
  assert.doesNotMatch(workspace.slice(workspaceRangesStart, workspaceRangesEnd), /seed/);
  assert.match(client, /fetchImg2ImgJobs/);
  assert.match(client, /"partial"/);
});

test("Image to Image history exposes all item parameters and client-validates range steps", async () => {
  const workspace = await readFile(new URL("../app/components/tools/ImageToImageWorkspace.tsx", import.meta.url), "utf8");
  const filterStart = workspace.indexOf("const filteredHistory = useMemo");
  const filterEnd = workspace.indexOf("    const canRetry", filterStart);
  assert.ok(filterStart >= 0 && filterEnd > filterStart, "history filter should be present");
  const filterBlock = workspace.slice(filterStart, filterEnd);
  assert.match(filterBlock, /itemDenoise = itemParameter\(item, "denoise"/);
  assert.match(filterBlock, /itemSteps = itemParameter\(item, "steps"/);
  assert.match(filterBlock, /itemCfg = itemParameter\(item, "cfg"/);
  assert.match(filterBlock, /itemSeed = itemParameter\(item, "seed"/);
  assert.match(filterBlock, /denoise \$\{itemDenoise\} steps \$\{itemSteps\} cfg \$\{itemCfg\} seed \$\{itemSeed\}/);

  const historyStart = workspace.indexOf("{recordItems.map((item) => (");
  const historyEnd = workspace.indexOf("                                        ))}", historyStart);
  assert.ok(historyStart >= 0 && historyEnd > historyStart, "expanded history items should be rendered");
  const historyBlock = workspace.slice(historyStart, historyEnd);
  for (const label of ["Denoise", "Steps", "CFG", "Seed"]) assert.match(historyBlock, new RegExp(`<dt>${label}</dt>`));
  assert.match(historyBlock, /itemParameter\(item, "denoise", Number\(record\.denoise\)\)/);
  assert.match(historyBlock, /itemParameter\(item, "steps", Number\(record\.steps\)\)/);
  assert.match(historyBlock, /itemParameter\(item, "cfg", Number\(record\.cfg\)\)/);
  assert.match(historyBlock, /itemParameter\(item, "seed", Number\(record\.seed\)\)/);

  assert.match(workspace, /const aligned = step === undefined \|\| Math\.abs\(\(value - min\) \/ step - Math\.round\(\(value - min\) \/ step\)\) <= 1e-8/);
  assert.match(workspace, /range min`, bounds\.min, bounds\.max, bounds\.integer, bounds\.step/);
  assert.match(workspace, /range max`, bounds\.min, bounds\.max, bounds\.integer, bounds\.step/);
  assert.match(workspace, /must align to step \$\{step\}/);
});
