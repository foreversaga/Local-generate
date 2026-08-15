import assert from "node:assert/strict";
import test from "node:test";
import {
  primaryRouteForPath,
  routeTitle,
  WEB_UI_ROUTES,
} from "../app/lib/webui-routes.mjs";
import {
  validateSingleRender,
} from "../app/lib/single-render-validation.mjs";
import {
  batchOutputName,
  batchSeed,
  buildSingleRenderRequest,
  H3_REALISM_PEOPLE_LORA_NAME,
  H3_REALISM_PEOPLE_LORA_TRIGGER,
  H3_REALISM_PEOPLE_DEFAULT_STRENGTH,
} from "../app/lib/single-render-request.mjs";
import { normalizeImageResolution } from "../app/lib/single-image-resolution.mjs";
import {
  buildSinglePromptRequest,
} from "../app/lib/single-prompt-request.mjs";

const ASSET = { name: "asset.png" };

function validSingleInput(overrides = {}) {
  return {
    mode: "t2v",
    prompt: "A cinematic tracking shot.",
    promptMaxChars: 7000,
    enforcePromptMaxChars: true,
    width: 736,
    height: 416,
    duration: 5,
    steps: 20,
    seed: 12345,
    renderCount: 1,
    referenceImage: null,
    referenceImages: [],
    lastFrameImage: null,
    sourceVideo: null,
    ...overrides,
  };
}

function validRequestInput(overrides = {}) {
  return {
    mode: "t2v",
    prompt: "A cinematic tracking shot.",
    negativePrompt: "flicker, watermark",
    referenceImageName: "",
    referenceImageNames: [],
    lastFrameName: "",
    sourceVideoName: "",
    modelProfile: "nvfp4_blackwell",
    width: 736,
    height: 416,
    duration: 5,
    steps: 20,
    seed: 12345,
    outputName: "h3-render",
    batchId: "",
    batchIndex: 1,
    batchTotal: 1,
    ...overrides,
  };
}

function messages(input) {
  return validateSingleRender(input).map((issue) => issue.message);
}

test("primary WebUI routes match the approved navigation", () => {
  assert.deepEqual(
    WEB_UI_ROUTES.map(({ id, label, href }) => ({ id, label, href })),
    [
      { id: "create", label: "建立", href: "/app/create" },
      { id: "jobs", label: "工作", href: "/app/jobs" },
      { id: "library", label: "素材庫", href: "/app/library" },
      { id: "tools", label: "工具", href: "/app/tools" },
      { id: "settings", label: "設定", href: "/app/settings" },
    ],
  );
});

test("route mapping keeps nested routes on the correct primary navigation item", () => {
  assert.equal(primaryRouteForPath("/app"), "create");
  assert.equal(primaryRouteForPath("/app/create/single"), "create");
  assert.equal(primaryRouteForPath("/app/create/long?draft=abc"), "create");
  assert.equal(primaryRouteForPath("/app/jobs/job-123"), "jobs");
  assert.equal(primaryRouteForPath("/app/library/"), "library");
  assert.equal(primaryRouteForPath("/app/tools"), "tools");
  assert.equal(primaryRouteForPath("/app/tools/image-to-image"), "tools");
  assert.equal(primaryRouteForPath("/app/settings#runtime"), "settings");
});

test("route titles identify important child pages", () => {
  assert.equal(routeTitle("/app/create"), "建立");
  assert.equal(routeTitle("/app/create/single"), "建立 / 單次影片");
  assert.equal(routeTitle("/app/create/long"), "建立 / 長影片");
  assert.equal(routeTitle("/app/jobs/job-123"), "工作詳情");
  assert.equal(routeTitle("/app/tools"), "工具");
  assert.equal(routeTitle("/app/tools/upscale"), "工具 / 影片升頻");
  assert.equal(routeTitle("/app/tools/image-to-image"), "工具 / 以圖生圖");
});

