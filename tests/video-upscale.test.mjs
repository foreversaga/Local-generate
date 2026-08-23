import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  H3_LATENT_PROFILE,
  H3_LATENT_REQUIRED_NODES,
  H3_LATENT_AUDIO_VAE_NAME,
  H3_LATENT_DIFFUSION_NAMES,
  H3_LATENT_ENCODER_NAME,
  H3_LATENT_PASS2_SIGMAS,
  H3_LATENT_VAE_NAME,
  SEEDVR2_REQUIRED_NODES,
  SEEDVR2_IMAGE_REQUIRED_NODES,
  SEEDVR2_DETAIL_REQUIRED_NODES,
  SEEDVR2_DETAIL_IMAGE_REQUIRED_NODES,
  SEEDVR2_DETAIL_NODE,
  SEEDVR2_DETAIL_NODE_INPUTS,
  SEEDVR2_DETAIL_NODE_INPUT_TYPES,
  SEEDVR2_DEFAULT_DETAIL,
  SEEDVR2_FP16_PROFILE,
  SEEDVR2_FP16_UNET_NAME,
  SEEDVR2_UNET_NAME,
  SEEDVR2_VAE_NAME,
  buildSeedVR2Prompt,
  buildSeedVR2ImagePrompt,
  buildSeedVR2DetailPrompt,
  buildH3LatentPrompt,
  createSeedVR2Controller,
  evaluateH3LatentReadiness,
  evaluateSeedVR2Readiness,
  normalizeVideoAssetName,
  normalizeUpscaleAssetName,
  normalizeSeedVR2Settings,
  parseSeedVR2History,
} from "../server/video-upscale/seedvr2.mjs";

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    async text() { return JSON.stringify(payload); },
  };
}

function binaryResponse(bytes, status = 200) {
  const body = Buffer.from(bytes);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    async text() { return body.toString("utf8"); },
    async arrayBuffer() { return body; },
  };
}

function objectInfo(unetName = SEEDVR2_UNET_NAME) {
  const info = Object.fromEntries(SEEDVR2_REQUIRED_NODES.map((name) => [name, { input: { required: {} } }]));
  info.UNETLoader.input.required.unet_name = [[unetName], {}];
  info.VAELoader.input.required.vae_name = [[SEEDVR2_VAE_NAME], {}];
  return info;
}

function imageObjectInfo(unetName = SEEDVR2_UNET_NAME) {
  const info = Object.fromEntries(SEEDVR2_IMAGE_REQUIRED_NODES.map((name) => [name, { input: { required: {} } }]));
  info.UNETLoader.input.required.unet_name = [[unetName], {}];
  info.VAELoader.input.required.vae_name = [[SEEDVR2_VAE_NAME], {}];
  return info;
}

function detailObjectInfo({ sourceKind = "video", unetName = SEEDVR2_UNET_NAME, omitInput = "", blending = ["multiband", "linear", "gaussian"], tiling = ["chess", "grid"] } = {}) {
  const requiredNodes = sourceKind === "image" ? SEEDVR2_DETAIL_IMAGE_REQUIRED_NODES : SEEDVR2_DETAIL_REQUIRED_NODES;
  const info = Object.fromEntries(requiredNodes.map((name) => [name, { input: { required: {} } }]));
  const inputs = Object.fromEntries(SEEDVR2_DETAIL_NODE_INPUTS.filter((name) => name !== omitInput).map((name) => [
    name,
    SEEDVR2_DETAIL_NODE_INPUT_TYPES[name] === "COMBO" ? [["placeholder"], {}] : [SEEDVR2_DETAIL_NODE_INPUT_TYPES[name], {}],
  ]));
  inputs.unet_name = [[unetName], {}];
  inputs.vae_name = [[SEEDVR2_VAE_NAME], {}];
  inputs.resize_method = [["lanczos", "bicubic", "bilinear", "area", "nearest-exact"], {}];
  inputs.color_correction = [["wavelet", "lab", "adain", "none"], {}];
  inputs.sampler_name = [["euler", "heun", "dpmpp_2m"], {}];
  inputs.scheduler = [["simple", "normal", "karras"], {}];
  inputs.blending_method = [blending, {}];
  inputs.tiling_strategy = [tiling, {}];
  inputs.detail_preset = [["default", "skin_detail"], {}];
  info[SEEDVR2_DETAIL_NODE].input.required = inputs;
  return info;
}

function h3ObjectInfo() {
  const info = Object.fromEntries(H3_LATENT_REQUIRED_NODES.map((name) => [name, { input: { required: {} } }]));
  info.UNETLoader.input.required.unet_name = ["COMBO", { options: H3_LATENT_DIFFUSION_NAMES }];
  info.CLIPLoader.input.required.clip_name = ["COMBO", { options: [H3_LATENT_ENCODER_NAME] }];
  info.VAELoader.input.required.vae_name = ["COMBO", { options: [H3_LATENT_VAE_NAME, H3_LATENT_AUDIO_VAE_NAME] }];
  return info;
}

function apiResponse() {
  return {
    headersSent: false,
    status: 0,
    body: null,
    writeHead(status) { this.status = status; this.headersSent = true; },
    end(value) { this.body = value ? JSON.parse(value) : null; },
  };
}

