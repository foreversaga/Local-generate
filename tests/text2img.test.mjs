import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FLUX2_CLIP_TYPE,
  FLUX2_KLEIN_9B_MODEL,
  FLUX2_KLEIN_9B_TEXT_ENCODER,
  FLUX2_KLEIN_9B_VAE,
  FLUX2_KLEIN_9B_LORAS,
  NATURE_CAMERA_ANATOMY_CLAUSE,
  NATURE_CAMERA_PROFILE,
  NATURE_CAMERA_SYSTEM_PROMPT,
  TEXT2IMG_REQUIRED_NODES,
  buildFlux2Klein9BText2ImgPrompt,
  buildText2ImgPrompt,
  createText2ImgController,
  evaluateText2ImgReadiness,
  normalizeText2ImgDescription,
  normalizeText2ImgInput,
  parseNatureCameraPromptResponse,
  parseText2ImgHistory,
} from "../server/image-generation/text2img.mjs";
import { createText2ImgStore } from "../server/image-generation/text2img-store.mjs";
import { createText2ImgBatchStore } from "../server/image-generation/text2img-batch-store.mjs";
import { randomizePersonPhotoRecipes } from "../server/image-generation/person-photo-randomizer.mjs";

const OBJECT_INFO = {
  ...Object.fromEntries(TEXT2IMG_REQUIRED_NODES.map((name) => [name, {}])),
  UNETLoader: { input: { required: { unet_name: [[FLUX2_KLEIN_9B_MODEL]] } } },
  CLIPLoader: { input: { required: { clip_name: [[FLUX2_KLEIN_9B_TEXT_ENCODER]], type: [[FLUX2_CLIP_TYPE]] } } },
  VAELoader: { input: { required: { vae_name: [[FLUX2_KLEIN_9B_VAE]] } } },
  LoraLoaderModelOnly: { input: { required: { lora_name: [FLUX2_KLEIN_9B_LORAS.map((lora) => lora.filename)] } } },
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

test("builds the official FLUX.2 Klein 9B distilled graph", () => {
  const graph = buildFlux2Klein9BText2ImgPrompt({
    prompt: "A vintage motorcycle outside a diner",
    width: 1024,
    height: 1024,
    cfg: 1,
    seed: 88,
  });

  assert.equal(Object.keys(graph).length, 13);
  assert.equal(graph["1"].inputs.unet_name, FLUX2_KLEIN_9B_MODEL);
  assert.deepEqual(graph["2"].inputs, { clip_name: FLUX2_KLEIN_9B_TEXT_ENCODER, type: "flux2", device: "default" });
  assert.equal(graph["3"].inputs.vae_name, FLUX2_KLEIN_9B_VAE);
  assert.deepEqual(graph["5"], { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["2", 0] } });
  assert.deepEqual(graph["6"], { class_type: "CFGGuider", inputs: { model: ["1", 0], positive: ["4", 0], negative: ["5", 0], cfg: 1 } });
  assert.deepEqual(graph["9"].inputs, { steps: 12, width: 1024, height: 1024 });
  assert.equal(buildText2ImgPrompt({ prompt: "Klein", modelId: "flux2-klein-9b" })["1"].inputs.unet_name, FLUX2_KLEIN_9B_MODEL);
});

test("chains selected Klein 9B LoRAs into the model input", () => {
  const graph = buildFlux2Klein9BText2ImgPrompt({
    prompt: "Restore this portrait",
    modelId: "flux2-klein-9b",
    loras: [
      { id: "consistency-v2", strength: 0.8 },
      { id: "ultrareal-v4", strength: 0.55 },
    ],
  });
  assert.deepEqual(graph["14"], { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: FLUX2_KLEIN_9B_LORAS[0].filename, strength_model: 0.8 } });
  assert.deepEqual(graph["15"], { class_type: "LoraLoaderModelOnly", inputs: { model: ["14", 0], lora_name: FLUX2_KLEIN_9B_LORAS[2].filename, strength_model: 0.55 } });
  assert.deepEqual(graph["6"].inputs.model, ["15", 0]);
});

