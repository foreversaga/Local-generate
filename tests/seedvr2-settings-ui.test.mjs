import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("SeedVR2 UI exposes validated upscale parameters and sends them to the API", async () => {
  const [workspace, client] = await Promise.all([
    readFile(new URL("../app/components/tools/UpscaleWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/tools/upscale-client.ts", import.meta.url), "utf8"),
  ]);

  assert.match(workspace, /SeedVR2 參數/);
  assert.match(workspace, /SEEDVR2_SCALE_MIN/);
  assert.match(workspace, /SEEDVR2_SCALE_MAX/);
  assert.match(workspace, /SEEDVR2_RESIZE_METHODS/);
  assert.match(workspace, /SEEDVR2_COLOR_CORRECTIONS/);
  assert.match(workspace, /seed: parsedSeed/);
  assert.match(workspace, /setScale\(event\.target\.value\)/);
  assert.doesNotMatch(workspace, /setScale\(Number\(event\.target\.value\)\)/);
  assert.match(workspace, /resizeMethod/);
  assert.match(workspace, /colorCorrection/);
  assert.match(client, /profile, \.\.\.parameters/);
  assert.match(client, /scale: UPSCALE_SCALE/);
});

test("SeedVR2 advanced sampling UI stays collapsed and preserves string editing state", async () => {
  const [workspace, client] = await Promise.all([
    readFile(new URL("../app/components/tools/UpscaleWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/tools/upscale-client.ts", import.meta.url), "utf8"),
  ]);

  assert.match(workspace, /<details className=\{styles\.advancedSampling\}>/);
  assert.doesNotMatch(workspace, /<details className=\{styles\.advancedSampling\} open/);
  assert.match(workspace, /setSteps\(event\.target\.value\)/);
  assert.match(workspace, /setCfg\(event\.target\.value\)/);
  assert.match(workspace, /setDenoise\(event\.target\.value\)/);
  assert.doesNotMatch(workspace, /setSteps\(Number\(event\.target\.value\)\)/);
  assert.match(workspace, /resetSeedVR2Sampling/);
  assert.match(workspace, /!samplingIsDefault/);
  assert.match(workspace, /steps: parsedSteps/);
  assert.match(workspace, /cfg: Math\.round\(parsedCfg \* 100\) \/ 100/);
  assert.match(workspace, /samplerName,/);
  assert.match(workspace, /scheduler,/);
  assert.match(workspace, /denoise: Math\.round\(parsedDenoise \* 100\) \/ 100/);
  assert.match(client, /SEEDVR2_DEFAULT_SAMPLING/);
  assert.match(client, /steps\?: number/);
  assert.match(client, /samplerName\?: SeedVR2SamplerName/);
  assert.match(client, /scheduler\?: SeedVR2Scheduler/);
  assert.match(client, /denoise\?: number/);
});

