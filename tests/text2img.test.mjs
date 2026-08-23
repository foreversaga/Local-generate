import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FLUX2_VAE,
  FLUX2_DEV_MODEL,
  FLUX2_DEV_TEXT_ENCODER,
  FLUX2_CLIP_TYPE,
  KREA2_CLIP_TYPE,
  KREA2_TEXT_ENCODER,
  KREA2_TURBO_MODEL,
  KREA2_VAE,
  NATURE_CAMERA_PROFILE,
  NATURE_CAMERA_SYSTEM_PROMPT,
  TEXT2IMG_REQUIRED_NODES,
  buildFlux2DevText2ImgPrompt,
  buildKrea2TurboText2ImgPrompt,
  buildText2ImgPrompt,
  createText2ImgController,
  evaluateText2ImgReadiness,
  normalizeText2ImgDescription,
  normalizeText2ImgInput,
  parseNatureCameraPromptResponse,
  parseText2ImgHistory,
} from "../server/image-generation/text2img.mjs";

const OBJECT_INFO = {
  ...Object.fromEntries(TEXT2IMG_REQUIRED_NODES.map((name) => [name, {}])),
  UNETLoader: { input: { required: { unet_name: [[FLUX2_DEV_MODEL, KREA2_TURBO_MODEL]] } } },
  CLIPLoader: { input: { required: { clip_name: [[FLUX2_DEV_TEXT_ENCODER, KREA2_TEXT_ENCODER]], type: [[FLUX2_CLIP_TYPE, KREA2_CLIP_TYPE]] } } },
  VAELoader: { input: { required: { vae_name: [[FLUX2_VAE, KREA2_VAE]] } } },
};

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(payload); },
  };
}

async function waitForTerminal(controller, id) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = controller.getJob(id);
    if (["completed", "failed"].includes(job?.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for text-to-image test job.");
}

test("builds the eager thirteen-node FLUX.2 Dev graph", () => {
  const graph = buildFlux2DevText2ImgPrompt({
    prompt: "A candid portrait in soft window light",
    width: 768,
    height: 1024,
    steps: 20,
    seed: 42,
  }, { filenamePrefix: "text2img/test" });

  assert.equal(Object.keys(graph).length, 13);
  assert.equal(graph["1"].inputs.unet_name, FLUX2_DEV_MODEL);
  assert.deepEqual(graph["2"].inputs, { clip_name: FLUX2_DEV_TEXT_ENCODER, type: "flux2", device: "default" });
  assert.equal(graph["4"].inputs.text, "A candid portrait in soft window light");
  assert.equal(graph["5"].inputs.guidance, 4);
  assert.deepEqual(graph["6"].inputs.conditioning, ["5", 0]);
  assert.equal(graph["7"].inputs.noise_seed, 42);
  assert.deepEqual(graph["9"].inputs, { steps: 20, width: 768, height: 1024 });
  assert.deepEqual(graph["10"].inputs, { width: 768, height: 1024, batch_size: 1 });
  assert.deepEqual(graph["13"].inputs.images, ["12", 0]);
  assert.equal(Object.values(graph).some((node) => node.class_type === "TorchCompileModel"), false);
  assert.deepEqual(graph["6"].inputs.model, ["1", 0]);
});

test("builds the official FLUX.2 Dev graph with Mistral guidance", () => {
  const graph = buildText2ImgPrompt({
    prompt: "A detailed documentary portrait",
    modelId: "flux2-dev",
    width: 1024,
    height: 1024,
    seed: 77,
  });

  assert.equal(Object.keys(graph).length, 13);
  assert.equal(graph["1"].inputs.unet_name, FLUX2_DEV_MODEL);
  assert.equal(graph["2"].inputs.clip_name, FLUX2_DEV_TEXT_ENCODER);
  assert.deepEqual(graph["5"], { class_type: "FluxGuidance", inputs: { conditioning: ["4", 0], guidance: 4 } });
  assert.deepEqual(graph["6"], { class_type: "BasicGuider", inputs: { model: ["1", 0], conditioning: ["5", 0] } });
  assert.deepEqual(graph["9"].inputs, { steps: 20, width: 1024, height: 1024 });
});

test("builds the Krea 2 Turbo FP8 Scaled workflow with the requested GB10 defaults", () => {
  const graph = buildKrea2TurboText2ImgPrompt({
    prompt: "A candid smartphone portrait",
    width: 1152,
    height: 2048,
    steps: 10,
    seed: 8675309,
  });

  assert.equal(Object.keys(graph).length, 10);
  assert.deepEqual(graph["1"].inputs, { unet_name: KREA2_TURBO_MODEL, weight_dtype: "default" });
  assert.deepEqual(graph["2"].inputs, { clip_name: KREA2_TEXT_ENCODER, type: "krea2", device: "default" });
  assert.equal(graph["3"].inputs.vae_name, KREA2_VAE);
  assert.deepEqual(graph["5"], { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } });
  assert.deepEqual(graph["6"].inputs, { width: 1152, height: 2048, batch_size: 1 });
  assert.equal(graph["7"].inputs.shift, 1.15);
  assert.deepEqual(graph["8"].inputs, {
    model: ["7", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0],
    seed: 8675309, steps: 10, cfg: 1, sampler_name: "er_sde", scheduler: "simple", denoise: 1,
  });
  assert.equal(graph["14"], undefined);
  assert.equal(buildText2ImgPrompt({ prompt: "Krea", modelId: "krea2-turbo" })["1"].inputs.unet_name, KREA2_TURBO_MODEL);
});

