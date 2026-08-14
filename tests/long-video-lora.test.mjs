import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { buildLongPlanRequest, buildLongSaveRequest, H3_REALISM_PEOPLE_DEFAULT_STRENGTH, H3_REALISM_PEOPLE_PRESET, validateLongCreate } from "../app/lib/long-create-contract.mjs";
import { runSequence } from "../server/long-video/runner.mjs";
import { assertLongLoraSupported, createSequenceRecord, H3_REALISM_PEOPLE_PRESET as SERVER_H3_REALISM_PEOPLE_PRESET, validateSequenceInput } from "../server/long-video/schema.mjs";
import { handleLongVideoRoute } from "../server/long-video/api.mjs";

const TIMELINE = [
  { start: 0, end: 5, description: "opening" },
  { start: 5, end: 10, description: "continuation" },
];

function response() {
  return { headersSent: false, writeHead(status) { this.status = status; }, end(value) { this.body = JSON.parse(value); } };
}

test("long LoRA contract normalizes safe name and finite strength", () => {
  const plan = buildLongPlanRequest({ inputType: "text", inputText: "story", timelineMode: "auto", duration: 10, characterLoraName: "trained\\hero.safetensors", characterLoraStrength: 1.1 });
  assert.equal(plan.characterLoraName, "trained/hero.safetensors");
  assert.equal(plan.characterLoraStrength, 1.1);
  const save = buildLongSaveRequest({ plan: { segments: TIMELINE }, inputType: "text", inputText: "story", referenceMode: "continuity", timelineText: "[0 - 5] opening\n[5 - 10] continuation", outputFolder: "safe", modelProfile: "nvfp4_blackwell", width: 736, height: 416, steps: 20, seed: 1, characterLoraName: "trained/hero.safetensors", characterLoraStrength: 0.75 });
  assert.equal(save.characterLoraName, "trained/hero.safetensors");
  assert.equal(save.characterLoraStrength, 0.75);
  const clear = buildLongSaveRequest({ plan: { segments: TIMELINE }, inputType: "text", inputText: "story", referenceMode: "continuity", timelineText: "[0 - 5] opening\n[5 - 10] continuation", outputFolder: "safe", modelProfile: "nvfp4_blackwell", width: 736, height: 416, steps: 20, seed: 1, clearCharacterLora: true });
  assert.deepEqual({ characterLoraName: clear.characterLoraName, characterLoraId: clear.characterLoraId, characterLoraStrength: clear.characterLoraStrength }, { characterLoraName: null, characterLoraId: null, characterLoraStrength: null });
  assert.deepEqual(validateLongCreate({ inputText: "story", inputType: "text", referenceAssets: [], timelineMode: "auto", duration: 10, segmentDurationHint: 5, width: 736, height: 416, steps: 20, seed: 1, characterLoraStrength: 0.75 }), []);
  assert.deepEqual(validateLongCreate({ inputText: "story", inputType: "text", referenceAssets: [], timelineMode: "auto", duration: 10, segmentDurationHint: 5, width: 736, height: 416, steps: 20, seed: 1, characterLoraName: "../unsafe.safetensors", characterLoraStrength: 1 }), [{ field: "characterLoraName", message: "Character LoRA must be a safe relative path under models/loras." }]);
  assert.equal(validateLongCreate({ inputText: "story", inputType: "text", referenceAssets: [], timelineMode: "auto", duration: 10, segmentDurationHint: 5, width: 736, height: 416, steps: 20, seed: 1, characterLoraName: "hero.safetensors", characterLoraStrength: 2.1 })[0].field, "characterLoraStrength");
});