test("builds corrected 15-node SeedVR2 graph with dynamic inputs", () => {
  const graph = buildSeedVR2Prompt({ sourceName: "clips/source.mp4", seed: 7 });
  assert.equal(Object.keys(graph).length, 15);
  assert.equal(graph["1"].class_type, "LoadVideo");
  assert.equal(graph["1"].inputs.file, "clips/source.mp4");
  assert.deepEqual(graph["9"].inputs, { latent: ["6", 0], temporal_overlap: 1, chunking_mode: "auto" });
  assert.deepEqual(graph["8"].inputs.vae_conditioning, ["9", 0]);
  assert.deepEqual(graph["10"].inputs.latent_image, ["9", 0]);
  assert.deepEqual(graph["11"].inputs, { latents: ["10", 0], temporal_overlap: ["9", 1] });
  assert.equal(graph["3"].inputs.resize_type, "scale by multiplier");
  assert.equal(graph["3"].inputs["resize_type.multiplier"], 2);
  assert.equal(graph["13"].inputs.color_correction_method, "wavelet");
  assert.deepEqual(graph["14"].inputs.fps, ["2", 2]);
  assert.deepEqual(graph["14"].inputs.audio, ["2", 1]);
  assert.equal("bit_depth" in graph["14"].inputs, false);
  assert.equal(graph["15"].inputs.filename_prefix.includes("/"), false);
  assert.equal(graph["15"].inputs["codec.encoding"], "re-encode");
  assert.equal(graph["15"].inputs["codec.encoding.crf"], 18);
});

test("builds native 11-node SeedVR2 image graph with 7B Sharp and tiled VAE", () => {
  const graph = buildSeedVR2ImagePrompt({
    sourceName: "images/source.png",
    seed: 9,
    scale: 3.5,
    resizeMethod: "bicubic",
    colorCorrection: "lab",
  });
  assert.equal(Object.keys(graph).length, 11);
  assert.equal(graph["1"].class_type, "LoadImage");
  assert.equal(graph["1"].inputs.image, "images/source.png");
  assert.equal(graph["2"].inputs["resize_type.multiplier"], 3.5);
  assert.equal(graph["2"].inputs.scale_method, "bicubic");
  assert.equal(graph["5"].class_type, "VAEEncodeTiled");
  assert.equal(graph["6"].inputs.unet_name, SEEDVR2_UNET_NAME);
  assert.equal(graph["8"].inputs.steps, 1);
  assert.equal(graph["10"].inputs.color_correction_method, "lab");
  assert.equal(graph["11"].class_type, "SaveImage");
});

test("validates SeedVR2 adjustable settings while keeping H3 fixed at 2x", () => {
  assert.deepEqual(normalizeSeedVR2Settings({ scale: 1.25, resizeMethod: "area", colorCorrection: "none" }), {
    scale: 1.25,
    resizeMethod: "area",
    colorCorrection: "none",
    steps: 1,
    cfg: 1,
    samplerName: "euler",
    scheduler: "simple",
    denoise: 1,
    ...SEEDVR2_DEFAULT_DETAIL,
  });
  assert.throws(() => normalizeSeedVR2Settings({ scale: 4.25 }), { code: "SCALE_INVALID" });
  assert.throws(() => normalizeSeedVR2Settings({ scale: 2, resizeMethod: "invented" }), { code: "RESIZE_METHOD_INVALID" });
  assert.throws(() => normalizeSeedVR2Settings({ scale: 2, colorCorrection: "invented" }), { code: "COLOR_CORRECTION_INVALID" });
  assert.throws(() => normalizeSeedVR2Settings({ scale: 3 }, H3_LATENT_PROFILE), { code: "SCALE_INVALID" });
});

test("default detail settings preserve the legacy image and video graphs exactly", () => {
  const video = buildSeedVR2Prompt({ sourceName: "clips/source.mp4", seed: 7 });
  const image = buildSeedVR2ImagePrompt({ sourceName: "images/source.png", seed: 9 });
  assert.deepEqual(buildSeedVR2Prompt({ sourceName: "clips/source.mp4", seed: 7, ...SEEDVR2_DEFAULT_DETAIL }), video);
  assert.deepEqual(buildSeedVR2ImagePrompt({ sourceName: "images/source.png", seed: 9, ...SEEDVR2_DEFAULT_DETAIL }), image);
  assert.equal(Object.values(video).some((node) => node.class_type === SEEDVR2_DETAIL_NODE), false);
  assert.equal(Object.values(image).some((node) => node.class_type === SEEDVR2_DETAIL_NODE), false);
});

test("detail graph receives every normalized SeedVR2 detail field for images and videos", () => {
  const settings = {
    detailPreset: "skin_detail",
    scale: 2,
    resizeMethod: "lanczos",
    colorCorrection: "wavelet",
    steps: 1,
    cfg: 1,
    samplerName: "euler",
    scheduler: "simple",
    denoise: 1,
    inputNoiseScale: 0.035,
    latentNoiseScale: 0.015,
    tileWidth: 768,
    tileHeight: 1024,
    tilePadding: 96,
    tileUpscaleResolution: 2560,
    blendingMethod: "gaussian",
    antiAliasingStrength: 0.25,
    maskBlur: 2.5,
    tilingStrategy: "grid",
  };
  const video = buildSeedVR2DetailPrompt({ sourceName: "clips/source.mp4", seed: 7, ...settings });
  const image = buildSeedVR2DetailPrompt({ sourceName: "images/source.png", seed: 9, ...settings });
  const expected = {
    unet_name: SEEDVR2_UNET_NAME,
    vae_name: SEEDVR2_VAE_NAME,
    scale: 2,
    resize_method: "lanczos",
    color_correction: "wavelet",
    steps: 1,
    cfg: 1,
    sampler_name: "euler",
    scheduler: "simple",
    denoise: 1,
    input_noise_scale: 0.035,
    latent_noise_scale: 0.015,
    tile_width: 768,
    tile_height: 1024,
    tile_padding: 96,
    tile_upscale_resolution: 2560,
    blending_method: "gaussian",
    anti_aliasing_strength: 0.25,
    mask_blur: 2.5,
    tiling_strategy: "grid",
    detail_preset: "skin_detail",
  };
  assert.equal(video["3"].class_type, SEEDVR2_DETAIL_NODE);
  assert.equal(image["2"].class_type, SEEDVR2_DETAIL_NODE);
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(video["3"].inputs[key], value, key);
    assert.deepEqual(image["2"].inputs[key], value, key);
  }
  assert.deepEqual(video["3"].inputs.image, ["2", 0]);
  assert.deepEqual(image["2"].inputs.image, ["1", 0]);
});

