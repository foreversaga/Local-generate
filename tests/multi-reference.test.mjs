import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { codexLongPlanModeInstruction, codexLongPlanReferences, normalizeReferenceImageNames, referenceImageArgs } from "../local-bridge.mjs";
import { buildRef2VAPrompt } from "../server/long-video/prompt-builder.mjs";
import { planSequence } from "../server/long-video/planner.mjs";
import { appendMultiReferenceTail, runSequence } from "../server/long-video/runner.mjs";
import { validateSequenceInput } from "../server/long-video/schema.mjs";

function timeline() {
  return [
    { start: 0, end: 5, description: "opening" },
    { start: 5, end: 10, description: "ending" },
  ];
}

test("normalizes plural Ref2V references with stable order and repeated args", () => {
  assert.deepEqual(
    normalizeReferenceImageNames({ mode: "ref2v", referenceImageNames: [" first.png ", "second.png", "FIRST.PNG"] }),
    ["first.png", "second.png"],
  );
  assert.deepEqual(referenceImageArgs(["a.png", "b.png"]), ["--reference-image", "a.png", "--reference-image", "b.png"]);
  assert.deepEqual(normalizeReferenceImageNames({ mode: "ref2v", referenceImageName: "first.png", referenceImageNames: ["first.png", "second.png"] }), ["first.png", "second.png"]);
  assert.throws(() => normalizeReferenceImageNames({ mode: "i2v", referenceImageNames: ["a.png"] }), { code: "REFERENCE_IMAGES_MODE_INVALID" });
  assert.throws(() => normalizeReferenceImageNames({ mode: "ref2v", referenceImageName: "other.png", referenceImageNames: ["first.png"] }), { code: "REFERENCE_IMAGES_CONFLICT" });
  assert.throws(() => normalizeReferenceImageNames({ mode: "ref2v", referenceImageNames: [""] }), { code: "REFERENCE_IMAGE_EMPTY" });
  assert.throws(() => normalizeReferenceImageNames({ mode: "ref2v", referenceImageNames: Array.from({ length: 10 }, (_, index) => `${index}.png`) }), { code: "REFERENCE_IMAGES_LIMIT" });
});

test("multi_reference schema dedupes ordered image refs and enforces limits", () => {
  const normalized = validateSequenceInput({
    inputType: "text",
    referenceMode: "multi_reference",
    inputAsset: { root: "input", name: "hero.png", kind: "image" },
    referenceAssets: [
      { root: "input", name: "hero.png", kind: "image" },
      { root: "input", name: "set.png", kind: "image" },
      { root: "input", name: "set.png", kind: "image" },
    ],
    timeline: timeline(),
  });
  assert.equal(normalized.referenceMode, "multi_reference");
  assert.deepEqual(normalized.referenceAssets.map((asset) => asset.name), ["hero.png", "set.png"]);
  assert.deepEqual(normalized.timeline.map((segment) => segment.mode), ["ref2v", "ref2v"]);
  assert.equal(normalized.imagePurpose, undefined);
  assert.throws(() => validateSequenceInput({ referenceMode: "multi_reference", referenceAssets: [], timeline: timeline() }), { code: "REFERENCE_ASSETS_REQUIRED" });
  assert.throws(() => validateSequenceInput({ referenceMode: "multi_reference", referenceAssets: [{ name: "clip.mp4", kind: "video" }], timeline: timeline() }), { code: "REFERENCE_ASSET_KIND_INVALID" });
  assert.throws(() => validateSequenceInput({ referenceMode: "continuity", referenceAssets: [{ name: "ref.png" }], timeline: timeline() }), { code: "REFERENCE_ASSETS_CONTINUITY" });
});

test("multi_reference planner emits Ref2VA prompts for every segment", async () => {
  let receivedPrompt = "";
  const plan = await planSequence({
    inputType: "text",
    inputText: "A dancer crosses a sunlit plaza.",
    referenceMode: "multi_reference",
    referenceAssets: [{ root: "input", name: "dancer.png", kind: "image" }],
    timeline: timeline(),
  }, {
    request: async ({ prompt }) => {
      receivedPrompt = prompt;
      return { continuityBible: {}, segments: timeline().map((segment) => ({ ...segment, description: segment.description })) };
    },
  });
  assert.deepEqual(plan.segments.map((segment) => segment.mode), ["ref2v", "ref2v"]);
  assert.match(plan.segments[0].prompt, /^subject_definitions:/);
  assert.match(plan.segments[0].prompt, /<Picture 1>/);
  assert.match(receivedPrompt, /multi-reference Ref2VA/);
  assert.doesNotMatch(receivedPrompt, /first frame lock/);
});