test("fixed H3 Realism People preset is enabled consistently and disabled with clear markers", () => {
  assert.equal(H3_REALISM_PEOPLE_PRESET, SERVER_H3_REALISM_PEOPLE_PRESET);
  const plan = buildLongPlanRequest({ inputType: "text", inputText: "story", timelineMode: "auto", duration: 10, h3LoraEnabled: true });
  assert.deepEqual({ h3LoraEnabled: plan.h3LoraEnabled, h3LoraPreset: plan.h3LoraPreset, characterLoraName: plan.characterLoraName, characterLoraStrength: plan.characterLoraStrength }, {
    h3LoraEnabled: true,
    h3LoraPreset: H3_REALISM_PEOPLE_PRESET,
    characterLoraName: H3_REALISM_PEOPLE_PRESET,
    characterLoraStrength: H3_REALISM_PEOPLE_DEFAULT_STRENGTH,
  });
  const save = buildLongSaveRequest({ plan: { segments: TIMELINE }, inputType: "text", inputText: "story", referenceMode: "continuity", timelineText: "[0 - 5] opening\n[5 - 10] continuation", outputFolder: "safe", modelProfile: "nvfp4_blackwell", width: 736, height: 416, steps: 20, seed: 1, h3LoraEnabled: true });
  assert.equal(save.characterLoraName, H3_REALISM_PEOPLE_PRESET);
  assert.equal(save.characterLoraStrength, H3_REALISM_PEOPLE_DEFAULT_STRENGTH);
  const clear = buildLongSaveRequest({ plan: { segments: TIMELINE }, inputType: "text", inputText: "story", referenceMode: "continuity", timelineText: "[0 - 5] opening\n[5 - 10] continuation", outputFolder: "safe", h3LoraEnabled: false });
  assert.deepEqual({ h3LoraEnabled: clear.h3LoraEnabled, h3LoraPreset: clear.h3LoraPreset, characterLoraName: clear.characterLoraName, characterLoraId: clear.characterLoraId, characterLoraStrength: clear.characterLoraStrength }, { h3LoraEnabled: false, h3LoraPreset: null, characterLoraName: null, characterLoraId: null, characterLoraStrength: null });
  assert.deepEqual(validateLongCreate({ inputText: "story", inputType: "text", referenceAssets: [], timelineMode: "auto", duration: 10, segmentDurationHint: 5, width: 736, height: 416, steps: 20, seed: 1, h3LoraEnabled: false, characterLoraStrength: H3_REALISM_PEOPLE_DEFAULT_STRENGTH }), []);
});

