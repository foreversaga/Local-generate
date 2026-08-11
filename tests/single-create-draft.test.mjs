import assert from "node:assert/strict";
import test from "node:test";
import {
  createSingleCreateDraft,
  parseSingleCreateDraft,
  SINGLE_CREATE_DRAFT_STORAGE_KEY,
} from "../app/lib/single-create-draft.mjs";

function draftInput(overrides = {}) {
  return {
    mode: "fl2v",
    prompt: "A cinematic tracking shot.",
    negativePrompt: "flicker",
    modelProfile: "nvfp4_blackwell",
    width: 736,
    height: 416,
    duration: 5,
    steps: 20,
    seed: 12345,
    renderCount: 2,
    outputName: "draft-video",
    characterLoraName: "characters/hero.safetensors",
    characterLoraStrength: 0.8,
    referenceImageKey: "input:first.png",
    referenceImageKeys: ["input:first.png", "input:second.png"],
    lastFrameImageKey: "input:last.png",
    sourceVideoKey: "input:motion.mp4",
    ...overrides,
  };
}

test("Single Create draft contract keeps only stable form state and asset keys", () => {
  assert.equal(SINGLE_CREATE_DRAFT_STORAGE_KEY, "h3-studio.single-create.draft.v1");
  assert.deepEqual(createSingleCreateDraft(draftInput()), {
    version: 1,
    ...draftInput(),
  });
});

test("Single Create draft round-trips valid state", () => {
  const source = createSingleCreateDraft(draftInput({ width: "", seed: "" }));
  assert.deepEqual(parseSingleCreateDraft(JSON.stringify(source)), source);
});

test("Single Create draft preserves an intentionally blank character LoRA strength", () => {
  const source = createSingleCreateDraft(draftInput({ characterLoraStrength: "" }));
  assert.equal(source.characterLoraStrength, "");
  assert.equal(parseSingleCreateDraft(JSON.stringify(source)).characterLoraStrength, "");
});

test("Single Create draft rejects unknown versions and sanitizes corrupted fields", () => {
  assert.equal(parseSingleCreateDraft("not-json"), null);
  assert.equal(parseSingleCreateDraft(JSON.stringify({ version: 2 })), null);

  const parsed = parseSingleCreateDraft(JSON.stringify({
    version: 1,
    mode: "unknown",
    prompt: 42,
    negativePrompt: null,
    modelProfile: "",
    width: "bad",
    height: 832,
    duration: "bad",
    steps: 0,
    seed: "",
    renderCount: 3,
    outputName: 9,
    referenceImageKey: 1,
    referenceImageKeys: ["input:a.png", 2, "input:b.png"],
    lastFrameImageKey: null,
    sourceVideoKey: "input:motion.mp4",
  }));

  assert.deepEqual(parsed, {
    version: 1,
    mode: "t2v",
    prompt: "",
    negativePrompt: "",
    modelProfile: "nvfp4_blackwell",
    width: 736,
    height: 832,
    duration: 5,
    steps: 0,
    seed: "",
    renderCount: 3,
    outputName: "",
    characterLoraName: "",
    characterLoraStrength: 0.75,
    referenceImageKey: null,
    referenceImageKeys: ["input:a.png", "input:b.png"],
    lastFrameImageKey: null,
    sourceVideoKey: "input:motion.mp4",
  });
});