test("route titles support English presentation without changing route paths", () => {
  assert.equal(routeTitle("/app/create", "en"), "Create");
  assert.equal(routeTitle("/app/create/single", "en"), "Create / Single video");
  assert.equal(routeTitle("/app/jobs/job-123", "en"), "Job details");
  assert.equal(routeTitle("/app/tools/image-to-image", "en"), "Tools / Image to Image");
});

test("valid t2v render has no validation issues", () => {
  assert.deepEqual(validateSingleRender(validSingleInput()), []);
});

test("single render requires a non-empty prompt and enforces H3 prompt length", () => {
  assert.match(messages(validSingleInput({ prompt: "   " }))[0], /提示詞/);
  assert.match(messages(validSingleInput({ prompt: "x".repeat(7001) }))[0], /7000/);
  assert.equal(
    messages(validSingleInput({
      mode: "replace",
      prompt: "x".repeat(7001),
      referenceImage: ASSET,
      sourceVideo: { name: "source.mp4" },
    })).some((message) => message.includes("7000")),
    false,
  );
});

test("Single render carries an Ollama prompt receipt only for an Ollama-backed prompt operation", () => {
  const withReceipt = buildSingleRenderRequest(validRequestInput({ ollamaPromptReceipt: "ollama-prompt-test" }));
  assert.equal(withReceipt.ollamaPromptReceipt, "ollama-prompt-test");
  const withoutReceipt = buildSingleRenderRequest(validRequestInput());
  assert.equal("ollamaPromptReceipt" in withoutReceipt, false);
});

test("replace request sends character LoRA fields only when a name is selected", () => {
  const payload = buildSingleRenderRequest(validRequestInput({
    mode: "replace",
    characterLoraName: " characters/hero.safetensors ",
    characterLoraStrength: 0.8,
  }));
  assert.equal(payload.characterLoraName, "characters/hero.safetensors");
  assert.equal(payload.characterLoraStrength, 0.8);

  const withoutLora = buildSingleRenderRequest(validRequestInput({
    mode: "replace",
    characterLoraName: "   ",
    characterLoraStrength: 1.4,
  }));
  assert.equal("characterLoraName" in withoutLora, false);
  assert.equal("characterLoraStrength" in withoutLora, false);

  const nonReplace = buildSingleRenderRequest(validRequestInput({
    mode: "t2v",
    characterLoraName: "characters/ignored.safetensors",
    characterLoraStrength: 0.8,
  }));
  assert.equal("characterLoraName" in nonReplace, false);
  assert.equal("characterLoraStrength" in nonReplace, false);
});

test("Single H3 preset request is canonical across every supported H3 mode", () => {
  for (const mode of ["t2v", "i2v", "fl2v", "l2v", "ref2v"]) {
    const payload = buildSingleRenderRequest(validRequestInput({
      mode,
      h3LoraEnabled: true,
      characterLoraStrength: H3_REALISM_PEOPLE_DEFAULT_STRENGTH,
    }));
    assert.equal(payload.h3LoraEnabled, true, mode);
    assert.equal(payload.h3LoraPreset, H3_REALISM_PEOPLE_LORA_NAME, mode);
    assert.equal(payload.characterLoraName, H3_REALISM_PEOPLE_LORA_NAME, mode);
    assert.equal(payload.characterLoraTrigger, H3_REALISM_PEOPLE_LORA_TRIGGER, mode);
    assert.equal(payload.characterLoraStrength, H3_REALISM_PEOPLE_DEFAULT_STRENGTH, mode);
  }
});