test("plan route preserves fixed H3 fields without duplicating the trigger", async () => {
  const res = response();
  await handleLongVideoRoute({ method: "POST", url: "/api/sequences/plan", body: {
    inputType: "text", inputText: "story", duration: 10, h3LoraEnabled: true,
  } }, res, {
    plan: async () => ({ inputType: "text", duration: 10, continuityBible: {}, segments: TIMELINE, timeline: TIMELINE, planMeta: {} }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.plan.h3LoraEnabled, true);
  assert.equal(res.body.plan.characterLoraName, H3_REALISM_PEOPLE_PRESET);
  assert.equal(res.body.plan.characterLoraStrength, H3_REALISM_PEOPLE_DEFAULT_STRENGTH);
  assert.equal(Object.hasOwn(res.body.plan, "characterLoraTrigger"), false);
});

test("server schema rejects unsafe LoRA input and client provenance", () => {
  for (const name of ["../unsafe.safetensors", "C:/unsafe.safetensors", "/tmp/unsafe.safetensors", "nested//unsafe.safetensors"]) {
    assert.throws(() => validateSequenceInput({ characterLoraName: name, timeline: TIMELINE }), (error) => error.code === "CHARACTER_LORA_NAME_INVALID");
  }
  assert.throws(() => validateSequenceInput({ characterLoraName: "hero.safetensors", characterLoraStrength: Number.NaN, timeline: TIMELINE }), (error) => error.code === "CHARACTER_LORA_STRENGTH_INVALID");
  assert.throws(() => validateSequenceInput({ characterLoraStrength: 0.75, timeline: TIMELINE }), (error) => error.code === "CHARACTER_LORA_STRENGTH_WITHOUT_LORA");
  assert.throws(() => validateSequenceInput({ characterLoraName: "hero.safetensors", loraProvenance: { relativePath: "hero.safetensors" }, timeline: TIMELINE }), (error) => error.code === "CHARACTER_LORA_PROVENANCE_FORBIDDEN");
  const cleared = validateSequenceInput({ characterLoraName: null, characterLoraId: null, characterLoraStrength: null, timeline: TIMELINE });
  assert.equal(Object.hasOwn(cleared, "characterLoraName"), false);
  assert.equal(Object.hasOwn(cleared, "characterLoraId"), false);
  assert.equal(Object.hasOwn(cleared, "characterLoraStrength"), false);
  const record = createSequenceRecord({ characterLoraName: "hero.safetensors", characterLoraStrength: 0.75, outputFolder: "safe", timeline: TIMELINE });
  assert.equal(record.characterLoraName, "hero.safetensors");
  assert.equal(record.characterLoraStrength, 0.75);
  assert.throws(() => assertLongLoraSupported({ ...record, referenceMode: "multi_reference" }), (error) => error.code === "CHARACTER_LORA_MODE_UNSUPPORTED");
  const h3 = validateSequenceInput({ h3LoraEnabled: true, referenceMode: "multi_reference", inputAsset: { root: "input", kind: "image", name: "first.png" }, referenceAssets: [], characterLoraStrength: 0.8, timeline: TIMELINE });
  assert.equal(h3.characterLoraName, H3_REALISM_PEOPLE_PRESET);
  assert.equal(assertLongLoraSupported(h3).h3LoraEnabled, true);
  assert.throws(() => assertLongLoraSupported({ ...h3, referenceMode: "continuity", modelProfile: "ref2va_pruned_nvfp4" }), (error) => error.code === "CHARACTER_LORA_PROFILE_UNSUPPORTED");
  const clearedH3 = validateSequenceInput({ h3LoraEnabled: false, characterLoraName: H3_REALISM_PEOPLE_PRESET, characterLoraStrength: 0.8, timeline: TIMELINE });
  assert.deepEqual({ h3LoraEnabled: clearedH3.h3LoraEnabled, h3LoraPreset: clearedH3.h3LoraPreset, characterLoraName: clearedH3.characterLoraName, characterLoraStrength: clearedH3.characterLoraStrength }, { h3LoraEnabled: false, h3LoraPreset: null, characterLoraName: null, characterLoraStrength: null });
});

test("long-video API fails closed with 422 for unsupported LoRA profile", async () => {
  const res = response();
  const handled = await handleLongVideoRoute({ method: "POST", url: "/api/sequences", body: { inputType: "text", inputText: "story", outputFolder: "unsupported-lora", modelProfile: "unknown-profile", characterLoraName: "hero.safetensors", characterLoraStrength: 0.75, timeline: TIMELINE } }, res);
  assert.equal(handled, true);
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, "CHARACTER_LORA_PROFILE_UNSUPPORTED");
});

test("long-video PATCH clear removes a saved LoRA instead of preserving current fields", async () => {
  const testRoot = await mkdtemp(path.join(os.tmpdir(), "h3-long-lora-api-"));
  process.env.H3_SEQUENCE_DATA_ROOT = path.join(testRoot, "data");
  process.env.COMFYUI_OUTPUT_ROOT = path.join(testRoot, "output");
  const outputFolder = `clear-lora-${Date.now().toString(36)}`;
  const createdResponse = response();
  await handleLongVideoRoute({ method: "POST", url: "/api/sequences", body: { inputType: "text", inputText: "story", outputFolder, modelProfile: "nvfp4_blackwell", characterLoraName: "hero.safetensors", characterLoraStrength: 0.75, timeline: TIMELINE } }, createdResponse);
  assert.equal(createdResponse.status, 201);
  const created = createdResponse.body.job;
  const patchedResponse = response();
  await handleLongVideoRoute({ method: "PATCH", url: `/api/sequences/${encodeURIComponent(created.id)}`, body: { revision: created.revision, characterLoraName: null, characterLoraId: null, characterLoraStrength: null } }, patchedResponse);
  assert.equal(patchedResponse.status, 200);
  assert.equal(Object.hasOwn(patchedResponse.body.job, "characterLoraName"), false);
  assert.equal(Object.hasOwn(patchedResponse.body.job, "characterLoraId"), false);
  assert.equal(Object.hasOwn(patchedResponse.body.job, "characterLoraStrength"), false);
});

test("runner forwards one LoRA setting to every generated segment and retry", async () => {
  const calls = [];
  const folder = path.join(os.tmpdir(), "h3-long-lora-contract");
  const job = {
    id: "x", inputType: "text", outputPath: folder, outputFolder: "long-lora-contract", status: "ready", revision: 1,
    modelProfile: "nvfp4_blackwell", width: 736, height: 416, steps: 2, seed: 10, characterLoraName: "trained/hero.safetensors", characterLoraStrength: 0.8, continuityBible: {},
    segments: TIMELINE.map((segment, index) => ({ ...segment, id: `s${index + 1}`, duration: 5, prompt: "integrated_multimodal_description: scene\n\noverall_soundscape: room\n\nnon_diegetic_music: N/A" })),
  };
  const result = await runSequence(job, {
    generate: async (payload) => { calls.push(payload); return { rawPath: payload.outputPath }; },
    normalize: async () => {}, extractTail: async () => {},
    assemble: async ({ outputFolder }) => ({ outputPath: path.join(outputFolder, "final.mp4") }),
    updateJob: async (target, patch) => Object.assign(target, patch),
    updateSegment: async (target, index, patch) => Object.assign(target.segments[index], patch),
    writeManifest: async () => {}, log: async () => {},
  });
  assert.equal(result.status, "completed");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.characterLoraName, "trained/hero.safetensors");
    assert.equal(call.characterLoraStrength, 0.8);
  }
});