test("SeedVR2 detail reconstruction controls expose the complete backend contract", async () => {
  const [workspace, client, controls, detailModel, dictionaries, styles] = await Promise.all([
    readFile(new URL("../app/components/tools/UpscaleWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/tools/upscale-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/tools/SeedVR2DetailControls.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/tools/seedvr2-detail.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/i18n/dictionaries.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/tools/UpscaleWorkspace.module.css", import.meta.url), "utf8"),
  ]);

  assert.match(workspace, /<SeedVR2DetailControls/);
  assert.match(workspace, /parseSeedVR2DetailDraft\(detailDraft, seedVR2Help\.detail\.errors\)/);
  assert.match(workspace, /\.\.\.detailSettings/);
  assert.match(workspace, /handleSeedVR2DetailPreset/);
  assert.match(workspace, /SEEDVR2_SKIN_DETAIL_PRESET/);
  assert.match(workspace, /createSkinDetailSeedVR2Draft/);
  assert.match(workspace, /createDefaultSeedVR2DetailDraft/);
  assert.match(workspace, /isSeedVR2DetailDraftDefault\(detailDraft\)/);
  assert.match(workspace, /fetchUpscaleHealth\(profile, sourceKind, \{/);
  assert.match(workspace, /detailMode,/);
  assert.match(workspace, /health\?\.detail\?\.available === false/);

  for (const field of [
    "detailPreset",
    "inputNoiseScale",
    "latentNoiseScale",
    "tileWidth",
    "tileHeight",
    "tilePadding",
    "tileUpscaleResolution",
    "blendingMethod",
    "antiAliasingStrength",
    "maskBlur",
    "tilingStrategy",
  ]) {
    assert.match(client, new RegExp(`${field}\\?:`));
    assert.match(controls + detailModel, new RegExp(field));
  }

  assert.match(client, /detailPreset: "skin_detail"/);
  assert.match(client, /inputNoiseScale: 0\.035/);
  assert.match(client, /latentNoiseScale: 0/);
  assert.match(client, /tileWidth: 1024/);
  assert.match(client, /tileHeight: 1024/);
  assert.match(client, /tilePadding: 64/);
  assert.match(client, /tileUpscaleResolution: 2048/);
  assert.match(client, /blendingMethod: "multiband"/);
  assert.match(client, /antiAliasingStrength: 0/);
  assert.match(client, /maskBlur: 0/);
  assert.match(client, /tilingStrategy: "chess"/);

  assert.match(detailModel, /inputNoiseScale: string/);
  assert.match(detailModel, /tileUpscaleResolution: string/);
  assert.match(detailModel, /parseDecimal\(draft\.inputNoiseScale, 0, 0\.2/);
  assert.match(detailModel, /parseInteger\(draft\.tileWidth, 256, 2048, messages\.tileWidth, 64\)/);
  assert.match(detailModel, /parseInteger\(draft\.tileUpscaleResolution, 512, 4096, messages\.tileUpscaleResolution, 64\)/);
  assert.match(detailModel, /parseDecimal\(draft\.antiAliasingStrength, 0, 1/);
  assert.match(detailModel, /parseDecimal\(draft\.maskBlur, 0, 64/);

  assert.match(controls, /Input Noise Scale/);
  assert.match(controls, /Latent Noise Scale/);
  assert.match(controls, /Tile Width/);
  assert.match(controls, /Tile Height/);
  assert.match(controls, /Tile Padding/);
  assert.match(controls, /Tile Upscale Resolution/);
  assert.match(controls, /Blending Method/);
  assert.match(controls, /Anti-aliasing Strength/);
  assert.match(controls, /Mask Blur/);
  assert.match(controls, /Tiling Strategy/);
  assert.doesNotMatch(controls, /<details className=\{styles\.advancedSampling\} open/);
  assert.match(controls, /upscale\.seedvr2\.detail\.preset\.skin/);
  assert.match(controls, /upscale\.seedvr2\.detail\.reset/);
  assert.match(controls, /upscale\.seedvr2\.detail\.warning/);
  assert.match(dictionaries, /"upscale\.seedvr2\.detail\.title": "細節重建 \/ Tiled detail"/);
  assert.match(dictionaries, /"upscale\.seedvr2\.detailUnavailable"/);
  assert.match(styles, /\.detailUnavailable\{/);
  assert.match(workspace, /setScale\(String\(SEEDVR2_SKIN_DETAIL_PRESET\.scale\)\)/);
  assert.match(workspace, /setDetailDraft\(createSkinDetailSeedVR2Draft\(\)\)/);
  assert.match(workspace, /setDetailDraft\(createDefaultSeedVR2DetailDraft\(\)\)/);
  assert.match(client, /const parameters = isSeedVR2Profile \? settings : \{ scale: UPSCALE_SCALE \}/);
});

test("SeedVR2 controls explain what each setting and option does", async () => {
  const [workspace, helpCopy, styles] = await Promise.all([
    readFile(new URL("../app/components/tools/UpscaleWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/tools/seedvr2-help.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/tools/UpscaleWorkspace.module.css", import.meta.url), "utf8"),
  ]);

  assert.match(workspace, /getSeedVR2Help\(locale\)/);
  assert.match(workspace, /seedVR2Help\.scale/);
  assert.match(workspace, /seedVR2Help\.seed/);
  assert.match(workspace, /seedVR2Help\.resize\[resizeMethod\]/);
  assert.match(workspace, /seedVR2Help\.colorCorrection\[colorCorrection\]/);
  assert.match(workspace, /seedVR2Help\.steps/);
  assert.match(workspace, /seedVR2Help\.cfg/);
  assert.match(workspace, /seedVR2Help\.sampler\[samplerName\]/);
  assert.match(workspace, /seedVR2Help\.scheduler\[scheduler\]/);
  assert.match(workspace, /seedVR2Help\.denoise/);
  assert.match(workspace, /styles\.fieldHelp/);
  assert.match(styles, /\.fieldHelp\{/);

  for (const option of [
    "lanczos", "bicubic", "bilinear", "area",
    "wavelet", "lab", "adain", "none",
    "euler", "euler_ancestral", "heun", "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_3m_sde", "res_multistep",
    "simple", "normal", "karras", "exponential", "sgm_uniform", "ddim_uniform", "beta",
    "multiband", "linear", "gaussian", "chess", "grid",
  ]) {
    assert.match(helpCopy, new RegExp(`${option}:`));
  }
  assert.match(helpCopy, /"nearest-exact":/);
  assert.match(helpCopy, /官方預設為 1/);
  assert.match(helpCopy, /留空會自動隨機/);
  assert.match(helpCopy, /官方預設，最適合官方 1 Step 配置/);
  assert.match(helpCopy, /細節重建 \/ Tiled detail/);
  assert.match(helpCopy, /0\.02–0\.06/);
});

test("SeedVR2 FP16 is the connected high-quality default", async () => {
  const [workspace, client] = await Promise.all([
    readFile(new URL("../app/components/tools/UpscaleWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/tools/upscale-client.ts", import.meta.url), "utf8"),
  ]);

  assert.match(client, /id: "seedvr2_7b_sharp_fp16"/);
  assert.match(client, /SeedVR2 7B Sharp FP16 · 高品質預設/);
  assert.match(client, /DEFAULT_UPSCALE_UI_PROFILE: UpscaleProfile = "seedvr2_7b_sharp_fp16"/);
  assert.match(client, /DEFAULT_UPSCALE_PROFILE: UpscaleProfile = "h3_latent_2x"/);
  assert.match(workspace, /useState<UpscaleProfile>\(DEFAULT_UPSCALE_UI_PROFILE\)/);
  assert.match(workspace, /profile === "seedvr2_7b_sharp_fp16" \|\| profile === "seedvr2_7b_sharp_nvfp4"/);
  assert.match(workspace, /if \(uploaded\.kind === "image"\) setProfile\(DEFAULT_UPSCALE_UI_PROFILE\)/);
  assert.match(workspace, /if \(selected\.kind === "image"\) setProfile\(DEFAULT_UPSCALE_UI_PROFILE\)/);
  assert.doesNotMatch(workspace, /backendPending/);
  assert.doesNotMatch(workspace, /FP16 後端尚未啟用/);
  assert.match(client, /profile === "seedvr2_7b_sharp_fp16" \|\| profile === "seedvr2_7b_sharp_nvfp4"/);
});
