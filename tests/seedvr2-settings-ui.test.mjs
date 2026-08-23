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
    "lanczos", "bicubic", "bilinear", "nearest", "area",
    "wavelet", "adain", "none",
    "euler", "euler_ancestral", "heun", "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_3m_sde", "res_multistep",
    "simple", "normal", "karras", "exponential", "sgm_uniform", "ddim_uniform", "beta",
  ]) {
    assert.match(helpCopy, new RegExp(`${option}:`));
  }
  assert.match(helpCopy, /官方預設為 1/);
  assert.match(helpCopy, /留空會自動隨機/);
  assert.match(helpCopy, /官方預設，最適合官方 1 Step 配置/);
});
