import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { NATURE_CAMERA_ANATOMY_CLAUSE, createText2ImgController, normalizeText2ImgInput } from "../server/image-generation/text2img.mjs";
import { createText2ImgStore } from "../server/image-generation/text2img-store.mjs";

async function invoke(controller, method, url, body) {
  const result = { status: 0, body: null };
  await controller.handleRoute({ method, url }, {}, {
    pathname: new URL(url, "http://localhost").pathname,
    async readJson() { return body; },
    sendJson(_res, status, payload) { result.status = status; result.body = payload; },
    sendError(_res, status, message, code) { result.status = status; result.body = { error: message, code }; },
  });
  return result;
}

test("exposes the person-photo library and creates traceable single or batch recipes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-person-photo-routes-"));
  let id = 0;
  try {
    const controller = createText2ImgController({ outputRoot: root, storeRoot: path.join(root, "jobs"), idFactory: () => `generated-${++id}` });
    const library = await invoke(controller, "GET", "/api/text2img/person-photo/library");
    assert.equal(library.status, 200);
    assert.ok(library.body.library.libraryVersion);
    assert.ok(library.body.library.sourceSha256);

    const randomized = await invoke(controller, "POST", "/api/text2img/person-photo/randomize", {
      count: 2,
      seed: 7788,
      clothingRequirements: [{ category: "hosiery", value: "白襪子", applyToAll: true }],
    });
    assert.equal(randomized.status, 200);
    assert.equal(randomized.body.mode, "batch");
    assert.equal(randomized.body.count, 2);
    assert.equal(randomized.body.recipes.length, 2);
    assert.ok(randomized.body.batchId);
    for (const [batchIndex, recipe] of randomized.body.recipes.entries()) {
      assert.equal(recipe.batchId, randomized.body.batchId);
      assert.equal(recipe.batchIndex, batchIndex);
      assert.equal(recipe.batchSize, 2);
      assert.ok(recipe.id);
      assert.ok(recipe.recipeSeed >= 0);
      assert.equal(recipe.validation.passed, true);
      assert.match(recipe.hardRequirements[0].value, /白襪/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rebuilds recipe briefs and preserves mandatory clothing through prompt generation and job normalization", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-person-photo-prompt-"));
  const modelCalls = [];
  try {
    const controller = createText2ImgController({
      outputRoot: root,
      storeRoot: path.join(root, "jobs"),
      promptAssistant: {
        provider: "test",
        async status() {
          return {
            online: true,
            model: "photo-model",
            models: ["photo-model", "ornith:ornith-sglang"],
            modelOptions: [
              { value: "photo-model", model: "photo-model", provider: "qwen", location: "remote" },
              { value: "ornith:ornith-sglang", model: "ornith-sglang", provider: "ornith", location: "local" },
            ],
          };
        },
        async generate(input) { modelCalls.push(input); return JSON.stringify({ prompt: "自然窗光下的成人生活人像" }); },
      },
    });
    const randomized = await invoke(controller, "POST", "/api/text2img/person-photo/randomize", {
      count: 1,
      seed: 123,
      clothingRequirements: [{ category: "hosiery", value: "白襪子", applyToAll: true }],
    });
    const recipe = randomized.body.recipes[0];
    const requiredClothing = recipe.hardRequirements[0].selectedItem.text;
    recipe.brief = "untrusted client brief";

    const assistant = await controller.checkPromptAssistant();
    assert.deepEqual(assistant.models, ["photo-model", "ornith:ornith-sglang"]);
    assert.equal(assistant.modelOptions[1].provider, "ornith");
    const generated = await controller.generatePhotographicPrompt({ recipe, model: "ornith:ornith-sglang" });
    assert.notEqual(generated.description, "untrusted client brief");
    assert.equal(modelCalls[0].model, "ornith:ornith-sglang");
    assert.equal(generated.model, "ornith:ornith-sglang");
    assert.ok(modelCalls[0].prompt.includes(requiredClothing));
    for (const heading of ['照片目標', '人物', '服裝', '動作與表情', '構圖與鏡位', '場景', '光線', '拍攝質感']) {
      assert.match(modelCalls[0].prompt, new RegExp(`【${heading}】\\n`));
      assert.match(generated.prompt, new RegExp(`【${heading}】\\n`));
    }
    assert.match(generated.prompt, /【模型整合】\n/);
    assert.ok(generated.prompt.includes(requiredClothing));
    assert.match(generated.prompt, /【肢體完整性】\n/);
    assert.ok(generated.prompt.endsWith(NATURE_CAMERA_ANATOMY_CLAUSE));

    const normalized = normalizeText2ImgInput({ prompt: generated.prompt, seed: 42, recipe });
    assert.equal(normalized.prompt, generated.prompt);
    assert.equal(normalized.seed, 42);
    assert.equal(normalized.batchId, recipe.batchId);
    assert.equal(normalized.batchIndex, 0);
    assert.equal(normalized.batchSize, 1);
    assert.equal(normalized.recipeSeed, recipe.recipeSeed);
    assert.equal(normalized.libraryVersion, recipe.libraryVersion);
    assert.equal(normalized.validation.passed, true);

    const persistedRoot = path.join(root, "persisted-jobs");
    const enqueueController = createText2ImgController({
      outputRoot: root,
      storeRoot: persistedRoot,
      idFactory: () => "recipe-job",
      beforeRun() { throw new Error("test stop after persistence"); },
    });
    const queued = await enqueueController.enqueue({ prompt: generated.prompt, seed: 42, recipe });
    assert.equal(queued.submittedPrompt, generated.prompt);
    assert.equal(queued.recipeSeed, recipe.recipeSeed);
    assert.equal(queued.batchId, recipe.batchId);
    while (enqueueController.getJob("recipe-job")?.status !== "failed") await new Promise((resolve) => setImmediate(resolve));
    const persisted = await createText2ImgStore({ root: persistedRoot }).read("recipe-job");
    assert.equal(persisted.submittedPrompt, generated.prompt);
    assert.equal(persisted.seed, 42);
    assert.equal(persisted.recipe.id, queued.recipe.id);
    assert.equal(persisted.recipe.brief, queued.recipe.brief);
    assert.deepEqual(persisted.recipe.selections, queued.recipe.selections);
    assert.deepEqual(persisted.recipe.hardRequirements[0].resolvedOptionIds, queued.recipe.hardRequirements[0].resolvedOptionIds);
    assert.deepEqual(persisted.validation, queued.validation);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects person-photo batch counts outside 1 through 20", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-person-photo-count-"));
  try {
    const controller = createText2ImgController({ outputRoot: root, storeRoot: path.join(root, "jobs") });
    const result = await invoke(controller, "POST", "/api/text2img/person-photo/randomize", { count: 21 });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, "TEXT2IMG_COUNT_INVALID");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