test("detail readiness requires the complete node input contract and requested enum support", () => {
  const settings = normalizeSeedVR2Settings({ detailPreset: "skin_detail" });
  const ready = evaluateSeedVR2Readiness(detailObjectInfo(), { modelFiles: { unet: true, vae: true }, detailMode: true, detailSettings: settings });
  assert.equal(ready.ready, true);
  assert.equal(ready.detail.available, true);
  const missing = evaluateSeedVR2Readiness(detailObjectInfo({ omitInput: "latent_noise_scale" }), { modelFiles: { unet: true, vae: true }, detailMode: true, detailSettings: settings });
  assert.equal(missing.ready, false);
  assert.deepEqual(missing.detail.missingInputs, ["latent_noise_scale"]);
  const wrongType = detailObjectInfo();
  wrongType[SEEDVR2_DETAIL_NODE].input.required.tile_width = ["FLOAT", {}];
  const invalid = evaluateSeedVR2Readiness(wrongType, { modelFiles: { unet: true, vae: true }, detailMode: true, detailSettings: settings });
  assert.equal(invalid.ready, false);
  assert.deepEqual(invalid.detail.invalidInputs, ["tile_width"]);
  const unsupported = evaluateSeedVR2Readiness(detailObjectInfo({ blending: ["multiband", "linear"] }), {
    modelFiles: { unet: true, vae: true },
    detailMode: true,
    detailSettings: { ...settings, blendingMethod: "gaussian" },
  });
  assert.equal(unsupported.ready, false);
  assert.deepEqual(unsupported.detail.unsupported.blendingMethod, ["gaussian"]);
});

test("readiness requires native nodes and exact model combos", () => {
  const ready = evaluateSeedVR2Readiness(objectInfo(), { modelFiles: { unet: true, vae: true } });
  assert.equal(ready.ready, true);
  assert.equal(ready.models.unet.name, SEEDVR2_UNET_NAME);
  assert.equal(ready.models.vae.name, SEEDVR2_VAE_NAME);
  const missing = evaluateSeedVR2Readiness(objectInfo(), { modelFiles: { unet: false, vae: true } });
  assert.equal(missing.ready, false);
  assert.equal(missing.models.unet.available, false);
  assert.equal(evaluateSeedVR2Readiness(imageObjectInfo(), { modelFiles: { unet: true, vae: true }, sourceKind: "image" }).ready, true);
  const fp16 = evaluateSeedVR2Readiness(imageObjectInfo(SEEDVR2_FP16_UNET_NAME), {
    unetName: SEEDVR2_FP16_UNET_NAME,
    modelFiles: { unet: true, vae: true },
    sourceKind: "image",
  });
  assert.equal(fp16.ready, true);
  assert.equal(fp16.models.unet.name, SEEDVR2_FP16_UNET_NAME);
});

test("controller resolves the FP16 profile to the exact FP16 model", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "h3-seedvr2-fp16-"));
  const inputRoot = path.join(root, "input");
  const outputRoot = path.join(root, "output");
  await fs.mkdir(path.join(root, "models", "diffusion_models"), { recursive: true });
  await fs.mkdir(path.join(root, "models", "vae"), { recursive: true });
  await fs.mkdir(inputRoot, { recursive: true });
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.writeFile(path.join(root, "models", "diffusion_models", SEEDVR2_FP16_UNET_NAME), "model");
  await fs.writeFile(path.join(root, "models", "vae", SEEDVR2_VAE_NAME), "vae");
  const controller = createSeedVR2Controller({
    comfyRoot: root,
    inputRoot,
    outputRoot,
    fetchImpl: async (url) => {
      if (url.endsWith("/system_stats")) return response({ devices: [] });
      if (url.endsWith("/object_info")) return response(imageObjectInfo(SEEDVR2_FP16_UNET_NAME));
      throw new Error(`unexpected endpoint ${url}`);
    },
  });
  const health = await controller.checkReadiness(SEEDVR2_FP16_PROFILE, "image");
  assert.equal(health.ready, true);
  assert.equal(health.profile, SEEDVR2_FP16_PROFILE);
  assert.equal(health.models.unet.name, SEEDVR2_FP16_UNET_NAME);
});