test("validates prompt, dimensions, steps, and seed at the workflow boundary", () => {
  assert.deepEqual(normalizeText2ImgInput({ prompt: " portrait " }), {
    prompt: "portrait",
    modelId: "flux2-klein-9b",
    encoderId: "official",
    width: 1024,
    height: 1024,
    steps: 12,
    cfg: 1,
    seed: 12345,
    loras: [],
  });
  assert.throws(() => normalizeText2ImgInput({ prompt: "" }), { code: "TEXT2IMG_PROMPT_REQUIRED" });
  assert.throws(() => normalizeText2ImgInput({ prompt: "portrait", width: 777 }), { code: "TEXT2IMG_WIDTH_INVALID" });
  assert.throws(() => normalizeText2ImgInput({ prompt: "portrait", steps: 51 }), { code: "TEXT2IMG_STEPS_INVALID" });
  assert.throws(() => normalizeText2ImgInput({ prompt: "portrait", cfg: 0.9 }), { code: "TEXT2IMG_CFG_INVALID" });
  assert.throws(() => normalizeText2ImgInput({ prompt: "portrait", cfg: 8.1 }), { code: "TEXT2IMG_CFG_INVALID" });
  assert.throws(() => normalizeText2ImgInput({ prompt: "portrait", cfg: 4.05 }), { code: "TEXT2IMG_CFG_INVALID" });
  assert.throws(() => normalizeText2ImgInput({ prompt: "portrait", seed: -1 }), { code: "TEXT2IMG_SEED_INVALID" });
  assert.throws(() => normalizeText2ImgInput({ prompt: "portrait", modelId: "flux2-klein-32b" }), { code: "TEXT2IMG_MODEL_INVALID" });
  assert.throws(() => normalizeText2ImgInput({ prompt: "portrait", modelId: "flux2-klein-4b" }), { code: "TEXT2IMG_MODEL_INVALID" });
  assert.throws(() => normalizeText2ImgInput({ prompt: "portrait", modelId: "krea2-turbo" }), { code: "TEXT2IMG_MODEL_INVALID" });
  assert.throws(() => normalizeText2ImgInput({ prompt: "portrait", modelId: "flux2-dev" }), { code: "TEXT2IMG_MODEL_INVALID" });
  assert.throws(() => buildText2ImgPrompt({ prompt: "portrait", modelId: "krea2-turbo" }), { code: "TEXT2IMG_MODEL_INVALID" });
  assert.throws(() => normalizeText2ImgInput({ prompt: "portrait", encoderId: "uncensored" }), { code: "TEXT2IMG_ENCODER_INVALID" });
  assert.throws(() => normalizeText2ImgInput({ prompt: "portrait", modelId: "flux2-klein-9b", loras: [{ id: "base-version", strength: 0.8 }] }), { code: "TEXT2IMG_LORA_INVALID" });
  assert.equal(normalizeText2ImgInput({ prompt: "portrait", modelId: "flux2-klein-9b" }).cfg, 1);
  assert.equal(normalizeText2ImgInput({ prompt: "portrait", modelId: "flux2-klein-9b" }).steps, 12);
});

test("builds a bounded nature-camera description contract for realistic adult photography", () => {
  assert.equal(normalizeText2ImgDescription({ description: "  成人在窗邊喝咖啡  " }), "成人在窗邊喝咖啡");
  assert.throws(() => normalizeText2ImgDescription({ description: "" }), { code: "TEXT2IMG_DESCRIPTION_REQUIRED" });
  assert.match(NATURE_CAMERA_SYSTEM_PROMPT, /adults/);
  assert.match(NATURE_CAMERA_SYSTEM_PROMPT, /35–50mm/);
  assert.match(NATURE_CAMERA_SYSTEM_PROMPT, /anatomically correct hands/);
  assert.match(NATURE_CAMERA_SYSTEM_PROMPT, /normal number of arms and legs/);
  assert.match(NATURE_CAMERA_SYSTEM_PROMPT, /five fingers per visible hand/);
  assert.match(NATURE_CAMERA_SYSTEM_PROMPT, /five toes per visible bare foot/);
  assert.match(NATURE_CAMERA_SYSTEM_PROMPT, /plastic skin/);
  assert.match(NATURE_CAMERA_SYSTEM_PROMPT, /【人物】/);
  assert.match(NATURE_CAMERA_SYSTEM_PROMPT, /【服裝】/);
  assert.match(NATURE_CAMERA_SYSTEM_PROMPT, /one blank line between blocks/);
  assert.equal(NATURE_CAMERA_PROFILE, "nature-camera-v3-reference-pose");
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
      preferredOllamaModel: installedModel,
      storeRoot: path.join(outputRoot, "jobs"),
    });
    const result = await controller.generatePhotographicPrompt({ description: "成年女性在窗邊喝咖啡" });
    assert.equal(result.model, installedModel);
    assert.equal(result.profile, NATURE_CAMERA_PROFILE);
    assert.equal(result.unloadPromptModel, false);
    assert.match(result.prompt, /手機主鏡頭/);
    assert.match(result.prompt, /^【整體畫面】\n/);
    assert.match(result.prompt, /\n\n【肢體完整性】\n/);
    assert.ok(result.prompt.endsWith(NATURE_CAMERA_ANATOMY_CLAUSE));
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

