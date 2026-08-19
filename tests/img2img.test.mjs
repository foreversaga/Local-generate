import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  IMG2IMG_MODELS,
  IMG2IMG_MODEL_PROFILES,
  IMG2IMG_POSE_REQUIRED_NODES,
  buildImg2ImgPrompt,
  comfyWebSocketUrl,
  createImg2ImgController,
  evaluateImg2ImgReadiness,
  normalizeCharacterLoraName,
  normalizeCharacterLoraStrength,
  normalizeImageAssetName,
  normalizePoseImageName,
  normalizePoseControlNetName,
  normalizePoseControlStrength,
  normalizePoseResolution,
  normalizePoseRoot,
  parseComfyWebSocketMessage,
  parseImg2ImgHistory,
} from "../server/image-generation/img2img.mjs";
import { createImg2ImgStore } from "../server/image-generation/img2img-store.mjs";

const CHECKPOINT_MODELS = IMG2IMG_MODELS.filter((model) => IMG2IMG_MODEL_PROFILES[model].workflow === "checkpoint");
const WAI_MODEL = "waiIllustriousSDXL_v170.safetensors";
const JUGGERNAUT_MODEL = "Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors";
const Z_IMAGE_MODEL = "z_image_turbo_bf16.safetensors";
const Z_IMAGE_COMPANIONS = {
  clipName: "qwen_3_4b.safetensors",
  clipType: "lumina2",
  vaeName: "ae.safetensors",
};

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    async text() { return JSON.stringify(payload); },
  };
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

class FakeComfyWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.closed = false;
    FakeComfyWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, data) {
    for (const listener of this.listeners.get(type) || []) listener(data);
  }

  close() {
    this.closed = true;
  }
}

const requiredObjectInfo = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [[...CHECKPOINT_MODELS]] } } },
  LoadImage: {},
  VAEEncode: {},
  CLIPTextEncode: {},
  KSampler: {},
  VAEDecode: {},
  SaveImage: {},
  ImageScaleToTotalPixels: {},
};

const currentObjectInfo = {
  ...requiredObjectInfo,
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [{ value: [...CHECKPOINT_MODELS] }, { tooltip: "Checkpoint" }] } } },
};

const poseObjectInfo = {
  ...currentObjectInfo,
  ControlNetLoader: { input: { required: { control_net_name: [["openpose.safetensors"]] } } },
  ControlNetApplyAdvanced: {},
  DWPreprocessor: {},
};

const loraObjectInfo = {
  ...currentObjectInfo,
  LoraLoader: { input: { required: { model: ["MODEL"], clip: ["CLIP"], lora_name: [{ value: ["characters/hero.safetensors"] }], strength_model: ["FLOAT"], strength_clip: ["FLOAT"] } } },
  LoraLoaderModelOnly: { input: { required: { model: ["MODEL"], lora_name: [{ value: ["characters/hero.safetensors"] }], strength_model: ["FLOAT"] } } },
};

const windowsLoraObjectInfo = {
  ...currentObjectInfo,
  LoraLoader: { input: { required: { lora_name: [["trained\\girl2d.safetensors"]] } } },
};

const zImageObjectInfo = {
  LoadImage: {},
  VAEEncode: {},
  CLIPTextEncode: {},
  KSampler: {},
  VAEDecode: {},
  SaveImage: {},
  UNETLoader: { input: { required: { unet_name: [[Z_IMAGE_MODEL]], weight_dtype: [["default"]] } } },
  CLIPLoader: { input: { required: { clip_name: [[Z_IMAGE_COMPANIONS.clipName]], type: [[Z_IMAGE_COMPANIONS.clipType]] } } },
  VAELoader: { input: { required: { vae_name: [[Z_IMAGE_COMPANIONS.vaeName]] } } },
  ModelSamplingAuraFlow: {},
};

test("builds an eight-node native img2img workflow", () => {
  const graph = buildImg2ImgPrompt({
    sourceName: "source.png",
    prompt: "cinematic portrait",
    negativePrompt: "blur",
    model: IMG2IMG_MODELS[0],
    denoise: 0.55,
    steps: 4,
    cfg: 1,
    seed: 42,
  });
  assert.equal(Object.keys(graph).length, 8);
  assert.equal(graph["1"].inputs.ckpt_name, IMG2IMG_MODELS[0]);
  assert.equal(graph["2"].inputs.image, "source.png");
  assert.deepEqual(graph["3"].inputs.pixels, ["2", 0]);
  assert.equal(graph["4"].inputs.text, "cinematic portrait");
  assert.equal(graph["6"].inputs.denoise, 0.55);
  assert.equal(graph["6"].inputs.steps, 4);
  assert.deepEqual(graph["8"].inputs.images, ["7", 0]);
});

test("adds an optional DWPose ControlNet branch without changing source conditioning", () => {
  const graph = buildImg2ImgPrompt({
    sourceName: "character.png",
    poseName: "pose.png",
    poseControlNetName: "openpose.safetensors",
    poseControlStrength: 0.8,
    poseResolution: 512,
    prompt: "cinematic portrait",
    model: IMG2IMG_MODELS[0],
  });
  assert.equal(graph["2"].inputs.image, "character.png");
  assert.equal(graph["9"].class_type, "LoadImage");
  assert.equal(graph["9"].inputs.image, "pose.png");
  assert.equal(graph["10"].class_type, "DWPreprocessor");
  assert.equal(graph["11"].class_type, "ControlNetLoader");
  assert.equal(graph["11"].inputs.control_net_name, "openpose.safetensors");
  assert.equal(graph["12"].class_type, "ControlNetApplyAdvanced");
  assert.equal(graph["12"].inputs.strength, 0.8);
  assert.deepEqual(graph["6"].inputs.positive, ["12", 0]);
  assert.deepEqual(graph["6"].inputs.negative, ["12", 1]);
  assert.deepEqual(graph["6"].inputs.latent_image, ["3", 0]);
});

test("builds the high-quality Juggernaut pose workflow with SDXL normalization and Xinsir conditioning", () => {
  const graph = buildImg2ImgPrompt({
    sourceName: "character.png",
    poseName: "pose.png",
    poseControlNetName: "xinsir_openpose_sdxl_1.0.safetensors",
    prompt: "natural adult portrait",
    model: JUGGERNAUT_MODEL,
  });
  assert.equal(graph["6"].inputs.steps, 35);
  assert.equal(graph["6"].inputs.cfg, 5);
  assert.equal(graph["6"].inputs.denoise, 1);
  assert.equal(graph["6"].inputs.sampler_name, "dpmpp_2m");
  assert.equal(graph["6"].inputs.scheduler, "karras");
  assert.equal(graph["14"].class_type, "ImageScaleToTotalPixels");
  assert.deepEqual(graph["14"].inputs, {
    image: ["2", 0],
    upscale_method: "lanczos",
    megapixels: 1,
    resolution_steps: 64,
  });
  assert.deepEqual(graph["3"].inputs.pixels, ["14", 0]);
  assert.equal(graph["10"].inputs.scale_stick_for_xinsr_cn, "enable");
});

test("pose readiness requires configured ControlNet and DWPose nodes", () => {
  const ready = evaluateImg2ImgReadiness(poseObjectInfo, { poseControlNetName: "openpose.safetensors" });
  assert.deepEqual(Object.keys(ready.pose.nodes).sort(), [...IMG2IMG_POSE_REQUIRED_NODES].sort());
  assert.equal(ready.pose.available, true);
  const missingModel = evaluateImg2ImgReadiness(poseObjectInfo, { poseControlNetName: "missing.safetensors" });
  assert.equal(missingModel.pose.available, false);
  assert.equal(missingModel.pose.reason, "POSE_CONTROLNET_MODEL_MISSING");
});

test("allows image-to-image workflows without a positive prompt", () => {
  const graph = buildImg2ImgPrompt({
    sourceName: "source.png",
    prompt: "",
    negativePrompt: "",
    model: IMG2IMG_MODELS[0],
  });
  assert.equal(graph["4"].inputs.text, "");
  assert.equal(graph["5"].inputs.text, "");
});

