import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FLUX2_VAE,
  FLUX2_DEV_MODEL,
  FLUX2_DEV_TEXT_ENCODER,
  FLUX_KLEIN_CLIP_TYPE,
  FLUX_KLEIN_9B_MODEL,
  FLUX_KLEIN_9B_TEXT_ENCODER,
  FLUX_KLEIN_9B_UNCENSORED_TEXT_ENCODER,
  FLUX_KLEIN_9B_VAE,
  FLUX_KLEIN_MODEL,
  FLUX_KLEIN_TEXT_ENCODER,
  JUGGERNAUT_XL_MODEL,
  NATURE_CAMERA_PROFILE,
  NATURE_CAMERA_ADULT_SYSTEM_PROMPT,
  NATURE_CAMERA_SYSTEM_PROMPT,
  SDXL_ADULT_LORA,
  TEXT2IMG_REQUIRED_NODES,
  buildFluxKleinText2ImgPrompt,
  buildJuggernautText2ImgPrompt,
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
  UNETLoader: { input: { required: { unet_name: [[FLUX_KLEIN_MODEL, FLUX_KLEIN_9B_MODEL, FLUX2_DEV_MODEL]] } } },
  CLIPLoader: { input: { required: { clip_name: [[FLUX_KLEIN_TEXT_ENCODER, FLUX_KLEIN_9B_TEXT_ENCODER, FLUX_KLEIN_9B_UNCENSORED_TEXT_ENCODER, FLUX2_DEV_TEXT_ENCODER]], type: [[FLUX_KLEIN_CLIP_TYPE]] } } },
  VAELoader: { input: { required: { vae_name: [[FLUX2_VAE, FLUX_KLEIN_9B_VAE]] } } },
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [[JUGGERNAUT_XL_MODEL]] } } },
  LoraLoader: { input: { required: { lora_name: [[SDXL_ADULT_LORA]] } } },
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

test("builds the official thirteen-node FLUX.2 Klein distilled graph", () => {
  const graph = buildFluxKleinText2ImgPrompt({
    prompt: "A candid portrait in soft window light",
    width: 768,
    height: 1024,
    steps: 4,
    seed: 42,
  }, { filenamePrefix: "text2img/test" });

  assert.equal(Object.keys(graph).length, 13);
  assert.equal(graph["1"].inputs.unet_name, FLUX_KLEIN_MODEL);
  assert.deepEqual(graph["2"].inputs, { clip_name: FLUX_KLEIN_TEXT_ENCODER, type: "flux2", device: "default" });
  assert.equal(graph["4"].inputs.text, "A candid portrait in soft window light");
  assert.deepEqual(graph["5"].inputs.conditioning, ["4", 0]);
  assert.equal(graph["6"].inputs.cfg, 1);
  assert.equal(graph["7"].inputs.noise_seed, 42);
  assert.deepEqual(graph["9"].inputs, { steps: 4, width: 768, height: 1024 });
  assert.deepEqual(graph["10"].inputs, { width: 768, height: 1024, batch_size: 1 });
  assert.deepEqual(graph["13"].inputs.images, ["12", 0]);
});

test("selects the installed 9B BF16 model and its companion encoder and VAE", () => {
  const graph = buildFluxKleinText2ImgPrompt({
    prompt: "A natural adult portrait",
    modelId: "flux2-klein-9b",
  });

  assert.equal(graph["1"].inputs.unet_name, FLUX_KLEIN_9B_MODEL);
  assert.equal(graph["2"].inputs.clip_name, FLUX_KLEIN_9B_TEXT_ENCODER);
  assert.equal(graph["3"].inputs.vae_name, FLUX_KLEIN_9B_VAE);
});