test("reports a missing explicitly selected Ollama Text2Img prompt model", async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "h3-text2img-missing-prompt-model-"));
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/api/tags")) return response({ models: [{ name: "another-installed-model" }] });
    return response({}, 404);
  };
  try {
    const controller = createText2ImgController({
      comfyUrl: "http://comfy.test:8188",
      ollamaUrl: "http://ollama.test:11434",
      outputRoot,
      fetchImpl,
      ollamaCoordinator: { async generate() { throw new Error("not called"); } },
      preferredOllamaModel: "qwen-9b-configured-tag",
      storeRoot: path.join(outputRoot, "jobs"),
    });
    const status = await controller.checkPromptAssistant();
    assert.equal(status.ready, false);
    assert.equal(status.online, true);
    assert.equal(status.provider, "ollama");
    assert.equal(status.model, "qwen-9b-configured-tag");
    assert.equal(status.reason, "OLLAMA_PROMPT_MODEL_MISSING");
    await assert.rejects(
      controller.generatePhotographicPrompt({ description: "成人在窗邊喝咖啡" }),
      (error) => error.code === "OLLAMA_PROMPT_MODEL_MISSING" && /qwen-9b-configured-tag/.test(error.message),
    );
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("reports exact FLUX model and node readiness", () => {
  const ready = evaluateText2ImgReadiness(OBJECT_INFO);
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.models, { diffusion: true, textEncoder: true, clipType: true, vae: true });
  assert.deepEqual(Object.keys(ready.profiles), ["flux2-klein-9b"]);
  assert.equal(ready.profiles["flux2-klein-9b"].ready, true);
  assert.equal(ready.profiles["flux2-klein-9b"].encoders.official.label, "Qwen3 8B · FP8 Mixed");
  assert.equal(evaluateText2ImgReadiness(OBJECT_INFO, { modelId: "flux2-klein-9b" }).ready, true);
  assert.throws(() => evaluateText2ImgReadiness(OBJECT_INFO, { modelId: "krea2-turbo" }), { code: "TEXT2IMG_MODEL_INVALID" });
  const missing = structuredClone(OBJECT_INFO);
  missing.UNETLoader.input.required.unet_name = [["another-model.safetensors"]];
  assert.equal(evaluateText2ImgReadiness(missing).reason, "MODEL_OR_COMPANION_MISSING");
  assert.equal(evaluateText2ImgReadiness(OBJECT_INFO, { remote: true }).reason, "LOCAL_ONLY_MODEL");
});

test("local disable hides Klein 9B readiness without changing prompt support", () => {
  const disabled = evaluateText2ImgReadiness(OBJECT_INFO, { disabled: true });
  assert.equal(disabled.ready, false);
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.reason, "TEXT2IMG_KLEIN_9B_DISABLED");
  assert.deepEqual(disabled.profiles, {});
});