test("builds a matching ComfyUI WebSocket URL and parses native progress events", () => {
  assert.equal(comfyWebSocketUrl("http://127.0.0.1:8188/", "img2img-client"), "ws://127.0.0.1:8188/ws?clientId=img2img-client");
  assert.equal(comfyWebSocketUrl("https://comfy.example/", "img2img-client"), "wss://comfy.example/ws?clientId=img2img-client");
  assert.deepEqual(parseComfyWebSocketMessage(JSON.stringify({
    type: "progress",
    data: { prompt_id: "prompt-1", node: "6", value: 4, max: 4 },
  })), { type: "progress", prompt_id: "prompt-1", node: "6", value: 4, max: 4 });
  assert.equal(parseComfyWebSocketMessage("not-json"), null);
});

test("adds a checkpoint LoRA without changing the unselected graph node ids", () => {
  const graph = buildImg2ImgPrompt({
    sourceName: "source.png",
    prompt: "cinematic portrait",
    negativePrompt: "blur",
    model: IMG2IMG_MODELS[0],
    characterLoraName: "characters/hero.safetensors",
    characterLoraStrength: 0.75,
  });
  assert.equal(graph["9"].class_type, "LoraLoader");
  assert.deepEqual(graph["9"].inputs.model, ["1", 0]);
  assert.deepEqual(graph["9"].inputs.clip, ["1", 1]);
  assert.equal(graph["9"].inputs.lora_name, "characters/hero.safetensors");
  assert.equal(graph["9"].inputs.strength_model, 0.75);
  assert.equal(graph["9"].inputs.strength_clip, 0.75);
  assert.deepEqual(graph["4"].inputs.clip, ["9", 1]);
  assert.deepEqual(graph["5"].inputs.clip, ["9", 1]);
  assert.deepEqual(graph["6"].inputs.model, ["9", 0]);
});

test("adds a model-only LoRA to the Z-Image model path", () => {
  const graph = buildImg2ImgPrompt({
    sourceName: "source.png",
    prompt: "a realistic portrait",
    model: Z_IMAGE_MODEL,
    characterLoraName: "z-image/hero.safetensors",
    characterLoraStrength: 0.6,
  });
  assert.equal(graph["12"].class_type, "LoraLoaderModelOnly");
  assert.deepEqual(graph["12"].inputs.model, ["1", 0]);
  assert.equal(graph["12"].inputs.lora_name, "z-image/hero.safetensors");
  assert.equal(graph["12"].inputs.strength_model, 0.6);
  assert.deepEqual(graph["8"].inputs.model, ["12", 0]);
});

test("validates character LoRA names and strengths", () => {
  assert.equal(normalizeCharacterLoraName(" characters\\hero.safetensors "), "characters/hero.safetensors");
  assert.equal(normalizeCharacterLoraStrength(undefined), 0.75);
  assert.equal(normalizeCharacterLoraStrength("0.8"), 0.8);
  assert.throws(() => normalizeCharacterLoraName("../escape.safetensors"), { code: "CHARACTER_LORA_NAME_INVALID" });
  assert.throws(() => normalizeCharacterLoraName("C:\\models\\hero.safetensors"), { code: "CHARACTER_LORA_NAME_INVALID" });
  assert.throws(() => normalizeCharacterLoraName("\\\\server\\share\\hero.safetensors"), { code: "CHARACTER_LORA_NAME_INVALID" });
  assert.throws(() => normalizeCharacterLoraStrength(""), { code: "CHARACTER_LORA_STRENGTH_INVALID" });
  assert.throws(() => normalizeCharacterLoraStrength(false), { code: "CHARACTER_LORA_STRENGTH_INVALID" });
  assert.throws(() => normalizeCharacterLoraStrength(2.1), { code: "CHARACTER_LORA_STRENGTH_INVALID" });
});

test("builds the WAI checkpoint workflow without changing the native graph", () => {
  const graph = buildImg2ImgPrompt({
    sourceName: "source.png",
    prompt: "anime portrait",
    negativePrompt: "blurry",
    model: WAI_MODEL,
    denoise: 0.42,
    steps: 20,
    cfg: 7,
    seed: 11,
  });
  assert.equal(Object.keys(graph).length, 8);
  assert.equal(graph["1"].class_type, "CheckpointLoaderSimple");
  assert.equal(graph["1"].inputs.ckpt_name, WAI_MODEL);
  assert.deepEqual(graph["3"].inputs.vae, ["1", 2]);
  assert.deepEqual(graph["6"].inputs.model, ["1", 0]);
  assert.equal(graph["6"].inputs.denoise, 0.42);
});

test("builds the Z-Image Turbo image-conditioned workflow from local blueprint nodes", () => {
  const graph = buildImg2ImgPrompt({
    sourceName: "source.png",
    prompt: "a realistic portrait",
    negativePrompt: "blur",
    model: Z_IMAGE_MODEL,
    denoise: 0.33,
    steps: 9,
    cfg: 1,
    seed: 42,
  });
  assert.equal(Object.keys(graph).length, 11);
  assert.deepEqual(graph["1"], { class_type: "UNETLoader", inputs: { unet_name: Z_IMAGE_MODEL, weight_dtype: "default" } });
  assert.deepEqual(graph["2"], {
    class_type: "CLIPLoader",
    inputs: { clip_name: Z_IMAGE_COMPANIONS.clipName, type: Z_IMAGE_COMPANIONS.clipType, device: "default" },
  });
  assert.deepEqual(graph["3"], { class_type: "VAELoader", inputs: { vae_name: Z_IMAGE_COMPANIONS.vaeName } });
  assert.deepEqual(graph["5"].inputs, { pixels: ["4", 0], vae: ["3", 0] });
  assert.deepEqual(graph["8"], { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3 } });
  assert.equal(graph["9"].inputs.steps, 9);
  assert.equal(graph["9"].inputs.cfg, 1);
  assert.equal(graph["9"].inputs.seed, 42);
  assert.equal(graph["9"].inputs.denoise, 0.33);
  assert.equal(graph["9"].inputs.sampler_name, "dpmpp_2m_sde");
  assert.equal(graph["9"].inputs.scheduler, "beta");
  assert.deepEqual(graph["9"].inputs.latent_image, ["5", 0]);
  assert.deepEqual(graph["10"].inputs, { samples: ["9", 0], vae: ["3", 0] });
  assert.deepEqual(graph["11"].inputs.images, ["10", 0]);
});

test("readiness requires standard nodes and at least one approved checkpoint", () => {
  const ready = evaluateImg2ImgReadiness(requiredObjectInfo);
  assert.equal(ready.ready, true);
  assert.equal(ready.models[IMG2IMG_MODELS[0]], true);
  const missing = evaluateImg2ImgReadiness({ ...requiredObjectInfo, VAEEncode: undefined });
  assert.equal(missing.ready, false);
});

test("readiness parses the current ComfyUI checkpoint combo schema", () => {
  const readiness = evaluateImg2ImgReadiness(currentObjectInfo);
  assert.equal(readiness.ready, true);
  assert.equal(readiness.models[IMG2IMG_MODELS[0]], true);
  assert.equal(readiness.models[IMG2IMG_MODELS[1]], true);
});

test("readiness reports the optional LoRA loader nodes without making them required", () => {
  const withoutLoraNodes = evaluateImg2ImgReadiness(currentObjectInfo);
  assert.equal(withoutLoraNodes.models[IMG2IMG_MODELS[0]], true);
  assert.equal(withoutLoraNodes.profiles[IMG2IMG_MODELS[0]].loraAvailable, false);
  const withLoraNodes = evaluateImg2ImgReadiness(loraObjectInfo);
  assert.equal(withLoraNodes.profiles[IMG2IMG_MODELS[0]].loraLoader, "LoraLoader");
  assert.equal(withLoraNodes.profiles[IMG2IMG_MODELS[0]].loraAvailable, true);
});

