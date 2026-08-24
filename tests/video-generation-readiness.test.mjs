import assert from "node:assert/strict";
import test from "node:test";

import { inspectSingleVideoReadiness, SINGLE_VIDEO_PROFILE_MODELS } from "../server/video-generation/readiness.mjs";

function node(name, inputName, values) {
  return { [name]: { input: { required: { [inputName]: [values] } } } };
}

function readyObjectInfo() {
  const names = [
    "UNETLoader", "CLIPLoader", "VAELoader", "RandomNoise", "KSamplerSelect", "BasicScheduler",
    "BasicGuider", "SamplerCustomAdvanced", "VAEDecode", "VAEDecodeAudio", "CreateVideo", "SaveVideo",
    "MiniMaxH3ImageToVideo", "MiniMaxH3ReferenceToVideo", "CLIPVisionLoader", "CLIPVisionEncode",
    "LoadVideo", "GetVideoComponents", "ImageScale", "LoadImage", "ImageToMask", "DrawMaskOnImage",
    "CLIPTextEncode", "DWPreprocessor", "LoraLoaderModelOnly", "ModelSamplingSD3", "WanAnimateToVideo",
    "KSampler", "TrimVideoLatent", "ImageFromBatch",
  ];
  return {
    ...Object.fromEntries(names.map((name) => [name, {}])),
    ...node("UNETLoader", "unet_name", Object.values(SINGLE_VIDEO_PROFILE_MODELS)),
  };
}

test("reports every installed Single Video mode and profile as available", () => {
  const result = inspectSingleVideoReadiness(readyObjectInfo(), { comfyOnline: true, lastFrame: true });
  assert.equal(result.ready, true);
  assert.equal(Object.values(result.modes).every((mode) => mode.available), true);
  assert.equal(Object.values(result.profiles).every((profile) => profile.available), true);
});

test("disables only the affected model and modes when a model is missing", () => {
  const objectInfo = readyObjectInfo();
  objectInfo.UNETLoader.input.required.unet_name[0] = objectInfo.UNETLoader.input.required.unet_name[0]
    .filter((name) => name !== SINGLE_VIDEO_PROFILE_MODELS.wan22_animate_fp8);
  const result = inspectSingleVideoReadiness(objectInfo, { comfyOnline: true, lastFrame: true });
  assert.equal(result.profiles.wan22_animate_fp8.available, false);
  assert.equal(result.modes.replace.available, false);
  assert.equal(result.modes.t2v.available, true);
});

test("fails closed for last-frame modes when the generator flag is unavailable", () => {
  const result = inspectSingleVideoReadiness(readyObjectInfo(), { comfyOnline: true, lastFrame: false });
  assert.equal(result.modes.fl2v.available, false);
  assert.equal(result.modes.l2v.available, false);
  assert.match(result.modes.fl2v.reason, /尾幀/);
  assert.equal(result.modes.i2v.available, true);
});