test("Single H3 preset disable clears all LoRA fields without retaining trigger or strength", () => {
  for (const mode of ["t2v", "i2v", "fl2v", "l2v", "ref2v"]) {
    const payload = buildSingleRenderRequest(validRequestInput({
      mode,
      h3LoraEnabled: false,
      h3LoraPreset: H3_REALISM_PEOPLE_LORA_NAME,
      characterLoraName: H3_REALISM_PEOPLE_LORA_NAME,
      characterLoraTrigger: H3_REALISM_PEOPLE_LORA_TRIGGER,
      characterLoraStrength: H3_REALISM_PEOPLE_DEFAULT_STRENGTH,
    }));
    assert.equal(payload.h3LoraEnabled, false, mode);
    assert.equal(payload.h3LoraPreset, null, mode);
    assert.equal(payload.characterLoraName, null, mode);
    assert.equal(payload.characterLoraTrigger, null, mode);
    assert.equal(payload.characterLoraStrength, null, mode);
  }
});

test("Replace request never forwards H3 preset fields", () => {
  const payload = buildSingleRenderRequest(validRequestInput({
    mode: "replace",
    h3LoraEnabled: true,
    h3LoraPreset: H3_REALISM_PEOPLE_LORA_NAME,
    characterLoraName: "characters/hero.safetensors",
    characterLoraTrigger: H3_REALISM_PEOPLE_LORA_TRIGGER,
    characterLoraStrength: 0.8,
  }));
  assert.equal(payload.characterLoraName, "characters/hero.safetensors");
  assert.equal(payload.characterLoraStrength, 0.8);
  assert.equal("h3LoraEnabled" in payload, false);
  assert.equal("h3LoraPreset" in payload, false);
  assert.equal("characterLoraTrigger" in payload, false);
});

test("single render validates required assets per mode", () => {
  assert.match(messages(validSingleInput({ mode: "i2v" }))[0], /I2VA/);
  assert.match(messages(validSingleInput({ mode: "ref2v" }))[0], /Ref2VA/);
  assert.match(messages(validSingleInput({ mode: "fl2v", referenceImage: ASSET }))[0], /FL2VA/);
  assert.match(messages(validSingleInput({ mode: "l2v" }))[0], /L2VA/);
  assert.match(messages(validSingleInput({ mode: "replace", referenceImage: ASSET }))[0], /來源影片/);

  assert.deepEqual(validateSingleRender(validSingleInput({ mode: "i2v", referenceImage: ASSET })), []);
  assert.deepEqual(validateSingleRender(validSingleInput({ mode: "ref2v", referenceImages: [ASSET] })), []);
  assert.deepEqual(validateSingleRender(validSingleInput({ mode: "ref2v", sourceVideo: { name: "ref.mp4" } })), []);
  assert.deepEqual(validateSingleRender(validSingleInput({ mode: "fl2v", referenceImage: ASSET, lastFrameImage: ASSET })), []);
  assert.deepEqual(validateSingleRender(validSingleInput({ mode: "l2v", lastFrameImage: ASSET })), []);
  assert.deepEqual(validateSingleRender(validSingleInput({ mode: "replace", referenceImage: ASSET, sourceVideo: { name: "source.mp4" } })), []);
});

test("replace validation protects character LoRA path and strength", () => {
  const valid = validSingleInput({
    mode: "replace",
    referenceImage: ASSET,
    sourceVideo: { name: "source.mp4" },
    characterLoraName: "characters/hero.safetensors",
    characterLoraStrength: 0.75,
  });
  assert.deepEqual(validateSingleRender(valid), []);
  assert.match(messages({ ...valid, characterLoraName: "../escape.safetensors" }).find((message) => message.includes("LoRA")), /relative path/);
  assert.match(messages({ ...valid, characterLoraStrength: 2.1 }).find((message) => message.includes("LoRA")), /between 0 and 2/);
  assert.deepEqual(validateSingleRender({ ...valid, characterLoraName: "" }), []);
});

