import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLongPlanRequest,
  buildLongDirectPlan,
  buildLongSaveRequest,
  composeLongScriptText,
  longScriptsToTimeline,
  parseLongTimelineDraft,
  resizeLongSegment,
  selectHydratableLongJob,
  validateLongCreate,
} from "../app/lib/long-create-contract.mjs";

const ASSET = { root: "input", name: "first.png", kind: "image" };

test("Long Create hydration restores the latest non-completed persisted sequence", () => {
  assert.equal(selectHydratableLongJob([{ id: "done", status: "completed" }, { id: "draft", status: "draft" }]).id, "draft");
  assert.equal(selectHydratableLongJob([{ id: "done", status: "completed" }]), null);
});

test("Long plan request fixes the storyboard visual reference to two seconds", () => {
  const payload = buildLongPlanRequest({
    title: "Story",
    inputType: "image",
    inputText: "A chase",
    referenceMode: "multi_reference",
    referenceAssets: [ASSET, { ...ASSET, name: "second.png" }],
    timelineMode: "auto",
    duration: 12,
    segmentDurationHint: 4,
    timelineText: "",
    promptProvider: "codex",
    ollamaModel: "ollama-model",
    codexModel: "gpt-5.6-luna",
    reasoningEffort: "medium",
    negativePrompt: "flicker",
    plannerImages: [{ role: "picture_1", data: "abc" }],
  });
  assert.equal(payload.inputAsset.name, "first.png");
  assert.equal(payload.referenceAssets[0].name, "second.png");
  assert.equal(payload.duration, 12);
  assert.equal(payload.timelineText, undefined);
  assert.equal(payload.reasoningEffort, "medium");
  assert.equal(payload.continuationMode, "motion_context");
  assert.equal(payload.motionContextSeconds, 2);
});

test("script list becomes one authoritative storyboard segment per script", () => {
  const scripts = [
    { id: "a", name: "開場", content: "人物走進雨夜街道", description: "雨夜街道的開場遠景", negativePrompt: "sunny", duration: 4 },
    { id: "b", name: "追逐", content: "人物開始奔跑", description: "角色沿街奔跑的追逐鏡頭", negativePrompt: "", duration: 6 },
  ];
  assert.deepEqual(longScriptsToTimeline(scripts).map(({ start, end, description }) => ({ start, end, description })), [
    { start: 0, end: 4, description: "雨夜街道的開場遠景" },
    { start: 4, end: 10, description: "角色沿街奔跑的追逐鏡頭" },
  ]);
  assert.match(composeLongScriptText(scripts), /劇本 2：追逐/);
  const payload = buildLongPlanRequest({ inputType: "text", scripts, timelineMode: "auto", duration: 99 });
  assert.equal(payload.timelineMode, "manual");
  assert.equal(payload.duration, 10);
  assert.equal(payload.timeline.length, 2);
  assert.equal(payload.timelineText, undefined);
});

test("direct long plan uses every script verbatim without an AI planner", () => {
  const scripts = [
    { id: "a", name: "開場", content: "subject_definitions: exact first prompt", description: "雨夜街道開場", negativePrompt: "first negative", duration: 4 },
    { id: "b", name: "結尾", content: "detailed_description: exact second prompt", description: "列車離站的結尾", negativePrompt: "", duration: 6 },
  ];
  const plan = buildLongDirectPlan({ title: "Direct", inputType: "image", referenceMode: "multi_reference", referenceAssets: [ASSET], scripts, negativePrompt: "global" });
  assert.deepEqual(plan.segments.map(({ description, prompt, promptSource, mode }) => ({ description, prompt, promptSource, mode })), [
    { description: "雨夜街道開場", prompt: scripts[0].content, promptSource: "manual", mode: "ref2v" },
    { description: "列車離站的結尾", prompt: scripts[1].content, promptSource: "manual", mode: "ref2v" },
  ]);
  assert.deepEqual(plan.continuityBible, {});
  assert.equal(plan.planMeta.source, "author");
  assert.equal(plan.duration, 10);
});