test("builds the community H3 latent 2x two-pass graph", () => {
  const graph = buildH3LatentPrompt({ sourceName: "clips/source.mp4", filenamePrefix: "unsafe/prefix" });
  assert.equal(Object.keys(graph).length, 29);
  assert.deepEqual(
    Object.values(graph).map((node) => node.class_type),
    ["LoadVideo", "GetVideoComponents", "GetImageSize", "UNETLoader", "CLIPLoader", "VAELoader", "VAELoader", "MiniMaxH3ReferenceToVideo", "RandomNoise", "KSamplerSelect", "BasicScheduler", "BasicGuider", "SamplerCustomAdvanced", "LTXVSeparateAVLatent", "MiniMaxH3LatentUpscale", "RandomNoise", "ManualSigmas", "MiniMaxH3AddNoise", "MiniMaxH3ShiftSigmas", "MiniMaxH3AddNoise", "LTXVConcatAVLatent", "MiniMaxH3ConditioningUpscale", "BasicGuider", "DisableNoise", "SamplerCustomAdvanced", "VAEDecode", "VAEDecodeAudio", "CreateVideo", "SaveVideo"],
  );
  assert.equal(graph["4"].inputs.unet_name, H3_LATENT_DIFFUSION_NAMES[0]);
  assert.equal(graph["5"].inputs.clip_name, H3_LATENT_ENCODER_NAME);
  assert.equal(graph["6"].inputs.vae_name, H3_LATENT_VAE_NAME);
  assert.equal(graph["7"].inputs.vae_name, H3_LATENT_AUDIO_VAE_NAME);
  assert.equal(graph["8"].class_type, "MiniMaxH3ReferenceToVideo");
  assert.deepEqual(graph["8"].inputs["ref_videos.ref_video_0"], ["2", 0]);
  assert.deepEqual(graph["8"].inputs["ref_video_audios.ref_video_audio_0"], ["2", 1]);
  assert.equal(graph["11"].inputs.steps, 25);
  assert.equal(graph["15"].inputs.scale_by, 2);
  assert.equal(graph["15"].inputs.upscale_method, "bilinear");
  assert.equal(graph["17"].inputs.sigmas, H3_LATENT_PASS2_SIGMAS);
  assert.deepEqual(graph["18"].inputs.sigmas, ["17", 0]);
  assert.deepEqual(graph["25"].inputs.noise, ["24", 0]);
  assert.deepEqual(graph["28"].inputs.audio, ["27", 0]);
  assert.equal(graph["29"].inputs.filename_prefix.includes("/"), false);

  const modelFiles = {
    diffusion: Object.fromEntries(H3_LATENT_DIFFUSION_NAMES.map((name) => [name, true])),
    encoder: true,
    videoVae: true,
    audioVae: true,
  };
  const ready = evaluateH3LatentReadiness(h3ObjectInfo(), { modelFiles });
  assert.equal(ready.ready, true);
  assert.equal(ready.models.diffusion.name, H3_LATENT_DIFFUSION_NAMES[0]);
  assert.equal(ready.models.videoVae.name, H3_LATENT_VAE_NAME);
  const missing = evaluateH3LatentReadiness(h3ObjectInfo(), { modelFiles: { ...modelFiles, encoder: false } });
  assert.equal(missing.ready, false);
  assert.equal(missing.models.encoder.available, false);
});

test("normalizes source paths and rejects traversal/non-video names", () => {
  assert.equal(normalizeVideoAssetName("nested\\clip.MP4"), "nested/clip.MP4");
  assert.throws(() => normalizeVideoAssetName("../clip.mp4"), { code: "SOURCE_NAME_INVALID" });
  assert.throws(() => normalizeVideoAssetName("C:\\clip.mp4"), { code: "SOURCE_NAME_INVALID" });
  assert.throws(() => normalizeVideoAssetName("frame.png"), { code: "SOURCE_KIND_INVALID" });
  assert.equal(normalizeUpscaleAssetName("images/frame.png"), "images/frame.png");
  assert.equal(normalizeUpscaleAssetName("clips/source.mp4"), "clips/source.mp4");
  assert.throws(() => normalizeUpscaleAssetName("images/frame.gif"), { code: "SOURCE_KIND_INVALID" });
  assert.equal(parseSeedVR2History({ p: { status: { status_str: "error", messages: [["execution_error", { exception_message: "bad node" }]] } } }, "p").state, "failed");
});

test("parses SaveVideo history artifacts and ignores unsafe output paths", () => {
  const result = parseSeedVR2History({
    p: {
      status: { completed: true },
      outputs: { "15": { images: [{ filename: "seedvr2_00001_.mp4", subfolder: "", type: "output" }] } },
    },
  }, "p");
  assert.deepEqual(result, { state: "completed", artifact: "seedvr2_00001_.mp4" });
  const unsafe = parseSeedVR2History({ p: { status: { completed: true }, outputs: { "15": { videos: [{ filename: "../escape.mp4" }] } } } }, "p");
  assert.deepEqual(unsafe, { state: "completed" });
});