test("runner forwards fixed H3 LoRA to every Ref2V segment", async () => {
  const calls = [];
  const folder = path.join(os.tmpdir(), "h3-long-ref2v-lora-contract");
  const job = {
    id: "x", inputType: "image", referenceMode: "multi_reference", outputPath: folder, outputFolder: "long-ref2v-lora-contract", status: "ready", revision: 1,
    modelProfile: "nvfp4_blackwell", width: 736, height: 416, steps: 2, seed: 10, h3LoraEnabled: true, h3LoraPreset: H3_REALISM_PEOPLE_PRESET, characterLoraName: H3_REALISM_PEOPLE_PRESET, characterLoraStrength: 0.8, continuityBible: {},
    inputAsset: { root: "input", kind: "image", name: "first.png" },
    referenceAssets: [{ root: "input", kind: "image", name: "first.png" }],
    segments: TIMELINE.map((segment, index) => ({ ...segment, id: `r${index + 1}`, mode: "ref2v", duration: 5, prompt: "<Picture 1> detailed_description: scene\n\noverall_soundscape: room\n\nnon_diegetic_music: N/A" })),
  };
  const result = await runSequence(job, {
    generate: async (payload) => { calls.push(payload); return { rawPath: payload.outputPath }; },
    normalize: async () => {}, extractTail: async () => {},
    assemble: async ({ outputFolder }) => ({ outputPath: path.join(outputFolder, "final.mp4") }),
    updateJob: async (target, patch) => Object.assign(target, patch),
    updateSegment: async (target, index, patch) => Object.assign(target.segments[index], patch),
    writeManifest: async () => {}, log: async () => {},
  });
  assert.equal(result.status, "completed");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.mode, "ref2v");
    assert.equal(call.h3LoraEnabled, true);
    assert.equal(call.h3LoraPreset, H3_REALISM_PEOPLE_PRESET);
    assert.equal(call.characterLoraName, H3_REALISM_PEOPLE_PRESET);
    assert.equal(call.characterLoraStrength, 0.8);
  }
});