test("asset validation issues point at the exact missing Single Create fields", () => {
  assert.deepEqual(
    validateSingleRender(validSingleInput({ mode: "fl2v" }))
      .filter((issue) => ["referenceImage", "lastFrameImage"].includes(issue.field))
      .map((issue) => issue.field),
    ["referenceImage", "lastFrameImage"],
  );
  assert.deepEqual(
    validateSingleRender(validSingleInput({ mode: "replace" }))
      .filter((issue) => ["referenceImage", "sourceVideo"].includes(issue.field))
      .map((issue) => issue.field),
    ["referenceImage", "sourceVideo"],
  );
  assert.equal(
    validateSingleRender(validSingleInput({ mode: "fl2v", referenceImage: ASSET }))
      .find((issue) => issue.field === "lastFrameImage")?.message,
    "FL2VA 需要尾幀圖片。",
  );
});

test("single render validates dimension bounds and mode-specific grid", () => {
  assert.match(messages(validSingleInput({ width: "" }))[0], /影片寬度/);
  assert.match(messages(validSingleInput({ width: 16 }))[0], /32/);
  assert.match(messages(validSingleInput({ width: 2050 }))[0], /2048/);
  assert.match(messages(validSingleInput({ width: 750 }))[0], /32 的倍數/);

  assert.deepEqual(
    validateSingleRender(validSingleInput({
      mode: "replace",
      width: 720,
      height: 416,
      referenceImage: ASSET,
      sourceVideo: { name: "source.mp4" },
    })),
    [],
  );
  assert.match(
    messages(validSingleInput({
      mode: "replace",
      width: 728,
      referenceImage: ASSET,
      sourceVideo: { name: "source.mp4" },
    }))[0],
    /16 的倍數/,
  );
});

test("single render validates steps seed and render count limits", () => {
  assert.match(messages(validSingleInput({ steps: 0 }))[0], /Steps/);
  assert.match(messages(validSingleInput({ steps: 81 }))[0], /80/);
  assert.match(messages(validSingleInput({ seed: -1 }))[0], /Seed/);
  assert.match(messages(validSingleInput({ seed: 2147483648 }))[0], /2147483647/);
  assert.match(messages(validSingleInput({ renderCount: 0 }))[0], /影片數量/);
  assert.match(messages(validSingleInput({ renderCount: 21 }))[0], /20/);
});

test("single render request keeps the legacy generate payload shape", () => {
  assert.deepEqual(
    buildSingleRenderRequest(validRequestInput({
      mode: "fl2v",
      referenceImageName: "first.png",
      lastFrameName: "last.png",
      sourceVideoName: "stale.mp4",
    })),
    {
      mode: "fl2v",
      prompt: "A cinematic tracking shot.",
      negativePrompt: "flicker, watermark",
      inputImageName: "first.png",
      inputImageRoot: "",
      lastImageName: "last.png",
      lastImageRoot: "",
      inputVideoName: "stale.mp4",
      inputVideoRoot: "",
      referenceImageName: "first.png",
      referenceImageRoot: "",
      modelProfile: "nvfp4_blackwell",
      width: 736,
      height: 416,
      duration: 5,
      steps: 20,
      seed: 12345,
      outputName: "h3-render",
      batchId: "",
      batchIndex: 1,
      batchTotal: 1,
    },
  );
});

test("the request forwards the normalized resolution that the UI displays", () => {
  const finalResolution = normalizeImageResolution(4000, 3000, "i2v");
  const payload = buildSingleRenderRequest(validRequestInput({
    mode: "i2v",
    width: finalResolution.width,
    height: finalResolution.height,
  }));
  assert.equal(payload.width, finalResolution.width);
  assert.equal(payload.height, finalResolution.height);
  assert.equal(payload.width, 2048);
  assert.equal(payload.height, 1536);
});

test("single render duration accepts 60 seconds and rejects values above the new maximum", () => {
  assert.deepEqual(validateSingleRender(validSingleInput({ duration: 60 })), []);
  assert.match(messages(validSingleInput({ duration: 60.5 }))[0], /60/);
});