test("controller queues one active job, preserves public shape, and cleans output staging", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "h3-seedvr2-"));
  const inputRoot = path.join(root, "input");
  const outputRoot = path.join(root, "output");
  await fs.mkdir(path.join(root, "models", "diffusion_models"), { recursive: true });
  await fs.mkdir(path.join(root, "models", "vae"), { recursive: true });
  await fs.mkdir(inputRoot, { recursive: true });
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.writeFile(path.join(root, "models", "diffusion_models", SEEDVR2_UNET_NAME), "model");
  await fs.writeFile(path.join(root, "models", "vae", SEEDVR2_VAE_NAME), "vae");
  await fs.writeFile(path.join(outputRoot, "source.mp4"), "source");
  await fs.writeFile(path.join(outputRoot, "seedvr2_result.mp4"), "result");
  let promptSeen = null;
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith("/system_stats")) return response({ devices: [] });
    if (url.endsWith("/object_info")) return response(objectInfo());
    if (url.endsWith("/prompt")) {
      promptSeen = JSON.parse(init.body);
      return response({ prompt_id: "prompt-test" });
    }
    if (url.includes("/history/prompt-test")) {
      return response({ "prompt-test": { status: { completed: true }, outputs: { "15": { images: [{ filename: "seedvr2_result.mp4", subfolder: "", type: "output" }] } } } });
    }
    throw new Error(`unexpected endpoint ${url}`);
  };
  const controller = createSeedVR2Controller({
    comfyRoot: root,
    inputRoot,
    outputRoot,
    fetchImpl,
    pollIntervalMs: 1,
    toAsset: async (_root, name) => ({ name, root: "output", kind: "video" }),
    idFactory: () => "job-output",
  });
  const queued = await controller.enqueue({ sourceName: "source.mp4", sourceRoot: "output", scale: 2 });
  assert.equal(queued.status, "queued");
  assert.equal(queued.sourceRoot, "output");
  assert.equal(queued.startedAt, null);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await controller.getJob("job-output");
    if (current?.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const completed = await controller.getJob("job-output");
  assert.equal(completed.status, "completed");
  assert.equal(completed.output.name, "seedvr2_result.mp4");
  assert.equal(await fs.stat(path.join(inputRoot, "seedvr2_temp_job-output.mp4")).catch(() => null), null);
  assert.equal(promptSeen.prompt["5"].inputs.vae_name, SEEDVR2_VAE_NAME);
  assert.equal(promptSeen.prompt["7"].inputs.unet_name, SEEDVR2_UNET_NAME);
});

test("controller upscales a single image with SeedVR2 7B and registers a PNG output", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "h3-seedvr2-image-"));
  const inputRoot = path.join(root, "input");
  const outputRoot = path.join(root, "output");
  await fs.mkdir(path.join(root, "models", "diffusion_models"), { recursive: true });
  await fs.mkdir(path.join(root, "models", "vae"), { recursive: true });
  await fs.mkdir(inputRoot, { recursive: true });
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.writeFile(path.join(root, "models", "diffusion_models", SEEDVR2_UNET_NAME), "model");
  await fs.writeFile(path.join(root, "models", "vae", SEEDVR2_VAE_NAME), "vae");
  await fs.writeFile(path.join(inputRoot, "source.png"), "source");
  await fs.writeFile(path.join(outputRoot, "seedvr2_result.png"), "result");
  let promptSeen = null;
  const controller = createSeedVR2Controller({
    comfyRoot: root,
    inputRoot,
    outputRoot,
    pollIntervalMs: 1,
    fetchImpl: async (url, init = {}) => {
      if (url.endsWith("/system_stats")) return response({ devices: [] });
      if (url.endsWith("/object_info")) return response(imageObjectInfo());
      if (url.endsWith("/prompt")) {
        promptSeen = JSON.parse(init.body);
        return response({ prompt_id: "prompt-image" });
      }
      if (url.includes("/history/prompt-image")) {
        return response({ "prompt-image": { status: { completed: true }, outputs: { "11": { images: [{ filename: "seedvr2_result.png", subfolder: "", type: "output" }] } } } });
      }
      throw new Error(`unexpected endpoint ${url}`);
    },
    toAsset: async (_root, name) => ({ name, root: "output", kind: "image" }),
    idFactory: () => "image-job",
  });
  const queued = await controller.enqueue({
    sourceName: "source.png",
    sourceRoot: "input",
    scale: 3,
    profile: "seedvr2_7b_sharp_nvfp4",
    seed: 123,
    resizeMethod: "bilinear",
    colorCorrection: "adain",
  });
  assert.equal(queued.status, "queued");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await controller.getJob("image-job");
    if (current?.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const completed = await controller.getJob("image-job");
  assert.equal(completed.status, "completed");
  assert.equal(completed.output.kind, "image");
  assert.equal(completed.output.name, "seedvr2_result.png");
  assert.equal(promptSeen.prompt["1"].class_type, "LoadImage");
  assert.equal(promptSeen.prompt["2"].inputs["resize_type.multiplier"], 3);
  assert.equal(promptSeen.prompt["2"].inputs.scale_method, "bilinear");
  assert.equal(promptSeen.prompt["8"].inputs.seed, 123);
  assert.equal(promptSeen.prompt["10"].inputs.color_correction_method, "adain");
  assert.equal(promptSeen.prompt["11"].class_type, "SaveImage");
});

