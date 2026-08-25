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
  assert.equal(NATURE_CAMERA_PROFILE, "nature-camera-v2-anatomy");
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

async function invokeText2ImgRoute(controller, url) {
  const result = { status: 0, body: null };
  await controller.handleRoute({ method: "GET", url }, {}, {
    pathname: new URL(url, "http://localhost").pathname,
    sendJson(_res, status, body) { result.status = status; result.body = body; },
    sendError(_res, status, message, code) { result.status = status; result.body = { error: message, code }; },
  });
  return result;
}