test("validates prompt, dimensions, steps, and seed at the workflow boundary", () => {
  assert.deepEqual(normalizeText2ImgInput({ prompt: " portrait " }), {
    prompt: "portrait",
    modelId: "flux2-dev",
    encoderId: "official",
    width: 1024,
    height: 1024,
    steps: 20,
    seed: 12345,
  });
  assert.throws(() => normalizeText2ImgInput({ prompt: "" }), { code: "TEXT2IMG_PROMPT_REQUIRED" });
  assert.throws(() => normalizeText2ImgInput({ prompt: "portrait", width: 777 }), { code: "TEXT2IMG_WIDTH_INVALID" });
  assert.throws(() => normalizeText2ImgInput({ prompt: "portrait", steps: 51 }), { code: "TEXT2IMG_STEPS_INVALID" });
  assert.throws(() => normalizeText2ImgInput({ prompt: "portrait", seed: -1 }), { code: "TEXT2IMG_SEED_INVALID" });
  assert.throws(() => normalizeText2ImgInput({ prompt: "portrait", modelId: "flux2-klein-32b" }), { code: "TEXT2IMG_MODEL_INVALID" });
  assert.throws(() => normalizeText2ImgInput({ prompt: "portrait", modelId: "flux2-klein-4b" }), { code: "TEXT2IMG_MODEL_INVALID" });
  assert.throws(() => normalizeText2ImgInput({ prompt: "portrait", modelId: "flux2-klein-9b" }), { code: "TEXT2IMG_MODEL_INVALID" });
  assert.throws(() => normalizeText2ImgInput({ prompt: "portrait", encoderId: "uncensored" }), { code: "TEXT2IMG_ENCODER_INVALID" });
  assert.equal(normalizeText2ImgInput({ prompt: "portrait", modelId: "flux2-dev" }).steps, 20);
  assert.equal(normalizeText2ImgInput({ prompt: "portrait", modelId: "krea2-turbo", width: 2048, height: 2048 }).steps, 8);
  assert.throws(() => normalizeText2ImgInput({ prompt: "portrait", modelId: "krea2-turbo", width: 2064 }), { code: "TEXT2IMG_WIDTH_INVALID" });
});

test("builds a bounded nature-camera description contract for realistic adult photography", () => {
  assert.equal(normalizeText2ImgDescription({ description: "  成人在窗邊喝咖啡  " }), "成人在窗邊喝咖啡");
  assert.throws(() => normalizeText2ImgDescription({ description: "" }), { code: "TEXT2IMG_DESCRIPTION_REQUIRED" });
  assert.match(NATURE_CAMERA_SYSTEM_PROMPT, /adults/);
  assert.match(NATURE_CAMERA_SYSTEM_PROMPT, /35–50mm/);
  assert.match(NATURE_CAMERA_SYSTEM_PROMPT, /anatomically correct hands/);
  assert.match(NATURE_CAMERA_SYSTEM_PROMPT, /plastic skin/);
  assert.equal(NATURE_CAMERA_PROFILE, "nature-camera-v1");
  assert.equal(parseNatureCameraPromptResponse('```json\n{"prompt":"自然窗光下的成人紀實人像"}\n```'), "自然窗光下的成人紀實人像");
  assert.throws(() => parseNatureCameraPromptResponse('{"prompt":""}'), { code: "TEXT2IMG_OLLAMA_EMPTY_PROMPT" });
});