test("remote controller uploads source video and downloads the ComfyUI artifact", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "h3-seedvr2-remote-"));
  const inputRoot = path.join(root, "input");
  const outputRoot = path.join(root, "output");
  await fs.mkdir(path.join(root, "models", "diffusion_models"), { recursive: true });
  await fs.mkdir(path.join(root, "models", "vae"), { recursive: true });
  await fs.mkdir(inputRoot, { recursive: true });
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.writeFile(path.join(root, "models", "diffusion_models", SEEDVR2_UNET_NAME), "model");
  await fs.writeFile(path.join(root, "models", "vae", SEEDVR2_VAE_NAME), "vae");
  await fs.writeFile(path.join(outputRoot, "source.mp4"), "source-video");

  let uploadSeen = null;
  let promptSeen = null;
  let viewSeen = null;
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith("/system_stats")) return response({ devices: [] });
    if (url.endsWith("/object_info")) return response(objectInfo());
    if (url.endsWith("/upload/image")) {
      uploadSeen = init;
      assert.equal(init.method, "POST");
      assert.equal(init.body.get("subfolder"), "h3-studio-seedvr2");
      assert.equal(init.body.get("type"), "input");
      assert.equal(init.body.get("overwrite"), "true");
      assert.equal(typeof init.body.get("image").arrayBuffer, "function");
      return response({ name: "remote-source.mp4", subfolder: "h3-studio-seedvr2", type: "input" });
    }
    if (url.endsWith("/prompt")) {
      promptSeen = JSON.parse(init.body);
      return response({ prompt_id: "prompt-remote" });
    }
    if (url.includes("/history/prompt-remote")) {
      return response({ "prompt-remote": {
        status: { completed: true },
        outputs: { "15": { videos: [{ filename: "remote-result.mp4", subfolder: "seedvr2-out", type: "output" }] } },
      } });
    }
    if (url.includes("/view?")) {
      const requestUrl = new URL(url);
      viewSeen = requestUrl;
      assert.equal(requestUrl.searchParams.get("filename"), "remote-result.mp4");
      assert.equal(requestUrl.searchParams.get("subfolder"), "seedvr2-out");
      assert.equal(requestUrl.searchParams.get("type"), "output");
      return binaryResponse("remote-result");
    }
    throw new Error(`unexpected endpoint ${url}`);
  };
  const controller = createSeedVR2Controller({
    comfyUrl: "http://remote.test",
    remote: true,
    comfyRoot: root,
    inputRoot,
    outputRoot,
    fetchImpl,
    pollIntervalMs: 1,
    toAsset: async (_root, name) => ({ name, root: "output", kind: "video" }),
    idFactory: () => "remote-job",
  });
  const queued = await controller.enqueue({ sourceName: "source.mp4", sourceRoot: "output", scale: 2 });
  assert.equal(queued.status, "queued");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await controller.getJob("remote-job");
    if (current?.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const completed = await controller.getJob("remote-job");
  assert.equal(completed.status, "completed");
  assert.equal(completed.output.root, "output");
  assert.equal(completed.output.kind, "video");
  assert.match(completed.output.name, /^seedvr2\/seedvr2_source_remote-/);
  assert.equal(await fs.readFile(path.join(outputRoot, completed.output.name), "utf8"), "remote-result");
  assert.equal(promptSeen.prompt["1"].inputs.file, "h3-studio-seedvr2/remote-source.mp4");
  assert.ok(uploadSeen);
  assert.ok(viewSeen);
  assert.equal(await fs.stat(path.join(inputRoot, "seedvr2_temp_remote-job.mp4")).catch(() => null), null);
});

test("controller runs the H3 latent profile with its own model paths and output namespace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "h3-latent-upscale-"));
  const inputRoot = path.join(root, "input");
  const outputRoot = path.join(root, "output");
  await fs.mkdir(path.join(root, "models", "diffusion_models"), { recursive: true });
  await fs.mkdir(path.join(root, "models", "text_encoders"), { recursive: true });
  await fs.mkdir(path.join(root, "models", "vae"), { recursive: true });
  await fs.mkdir(inputRoot, { recursive: true });
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.writeFile(path.join(root, "models", "diffusion_models", H3_LATENT_DIFFUSION_NAMES[0]), "model");
  await fs.writeFile(path.join(root, "models", "text_encoders", H3_LATENT_ENCODER_NAME), "encoder");
  await fs.writeFile(path.join(root, "models", "vae", H3_LATENT_VAE_NAME), "vae");
  await fs.writeFile(path.join(root, "models", "vae", H3_LATENT_AUDIO_VAE_NAME), "audio-vae");
  await fs.writeFile(path.join(inputRoot, "source.mp4"), "source");
  await fs.writeFile(path.join(outputRoot, "h3_result.mp4"), "result");
  let promptSeen = null;
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith("/system_stats")) return response({ devices: [] });
    if (url.endsWith("/object_info")) return response(h3ObjectInfo());
    if (url.endsWith("/prompt")) {
      promptSeen = JSON.parse(init.body);
      return response({ prompt_id: "h3-prompt-test" });
    }
    if (url.includes("/history/h3-prompt-test")) {
      return response({ "h3-prompt-test": { status: { completed: true }, outputs: { "29": { videos: [{ filename: "h3_result.mp4", subfolder: "", type: "output" }] } } } });
    }
    throw new Error(`unexpected endpoint ${url}`);
  };
  const controller = createSeedVR2Controller({
    comfyRoot: root,
    inputRoot,
    outputRoot,
    fetchImpl,
    pollIntervalMs: 1,
    toAsset: async (_root, name) => ({ name, root: "output", kind: "video" }),
    idFactory: () => "h3-latent-job",
  });
  const health = apiResponse();
  assert.equal(await controller.handleRoute({ method: "GET", url: "/api/upscale/health?profile=h3_latent_2x" }, health), true);
  assert.equal(health.status, 200);
  assert.equal(health.body.profile, H3_LATENT_PROFILE);
  assert.equal(health.body.ready, true);
  const queued = await controller.enqueue({ sourceName: "source.mp4", sourceRoot: "input", scale: 2, profile: H3_LATENT_PROFILE });
  assert.equal(queued.profile, H3_LATENT_PROFILE);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await controller.getJob("h3-latent-job");
    if (current?.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const completed = await controller.getJob("h3-latent-job");
  assert.equal(completed.status, "completed");
  assert.equal(completed.output.name, "h3_result.mp4");
  assert.equal(promptSeen.prompt["4"].class_type, "UNETLoader");
  assert.equal(promptSeen.prompt["4"].inputs.unet_name, H3_LATENT_DIFFUSION_NAMES[0]);
  assert.equal(promptSeen.prompt["6"].inputs.vae_name, H3_LATENT_VAE_NAME);
  assert.equal(promptSeen.prompt["8"].class_type, "MiniMaxH3ReferenceToVideo");
  assert.equal(promptSeen.prompt["15"].class_type, "MiniMaxH3LatentUpscale");
  assert.equal(promptSeen.prompt["25"].class_type, "SamplerCustomAdvanced");
  assert.equal(promptSeen.prompt["29"].class_type, "SaveVideo");
  assert.match(completed.stage, /Completed/);
});