test("local disable rejects image POST before contacting ComfyUI", async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "h3-text2img-disabled-"));
  let comfyObjectInfoCalls = 0;
  try {
    const controller = createText2ImgController({
      outputRoot,
      disableKlein9B: true,
      fetchImpl: async (url) => {
        if (String(url).endsWith("/object_info")) comfyObjectInfoCalls += 1;
        return response({}, 404);
      },
      storeRoot: path.join(outputRoot, "jobs"),
    });
    const result = await invokeText2ImgRoute(controller, "/api/text2img", { method: "POST", body: { prompt: "portrait" } });
    assert.equal(result.status, 503);
    assert.equal(result.body.code, "TEXT2IMG_KLEIN_9B_DISABLED");
    assert.match(result.body.error, /本機未啟用/);
    assert.equal(comfyObjectInfoCalls, 0);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
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
      storeRoot: path.join(outputRoot, "jobs"),
      fetchImpl,
      pollIntervalMs: 1,
      maxPollMs: 1_000,
      idFactory: () => "job-123",
      toAsset: async (root, name) => ({ root, name, kind: "image", url: `/media?root=${root}&name=${encodeURIComponent(name)}` }),
    });
    const queued = await controller.enqueue({ prompt: "portrait", cfg: 5.5, seed: 7 });
    assert.equal(queued.status, "queued");
    assert.equal(queued.modelId, "flux2-klein-9b");
    assert.equal(queued.encoderId, "official");
    assert.equal(queued.license, "FLUX Non-Commercial License");
    assert.equal(queued.cfg, 5.5);
    const completed = await waitForTerminal(controller, queued.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.output.name, "text2img/result.png");
    assert.equal(submittedGraph["1"].inputs.unet_name, FLUX2_KLEIN_9B_MODEL);
    assert.equal(submittedGraph["6"].inputs.cfg, 5.5);
    assert.equal(submittedGraph["7"].inputs.noise_seed, 7);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("persists completed text-to-image jobs and reloads them after controller restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-text2img-persistence-"));
  const outputRoot = path.join(root, "output");
  const storeRoot = path.join(root, "jobs");
  await mkdir(path.join(outputRoot, "text2img"), { recursive: true });
  await writeFile(path.join(outputRoot, "text2img", "persisted.png"), "image");
  const fetchImpl = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/object_info") return response(OBJECT_INFO);
    if (pathname === "/prompt") return response({ prompt_id: "persisted-prompt" });
    if (pathname === "/history/persisted-prompt") return response({
      "persisted-prompt": {
        status: { completed: true, status_str: "success" },
        outputs: { "13": { images: [{ filename: "persisted.png", subfolder: "text2img", type: "output" }] } },
      },
    });
    return response({}, 404);
  };
  try {
    const first = createText2ImgController({ outputRoot, storeRoot, fetchImpl, pollIntervalMs: 1, idFactory: () => "persistent-job" });
    const queued = await first.enqueue({ prompt: "persistent portrait" });
    const completed = await waitForTerminal(first, queued.id);
    assert.equal(completed.status, "completed");

    const second = createText2ImgController({ outputRoot, storeRoot, fetchImpl });
    const payload = await invokeText2ImgRoute(second, "/api/text2img/jobs/persistent-job");
    assert.equal(payload.status, 200);
    assert.equal(payload.body.job.status, "completed");
    assert.equal(payload.body.job.output.name, "text2img/persisted.png");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("server-owned text-to-image batches continue without a browser and restore from disk", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-text2img-batch-"));
  const outputRoot = path.join(root, "output");
  const storeRoot = path.join(root, "jobs");
  const batchStoreRoot = path.join(root, "batches");
  await mkdir(path.join(outputRoot, "text2img"), { recursive: true });
  await Promise.all([1, 2].map((index) => writeFile(path.join(outputRoot, "text2img", `batch-${index}.png`), "image")));
  let id = 0;
  let promptId = 0;
  const fetchImpl = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/object_info") return response(OBJECT_INFO);
    if (pathname === "/prompt") return response({ prompt_id: `batch-prompt-${++promptId}` });
    const history = pathname.match(/^\/history\/batch-prompt-(\d+)$/);
    if (history) {
      const index = Number(history[1]);
      return response({
        [`batch-prompt-${index}`]: {
          status: { completed: true, status_str: "success" },
          outputs: { "13": { images: [{ filename: `batch-${index}.png`, subfolder: "text2img", type: "output" }] } },
        },
      });
    }
    return response({}, 404);
  };
  const promptAssistant = {
    provider: "test",
    async status() { return { online: true, model: "photo-model", models: ["photo-model"] }; },
    async generate() { return JSON.stringify({ prompt: "自然光下的成人生活人像" }); },
  };
  try {
    const randomized = await randomizePersonPhotoRecipes({ seed: 2468, count: 2 });
    const recipes = randomized.recipes.map((recipe, index) => ({ ...recipe, batchId: "recipe-batch", batchIndex: index, batchSize: 2 }));
    const controller = createText2ImgController({
      outputRoot,
      storeRoot,
      batchStoreRoot,
      fetchImpl,
      promptAssistant,
      pollIntervalMs: 1,
      maxPollMs: 1_000,
      idFactory: () => `server-owned-${++id}`,
      toAsset: async (assetRoot, name) => ({ root: assetRoot, name, kind: "image" }),
    });
    const acceptedResponse = await invokeText2ImgRoute(controller, "/api/text2img/batches", { method: "POST", body: {
      clientRequestId: "recipe-batch",
      promptModel: "photo-model",
      modelId: "flux2-klein-9b",
      encoderId: "official",
      steps: 12,
      cfg: 1,
      loras: [],
      items: recipes.map((recipe, index) => ({
        recipe,
        seed: index + 10,
        width: index === 0 ? 1280 : 768,
        height: index === 0 ? 768 : 1280,
      })),
    } });
    assert.equal(acceptedResponse.status, 202);
    const accepted = acceptedResponse.body.batch;
    assert.equal(accepted.status, "queued");
    assert.equal(accepted.total, 2);

    let completed = null;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      completed = await controller.getBatch(accepted.id);
      if (completed.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.prompted, 2);
    assert.equal(completed?.submitted, 2);
    assert.equal(completed?.completed, 2);
    assert.deepEqual(completed?.items.map((item) => [item.job?.width, item.job?.height]), [[1280, 768], [768, 1280]]);
    assert.deepEqual(completed?.items.map((item) => item.job?.seed), [10, 11]);
    assert.deepEqual(completed?.items.map((item) => item.job?.output?.name), ["text2img/batch-1.png", "text2img/batch-2.png"]);
    assert.equal((await createText2ImgBatchStore({ root: batchStoreRoot }).read(accepted.id)).status, "completed");

    const listed = await invokeText2ImgRoute(controller, "/api/text2img/batches?limit=1");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.batches[0].id, accepted.id);
    assert.equal(listed.body.batches[0].items, undefined);

    const restoredController = createText2ImgController({ outputRoot, storeRoot, batchStoreRoot, fetchImpl });
    const restored = await restoredController.getBatch(accepted.id);
    assert.equal(restored.status, "completed");
    assert.equal(restored.items.length, 2);
    assert.equal(restored.items[0].job.status, "completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("batch pipeline starts an image job while a later prompt is still in flight", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-text2img-pipeline-"));
  const outputRoot = path.join(root, "output");
  await mkdir(path.join(outputRoot, "text2img"), { recursive: true });
  await Promise.all([1, 2].map((index) => writeFile(path.join(outputRoot, "text2img", `pipeline-${index}.png`), "image")));
  let promptCall = 0;
  let imageSubmitCount = 0;
  let secondPromptStarted;
  let releaseSecondPrompt;
  let firstImageSubmitted;
  const secondStarted = new Promise((resolve) => { secondPromptStarted = resolve; });
  const releaseSecond = new Promise((resolve) => { releaseSecondPrompt = resolve; });
  const imageSubmitted = new Promise((resolve) => { firstImageSubmitted = resolve; });
  try {
    const randomized = await randomizePersonPhotoRecipes({ seed: 1357, count: 2 });
    const recipes = randomized.recipes.map((recipe, index) => ({ ...recipe, batchId: "pipeline-recipes", batchIndex: index, batchSize: 2 }));
    const controller = createText2ImgController({
      outputRoot,
      storeRoot: path.join(root, "jobs"),
      batchStoreRoot: path.join(root, "batches"),
      pollIntervalMs: 1,
      maxPollMs: 1_000,
      idFactory: (() => { let id = 0; return () => `pipeline-${++id}`; })(),
      promptAssistant: {
        provider: "test",
        async status() {
          return {
            online: true,
            model: "remote-photo-model",
            models: ["remote-photo-model"],
            modelOptions: [{ value: "remote-photo-model", model: "remote-photo-model", provider: "qwen", location: "remote" }],
          };
        },
        async generate() {
          promptCall += 1;
          if (promptCall === 2) {
            secondPromptStarted();
            await releaseSecond;
          }
          return JSON.stringify({ prompt: `自然光成人生活人像 ${promptCall}` });
        },
      },
      fetchImpl: async (url) => {
        const pathname = new URL(url).pathname;
        if (pathname === "/object_info") return response(OBJECT_INFO);
        if (pathname === "/prompt") {
          imageSubmitCount += 1;
          if (imageSubmitCount === 1) firstImageSubmitted();
          return response({ prompt_id: `pipeline-image-${imageSubmitCount}` });
        }
        const history = pathname.match(/^\/history\/pipeline-image-(\d+)$/);
        if (history) {
          const index = Number(history[1]);
          return response({
            [`pipeline-image-${index}`]: {
              status: { completed: true, status_str: "success" },
              outputs: { "13": { images: [{ filename: `pipeline-${index}.png`, subfolder: "text2img", type: "output" }] } },
            },
          });
        }
        return response({}, 404);
      },
    });
    const accepted = await controller.createBatch({
      clientRequestId: "pipeline-recipes",
      promptModel: "remote-photo-model",
      items: recipes.map((recipe, index) => ({ recipe, seed: index + 1 })),
    });
    await secondStarted;
    let pipelineTimeout;
    try {
      await Promise.race([
        imageSubmitted,
        new Promise((_resolve, reject) => { pipelineTimeout = setTimeout(() => reject(new Error("First image did not start while the second prompt was in flight.")), 1_000); }),
      ]);
    } finally {
      clearTimeout(pipelineTimeout);
    }
    assert.equal(imageSubmitCount, 1);
    const overlapping = await controller.getBatch(accepted.id);
    assert.match(overlapping.items[0].job.status, /^(?:running|completed)$/);
    assert.equal(overlapping.items[1].status, "prompting");
    releaseSecondPrompt();
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await controller.getBatch(accepted.id)).status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal((await controller.getBatch(accepted.id)).status, "completed");
  } finally {
    releaseSecondPrompt?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelling a server-owned batch aborts in-flight prompt work and persists cancellation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-text2img-batch-cancel-"));
  let promptStarted;
  const started = new Promise((resolve) => { promptStarted = resolve; });
  try {
    const randomized = await randomizePersonPhotoRecipes({ seed: 8642, count: 1 });
    const recipe = { ...randomized.recipes[0], batchId: "cancel-recipe", batchIndex: 0, batchSize: 1 };
    const controller = createText2ImgController({
      outputRoot: path.join(root, "output"),
      storeRoot: path.join(root, "jobs"),
      batchStoreRoot: path.join(root, "batches"),
      fetchImpl: async (url) => new URL(url).pathname === "/object_info" ? response(OBJECT_INFO) : response({}, 404),
      idFactory: () => "cancel-batch",
      promptAssistant: {
        provider: "test",
        async status() { return { online: true, model: "photo-model", models: ["photo-model"] }; },
        async generate({ signal }) {
          promptStarted();
          await new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
          });
        },
      },
    });
    const accepted = await controller.createBatch({
      clientRequestId: "cancel-recipe",
      promptModel: "photo-model",
      items: [{ recipe, seed: 99 }],
    });
    await started;
    const cancelled = await controller.cancelBatch(accepted.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.cancelled, 1);
    assert.equal(cancelled.items[0].status, "cancelled");
    assert.equal((await createText2ImgBatchStore({ root: path.join(root, "batches") }).read(accepted.id)).status, "cancelled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("turns persisted active text-to-image jobs into viewable interrupted records after restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-text2img-recovery-"));
  const store = createText2ImgStore({ root: path.join(root, "jobs") });
  await store.save({
    id: "interrupted-job",
    status: "running",
    progress: 52,
    stage: "Generating image",
    prompt: "portrait",
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:01:00.000Z",
  });
  try {
    const controller = createText2ImgController({ outputRoot: path.join(root, "output"), store });
    const payload = await invokeText2ImgRoute(controller, "/api/text2img/jobs/interrupted-job");
    assert.equal(payload.status, 200);
    assert.equal(payload.body.job.status, "interrupted");
    assert.equal(payload.body.job.errorCode, "TEXT2IMG_INTERRUPTED");
    assert.equal((await store.read("interrupted-job")).status, "interrupted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function invokeText2ImgRoute(controller, url, { method = "GET", body } = {}) {
  const result = { status: 0, body: null };
  await controller.handleRoute({ method, url }, {}, {
    pathname: new URL(url, "http://localhost").pathname,
    async readJson() { return body; },
    sendJson(_res, status, body) { result.status = status; result.body = body; },
    sendError(_res, status, message, code) { result.status = status; result.body = { error: message, code }; },
  });
  return result;
}