test("ref2v request preserves video input and caps reference images at nine", () => {
  const referenceImageNames = Array.from({ length: 12 }, (_, index) => `ref-${index + 1}.png`);
  const referenceImageRoots = Array.from({ length: 12 }, (_, index) => index % 2 ? "input" : "output");
  const payload = buildSingleRenderRequest(validRequestInput({
    mode: "ref2v",
    referenceImageName: "ref-1.png",
    referenceImageNames,
    referenceImageRoots,
    sourceVideoName: "motion.mp4",
    modelProfile: "ref2va_pruned_nvfp4",
  }));

  assert.equal(payload.inputImageName, "");
  assert.equal(payload.inputVideoName, "motion.mp4");
  assert.equal(payload.referenceImageName, "ref-1.png");
  assert.deepEqual(payload.referenceImageNames, referenceImageNames.slice(0, 9));
  assert.deepEqual(payload.referenceImageRoots, referenceImageRoots.slice(0, 9));
});

test("batch request helpers keep legacy seed and filename behavior", () => {
  assert.equal(batchSeed(2147483647, 1), 0);
  assert.equal(batchSeed(12345, 2), 12347);
  assert.equal(batchOutputName("clip.mp4", 0, 3), "clip-1");
  assert.equal(batchOutputName("", 1, 3), "h3-render-2");
  assert.equal(batchOutputName("clip", 0, 1), "clip");
});


test("single prompt request keeps legacy provider and media payload shape", () => {
  assert.deepEqual(
    buildSinglePromptRequest({
      provider: "codex",
      model: "gpt-5.6-luna",
      codexModel: "gpt-5.6-luna",
      reasoningEffort: "medium",
      brief: "A person waits on a windy platform.",
      negativePrompt: "flicker",
      mode: "fl2v",
      duration: 5,
      referenceImageName: "first.png",
      referenceImageNames: [],
      lastFrameName: "last.png",
      sourceVideoName: "",
      images: [
        { role: "first_frame", data: "first-base64" },
        { role: "last_frame", data: "last-base64" },
      ],
    }),
    {
      provider: "codex",
      model: "gpt-5.6-luna",
      codexModel: "gpt-5.6-luna",
      reasoningEffort: "medium",
      brief: "A person waits on a windy platform.",
      negativePrompt: "flicker",
      mode: "fl2v",
      duration: 5,
      referenceImageName: "first.png",
      firstFrameName: "first.png",
      lastFrameName: "last.png",
      sourceVideoName: "",
      images: [
        { role: "first_frame", data: "first-base64" },
        { role: "last_frame", data: "last-base64" },
      ],
    },
  );
});

test("ref2v prompt request caps references and uses Picture 1 as primary reference", () => {
  const referenceImageNames = Array.from({ length: 12 }, (_, index) => `ref-${index + 1}.png`);
  const payload = buildSinglePromptRequest({
    provider: "ollama",
    model: "vision-model",
    codexModel: "gpt-5.6-luna",
    reasoningEffort: "medium",
    brief: "Keep the same character identity.",
    negativePrompt: "",
    mode: "ref2v",
    duration: 5,
    referenceImageName: "stale.png",
    referenceImageNames,
    lastFrameName: "",
    sourceVideoName: "motion.mp4",
    images: [],
    cameraPlan: { version: 1, shots: [{ id: "shot-1" }] },
  });

  assert.equal(payload.referenceImageName, "ref-1.png");
  assert.deepEqual(payload.referenceImageNames, referenceImageNames.slice(0, 9));
  assert.equal(payload.sourceVideoName, "motion.mp4");
  assert.deepEqual(payload.cameraPlan, { version: 1, shots: [{ id: "shot-1" }] });
});

test("camera planning data is omitted from non-Ref2V prompt requests", () => {
  const payload = buildSinglePromptRequest({
    provider: "ollama", model: "vision-model", codexModel: "gpt-5.6-luna", reasoningEffort: "medium",
    brief: "A scene", negativePrompt: "", mode: "i2v", duration: 5, images: [], cameraPlan: { version: 1 },
  });
  assert.equal(Object.hasOwn(payload, "cameraPlan"), false);
});