test("controller route reports 503 when ComfyUI readiness is false", async () => {
  const controller = createSeedVR2Controller({
    inputRoot: path.join(os.tmpdir(), "h3-seedvr2-input-missing"),
    outputRoot: path.join(os.tmpdir(), "h3-seedvr2-output-missing"),
    fetchImpl: async () => { throw new Error("offline"); },
  });
  const res = apiResponse();
  const handled = await controller.handleRoute({ method: "POST", url: "/api/upscale" }, res, {
    readJson: async () => ({ sourceName: "clip.mp4", sourceRoot: "input", scale: 2 }),
  });
  assert.equal(handled, true);
  assert.equal(res.status, 503);
  assert.equal(res.body.health.ready, false);
});

test("controller rejects detail submissions when the detail node contract is unavailable", async () => {
  const controller = createSeedVR2Controller({
    inputRoot: path.join(os.tmpdir(), "h3-seedvr2-input-detail-missing"),
    outputRoot: path.join(os.tmpdir(), "h3-seedvr2-output-detail-missing"),
    fetchImpl: async (url) => {
      if (url.endsWith("/system_stats")) return response({ devices: [] });
      if (url.endsWith("/object_info")) return response(objectInfo());
      throw new Error(`unexpected endpoint ${url}`);
    },
  });
  const res = apiResponse();
  await controller.handleRoute({ method: "POST", url: "/api/upscale" }, res, {
    readJson: async () => ({ sourceName: "clip.mp4", sourceRoot: "input", scale: 2, detailPreset: "skin_detail" }),
  });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "SEEDVR2_DETAIL_NOT_READY");
  assert.equal(res.body.health.detail.requested, true);
  assert.equal(res.body.health.detail.available, false);
  assert.equal(res.body.health.nodes[SEEDVR2_DETAIL_NODE], false);
});

test("SeedVR2 advanced sampling overrides reach both KSampler graphs", () => {
  const settings = {
    steps: 7,
    cfg: 2.35,
    samplerName: "dpmpp_2m",
    scheduler: "karras",
    denoise: 0.65,
  };
  const video = buildSeedVR2Prompt({ sourceName: "clips/source.mp4", seed: 7, ...settings });
  const image = buildSeedVR2ImagePrompt({ sourceName: "images/source.png", seed: 9, ...settings });
  for (const sampler of [video["10"].inputs, image["8"].inputs]) {
    assert.equal(sampler.steps, 7);
    assert.equal(sampler.cfg, 2.35);
    assert.equal(sampler.sampler_name, "dpmpp_2m");
    assert.equal(sampler.scheduler, "karras");
    assert.equal(sampler.denoise, 0.65);
  }

  const defaults = buildSeedVR2Prompt({ sourceName: "clips/source.mp4", seed: 7 })["10"].inputs;
  assert.equal(defaults.steps, 1);
  assert.equal(defaults.cfg, 1);
  assert.equal(defaults.sampler_name, "euler");
  assert.equal(defaults.scheduler, "simple");
  assert.equal(defaults.denoise, 1);
});

test("SeedVR2 advanced sampling validation uses stable 400-series error codes", () => {
  assert.throws(() => normalizeSeedVR2Settings({ steps: 0 }), { code: "STEPS_INVALID", status: 400 });
  assert.throws(() => normalizeSeedVR2Settings({ steps: 1.5 }), { code: "STEPS_INVALID", status: 400 });
  assert.throws(() => normalizeSeedVR2Settings({ cfg: -0.01 }), { code: "CFG_INVALID", status: 400 });
  assert.throws(() => normalizeSeedVR2Settings({ cfg: 20.01 }), { code: "CFG_INVALID", status: 400 });
  assert.throws(() => normalizeSeedVR2Settings({ samplerName: "invented" }), { code: "SAMPLER_INVALID", status: 400 });
  assert.throws(() => normalizeSeedVR2Settings({ scheduler: "invented" }), { code: "SCHEDULER_INVALID", status: 400 });
  assert.throws(() => normalizeSeedVR2Settings({ denoise: -0.01 }), { code: "DENOISE_INVALID", status: 400 });
  assert.throws(() => normalizeSeedVR2Settings({ denoise: 1.01 }), { code: "DENOISE_INVALID", status: 400 });
  assert.deepEqual(normalizeSeedVR2Settings({ cfg: 1.234, denoise: 0.666 }), {
    scale: 2,
    resizeMethod: "lanczos",
    colorCorrection: "wavelet",
    steps: 1,
    cfg: 1.23,
    samplerName: "euler",
    scheduler: "simple",
    denoise: 0.67,
    ...SEEDVR2_DEFAULT_DETAIL,
  });
  assert.throws(
    () => normalizeSeedVR2Settings({ scale: 2, steps: 2 }, H3_LATENT_PROFILE),
    { code: "SEEDVR2_SETTINGS_UNSUPPORTED", status: 400 },
  );
});

