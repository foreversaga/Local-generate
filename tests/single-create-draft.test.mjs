import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  createSingleCreateDraft,
  createSingleCreateDraftFromJob,
  parseSingleCreateDraft,
  SINGLE_CREATE_DRAFT_STORAGE_KEY,
} from "../app/lib/single-create-draft.mjs";

function draftInput(overrides = {}) {
  return {
    mode: "fl2v",
    initialDescription: "一個人在月台等待，風吹動他的外套。",
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
    h3LoraEnabled: false,
    h3LoraStrength: 0.8,
    h3LoraPreset: null,
    characterLoraTrigger: null,
    referenceImageKey: "input:first.png",
    referenceImageKeys: ["input:first.png", "input:second.png"],
    faceReferenceImageKeys: [],
    clothingReferenceImageKeys: [],
    clothingMode: "character",
    clothingDescription: "",
    referenceVideoStart: 0,
    referenceVideoEnd: 5,
    referenceVideoMaxDimension: 720,
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

test("Single retry draft restores persisted job parameters and the initial description", () => {
  const draft = createSingleCreateDraftFromJob({
    mode: "ref2v",
    initialDescription: "角色從雨夜街口走向鏡頭。",
    prompt: "integrated_multimodal_description: cinematic rain",
    negativePrompt: "flicker",
    modelProfile: "ref2va_pruned_nvfp4",
    width: 832,
    height: 480,
    duration: 6,
    steps: 24,
    seed: 77,
    outputName: "rain.mp4",
    inputRefs: { referenceImages: ["hero.png", "street.png"], inputVideo: "motion.mp4" },
    provenance: { request: {
      ref2vWorkflow: "character_motion",
      referenceImageRoots: ["input", "output"],
      referenceImageRoles: ["character", "face"],
      clothingMode: "description",
      clothingDescription: "a white leather jacket",
      referenceVideoStart: 2,
      referenceVideoEnd: 8,
      referenceVideoMaxDimension: 480,
      inputVideoRoot: "output",
    } },
  });
  assert.equal(draft.initialDescription, "角色從雨夜街口走向鏡頭。");
  assert.equal(draft.mode, "ref2v_motion");
  assert.equal(draft.prompt, "integrated_multimodal_description: cinematic rain");
  assert.deepEqual(draft.referenceImageKeys, ["input:hero.png"]);
  assert.deepEqual(draft.faceReferenceImageKeys, ["output:street.png"]);
  assert.equal(draft.clothingMode, "description");
  assert.equal(draft.clothingDescription, "a white leather jacket");
  assert.equal(draft.referenceVideoStart, 2);
  assert.equal(draft.referenceVideoEnd, 8);
  assert.equal(draft.referenceVideoMaxDimension, 480);
  assert.equal(draft.sourceVideoKey, "output:motion.mp4");
  assert.equal(draft.renderCount, 1);
});

test("legacy generic Ref2V retry stays in the original optional-video mode", () => {
  const draft = createSingleCreateDraftFromJob({
    mode: "ref2v",
    inputRefs: { referenceImages: ["one.png", "two.png"] },
    provenance: { request: { referenceImageRoots: ["input", "output"] } },
  });
  assert.equal(draft.mode, "ref2v");
  assert.deepEqual(draft.referenceImageKeys, ["input:one.png", "output:two.png"]);
  assert.deepEqual(draft.faceReferenceImageKeys, []);
  assert.equal(draft.sourceVideoKey, null);
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
    initialDescription: "",
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
    h3LoraEnabled: false,
    h3LoraStrength: 0.8,
    h3LoraPreset: null,
    characterLoraTrigger: null,
    referenceImageKey: null,
    referenceImageKeys: ["input:a.png", "input:b.png"],
    faceReferenceImageKeys: [],
    clothingReferenceImageKeys: [],
    clothingMode: "character",
    clothingDescription: "",
    referenceVideoStart: 0,
    referenceVideoEnd: 5,
    referenceVideoMaxDimension: 720,
    lastFrameImageKey: null,
    sourceVideoKey: "input:motion.mp4",
  });
});

test("Single Create exposes a confirmed manual draft clear action", async () => {
  const [form, hook] = await Promise.all([
    readFile(new URL("../app/components/create/SingleCreateForm.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/create/useSingleCreateDraft.ts", import.meta.url), "utf8"),
  ]);

  assert.match(form, /function clearSingleCreateDraft\(\)/);
  assert.match(form, /window\.confirm\("確定清除目前 Single 草稿/);
  assert.match(form, /clearDraft\(\{ suppressNextSave: true \}\)/);
  assert.match(form, />清除草稿<\/button>/);
  assert.match(hook, /skipNextSaveRef\.current = suppressNextSave/);
});