test("readiness checks Z-Image loader nodes and companion model combos", () => {
  const readiness = evaluateImg2ImgReadiness(zImageObjectInfo);
  assert.equal(readiness.ready, true);
  assert.equal(readiness.models[Z_IMAGE_MODEL], true);
  assert.equal(readiness.profiles[Z_IMAGE_MODEL].nodes.UNETLoader, true);
  assert.equal(readiness.profiles[Z_IMAGE_MODEL].companions.clip, true);
  assert.equal(readiness.profiles[Z_IMAGE_MODEL].companions.vae, true);

  const missingVae = evaluateImg2ImgReadiness({ ...zImageObjectInfo, VAELoader: undefined });
  assert.equal(missingVae.models[Z_IMAGE_MODEL], false);
  assert.equal(missingVae.ready, false);

  const missingClipType = evaluateImg2ImgReadiness({
    ...zImageObjectInfo,
    CLIPLoader: { input: { required: { clip_name: [[Z_IMAGE_COMPANIONS.clipName]], type: [["sd3"]] } } },
  });
  assert.equal(missingClipType.models[Z_IMAGE_MODEL], false);
});

test("remote readiness marks local-only WAI and Z-Image profiles unavailable", () => {
  const readiness = evaluateImg2ImgReadiness({ ...requiredObjectInfo, ...zImageObjectInfo }, { remote: true });
  assert.equal(readiness.models[IMG2IMG_MODELS[0]], true);
  assert.equal(readiness.models[WAI_MODEL], false);
  assert.equal(readiness.models[Z_IMAGE_MODEL], false);
  assert.equal(readiness.profiles[WAI_MODEL].reason, "LOCAL_ONLY_MODEL");
  assert.equal(readiness.profiles[Z_IMAGE_MODEL].reason, "LOCAL_ONLY_MODEL");
});

test("readiness ignores unrelated current-schema checkpoints", () => {
  const readiness = evaluateImg2ImgReadiness({
    ...requiredObjectInfo,
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [{ value: ["sam3.1_multiplex_fp16.safetensors"] }, {}] } } },
  });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.models[IMG2IMG_MODELS[0]], false);
  assert.equal(readiness.models[IMG2IMG_MODELS[1]], false);
});

test("POST readiness 503 keeps health details for actionable diagnostics", async () => {
  const controller = createImg2ImgController({
    inputRoot: path.join(os.tmpdir(), "h3-img2img-input-missing"),
    outputRoot: path.join(os.tmpdir(), "h3-img2img-output-missing"),
    fetchImpl: async (url) => {
      if (String(url).endsWith("/system_stats")) throw new Error("offline");
      if (String(url).endsWith("/object_info")) return response(currentObjectInfo);
      throw new Error(`unexpected endpoint ${url}`);
    },
  });
  const res = apiResponse();
  const handled = await controller.handleRoute({ method: "POST", url: "/api/img2img" }, res, {
    readJson: async () => ({ sourceName: "source.png", prompt: "restyle" }),
    sendJson: (_target, status, body) => { res.status = status; res.body = body; },
    sendError: (_target, status, message, code) => { res.status = status; res.body = { error: message, code }; },
  });
  assert.equal(handled, true);
  assert.equal(res.status, 503);
  assert.equal(res.body.error, "Image-to-image is not ready.");
  assert.equal(res.body.health.comfyUi, false);
  assert.equal(res.body.health.models[IMG2IMG_MODELS[0]], true);
});

test("POST rejects a LoRA when the selected profile loader node is unavailable", async () => {
  const controller = createImg2ImgController({
    inputRoot: path.join(os.tmpdir(), "h3-img2img-lora-input-missing"),
    outputRoot: path.join(os.tmpdir(), "h3-img2img-lora-output-missing"),
    fetchImpl: async (url) => {
      if (String(url).endsWith("/system_stats")) return response({});
      if (String(url).endsWith("/object_info")) return response(currentObjectInfo);
      throw new Error(`unexpected endpoint ${url}`);
    },
  });
  const res = apiResponse();
  await controller.handleRoute({ method: "POST", url: "/api/img2img" }, res, {
    readJson: async () => ({ sourceName: "source.png", prompt: "restyle", characterLoraName: "characters/hero.safetensors" }),
    sendJson: (_target, status, body) => { res.status = status; res.body = body; },
    sendError: (_target, status, message, code) => { res.status = status; res.body = { error: message, code }; },
  });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "IMG2IMG_LORA_NOT_READY");
  assert.equal(res.body.health.profiles[IMG2IMG_MODELS[0]].loraAvailable, false);
});

test("POST rejects a selected model when another profile is ready", async () => {
  const controller = createImg2ImgController({
    inputRoot: path.join(os.tmpdir(), "h3-img2img-model-input-missing"),
    outputRoot: path.join(os.tmpdir(), "h3-img2img-model-output-missing"),
    fetchImpl: async (url) => {
      if (String(url).endsWith("/system_stats")) return response({});
      if (String(url).endsWith("/object_info")) return response(requiredObjectInfo);
      throw new Error(`unexpected endpoint ${url}`);
    },
  });
  const res = apiResponse();
  const handled = await controller.handleRoute({ method: "POST", url: "/api/img2img" }, res, {
    readJson: async () => ({ sourceName: "source.png", prompt: "anime", model: Z_IMAGE_MODEL }),
    sendJson: (_target, status, body) => { res.status = status; res.body = body; },
    sendError: (_target, status, message, code) => { res.status = status; res.body = { error: message, code }; },
  });
  assert.equal(handled, true);
  assert.equal(res.status, 503);
  assert.equal(res.body.error, `Image model ${Z_IMAGE_MODEL} is not ready on this runtime.`);
  assert.equal(res.body.health.models[Z_IMAGE_MODEL], false);
});

test("POST rejects a pose reference when no ControlNet model is configured", async () => {
  const controller = createImg2ImgController({
    inputRoot: path.join(os.tmpdir(), "h3-img2img-pose-input-missing"),
    outputRoot: path.join(os.tmpdir(), "h3-img2img-pose-output-missing"),
    fetchImpl: async (url) => {
      if (String(url).endsWith("/system_stats")) return response({});
      if (String(url).endsWith("/object_info")) return response(currentObjectInfo);
      throw new Error(`unexpected endpoint ${url}`);
    },
  });
  const res = apiResponse();
  await controller.handleRoute({ method: "POST", url: "/api/img2img" }, res, {
    readJson: async () => ({ sourceName: "character.png", poseName: "pose.png", prompt: "portrait" }),
    sendJson: (_target, status, body) => { res.status = status; res.body = body; },
    sendError: (_target, status, message, code) => { res.status = status; res.body = { error: message, code }; },
  });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "IMG2IMG_POSE_NOT_READY");
  assert.equal(res.body.health.pose.reason, "POSE_CONTROLNET_NOT_CONFIGURED");
});

test("normalizes safe image names and parses SaveImage history", () => {
  assert.equal(normalizeImageAssetName("folder/source.webp"), "folder/source.webp");
  assert.throws(() => normalizeImageAssetName("../secret.png"), { code: "SOURCE_NAME_INVALID" });
  assert.throws(() => normalizeImageAssetName("clip.mp4"), { code: "SOURCE_KIND_INVALID" });
  const parsed = parseImg2ImgHistory({
    abc: {
      status: { status_str: "success", completed: true },
      outputs: { "8": { images: [{ filename: "result.png", subfolder: "img2img", type: "output" }] } },
    },
  }, "abc");
  assert.equal(parsed.state, "completed");
  assert.equal(parsed.artifact.relativeName, "img2img/result.png");
});