test("SeedVR2 detail validation uses stable 400-series error codes for every field", () => {
  const invalid = [
    [{ inputNoiseScale: -0.001 }, "INPUT_NOISE_SCALE_INVALID"],
    [{ inputNoiseScale: 0.201 }, "INPUT_NOISE_SCALE_INVALID"],
    [{ latentNoiseScale: -0.001 }, "LATENT_NOISE_SCALE_INVALID"],
    [{ latentNoiseScale: 0.201 }, "LATENT_NOISE_SCALE_INVALID"],
    [{ tileWidth: 255 }, "TILE_WIDTH_INVALID"],
    [{ tileWidth: 257 }, "TILE_WIDTH_INVALID"],
    [{ tileWidth: 2112 }, "TILE_WIDTH_INVALID"],
    [{ tileHeight: 255 }, "TILE_HEIGHT_INVALID"],
    [{ tileHeight: 2112 }, "TILE_HEIGHT_INVALID"],
    [{ tileHeight: 1000 }, "TILE_HEIGHT_INVALID"],
    [{ tilePadding: -1 }, "TILE_PADDING_INVALID"],
    [{ tilePadding: 257 }, "TILE_PADDING_INVALID"],
    [{ tilePadding: 1.5 }, "TILE_PADDING_INVALID"],
    [{ tileUpscaleResolution: 511 }, "TILE_UPSCALE_RESOLUTION_INVALID"],
    [{ tileUpscaleResolution: 513 }, "TILE_UPSCALE_RESOLUTION_INVALID"],
    [{ tileUpscaleResolution: 4160 }, "TILE_UPSCALE_RESOLUTION_INVALID"],
    [{ blendingMethod: "invented" }, "BLENDING_METHOD_INVALID"],
    [{ blendingMethod: 0 }, "BLENDING_METHOD_INVALID"],
    [{ antiAliasingStrength: -0.001 }, "ANTI_ALIASING_STRENGTH_INVALID"],
    [{ antiAliasingStrength: 1.001 }, "ANTI_ALIASING_STRENGTH_INVALID"],
    [{ maskBlur: -0.001 }, "MASK_BLUR_INVALID"],
    [{ maskBlur: 64.001 }, "MASK_BLUR_INVALID"],
    [{ tilingStrategy: "invented" }, "TILING_STRATEGY_INVALID"],
    [{ detailPreset: "invented" }, "DETAIL_PRESET_INVALID"],
  ];
  for (const [input, code] of invalid) {
    assert.throws(() => normalizeSeedVR2Settings(input), { code, status: 400 }, code);
  }
  assert.deepEqual(normalizeSeedVR2Settings({ detailPreset: "skin_detail" }), {
    scale: 2,
    resizeMethod: "lanczos",
    colorCorrection: "wavelet",
    steps: 1,
    cfg: 1,
    samplerName: "euler",
    scheduler: "simple",
    denoise: 1,
    ...SEEDVR2_DEFAULT_DETAIL,
    detailPreset: "skin_detail",
    inputNoiseScale: 0.035,
  });
  assert.throws(
    () => normalizeSeedVR2Settings({ detailPreset: "skin_detail" }, H3_LATENT_PROFILE),
    { code: "SEEDVR2_SETTINGS_UNSUPPORTED", status: 400 },
  );
});

test("detail validation codes are preserved by the public POST API", async () => {
  const controller = createSeedVR2Controller({
    inputRoot: path.join(os.tmpdir(), "h3-seedvr2-validation-input"),
    outputRoot: path.join(os.tmpdir(), "h3-seedvr2-validation-output"),
    fetchImpl: async () => { throw new Error("validation must run before ComfyUI readiness"); },
  });
  const invalid = [
    ["inputNoiseScale", 0.3, "INPUT_NOISE_SCALE_INVALID"],
    ["latentNoiseScale", -1, "LATENT_NOISE_SCALE_INVALID"],
    ["tileWidth", 1000, "TILE_WIDTH_INVALID"],
    ["tileHeight", 1000, "TILE_HEIGHT_INVALID"],
    ["tilePadding", 1.5, "TILE_PADDING_INVALID"],
    ["tileUpscaleResolution", 513, "TILE_UPSCALE_RESOLUTION_INVALID"],
    ["blendingMethod", "bad", "BLENDING_METHOD_INVALID"],
    ["antiAliasingStrength", 2, "ANTI_ALIASING_STRENGTH_INVALID"],
    ["maskBlur", 65, "MASK_BLUR_INVALID"],
    ["tilingStrategy", "bad", "TILING_STRATEGY_INVALID"],
    ["detailPreset", "bad", "DETAIL_PRESET_INVALID"],
  ];
  for (const [field, value, code] of invalid) {
    const res = apiResponse();
    await controller.handleRoute({ method: "POST", url: "/api/upscale" }, res, {
      readJson: async () => ({ sourceName: "clip.mp4", sourceRoot: "input", scale: 2, [field]: value }),
    });
    assert.equal(res.status, 400, field);
    assert.equal(res.body.code, code, field);
  }
});