test("multi_reference runner passes static refs then appends previous tail", async () => {
  const folder = path.join(os.tmpdir(), `h3-multi-run-${Date.now().toString(36)}`);
  const calls = [];
  const job = {
    id: "x",
    referenceMode: "multi_reference",
    inputType: "text",
    inputAsset: { root: "input", name: "hero.png", kind: "image" },
    referenceAssets: [{ root: "input", name: "set.png", kind: "image" }],
    outputPath: folder,
    outputFolder: "multi-memory",
    status: "ready",
    revision: 1,
    width: 736,
    height: 416,
    steps: 1,
    seed: 1,
    continuityBible: {},
    segments: timeline().map((segment, index) => ({ id: `s${index + 1}`, ...segment, duration: segment.end - segment.start, prompt: "", status: "pending" })),
  };
  const result = await runSequence(job, {
    generate: async (payload) => {
      calls.push(payload);
      return { rawPath: payload.outputPath, id: `generation-${payload.segmentIndex}` };
    },
    normalize: async () => {},
    extractTail: async () => {},
    assemble: async () => ({ outputPath: path.join(folder, "final-r001.mp4"), revision: 1, probe: {} }),
    writeManifest: async () => {},
    writeAttempt: async () => {},
    writeAssemblyJson: async () => {},
    updateJob: async (target, patch) => Object.assign(target, patch),
    updateSegment: async (target, index, patch) => Object.assign(target.segments[index], patch),
    log: async () => {},
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(calls.map((call) => call.mode), ["ref2v", "ref2v"]);
  assert.deepEqual(calls[0].referenceImageNames, ["hero.png", "set.png"]);
  assert.equal(calls[1].referenceImageNames.slice(0, 2).join(","), "hero.png,set.png");
  assert.match(calls[1].referenceImageNames.at(-1), /segment-001-attempt-001-tail\.png$/);
  assert.equal(calls[1].referenceAssets.at(-1).root, "output");
});

test("Ref2VA prompt keeps the six-field contract without first-frame wording", () => {
  const prompt = buildRef2VAPrompt({ description: "preserve the subject" });
  assert.match(prompt, /^subject_definitions:/);
  assert.match(prompt, /detailed_description:/);
  assert.doesNotMatch(prompt, /first-frame/i);
});

test("Codex multi-reference planning keeps ordered image attachments and Ref2VA continuation instruction", () => {
  const references = codexLongPlanReferences({
    referenceMode: "multi_reference",
    inputAsset: { root: "input", name: "hero.png" },
    referenceAssets: [{ root: "output", name: "style.png" }, { root: "input", name: "HERO.PNG" }],
  });
  assert.deepEqual(references.map((reference) => `${reference.root}:${reference.name}`), ["input:hero.png", "output:style.png"]);
  const instruction = codexLongPlanModeInstruction({ referenceMode: "multi_reference" }, references);
  assert.match(instruction, /Ref2VA for every segment/);
  assert.match(instruction, /<Picture 1> \(hero\.png\)/);
  assert.match(instruction, /<Picture 3>/);
  assert.match(instruction, /not a frame-zero lock/i);
  assert.doesNotMatch(instruction, /T2VA.*I2VA.*first-frame/i);
});

test("custom multi-reference continuation prompt gets an idempotent previous-tail label", () => {
  const prompt = buildRef2VAPrompt({ description: "preserve the subject" });
  const refs = [{ root: "input", name: "hero.png" }, { root: "input", name: "style.png" }, { root: "output", name: "tail.png" }];
  const once = appendMultiReferenceTail(prompt, refs, "tail.png");
  const twice = appendMultiReferenceTail(once, refs, "tail.png");
  assert.match(once, /<Picture 3> is the previous segment's normalized tail frame/);
  assert.match(once, /do not lock it to frame 0/);
  assert.equal(twice, once);
});