test("uses an installed Ollama model to turn a short description into a photographic prompt", async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "h3-text2img-prompt-"));
  const calls = [];
  const installedModel = "local-photography-model";
  const fetchImpl = async (url) => {
    const target = new URL(url);
    if (target.host === "ollama.test:11434" && target.pathname === "/api/tags") {
      return response({ models: [{ name: installedModel }] });
    }
    return response({}, 404);
  };
  const ollamaCoordinator = {
    async generate(input) {
      calls.push(input);
      return { payload: { response: JSON.stringify({ prompt: "一張由朋友以手機主鏡頭隨手拍下的成人生活人像，自然窗光與真實膚質" }) } };
    },
  };
  try {
    const controller = createText2ImgController({
      comfyUrl: "http://comfy.test:8188",
      ollamaUrl: "http://ollama.test:11434",
      outputRoot,
      fetchImpl,
      ollamaCoordinator,
      preferredOllamaModel: "missing-default",
    });
    const result = await controller.generatePhotographicPrompt({ description: "成年女性在窗邊喝咖啡" });
    assert.equal(result.model, installedModel);
    assert.equal(result.profile, NATURE_CAMERA_PROFILE);
    assert.equal(result.unloadPromptModel, false);
    assert.match(result.prompt, /手機主鏡頭/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, installedModel);
    assert.equal(calls[0].body.system, NATURE_CAMERA_SYSTEM_PROMPT);
    assert.match(calls[0].body.prompt, /成年女性在窗邊喝咖啡/);
    assert.equal(calls[0].unloadAfter, false);

    const unloaded = await controller.generatePhotographicPrompt({ description: "成人街頭攝影", unloadPromptModel: true });
    assert.equal(unloaded.unloadPromptModel, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].unloadAfter, true);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("reports exact FLUX and Krea model and node readiness", () => {
  const ready = evaluateText2ImgReadiness(OBJECT_INFO);
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.models, { diffusion: true, textEncoder: true, clipType: true, vae: true });
  assert.deepEqual(Object.keys(ready.profiles), ["flux2-dev", "krea2-turbo"]);
  assert.equal(ready.profiles["flux2-dev"].ready, true);
  assert.equal(ready.profiles["flux2-dev"].commercial, false);
  assert.equal(ready.profiles["flux2-dev"].encoders.official.label, "Mistral 3 Small · BF16");
  assert.equal(ready.profiles["krea2-turbo"].ready, true);
  assert.equal(ready.profiles["krea2-turbo"].encoders.official.label, "Qwen3-VL 4B · FP8 Scaled");
  assert.equal(evaluateText2ImgReadiness(OBJECT_INFO, { modelId: "krea2-turbo" }).ready, true);
  const missing = structuredClone(OBJECT_INFO);
  missing.UNETLoader.input.required.unet_name = [["another-model.safetensors"]];
  assert.equal(evaluateText2ImgReadiness(missing).reason, "MODEL_OR_COMPANION_MISSING");
  assert.equal(evaluateText2ImgReadiness(OBJECT_INFO, { remote: true }).reason, "LOCAL_ONLY_MODEL");
});

test("parses the SaveImage artifact from ComfyUI history", () => {
  const parsed = parseText2ImgHistory({
    prompt: {
      status: { completed: true, status_str: "success" },
      outputs: { "13": { images: [{ filename: "result.png", subfolder: "text2img", type: "output" }] } },
    },
  }, "prompt");
  assert.equal(parsed.state, "completed");
  assert.equal(parsed.artifact.relativeName, "text2img/result.png");
});

test("queues the graph, waits for ComfyUI, and registers the local output", async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "h3-text2img-"));
  const outputFolder = path.join(outputRoot, "text2img");
  await mkdir(outputFolder, { recursive: true });
  await writeFile(path.join(outputFolder, "result.png"), "image");
  let submittedGraph = null;
  const fetchImpl = async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/object_info") return response(OBJECT_INFO);
    if (pathname === "/prompt") {
      submittedGraph = JSON.parse(init.body).prompt;
      return response({ prompt_id: "prompt-1" });
    }
    if (pathname === "/history/prompt-1") {
      return response({
        "prompt-1": {
          status: { completed: true, status_str: "success" },
          outputs: { "13": { images: [{ filename: "result.png", subfolder: "text2img", type: "output" }] } },
        },
      });
    }
    return response({ error: "not found" }, 404);
  };
  try {
    const controller = createText2ImgController({
      outputRoot,
      fetchImpl,
      pollIntervalMs: 1,
      maxPollMs: 1_000,
      idFactory: () => "job-123",
      toAsset: async (root, name) => ({ root, name, kind: "image", url: `/media?root=${root}&name=${encodeURIComponent(name)}` }),
    });
    const queued = await controller.enqueue({ prompt: "portrait", seed: 7 });
    assert.equal(queued.status, "queued");
    assert.equal(queued.modelId, "flux2-dev");
    assert.equal(queued.encoderId, "official");
    assert.equal(queued.license, "FLUX Non-Commercial License");
    const completed = await waitForTerminal(controller, queued.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.output.name, "text2img/result.png");
    assert.equal(submittedGraph["1"].inputs.unet_name, FLUX2_DEV_MODEL);
    assert.equal(submittedGraph["7"].inputs.noise_seed, 7);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});
