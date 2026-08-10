import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  IMG2IMG_MODELS,
  IMG2IMG_MODEL_PROFILES,
  buildImg2ImgPrompt,
  createImg2ImgController,
  evaluateImg2ImgReadiness,
  normalizeImageAssetName,
  parseImg2ImgHistory,
} from "../server/image-generation/img2img.mjs";

const CHECKPOINT_MODELS = IMG2IMG_MODELS.filter((model) => IMG2IMG_MODEL_PROFILES[model].workflow === "checkpoint");
const WAI_MODEL = "waiIllustriousSDXL_v170.safetensors";
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

const requiredObjectInfo = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [[...CHECKPOINT_MODELS]] } } },
  LoadImage: {},
  VAEEncode: {},
  CLIPTextEncode: {},
  KSampler: {},
  VAEDecode: {},
  SaveImage: {},
};

const currentObjectInfo = {
  ...requiredObjectInfo,
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [{ value: [...CHECKPOINT_MODELS] }, { tooltip: "Checkpoint" }] } } },
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
    assert.equal(job.output.name, "img2img/source-12345678.png");
    assert.deepEqual([...await readFile(path.join(outputRoot, job.output.name))], [137, 80, 78, 71, 13, 10]);
    assert.ok(calls.some((item) => item.startsWith("/view?")));
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