test("selects the third-party uncensored BF16 encoder without changing the 9B diffusion model", () => {
  const graph = buildFluxKleinText2ImgPrompt({
    prompt: "A natural adult portrait",
    modelId: "flux2-klein-9b",
    encoderId: "uncensored",
  });
  assert.equal(graph["1"].inputs.unet_name, FLUX_KLEIN_9B_MODEL);
  assert.equal(graph["2"].inputs.clip_name, FLUX_KLEIN_9B_UNCENSORED_TEXT_ENCODER);
  assert.equal(graph["3"].inputs.vae_name, FLUX_KLEIN_9B_VAE);
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

test("builds Juggernaut XL with an optional adult SDXL LoRA", () => {
  const standard = buildJuggernautText2ImgPrompt({ prompt: "A natural adult portrait", steps: 35, seed: 9 });
  assert.equal(standard["1"].inputs.ckpt_name, JUGGERNAUT_XL_MODEL);
  assert.equal(standard["2"], undefined);
  assert.equal(standard["6"].inputs.model[0], "1");
  assert.equal(standard["6"].inputs.cfg, 5);
  assert.equal(standard["6"].inputs.sampler_name, "dpmpp_2m");
  assert.equal(standard["6"].inputs.scheduler, "karras");

  const adult = buildText2ImgPrompt({ prompt: "A tasteful adult portrait", modelId: "juggernaut-xl-v9", adultMode: true, steps: 35 });
  assert.deepEqual(adult["2"].inputs, { model: ["1", 0], clip: ["1", 1], lora_name: SDXL_ADULT_LORA, strength_model: 2, strength_clip: 2 });
  assert.deepEqual(adult["6"].inputs.model, ["2", 0]);
  assert.deepEqual(adult["3"].inputs.clip, ["2", 1]);
});

test("validates prompt, dimensions, steps, and seed at the workflow boundary", () => {
  assert.deepEqual(normalizeText2ImgInput({ prompt: " portrait " }), {
    prompt: "portrait",
    modelId: "flux2-klein-4b",
    encoderId: "official",
    adultMode: false,
    width: 1024,
    height: 1024,
    steps: 4,
    seed: 12345,
  });
  assert.throws(() => normalizeText2ImgInput({ prompt: "" }), { code: "TEXT2IMG_PROMPT_REQUIRED" });
  assert.throws(() => normalizeText2ImgInput({ prompt: "portrait", width: 777 }), { code: "TEXT2IMG_WIDTH_INVALID" });
  assert.throws(() => normalizeText2ImgInput({ prompt: "portrait", steps: 9 }), { code: "TEXT2IMG_STEPS_INVALID" });
  assert.throws(() => normalizeText2ImgInput({ prompt: "portrait", seed: -1 }), { code: "TEXT2IMG_SEED_INVALID" });
  assert.throws(() => normalizeText2ImgInput({ prompt: "portrait", modelId: "flux2-klein-32b" }), { code: "TEXT2IMG_MODEL_INVALID" });
  assert.throws(() => normalizeText2ImgInput({ prompt: "portrait", encoderId: "uncensored" }), { code: "TEXT2IMG_ENCODER_INVALID" });
  assert.equal(normalizeText2ImgInput({ prompt: "portrait", modelId: "juggernaut-xl-v9" }).steps, 35);
  assert.equal(normalizeText2ImgInput({ prompt: "portrait", modelId: "flux2-dev" }).steps, 20);
  assert.equal(normalizeText2ImgInput({ prompt: "portrait", modelId: "juggernaut-xl-v9", adultMode: true }).adultMode, true);
  assert.throws(() => normalizeText2ImgInput({ prompt: "portrait", adultMode: true }), { code: "TEXT2IMG_ADULT_MODE_INVALID" });
});

test("builds a bounded nature-camera description contract for realistic adult photography", () => {
  assert.equal(normalizeText2ImgDescription({ description: "  成人在窗邊喝咖啡  " }), "成人在窗邊喝咖啡");
  assert.throws(() => normalizeText2ImgDescription({ description: "" }), { code: "TEXT2IMG_DESCRIPTION_REQUIRED" });
  assert.match(NATURE_CAMERA_SYSTEM_PROMPT, /adults/);
  assert.match(NATURE_CAMERA_SYSTEM_PROMPT, /35–50mm/);
  assert.match(NATURE_CAMERA_SYSTEM_PROMPT, /anatomically correct hands/);
  assert.match(NATURE_CAMERA_SYSTEM_PROMPT, /plastic skin/);
  assert.match(NATURE_CAMERA_ADULT_SYSTEM_PROMPT, /consensual adult/);
  assert.match(NATURE_CAMERA_ADULT_SYSTEM_PROMPT, /trigger token sexy exactly once/);
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

test("reports exact FLUX model and node readiness", () => {
  const ready = evaluateText2ImgReadiness(OBJECT_INFO);
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.models, { diffusion: true, textEncoder: true, clipType: true, vae: true });
  assert.equal(ready.profiles["flux2-klein-4b"].commercial, true);
  assert.equal(ready.profiles["flux2-klein-9b"].ready, true);
  assert.equal(ready.profiles["flux2-klein-9b"].commercial, false);
  assert.equal(ready.profiles["flux2-klein-9b"].encoders.uncensored.ready, true);
  assert.equal(ready.profiles["flux2-klein-9b"].encoders.uncensored.thirdParty, true);
  assert.equal(ready.profiles["flux2-dev"].ready, true);
  assert.equal(ready.profiles["flux2-dev"].commercial, false);
  assert.equal(ready.profiles["flux2-dev"].encoders.official.label, "Mistral 3 Small · BF16");
  assert.equal(ready.profiles["juggernaut-xl-v9"].ready, true);
  assert.equal(ready.profiles["juggernaut-xl-v9"].adultLora.ready, true);

  const missingLora = structuredClone(OBJECT_INFO);
  missingLora.LoraLoader.input.required.lora_name = [[]];
  assert.equal(evaluateText2ImgReadiness(missingLora, { modelId: "juggernaut-xl-v9" }).ready, true);
  assert.equal(evaluateText2ImgReadiness(missingLora, { modelId: "juggernaut-xl-v9" }).profiles["juggernaut-xl-v9"].adultLora.ready, false);

  const selected9b = evaluateText2ImgReadiness(OBJECT_INFO, { modelId: "flux2-klein-9b" });
  assert.equal(selected9b.modelId, "flux2-klein-9b");
  assert.equal(selected9b.ready, true);

  const uncensored9b = evaluateText2ImgReadiness(OBJECT_INFO, { modelId: "flux2-klein-9b", encoderId: "uncensored" });
  assert.equal(uncensored9b.encoderId, "uncensored");
  assert.equal(uncensored9b.ready, true);

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
    assert.equal(queued.modelId, "flux2-klein-4b");
    assert.equal(queued.encoderId, "official");
    assert.equal(queued.adultMode, false);
    assert.equal(queued.license, "Apache 2.0");
    const completed = await waitForTerminal(controller, queued.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.output.name, "text2img/result.png");
    assert.equal(submittedGraph["1"].inputs.unet_name, FLUX_KLEIN_MODEL);
    assert.equal(submittedGraph["7"].inputs.noise_seed, 7);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});