test("Long save request keeps persisted shape and canonical timeline duration", () => {
  const plan = { title: "Story", segments: [
    { start: 0, end: 5, description: "A", prompt: "P1" },
    { start: 5, end: 10, description: "B", prompt: "P2" },
  ] };
  const payload = buildLongSaveRequest({
    plan,
    title: "Story",
    inputType: "text",
    inputText: "A chase",
    referenceMode: "continuity",
    referenceAssets: [],
    timelineText: "[0 - 4] Opening\n[4 - 11] Ending",
    outputFolder: "story-001",
    modelProfile: "nvfp4_blackwell",
    width: 736,
    height: 416,
    steps: 20,
    seed: 12345,
    ollamaModel: "model",
    promptProvider: "ollama",
    codexModel: "gpt-5.6-luna",
    reasoningEffort: "medium",
    negativePrompt: "",
    seam: "keep_duplicate_frame",
    revision: 3,
  });
  assert.equal(payload.duration, 11);
  assert.equal(payload.segments[0].prompt, "P1");
  assert.equal(payload.segments[1].description, "Ending");
  assert.equal(payload.revision, 3);
  assert.equal(payload.continuationMode, "motion_context");
  assert.equal(payload.motionContextSeconds, 2);
});

test("Long validation covers story, images, timeline and render setup", () => {
  const base = {
    inputText: "Story",
    inputType: "text",
    referenceAssets: [],
    timelineMode: "auto",
    duration: 10,
    segmentDurationHint: 5,
    timelineText: "",
    width: 736,
    height: 416,
    steps: 20,
    seed: 12345,
    requireSavedPlan: false,
  };
  assert.deepEqual(validateLongCreate(base), []);
  assert.match(validateLongCreate({ ...base, inputText: "" })[0].message, /故事描述/);
  assert.match(validateLongCreate({ ...base, inputType: "image" })[0].message, /起始參考圖片/);
  assert.match(validateLongCreate({ ...base, timelineMode: "manual", timelineText: "one" })[0].message, /至少需要兩段/);
  assert.match(validateLongCreate({ ...base, width: 750 })[0].message, /32 的倍數/);
  assert.deepEqual(validateLongCreate({ ...base, continuationMode: "motion_context", motionContextSeconds: 2, modelProfile: "nvfp4_blackwell" }), []);
});

test("Long validation requires at least two complete script cards", () => {
  const base = { scripts: [
    { name: "A", content: "First", duration: 5 },
    { name: "B", content: "Second", duration: 5 },
  ], inputType: "text", referenceAssets: [], modelProfile: "nvfp4_blackwell", width: 736, height: 416, steps: 20, seed: 1 };
  assert.deepEqual(validateLongCreate(base), []);
  assert.match(validateLongCreate({ ...base, scripts: base.scripts.slice(0, 1) })[0].message, /至少需要兩個劇本/);
  assert.match(validateLongCreate({ ...base, scripts: [{ ...base.scripts[0], content: "" }, base.scripts[1]] })[0].message, /劇本 1/);
});

test("latent continuation requires an image-origin long video", () => {
  const base = {
    scripts: [
      { name: "one", content: "first", description: "first", duration: 5 },
      { name: "two", content: "second", description: "second", duration: 5 },
    ],
    continuationMode: "latent_context",
    motionContextSeconds: 2,
    modelProfile: "nvfp4_blackwell",
    timelineMode: "auto",
    duration: 10,
    segmentDurationHint: 5,
    width: 736,
    height: 416,
    steps: 20,
    seed: 1,
  };
  assert.match(validateLongCreate({ ...base, inputType: "text", referenceAssets: [] })[0].message, /圖片開始/);
  assert.deepEqual(validateLongCreate({ ...base, inputType: "image", referenceAssets: [{ name: "start.png", root: "input" }] }), []);
});

test("Long timeline draft parses range and duration forms", () => {
  assert.deepEqual(parseLongTimelineDraft("[0 - 4] A\n3 sec B", []), [
    { start: 0, end: 4, duration: 4, description: "A" },
    { start: 4, end: 7, duration: 3, description: "B" },
  ]);
});

test("resizing one long-video segment reflows only that segment and following timestamps", () => {
  const timeline = [
    { id: "s1", start: 0, end: 4, duration: 4, description: "A" },
    { id: "s2", start: 4, end: 7, duration: 3, description: "B" },
    { id: "s3", start: 7, end: 10, duration: 3, description: "C" },
  ];
  assert.deepEqual(resizeLongSegment(timeline, 1, 5).map(({ start, end, duration }) => ({ start, end, duration })), [
    { start: 0, end: 4, duration: 4 },
    { start: 4, end: 9, duration: 5 },
    { start: 9, end: 12, duration: 3 },
  ]);
  assert.deepEqual(resizeLongSegment(timeline, 0, 2).map(({ start, end, duration }) => ({ start, end, duration })), [
    { start: 0, end: 2, duration: 2 },
    { start: 2, end: 5, duration: 3 },
    { start: 5, end: 8, duration: 3 },
  ]);
});
