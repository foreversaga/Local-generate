import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("renders the H3 Studio interface without promotional shell copy", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>H3 Studio/);
  assert.match(html, /id="prompt"/);
  assert.match(html, /開始生成影片/);
  assert.match(html, /影片寬度（px）/);
  assert.match(html, /影片高度（px）/);
  assert.match(html, /aria-label="交換影片寬度與高度"/);
  assert.doesNotMatch(html, /Gemma 3 4B/);
  assert.doesNotMatch(html, /黃色雨衣|Cinematic night street|h3-rainy-neon/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|Building your site/i);
  assert.doesNotMatch(html, /LOCAL RENDER CONSOLE|LOCAL VIDEO LAB|8787|local bridge/i);
});

test("uses the same-origin API on the web service", async () => {
  const [page, vite, packageJson, readme, bridge, h3Instruction, h3Validator, restartScript] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../local-bridge.mjs", import.meta.url), "utf8"),
    readFile(new URL("../server/h3-prompt/instruction.mjs", import.meta.url), "utf8"),
    readFile(new URL("../server/h3-prompt/validator.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/restart-web.ps1", import.meta.url), "utf8"),
  ]);

  assert.match(page, /const BRIDGE_URL = "\/app"/);
  assert.match(page, /<button\s+type="button"\s+className="resolution-swap-button"/);
  assert.match(page, /aria-label="交換影片寬度與高度"/);
  assert.match(page, /title="交換寬度與高度"/);
  assert.match(page, /function swapResolution\(\)[\s\S]*?setWidth\(currentHeight\)[\s\S]*?setHeight\(currentWidth\)/);
  assert.match(vite, /name:\s*["']h3-local-api["']/);
  assert.match(vite, /port:\s*webPort/);
  assert.match(vite, /const listenHost = "0\.0\.0\.0"/);
  assert.match(vite, /const webPort = 8787/);
  assert.match(vite, /hmr:\s*false/);
  assert.match(vite, /ws:\s*false/);
  assert.match(vite, /forwardConsole:\s*false/);
  assert.match(vite, /disableRemoteDevHmr/);
  assert.match(page, /promptModelCatalog\.filter\(\(model\) => visibleModels\.includes\(model\.value\)\)/);
  assert.match(page, /type PromptProvider = "ollama" \| "codex"/);
  assert.match(page, /codexModelCatalog/);
  assert.match(page, /availableCodexModels/);
  assert.doesNotMatch(page, /gpt-5\.3-codex|gpt-5\.2-codex|codex-mini-latest/);
  assert.match(page, /codexReasoningEffort/);
  assert.match(page, /ultra/);
  assert.match(page, /BRIDGE_URL \+ "\/api\/prompt"/);
  assert.match(page, /const H3_PROMPT_MAX_CHARS = 7000/);
  assert.match(page, /H3_IMAGE_PROMPT_MODES\.has\(mode\)/);
  assert.match(page, /I2VA 提示詞需要參考圖片/);
  assert.match(page, /FL2VA 提示詞需要首幀與尾幀圖片/);
  assert.match(page, /L2VA 提示詞需要尾幀圖片/);
  assert.match(page, /maxLength=\{isH3PromptMode\(mode\) \? H3_PROMPT_MAX_CHARS : undefined\}/);
  assert.match(page, /apiErrorMessage\(payload, "無法建立生成工作"\)/);
  assert.match(page, /影片升頻/);
  assert.match(page, /BRIDGE_URL \+ "\/api\/upscale"/);
  assert.match(page, /\/api\/upscale\/jobs\/\$\{encodeURIComponent\(trackedJobId\)\}/);
  assert.match(page, /sourceRoot: upscaleSource\.root/);
  assert.match(page, /accept="video\/\*"/);
  assert.match(page, /selectAssetForUpscale/);
  assert.match(page, /SeedVR2 3B Int8/);
  assert.match(page, /role="progressbar"/);
  assert.match(page, /role="alert"/);
  assert.match(page, /const VIDEO_PAGE_SIZE = 10/);
  assert.match(page, /const videoPageNumbers = Array\.from\(\{ length: videoPageCount \}/);
  assert.match(page, /asset-pagination-number/);
  assert.match(page, /aria-current=\{currentVideoPage === page \? "page" : undefined\}/);
  assert.match(page, /const latestCompletedJob = \[\.\.\.renderJobs\]/);
  assert.match(page, /progress-timing/);
  assert.match(page, /實際生成總時間/);
  assert.match(page, /formatDurationMs\(activeJob\.elapsedMs\)/);
  assert.match(page, /formatDurationMs\(activeJob\.estimatedDurationMs\)/);
  assert.match(page, /formatDurationMs\(activeJob\.etaMs\)/);
  assert.match(page, /async function deleteOutputAsset\(asset: Asset\)/);
  assert.match(page, /asset\.kind === "image" \|\| asset\.kind === "video"/);
  assert.match(page, /method: "DELETE"/);
  assert.match(page, /const MAX_REF2V_IMAGES = 9/);
  assert.match(page, /referenceImageNames/);
  assert.match(page, /multiple/);
  assert.match(page, /uploadFiles\(files/);
  assert.match(page, /從 Ref2V 參考選取移除/);
  assert.match(page, /const MAX_LONG_REFERENCE_IMAGES = 8/);
  assert.match(page, /referenceMode/);
  assert.match(page, /referenceAssets/);
  assert.match(page, /multi_reference/);
  assert.match(page, /多參考會將前段尾幀作下一段 reference/);
  assert.match(page, /加入一般參考/);
  assert.match(page, /加入長片參考/);
  assert.match(page, /root=" \+ encodeURIComponent\(asset\.root\)/);
  assert.match(page, /資源使用中，請先停止使用中的工作後再刪除/);
  assert.match(page, /const responseStatus = response\.status/);
  assert.match(page, /function assetDeleteFailureMessage\(status: number, payload: AssetDeletePayload\)/);
  assert.match(page, /ASSET_USE_UNKNOWN/);
  assert.match(page, /upscaleSourceDeleted/);
  assert.match(page, /upscaleLegacySourceDeleted/);
  assert.match(page, /upscaleOutputDeleted/);
  assert.match(page, /finalAsset && deletedKeys\.has\(assetKeyFromParts/);
  assert.match(page, /setHistory\(\(current\) => current\.map/);
  assert.match(page, /asset\.root !== "input"/);
  assert.match(page, /Ref2V 多參考只接受 ComfyUI\/input 圖片/);
  assert.match(page, /function clearDeletedAssetState/);
  assert.match(page, /selectedAssetKeys/);
  assert.match(page, /async function deleteOutputAssets\(requestedAssets: Asset\[\]/);
  assert.match(page, /全選目前篩選/);
  assert.match(page, /刪除選取/);
  assert.match(page, /選取刪除資源/);
  assert.match(page, /影片分頁/);
  assert.match(page, /影片數量/);
  assert.match(page, /batchSeed\(seed, index\)/);
  assert.match(page, /useState<NumberDraft>\(20\)/);
  assert.match(page, /useState<NumberDraft>\(12345\)/);
  assert.match(page, /function numberInputDraft\(value: string\)/);
  assert.match(page, /function randomSeedValue\(\)/);
  assert.match(page, /setSteps\(numberInputDraft\(event\.target\.value\)\)/);
  assert.match(page, /setSeed\(numberInputDraft\(event\.target\.value\)\)/);
  assert.equal((page.match(/aria-label="隨機產生 Seed"/g) || []).length, 2);
  assert.match(page, /id="long-video-prompt"/);
  assert.match(page, /id="long-video-negative-prompt"/);
  assert.match(page, /const \[longPlanning, setLongPlanning\] = useState\(false\)/);
  assert.match(page, /function clearLongSettings\(\)/);
  assert.match(page, /const latest = payload\.jobs\?\.find\(\(item\) => item\.status !== "completed"\)/);
  assert.doesNotMatch(page, /const latest = payload\.jobs\?\.\[0\]/);
  assert.match(page, /清除目前長影片設定/);
  assert.match(page, /setLongReferenceImage\(null\)/);
  assert.match(page, /aria-live="polite"/);
  assert.match(page, /首次載入模型可能需要 1–2 分鐘/);
  assert.match(page, /若第一次格式不合規，系統會自動修正一次/);
  assert.match(page, /aria-label="長影片生成進度"/);
  assert.match(page, /aria-label="長影片整體生成進度"/);
  assert.match(page, /長影片生成中 \$\{longOverallProgress\}%/);
  assert.match(page, /role="alertdialog"/);
  assert.match(page, /LONG VIDEO ERROR/);
  assert.match(page, /prompt-provider-switch long-provider-switch/);
  assert.match(page, /長影片 Codex CLI 模型/);
  assert.match(page, /長影片 Codex CLI 推理程度/);
  assert.match(page, /promptProvider,/);
  assert.match(page, /timelineMode: longTimelineMode/);
  assert.match(page, /timelineText: longTimelineMode === "manual" \? longTimeline : undefined/);
  assert.match(page, /negativePrompt: longNegativePrompt/);
  assert.match(page, /逐段規劃輸出/);
  assert.match(page, /setLongTimelineMode\("manual"\)/);
  assert.match(page, /const activeJobs = jobs\.filter\(isActiveJob\)/);
  assert.match(page, /setRenderJobs\(trackedJobs\)/);
  assert.match(page, /renderJobs\.find\(\(item\) => item\.status === "running"\)/);
  assert.match(page, /function isFinishedJob\(job: Job\)/);
  assert.match(page, /原生步數/);
  assert.match(page, /尚未收到原生步數（目前為估算）/);
  assert.match(page, /progressUpdateAge/);
  assert.match(page, /const trackedRenderJobIds = renderJobIds/);
  assert.match(page, /tracked\.every\(isFinishedJob\)/);
  assert.match(page, /referenceImageName: referenceImage\?\.kind === "image"/);
  assert.match(page, /sourceVideoName: sourceVideo\?\.kind === "video"/);
  assert.match(page, /lastFrameImage/);
  assert.match(page, /lastImageName: mode === "fl2v" \|\| mode === "l2v"/);
  assert.match(page, /mode === "replace" && \(!referenceImage \|\| !sourceVideo\)/);
  assert.match(page, /完整參考生片/);
  assert.match(page, /promptFormatLabel/);
  assert.match(bridge, /const generationQueue = \[\]/);
  assert.match(bridge, /const COMFY_ROOT = path\.resolve\(/);
  assert.match(bridge, /const INPUT_ROOT = path\.join\(COMFY_ROOT, "input"\)/);
  assert.match(bridge, /const OUTPUT_ROOT = path\.join\(COMFY_ROOT, "output"\)/);
  assert.match(bridge, /function mediaRoots\(rootName\)/);
  assert.match(bridge, /: \[OUTPUT_ROOT\]/);
  assert.doesNotMatch(bridge, /const INPUT_ROOT = path\.join\(H3_ROOT, "input"\)/);
  assert.doesNotMatch(bridge, /const OUTPUT_ROOT = path\.join\(H3_ROOT, "output"\)/);
  assert.match(bridge, /job\.status = child\.started \? "running" : "queued"/);
  assert.match(bridge, /async function allocateOutputPath\(requestedName\)/);
  assert.match(bridge, /reservedOutputPaths\.has\(candidatePath\)/);
  assert.match(bridge, /render-timing-history\.json/);
  assert.match(bridge, /const timingSampleWindow = 5/);
  assert.match(bridge, /withinTenPercent/);
  assert.match(bridge, /const warmupProgress = Math\.min\(18/);
  assert.match(bridge, /H3_PROGRESS /);
  assert.match(bridge, /progressSource !== "native"/);
  assert.match(bridge, /nativeCurrent/);
  assert.match(bridge, /websocket_reconnecting/);
  assert.match(bridge, /PYTHONUTF8: "1"/);
  assert.match(bridge, /PYTHONIOENCODING: "utf-8"/);
  assert.match(bridge, /type === "artifact"/);
  assert.match(bridge, /outputRelativeName/);
  assert.match(bridge, /20 \+ \(current \/ maximum\) \* 72/);
  assert.match(bridge, /entry\.job\.progress = Math\.max\(entry\.job\.progress, 8\)/);
  assert.match(bridge, /waitForLegacyGeneration\(legacy\.id, 30 \* 60 \* 1000, payload\.onProgress\)/);
  assert.match(bridge, /function promptSystem\(mode, durationSeconds, hasVisualReference\)/);
  assert.match(bridge, /function createCodexPrompt/);
  assert.match(bridge, /function requestCodexLongPlanModel/);
  assert.match(bridge, /CODEX_MODELS_CACHE_PATH/);
  assert.match(bridge, /CODEX_MODEL_UNAVAILABLE/);
  assert.match(bridge, /CODEX_REASONING_UNSUPPORTED/);
  assert.match(bridge, /requestCodexLongPlanModel\(\{ input: requestInput/);
  assert.match(bridge, /function planSequenceWithPromptProvider/);
  assert.match(bridge, /h3-prompt-writing/);
  assert.match(bridge, /complete user requirement appears in the final block/);
  assert.match(bridge, /Complete user requirement to transform/);
  assert.match(bridge, /model_reasoning_effort=/);
  assert.match(bridge, /"--ask-for-approval",\s*"never",\s*"exec"/);
  assert.match(bridge, /--output-last-message/);
  assert.match(bridge, /pathname === "\/api\/prompt"/);
  assert.match(h3Instruction, /integrated_multimodal_description/);
  assert.match(h3Instruction, /For the target video, at 0\.00 seconds into the target video/);
  assert.match(bridge, /FL2VA first-and-last-frame video/);
  assert.match(h3Instruction, /Picture 2 \(from Shot <FINAL_SHOT>\) aligns with the/);
  assert.match(bridge, /L2VA last-frame video/);
  assert.match(h3Instruction, /Ref2VA subject_definitions/);
  assert.match(h3Validator, /subject_definitions.*summary.*retention_analysis.*detailed_description.*overall_soundscape.*non_diegetic_music/s);
  assert.match(h3Instruction, /<Subject N>.*<Picture N>.*<Video N>.*<Audio N>/s);
  assert.match(bridge, /"ref2v"/);
  assert.match(bridge, /--task", "ref2v"/);
  assert.match(bridge, /--reference-image/);
  assert.match(bridge, /--reference-video/);
  assert.doesNotMatch(bridge, /目前本機生成器尚未接入原生 Ref2VA/);
  assert.match(bridge, /identity drift, face drift, costume drift/);
  assert.match(bridge, /source-video preview frame/);
  assert.match(bridge, /hasLastImageGeneratorFlag/);
  assert.match(bridge, /--last-frame/);
  assert.match(bridge, /async function deleteOutputAsset\(relativeName\)/);
  assert.match(bridge, /只能刪除 output 內受支援的圖片或影片/);
  assert.match(bridge, /async function stageSequenceInputImage\(payload\)/);
  assert.match(bridge, /內部銜接影格不在 ComfyUI\/input 內/);
  assert.match(bridge, /generation\.input\.cleanup/);
  assert.match(bridge, /req\.method === "DELETE" && pathname === "\/api\/assets"/);
  assert.doesNotMatch(bridge, /STUDIO_OUTPUT_ROOT/);
  assert.match(bridge, /job\.status === "running" && Number\.isFinite\(job\.executionStartedMs\)/);
  assert.match(bridge, /job\.elapsedMs = Number\.isFinite\(job\.executionStartedMs\)/);
  assert.match(bridge, /T2VA text-to-video/);
  assert.doesNotMatch(page, /127\.0\.0\.1:8787|NEXT_PUBLIC_BRIDGE_URL/);
  assert.doesNotMatch(vite, /H3_BRIDGE_HOST|H3_BRIDGE_PORT/);
  assert.doesNotMatch(packageJson, /npm run bridge|local-bridge\.mjs/);
  assert.match(readme, /8787/);
  assert.match(readme, /ComfyUI\\input/);
  assert.match(readme, /ComfyUI\\output/);
  assert.match(readme, /restart-web\.ps1/);
  assert.match(packageJson, /restart:web/);
  assert.match(restartScript, /Start-Process/);
  assert.match(restartScript, /healthUrl = "http:\/\/127\.0\.0\.1:8787\/app\/api\/health"/);
  assert.match(restartScript, /SetEnvironmentVariable\("PATH", \$null, "Process"\)/);
  assert.doesNotMatch(readme, /npm\.cmd run bridge|local bridge/i);
});