test("remote controller rejects local-only model profiles before queueing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-img2img-local-only-"));
  const inputRoot = path.join(root, "input");
  const outputRoot = path.join(root, "output");
  await mkdir(inputRoot, { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  await writeFile(path.join(inputRoot, "source.png"), Buffer.from([137, 80, 78, 71]));
  try {
    const controller = createImg2ImgController({
      comfyUrl: "http://comfy",
      remote: true,
      inputRoot,
      outputRoot,
      storeRoot: path.join(root, "records"),
      fetchImpl: async () => { throw new Error("remote guard should run before ComfyUI requests"); },
    });
    await assert.rejects(
      () => controller.enqueue({ sourceName: "source.png", prompt: "anime portrait", model: WAI_MODEL }),
      (error) => error?.code === "MODEL_RUNTIME_UNSUPPORTED" && /local runtime/.test(error.message),
    );
    await assert.rejects(
      () => controller.enqueue({ sourceName: "source.png", prompt: "realistic portrait", model: Z_IMAGE_MODEL }),
      (error) => error?.code === "MODEL_RUNTIME_UNSUPPORTED" && /local runtime/.test(error.message),
    );
    assert.deepEqual(controller.getJobs(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remote controller uploads, generates, downloads, and registers an image", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-img2img-"));
  const inputRoot = path.join(root, "input");
  const outputRoot = path.join(root, "output");
  await mkdir(inputRoot, { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  await writeFile(path.join(inputRoot, "source.png"), Buffer.from([137, 80, 78, 71]));
  const calls = [];
  let submittedGraph = null;
  const fetchImpl = async (url, init = {}) => {
    const endpoint = String(url).replace("http://comfy", "");
    calls.push(endpoint);
    if (endpoint === "/system_stats") return new Response("{}");
    if (endpoint === "/object_info") return new Response(JSON.stringify(requiredObjectInfo));
    if (endpoint === "/upload/image") {
      assert.equal(init.method, "POST");
      assert.equal(typeof init.body?.get, "function");
      return new Response(JSON.stringify({ name: "job.png", subfolder: "h3-studio-img2img", type: "input" }));
    }
    if (endpoint === "/prompt") {
      submittedGraph = JSON.parse(init.body).prompt;
      return new Response(JSON.stringify({ prompt_id: "prompt-1" }));
    }
    if (endpoint === "/history/prompt-1") return new Response(JSON.stringify({
      "prompt-1": {
        status: { status_str: "success", completed: true },
        outputs: { "8": { images: [{ filename: "remote.png", subfolder: "img2img", type: "output" }] } },
      },
    }));
    if (endpoint.startsWith("/view?")) return new Response(Buffer.from([137, 80, 78, 71, 13, 10]));
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };
  let beforeRuns = 0;
  try {
    const controller = createImg2ImgController({
      comfyUrl: "http://comfy",
      remote: true,
      inputRoot,
      outputRoot,
      storeRoot: path.join(root, "records"),
      fetchImpl,
      pollIntervalMs: 1,
      beforeRun: async () => { beforeRuns += 1; },
      idFactory: () => "12345678-abcd",
      toAsset: async (_root, name) => ({ root: "output", name, kind: "image" }),
    });
    const queued = await controller.enqueue({ sourceName: "source.png", prompt: "restyled portrait", seed: 7 });
    assert.equal(queued.status, "queued");
    let job = queued;
    for (let count = 0; count < 100 && !["completed", "failed"].includes(job.status); count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      job = await controller.getJob(queued.id);
    }
    assert.equal(job.status, "completed", job.error);
    assert.equal(beforeRuns, 1);
    assert.equal(submittedGraph["2"].inputs.image, "h3-studio-img2img/job.png");
    assert.equal(submittedGraph["6"].inputs.seed, 7);
    assert.equal(job.output.name, "img2img/source-12345678.png");
    assert.deepEqual([...await readFile(path.join(outputRoot, job.output.name))], [137, 80, 78, 71, 13, 10]);
    assert.ok(calls.some((item) => item.startsWith("/view?")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remote controller stages the optional pose image and submits the ControlNet branch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-img2img-pose-remote-"));
  const inputRoot = path.join(root, "input");
  const outputRoot = path.join(root, "output");
  await mkdir(inputRoot, { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  await writeFile(path.join(inputRoot, "character.png"), Buffer.from([137, 80, 78, 71]));
  await writeFile(path.join(inputRoot, "pose.png"), Buffer.from([137, 80, 78, 71]));
  let uploadCount = 0;
  let submittedGraph = null;
  const fetchImpl = async (url, init = {}) => {
    const endpoint = String(url).replace("http://pose-comfy", "");
    if (endpoint === "/system_stats") return new Response("{}");
    if (endpoint === "/object_info") return new Response(JSON.stringify(poseObjectInfo));
    if (endpoint === "/upload/image") {
      uploadCount += 1;
      return new Response(JSON.stringify({
        name: uploadCount === 1 ? "character-upload.png" : "pose-upload.png",
        subfolder: "h3-studio-img2img",
        type: "input",
      }));
    }
    if (endpoint === "/prompt") {
      submittedGraph = JSON.parse(init.body).prompt;
      return new Response(JSON.stringify({ prompt_id: "pose-prompt-1" }));
    }
    if (endpoint === "/history/pose-prompt-1") return new Response(JSON.stringify({
      "pose-prompt-1": {
        status: { status_str: "success", completed: true },
        outputs: { "8": { images: [{ filename: "pose-result.png", subfolder: "img2img", type: "output" }] } },
      },
    }));
    if (endpoint.startsWith("/view?")) return new Response(Buffer.from([137, 80, 78, 71, 13, 10]));
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };
  try {
    const controller = createImg2ImgController({
      comfyUrl: "http://pose-comfy",
      remote: true,
      inputRoot,
      outputRoot,
      storeRoot: path.join(root, "records"),
      fetchImpl,
      pollIntervalMs: 1,
      poseControlNetName: "openpose.safetensors",
      idFactory: () => "pose-remote-job",
      toAsset: (_root, name) => ({ root: "output", name, kind: "image" }),
    });
    const queued = await controller.enqueue({
      sourceName: "character.png",
      poseName: "pose.png",
      poseControlStrength: 1.3,
      poseResolution: 768,
      prompt: "pose-controlled portrait",
      seed: 17,
    });
    let job = queued;
    for (let count = 0; count < 100 && !["completed", "failed"].includes(job.status); count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      job = await controller.getJob(queued.id);
    }
    assert.equal(job.status, "completed", job.error);
    assert.equal(uploadCount, 2);
    assert.equal(submittedGraph["2"].inputs.image, "h3-studio-img2img/character-upload.png");
    assert.equal(submittedGraph["9"].inputs.image, "h3-studio-img2img/pose-upload.png");
    assert.equal(submittedGraph["10"].class_type, "DWPreprocessor");
    assert.equal(submittedGraph["10"].inputs.resolution, 768);
    assert.equal(submittedGraph["11"].inputs.control_net_name, "openpose.safetensors");
    assert.equal(submittedGraph["12"].inputs.strength, 1.3);
    assert.deepEqual(submittedGraph["6"].inputs.positive, ["12", 0]);
    assert.equal(job.poseControlStrength, 1.3);
    assert.equal(job.poseResolution, 768);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normalizes an optional pose reference without changing legacy source validation", () => {
  assert.equal(normalizePoseImageName("poses\\hero.webp"), "poses/hero.webp");
  assert.equal(normalizePoseControlNetName("openpose\\body.safetensors"), "openpose/body.safetensors");
  assert.equal(normalizePoseControlStrength(undefined), 1);
  assert.equal(normalizePoseResolution(undefined), 512);
  assert.equal(normalizePoseRoot(undefined), "input");
  assert.equal(normalizePoseRoot("output"), "output");
  assert.throws(() => normalizePoseImageName("../pose.png"), { code: "POSE_NAME_INVALID" });
  assert.throws(() => normalizePoseImageName("pose.mp4"), { code: "POSE_KIND_INVALID" });
  assert.throws(() => normalizePoseRoot("training"), { code: "POSE_ROOT_INVALID" });
  assert.throws(() => normalizePoseControlNetName("../escape.safetensors"), { code: "POSE_CONTROLNET_NAME_INVALID" });
  assert.throws(() => normalizePoseControlStrength(11), { code: "POSE_CONTROL_STRENGTH_INVALID" });
  assert.throws(() => normalizePoseResolution(513), { code: "POSE_RESOLUTION_INVALID" });
});

test("local controller submits the exact Windows ComfyUI LoRA token", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-img2img-windows-lora-"));
  const inputRoot = path.join(root, "input");
  const outputRoot = path.join(root, "output");
  const artifactName = "img2img/windows-lora.png";
  await mkdir(inputRoot, { recursive: true });
  await mkdir(path.join(outputRoot, "img2img"), { recursive: true });
  await writeFile(path.join(inputRoot, "source.png"), Buffer.from([137, 80, 78, 71]));
  await writeFile(path.join(outputRoot, artifactName), Buffer.from([137, 80, 78, 71]));
  let submittedGraph = null;
  const fetchImpl = async (url, init = {}) => {
    const endpoint = String(url).replace("http://windows-comfy", "");
    if (endpoint === "/system_stats") return new Response("{}");
    if (endpoint === "/object_info") return new Response(JSON.stringify(windowsLoraObjectInfo));
    if (endpoint === "/prompt") {
      submittedGraph = JSON.parse(init.body).prompt;
      return new Response(JSON.stringify({ prompt_id: "windows-lora-prompt" }));
    }
    if (endpoint === "/history/windows-lora-prompt") return new Response(JSON.stringify({
      "windows-lora-prompt": {
        status: { status_str: "success", completed: true },
        outputs: { "8": { images: [{ filename: "windows-lora.png", subfolder: "img2img", type: "output" }] } },
      },
    }));
    throw new Error("Unexpected endpoint: " + endpoint);
  };
  try {
    const controller = createImg2ImgController({
      comfyUrl: "http://windows-comfy",
      inputRoot,
      outputRoot,
      storeRoot: path.join(root, "records"),
      fetchImpl,
      pollIntervalMs: 1,
      idFactory: () => "windows-lora-job",
      toAsset: (_root, name) => ({ root: "output", name, kind: "image" }),
    });
    const queued = await controller.enqueue({
      sourceName: "source.png",
      prompt: "anime portrait",
      model: WAI_MODEL,
      characterLoraName: "trained/girl2d.safetensors",
      characterLoraStrength: 0.75,
    });
    let job = queued;
    for (let count = 0; count < 100 && !["completed", "failed"].includes(job.status); count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      job = await controller.getJob(queued.id);
    }
    assert.equal(job.status, "completed", job.error);
    assert.equal(job.characterLoraName, "trained/girl2d.safetensors");
    assert.equal(submittedGraph["9"].inputs.lora_name, "trained\\girl2d.safetensors");
    assert.equal(job.output.name, artifactName);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("controller preserves actionable ComfyUI node validation details", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-img2img-node-errors-"));
  const inputRoot = path.join(root, "input");
  const outputRoot = path.join(root, "output");
  await mkdir(inputRoot, { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  await writeFile(path.join(inputRoot, "source.png"), Buffer.from([137, 80, 78, 71]));
  const fetchImpl = async (url) => {
    const endpoint = String(url).replace("http://error-comfy", "");
    if (endpoint === "/system_stats") return new Response("{}");
    if (endpoint === "/object_info") return new Response(JSON.stringify(currentObjectInfo));
    if (endpoint === "/prompt") return new Response(JSON.stringify({
      error: { message: "Prompt outputs failed validation" },
      node_errors: {
        "9": {
          class_type: "LoraLoader",
          errors: [{
            message: "Value not in list",
            extra_info: {
              input_name: "lora_name",
              received_value: "trained/girl2d.safetensors",
            },
          }],
        },
      },
    }), { status: 400 });
    throw new Error("Unexpected endpoint: " + endpoint);
  };
  try {
    const controller = createImg2ImgController({
      comfyUrl: "http://error-comfy",
      inputRoot,
      outputRoot,
      storeRoot: path.join(root, "records"),
      fetchImpl,
      pollIntervalMs: 1,
      idFactory: () => "node-error-job",
    });
    const queued = await controller.enqueue({ sourceName: "source.png", prompt: "portrait" });
    let job = queued;
    for (let count = 0; count < 100 && !["completed", "failed"].includes(job.status); count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      job = await controller.getJob(queued.id);
    }
    assert.equal(job.status, "failed");
    assert.match(job.error, /Prompt outputs failed validation/);
    assert.match(job.error, /LoraLoader\.lora_name: Value not in list/);
    assert.match(job.error, /trained\/girl2d\.safetensors/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local controller submits the Z-Image graph and registers node 11 output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-img2img-z-local-"));
  const inputRoot = path.join(root, "input");
  const outputRoot = path.join(root, "output");
  const artifactName = "img2img/z-result.png";
  await mkdir(inputRoot, { recursive: true });
  await mkdir(path.join(outputRoot, "img2img"), { recursive: true });
  await writeFile(path.join(inputRoot, "source.png"), Buffer.from([137, 80, 78, 71]));
  await writeFile(path.join(outputRoot, artifactName), Buffer.from([137, 80, 78, 71]));
  let submittedGraph = null;
  const fetchImpl = async (url, init = {}) => {
    const endpoint = String(url).replace("http://local-comfy", "");
    if (endpoint === "/system_stats") return new Response("{}");
    if (endpoint === "/object_info") return new Response(JSON.stringify(zImageObjectInfo));
    if (endpoint === "/prompt") {
      submittedGraph = JSON.parse(init.body).prompt;
      return new Response(JSON.stringify({ prompt_id: "z-prompt-1" }));
    }
    if (endpoint === "/history/z-prompt-1") return new Response(JSON.stringify({
      "z-prompt-1": {
        status: { status_str: "success", completed: true },
        outputs: { "11": { images: [{ filename: "z-result.png", subfolder: "img2img", type: "output" }] } },
      },
    }));
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };
  try {
    const controller = createImg2ImgController({
      comfyUrl: "http://local-comfy",
      inputRoot,
      outputRoot,
      storeRoot: path.join(root, "records"),
      fetchImpl,
      pollIntervalMs: 1,
      idFactory: () => "z-local-job",
      toAsset: (_root, name) => ({ root: "output", name, kind: "image" }),
    });
    const queued = await controller.enqueue({ sourceName: "source.png", prompt: "realistic portrait", model: Z_IMAGE_MODEL });
    let job = queued;
    for (let count = 0; count < 100 && !["completed", "failed"].includes(job.status); count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      job = await controller.getJob(queued.id);
    }
    assert.equal(job.status, "completed", job.error);
    assert.equal(submittedGraph["1"].class_type, "UNETLoader");
    assert.equal(submittedGraph["11"].class_type, "SaveImage");
    assert.equal(job.output.name, artifactName);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("batch controller randomizes every item Seed, ignores legacy Seed ranges, and reloads persisted records", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-img2img-batch-"));
  const inputRoot = path.join(root, "input");
  const outputRoot = path.join(root, "output");
  const storeRoot = path.join(root, "records");
  await mkdir(inputRoot, { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  await writeFile(path.join(inputRoot, "source.png"), Buffer.from([137, 80, 78, 71]));
  const submitted = [];
  let promptCount = 0;
  const randomValues = [0, 0, 0, 0, 0.999999999999, 0.999999999999, 0.999999999999, 0.999999999999, 0.999999999999];
  let randomIndex = 0;
  const fetchImpl = async (url, init = {}) => {
    const endpoint = String(url).replace("http://batch-comfy", "");
    if (endpoint === "/system_stats") return new Response("{}");
    if (endpoint === "/object_info") return new Response(JSON.stringify(requiredObjectInfo));
    if (endpoint === "/upload/image") return new Response(JSON.stringify({ name: "batch-source.png", subfolder: "h3-studio-img2img", type: "input" }));
    if (endpoint === "/prompt") {
      promptCount += 1;
      submitted.push(JSON.parse(init.body).prompt);
      return new Response(JSON.stringify({ prompt_id: `batch-prompt-${promptCount}` }));
    }
    if (endpoint.startsWith("/history/batch-prompt-")) {
      const index = Number(endpoint.slice("/history/batch-prompt-".length));
      return new Response(JSON.stringify({
        [`batch-prompt-${index}`]: {
          status: { status_str: "success", completed: true },
          outputs: { "8": { images: [{ filename: `remote-${index}.png`, subfolder: "img2img", type: "output" }] } },
        },
      }));
    }
    if (endpoint.startsWith("/view?")) return new Response(Buffer.from([137, 80, 78, 71, 13, 10]));
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };
  try {
    const controller = createImg2ImgController({
      comfyUrl: "http://batch-comfy",
      remote: true,
      inputRoot,
      outputRoot,
      storeRoot,
      fetchImpl,
      pollIntervalMs: 1,
      idFactory: () => "batch-job-1",
      randomFn: () => randomValues[randomIndex++] ?? 0,
      toAsset: async (_root, name) => ({ root: "output", name, kind: "image" }),
    });
    const queued = await controller.enqueue({
      sourceName: "source.png",
      prompt: "restyled portrait",
      model: IMG2IMG_MODELS[0],
      denoise: 0.55,
      steps: 4,
      cfg: 1,
      seed: 42,
      batchCount: 3,
      randomRanges: {
        denoise: { min: 0.4, max: 0.6 },
        steps: { min: 3, max: 5 },
        cfg: { min: 0.5, max: 1.5 },
        seed: { min: 100, max: 102 },
      },
    });
    assert.equal(queued.status, "queued");
    assert.equal(queued.batchCount, 3);
    assert.equal(queued.items.length, 3);
    let job = queued;
    for (let count = 0; count < 1000 && !["completed", "failed", "partial"].includes(job.status); count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      job = await controller.getJob(queued.id);
    }
    assert.equal(job.status, "completed", job.error);
    assert.equal(job.completedCount, 3);
    assert.equal(job.failedCount, 0);
    assert.deepEqual(job.items[0].parameters, { denoise: 0.55, steps: 4, cfg: 1, seed: 0 });
    assert.deepEqual(job.items[1].parameters, { denoise: 0.4, steps: 3, cfg: 0.5, seed: 2147483647 });
    assert.deepEqual(job.items[2].parameters, { denoise: 0.6, steps: 5, cfg: 1.5, seed: 2147483647 });
    assert.equal(submitted[0]["6"].inputs.seed, 0);
    assert.equal(submitted[1]["6"].inputs.seed, 2147483647);
    assert.equal(submitted[2]["6"].inputs.seed, 2147483647);
    assert.notEqual(job.items[0].output.name, job.items[1].output.name);
    assert.notEqual(job.items[1].output.name, job.items[2].output.name);

    const restarted = createImg2ImgController({ inputRoot, outputRoot, storeRoot, fetchImpl: async () => { throw new Error("ComfyUI should not be queried for persisted detail"); } });
    const persisted = await restarted.getJob(queued.id);
    assert.equal(persisted.status, "completed");
    assert.equal(persisted.items[2].parameters.seed, 2147483647);
    assert.equal((await restarted.listJobs()).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("batch controller records partial failures and continues with later items", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-img2img-partial-"));
  const inputRoot = path.join(root, "input");
  const outputRoot = path.join(root, "output");
  const storeRoot = path.join(root, "records");
  await mkdir(inputRoot, { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  await writeFile(path.join(inputRoot, "source.png"), Buffer.from([137, 80, 78, 71]));
  let promptCount = 0;
  const fetchImpl = async (url) => {
    const endpoint = String(url).replace("http://partial-comfy", "");
    if (endpoint === "/system_stats") return new Response("{}");
    if (endpoint === "/object_info") return new Response(JSON.stringify(requiredObjectInfo));
    if (endpoint === "/upload/image") return new Response(JSON.stringify({ name: "partial-source.png", subfolder: "h3-studio-img2img", type: "input" }));
    if (endpoint === "/prompt") {
      promptCount += 1;
      if (promptCount === 2) throw new Error("simulated second image failure");
      return new Response(JSON.stringify({ prompt_id: `partial-prompt-${promptCount}` }));
    }
    if (endpoint.startsWith("/history/partial-prompt-")) {
      const index = Number(endpoint.slice("/history/partial-prompt-".length));
      return new Response(JSON.stringify({
        [`partial-prompt-${index}`]: {
          status: { status_str: "success", completed: true },
          outputs: { "8": { images: [{ filename: `partial-${index}.png`, subfolder: "img2img", type: "output" }] } },
        },
      }));
    }
    if (endpoint.startsWith("/view?")) return new Response(Buffer.from([137, 80, 78, 71, 13, 10]));
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };
  try {
    const controller = createImg2ImgController({
      comfyUrl: "http://partial-comfy",
      remote: true,
      inputRoot,
      outputRoot,
      storeRoot,
      fetchImpl,
      pollIntervalMs: 1,
      idFactory: (() => { const ids = ["partial-job-1", "partial-retry-1"]; return () => ids.shift(); })(),
      toAsset: async (_root, name) => ({ root: "output", name, kind: "image" }),
    });
    const queued = await controller.enqueue({ sourceName: "source.png", prompt: "restyled", batchCount: 3 });
    let job = queued;
    for (let count = 0; count < 1000 && !["completed", "failed", "partial"].includes(job.status); count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      job = await controller.getJob(queued.id);
    }
    assert.equal(job.status, "partial");
    assert.equal(job.completedCount, 2);
    assert.equal(job.failedCount, 1);
    assert.equal(job.items[1].status, "failed");
    assert.match(job.items[1].error, /simulated second image failure/);
    assert.equal(job.items[2].status, "completed");
    assert.equal(promptCount, 3);
    const preservedFirstOutput = job.items[0].output.name;
    const preservedThirdOutput = job.items[2].output.name;
    const persisted = await createImg2ImgController({ inputRoot, outputRoot, storeRoot, fetchImpl }).getJob(queued.id);
    assert.equal(persisted.status, "partial");
    assert.equal(persisted.failedCount, 1);
    const retryResponse = apiResponse();
    await controller.handleRoute({ method: "POST", url: `/api/img2img/jobs/${queued.id}/retry` }, retryResponse, { readJson: async () => ({}) });
    assert.equal(retryResponse.status, 201);
    const retry = retryResponse.body.job;
    assert.equal(retry.retryOf, queued.id);
    assert.equal(retry.attempt, 2);
    assert.equal(retry.completedCount, 2);
    let retried = retry;
    for (let count = 0; count < 1000 && !["completed", "failed", "partial"].includes(retried.status); count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      retried = await controller.getJob(retry.id);
    }
    assert.equal(retried.status, "completed", retried.error);
    assert.equal(retried.completedCount, 3);
    assert.equal(retried.failedCount, 0);
    assert.equal(promptCount, 4, "retry should only submit the previously failed item");
    assert.equal(retried.items[0].output.name, preservedFirstOutput);
    assert.equal(retried.items[2].output.name, preservedThirdOutput);
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("batch request rejects invalid count and unaligned random ranges", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-img2img-range-"));
  const inputRoot = path.join(root, "input");
  const outputRoot = path.join(root, "output");
  await mkdir(inputRoot, { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  await writeFile(path.join(inputRoot, "source.png"), Buffer.from([137, 80, 78, 71]));
  try {
    const controller = createImg2ImgController({ inputRoot, outputRoot, storeRoot: path.join(root, "records"), fetchImpl: async () => { throw new Error("not reached"); } });
    await assert.rejects(
      () => controller.enqueue({ sourceName: "source.png", prompt: "restyled", batchCount: 21 }),
      (error) => error?.status === 400 && error?.code === "BATCH_COUNT_INVALID",
    );
    await assert.rejects(
      () => controller.enqueue({ sourceName: "source.png", prompt: "restyled", randomRanges: { denoise: { min: 0.011, max: 0.5 } } }),
      (error) => error?.status === 400 && error?.code === "RANDOM_RANGE_INVALID",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restart recovers queued and running jobs without ghost state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-img2img-recovery-"));
  const inputRoot = path.join(root, "input");
  const outputRoot = path.join(root, "output");
  const storeRoot = path.join(root, "records");
  await mkdir(inputRoot, { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  await writeFile(path.join(inputRoot, "source.png"), Buffer.from([137, 80, 78, 71]));
  const store = createImg2ImgStore({ root: storeRoot });
  const base = {
    sourceName: "source.png",
    sourceRoot: "input",
    prompt: "restart recovery",
    negativePrompt: "",
    model: IMG2IMG_MODELS[0],
    denoise: 0.65,
    steps: 4,
    cfg: 1,
    seed: 11,
    batchCount: 2,
    randomRanges: { denoise: { min: 0.65, max: 0.65 }, steps: { min: 4, max: 4 }, cfg: { min: 1, max: 1 } },
    completedCount: 1,
    failedCount: 0,
    items: [
      { index: 0, status: "completed", parameters: { denoise: 0.65, steps: 4, cfg: 1, seed: 11 }, output: { root: "output", name: "img2img/kept.png", kind: "image" }, progress: 100, stage: "Completed", startedAt: "2026-08-12T03:00:00.000Z", completedAt: "2026-08-12T03:01:00.000Z" },
      { index: 1, status: "running", parameters: { denoise: 0.65, steps: 4, cfg: 1, seed: 12 }, output: null, progress: 30, stage: "Generating image", startedAt: "2026-08-12T03:01:00.000Z", completedAt: null },
    ],
    createdAt: "2026-08-12T03:00:00.000Z",
    startedAt: "2026-08-12T03:00:00.000Z",
    completedAt: null,
    status: "running",
  };
  await store.save({ ...base, id: "running-recovery" });
  await store.save({ ...base, id: "queued-recovery", status: "queued", items: base.items.map((item) => ({ ...item, status: "queued", output: null, progress: 0, stage: "Queued" })), completedCount: 0 });
  const controller = createImg2ImgController({ inputRoot, outputRoot, storeRoot, store, fetchImpl: async () => { throw new Error("queued recovery is intentionally not executed in this fixture"); } });
  const running = await controller.getJob("running-recovery");
  assert.equal(running.status, "interrupted");
  assert.equal(running.recoverable, true);
  assert.equal(running.recovery.reason, "bridge_restart");
  assert.equal(running.completedCount, 1);
  assert.equal(running.items[0].output.name, "img2img/kept.png");
  let queued = await controller.getJob("queued-recovery");
  for (let count = 0; count < 100 && queued.status === "queued"; count += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    queued = await controller.getJob("queued-recovery");
  }
  assert.notEqual(queued.status, "queued");
  for (let count = 0; count < 100 && controller.active(); count += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  await rm(root, { recursive: true, force: true });
});

test("publishes native ComfyUI node and sampler progress while history is pending", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-img2img-websocket-"));
  const inputRoot = path.join(root, "input");
  const outputRoot = path.join(root, "output");
  await mkdir(inputRoot, { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  await writeFile(path.join(inputRoot, "source.png"), Buffer.from([137, 80, 78, 71]));
  FakeComfyWebSocket.instances = [];
  let historyReady = false;
  let postedClientId = "";
  const fetchImpl = async (url, init = {}) => {
    const endpoint = String(url).replace("http://ws-comfy", "");
    if (endpoint === "/system_stats") return response({});
    if (endpoint === "/object_info") return response(requiredObjectInfo);
    if (endpoint === "/prompt") {
      const payload = JSON.parse(init.body || "{}");
      postedClientId = payload.client_id;
      setTimeout(() => {
        const socket = FakeComfyWebSocket.instances.at(-1);
        socket?.emit("open");
        const emit = (type, data) => socket?.emit("message", JSON.stringify({ type, data }));
        emit("execution_start", { prompt_id: "ws-prompt-1" });
        emit("executing", { prompt_id: "ws-prompt-1", node: "6", display_node: "6" });
        emit("progress", { prompt_id: "ws-prompt-1", node: "6", value: 4, max: 4 });
      }, 0);
      return response({ prompt_id: "ws-prompt-1" });
    }
    if (endpoint === "/history/ws-prompt-1") {
      if (!historyReady) return response({});
      await mkdir(path.join(outputRoot, "img2img"), { recursive: true });
      await writeFile(path.join(outputRoot, "img2img", "ws-result.png"), Buffer.from([137, 80, 78, 71]));
      return response({
        "ws-prompt-1": {
          status: { status_str: "success", completed: true },
          outputs: { "8": { images: [{ filename: "ws-result.png", subfolder: "img2img", type: "output" }] } },
        },
      });
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };
  const controller = createImg2ImgController({
    comfyUrl: "http://ws-comfy",
    inputRoot,
    outputRoot,
    storeRoot: path.join(root, "records"),
    fetchImpl,
    webSocketImpl: FakeComfyWebSocket,
    pollIntervalMs: 10,
    idFactory: () => "websocket-job",
    clientId: "test-img2img",
  });
  try {
    const queued = await controller.enqueue({ sourceName: "source.png", prompt: "native progress" });
    let running = await controller.getJob(queued.id);
    for (let count = 0; count < 100 && running.nativeCurrent !== 4; count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      running = await controller.getJob(queued.id);
    }
    assert.equal(running.status, "running", running.error || running.stage);
    assert.equal(running.progressSource, "native");
    assert.equal(running.nativeCurrent, 4);
    assert.equal(running.nativeMaximum, 4);
    assert.equal(running.comfyNode, "KSampler");
    assert.match(running.stage, /KSampler.*4\/4/);
    assert.match(postedClientId, /^test-img2img-/);
    assert.equal(FakeComfyWebSocket.instances[0].url, `ws://ws-comfy/ws?clientId=${postedClientId}`);
    historyReady = true;
    let completed = await controller.getJob(queued.id);
    for (let count = 0; count < 100 && completed.status === "running"; count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      completed = await controller.getJob(queued.id);
    }
    assert.equal(completed.status, "completed");
    assert.equal(FakeComfyWebSocket.instances[0].closed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("classifies a matching ComfyUI execution_error without waiting for history timeout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-img2img-websocket-error-"));
  const inputRoot = path.join(root, "input");
  const outputRoot = path.join(root, "output");
  await mkdir(inputRoot, { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  await writeFile(path.join(inputRoot, "source.png"), Buffer.from([137, 80, 78, 71]));
  FakeComfyWebSocket.instances = [];
  const fetchImpl = async (url) => {
    const endpoint = String(url).replace("http://ws-error-comfy", "");
    if (endpoint === "/system_stats") return response({});
    if (endpoint === "/object_info") return response(requiredObjectInfo);
    if (endpoint === "/prompt") {
      setTimeout(() => {
        const socket = FakeComfyWebSocket.instances.at(-1);
        socket?.emit("open");
        const emit = (type, data) => socket?.emit("message", JSON.stringify({ type, data }));
        emit("status", { status: { exec_info: { queue_remaining: 1 } } });
        emit("execution_start", { prompt_id: "ws-error-prompt" });
        emit("executing", { prompt_id: "ws-error-prompt", node: "6", display_node: "6" });
        emit("execution_error", { prompt_id: "ws-error-prompt", node_id: "6", exception_message: "simulated KSampler failure" });
      }, 0);
      return response({ prompt_id: "ws-error-prompt" });
    }
    if (endpoint === "/history/ws-error-prompt") return response({});
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };
  const controller = createImg2ImgController({
    comfyUrl: "http://ws-error-comfy",
    inputRoot,
    outputRoot,
    storeRoot: path.join(root, "records"),
    fetchImpl,
    webSocketImpl: FakeComfyWebSocket,
    pollIntervalMs: 10,
    maxPollMs: 5_000,
    idFactory: () => "websocket-error-job",
  });
  try {
    const queued = await controller.enqueue({ sourceName: "source.png", prompt: "error progress" });
    let failed = await controller.getJob(queued.id);
    for (let count = 0; count < 100 && ["queued", "running"].includes(failed.status); count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      failed = await controller.getJob(queued.id);
    }
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /simulated KSampler failure/);
    assert.equal(FakeComfyWebSocket.instances[0].closed, true);
  } finally {
    for (let count = 0; count < 100 && controller.active(); count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("history timeout cancels the exact ComfyUI prompt and preserves timeout semantics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-img2img-timeout-cancel-"));
  const inputRoot = path.join(root, "input");
  const outputRoot = path.join(root, "output");
  await mkdir(inputRoot, { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  await writeFile(path.join(inputRoot, "source.png"), Buffer.from([137, 80, 78, 71]));
  const cancelRequests = [];
  const fetchImpl = async (url, init = {}) => {
    const endpoint = String(url).replace("http://timeout-cancel-comfy", "");
    if (endpoint === "/system_stats") return response({});
    if (endpoint === "/object_info") return response(requiredObjectInfo);
    if (endpoint === "/prompt") return response({ prompt_id: "timeout-cancel-prompt" });
    if (endpoint === "/history/timeout-cancel-prompt") return response({});
    if (endpoint === "/api/jobs/timeout-cancel-prompt/cancel") {
      cancelRequests.push({ method: init.method, body: init.body });
      return response({ cancelled: true });
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };
  const controller = createImg2ImgController({
    comfyUrl: "http://timeout-cancel-comfy",
    inputRoot,
    outputRoot,
    storeRoot: path.join(root, "records"),
    fetchImpl,
    webSocketImpl: null,
    pollIntervalMs: 1,
    maxPollMs: 5,
    idFactory: () => "timeout-cancel-job",
  });
  try {
    const queued = await controller.enqueue({ sourceName: "source.png", prompt: "timeout" });
    let failed = await controller.getJob(queued.id);
    for (let count = 0; count < 100 && ["queued", "running"].includes(failed.status); count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      failed = await controller.getJob(queued.id);
    }
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /Timed out waiting for the generated image/);
    assert.deepEqual(cancelRequests, [{ method: "POST", body: "{}" }]);
  } finally {
    for (let count = 0; count < 100 && controller.active(); count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("failed targeted timeout cancellation uses only prompt-scoped fallbacks and keeps the timeout error", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-img2img-timeout-fallback-"));
  const inputRoot = path.join(root, "input");
  const outputRoot = path.join(root, "output");
  await mkdir(inputRoot, { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  await writeFile(path.join(inputRoot, "source.png"), Buffer.from([137, 80, 78, 71]));
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const endpoint = String(url).replace("http://timeout-fallback-comfy", "");
    if (endpoint === "/system_stats") return response({});
    if (endpoint === "/object_info") return response(requiredObjectInfo);
    if (endpoint === "/prompt") return response({ prompt_id: "timeout-fallback-prompt" });
    if (endpoint === "/history/timeout-fallback-prompt") return response({});
    if (endpoint === "/api/jobs/timeout-fallback-prompt/cancel") {
      requests.push({ endpoint, method: init.method, body: init.body });
      return response({ error: "unsupported" }, 503);
    }
    if (endpoint === "/queue" || endpoint === "/interrupt") {
      requests.push({ endpoint, method: init.method, body: init.body });
      return response({});
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };
  const controller = createImg2ImgController({
    comfyUrl: "http://timeout-fallback-comfy",
    inputRoot,
    outputRoot,
    storeRoot: path.join(root, "records"),
    fetchImpl,
    webSocketImpl: null,
    pollIntervalMs: 1,
    maxPollMs: 5,
    idFactory: () => "timeout-fallback-job",
  });
  try {
    const queued = await controller.enqueue({ sourceName: "source.png", prompt: "timeout fallback" });
    let failed = await controller.getJob(queued.id);
    for (let count = 0; count < 100 && ["queued", "running"].includes(failed.status); count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      failed = await controller.getJob(queued.id);
    }
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /Timed out waiting for the generated image/);
    assert.deepEqual(requests, [
      { endpoint: "/api/jobs/timeout-fallback-prompt/cancel", method: "POST", body: "{}" },
      { endpoint: "/queue", method: "POST", body: JSON.stringify({ delete: ["timeout-fallback-prompt"] }) },
      { endpoint: "/interrupt", method: "POST", body: JSON.stringify({ prompt_id: "timeout-fallback-prompt" }) },
    ]);
  } finally {
    for (let count = 0; count < 100 && controller.active(); count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("active manual cancellation uses the targeted ComfyUI cancel endpoint", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-img2img-manual-cancel-targeted-"));
  const inputRoot = path.join(root, "input");
  const outputRoot = path.join(root, "output");
  await mkdir(inputRoot, { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  await writeFile(path.join(inputRoot, "source.png"), Buffer.from([137, 80, 78, 71]));
  let promptSubmitted;
  const promptReady = new Promise((resolve) => { promptSubmitted = resolve; });
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const endpoint = String(url).replace("http://manual-cancel-comfy", "");
    if (endpoint === "/system_stats") return response({});
    if (endpoint === "/object_info") return response(requiredObjectInfo);
    if (endpoint === "/prompt") {
      promptSubmitted();
      return response({ prompt_id: "manual-cancel-prompt" });
    }
    if (endpoint === "/history/manual-cancel-prompt") return response({});
    if (endpoint === "/api/jobs/manual-cancel-prompt/cancel") {
      requests.push({ endpoint, method: init.method, body: init.body });
      return response({ cancelled: true });
    }
    if (endpoint === "/interrupt" || endpoint === "/queue") {
      requests.push({ endpoint, method: init.method, body: init.body });
      return response({});
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };
  const controller = createImg2ImgController({
    comfyUrl: "http://manual-cancel-comfy",
    inputRoot,
    outputRoot,
    storeRoot: path.join(root, "records"),
    fetchImpl,
    webSocketImpl: null,
    pollIntervalMs: 1,
    maxPollMs: 30_000,
    idFactory: () => "manual-cancel-job",
  });
  try {
    const queued = await controller.enqueue({ sourceName: "source.png", prompt: "manual cancel" });
    await promptReady;
    const cancelResponse = apiResponse();
    await controller.handleRoute({ method: "POST", url: `/api/img2img/jobs/${queued.id}/cancel` }, cancelResponse, {
      readJson: async () => ({ reason: "stop active" }),
    });
    assert.equal(cancelResponse.status, 200);
    let cancelled = await controller.getJob(queued.id);
    for (let count = 0; count < 100 && cancelled.status !== "cancelled"; count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      cancelled = await controller.getJob(queued.id);
    }
    assert.equal(cancelled.status, "cancelled");
    assert.deepEqual(requests, [{ endpoint: "/api/jobs/manual-cancel-prompt/cancel", method: "POST", body: "{}" }]);
  } finally {
    for (let count = 0; count < 100 && controller.active(); count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("queued cancellation is durable and does not submit a ComfyUI prompt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-img2img-cancel-queue-"));
  const inputRoot = path.join(root, "input");
  const outputRoot = path.join(root, "output");
  await mkdir(inputRoot, { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  await writeFile(path.join(inputRoot, "source.png"), Buffer.from([137, 80, 78, 71]));
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const beforeRunStarted = new Promise((resolve) => { started = resolve; });
  let beforeRunCount = 0;
  let promptCount = 0;
  const fetchImpl = async (url) => {
    const endpoint = String(url).replace("http://cancel-comfy", "");
    if (endpoint === "/system_stats") return response({});
    if (endpoint === "/object_info") return response(requiredObjectInfo);
    if (endpoint === "/prompt") {
      promptCount += 1;
      return response({ prompt_id: `cancel-prompt-${promptCount}` });
    }
    if (endpoint.startsWith("/history/")) return response({});
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };
  const controller = createImg2ImgController({
    comfyUrl: "http://cancel-comfy",
    inputRoot,
    outputRoot,
    storeRoot: path.join(root, "records"),
    fetchImpl,
    pollIntervalMs: 1,
    idFactory: (() => { const ids = ["active-cancel-job", "queued-cancel-job"]; return () => ids.shift(); })(),
    beforeRun: async () => {
      beforeRunCount += 1;
      if (beforeRunCount === 1) {
        started();
        await gate;
      }
    },
  });
  try {
    const active = await controller.enqueue({ sourceName: "source.png", prompt: "active", batchCount: 1 });
    await beforeRunStarted;
    const queued = await controller.enqueue({ sourceName: "source.png", prompt: "queued", batchCount: 1 });
    const queuedCancelResponse = apiResponse();
    await controller.handleRoute({ method: "POST", url: `/api/img2img/jobs/${queued.id}/cancel` }, queuedCancelResponse, {
      readJson: async () => ({ reason: "No longer needed" }),
    });
    const cancelled = queuedCancelResponse.body.job;
    assert.equal(queuedCancelResponse.status, 200);
    assert.equal(cancelled.status, "cancelled");
    assert.equal((await controller.getJob(queued.id)).cancelReason, "No longer needed");
    assert.equal(promptCount, 0);
    const activeCancelResponse = apiResponse();
    await controller.handleRoute({ method: "POST", url: `/api/img2img/jobs/${active.id}/cancel` }, activeCancelResponse, {
      readJson: async () => ({ reason: "stop active" }),
    });
    assert.equal(activeCancelResponse.status, 200);
    release();
    let final = await controller.getJob(active.id);
    for (let count = 0; count < 100 && final.status !== "cancelled"; count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      final = await controller.getJob(active.id);
    }
    assert.equal(final.status, "cancelled");
  } finally {
    release();
    await rm(root, { recursive: true, force: true });
  }
});
