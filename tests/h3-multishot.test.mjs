import "./test-isolation.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildAutoExtendPrompts,
  buildShotWindows,
  evaluateMotionContextCapability,
  MOTION_CONTEXT_NODE_CONTRACT,
  normalizeMultishotSettings,
  resolveMultishotContinuity,
  splitManualShotPrompts,
} from "../server/long-video/multishot.mjs";
import { createSequenceRecord, LongVideoError, validateSequenceInput } from "../server/long-video/schema.mjs";
import { trimLeadingOverlap } from "../server/long-video/media.mjs";
import { contextPinRenderedDuration, runSequence } from "../server/long-video/runner.mjs";
import { handleLongVideoRoute } from "../server/long-video/api.mjs";

function timeline(count, seconds = 10.125) {
  return Array.from({ length: count }, (_, index) => ({
    start: Number((index * seconds).toFixed(3)),
    end: Number(((index + 1) * seconds).toFixed(3)),
    description: `window ${index + 1}`,
    prompt: `prompt ${index + 1}`,
  }));
}

function multishotPayload(overrides = {}) {
  return {
    title: "Multishot",
    inputType: "text",
    longVideoEnabled: true,
    targetDurationSeconds: 30.375,
    duration: 30.375,
    framesPerShot: 243,
    continuityMode: "first_frame",
    promptMode: "auto_extend",
    identityAnchor: true,
    voiceContinuity: true,
    contextFrames: 22,
    chainGainControl: "off",
    masterNormalize: "off",
    timeline: timeline(3),
    outputFolder: "multishot-test",
    ...overrides,
  };
}

test("multishot selectors show an explanation for the current option", async () => {
  const source = await readFile(new URL("../app/components/create/LongCreateForm.tsx", import.meta.url), "utf8");
  for (const binding of [
    "helper={MULTISHOT_FRAMES_HELP[framesPerShot]}",
    "MULTISHOT_CONTINUITY_HELP[continuityMode]",
    "helper={MULTISHOT_PROMPT_HELP[promptMode]}",
    "CONTEXT_FRAMES_HELP[contextFrames]",
    "helper={CHAIN_GAIN_HELP[chainGainControl]}",
    "helper={MASTER_NORMALIZE_HELP[masterNormalize]}",
  ]) assert.match(source, new RegExp(binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(source, /目前本機不可用，提交時會自動退回 first_frame/);
  assert.match(source, /這不是音量控制/);
  assert.match(source, /直接合併片段、不重新編碼/);
  assert.match(source, /高畫質 INT8 ConvRot/);
  assert.match(source, /使用更多 UMA、生成稍慢/);
  assert.match(source, /<select id="long-model-profile"/);
});

test("multishot settings compute H3-native windows at 24 FPS", () => {
  const settings = normalizeMultishotSettings({ longVideoEnabled: true, targetDurationSeconds: 60, framesPerShot: 243 });
  assert.equal(settings.fps, 24);
  assert.equal(settings.secondsPerShot, 10.125);
  assert.equal(settings.shotCount, 6);
  assert.equal(buildShotWindows(settings).length, 6);
});

test("manual and automatic shot prompts preserve one continuous take", () => {
  assert.deepEqual(splitManualShotPrompts("one\n---\ntwo", 2), ["one", "two"]);
  assert.throws(() => splitManualShotPrompts("one", 2), (error) => error.code === "MANUAL_SHOT_COUNT_MISMATCH");
  const prompts = buildAutoExtendPrompts("An adult walks through rain.", 3);
  assert.match(prompts[1], /Continue naturally from the previous moment/);
  assert.doesNotMatch(prompts[1], /cut to/i);
  assert.match(prompts[2], /stable readable face/);
});

test("automatic multishot prompts assign timestamped story beats to only their own windows", async () => {
  const { buildLongDirectPlan } = await import("../app/lib/long-create-contract.mjs");
  const plan = buildLongDirectPlan(multishotPayload({
    targetDurationSeconds: 30,
    inputText: [
      "主角設定：同一位成年女性，臉孔與髮型一致。",
      "00:00–00:10｜LOOK 1",
      "她穿白色連身裝，在咖啡館起身。",
      "00:10–00:20｜LOOK 2",
      "她換成藍色牛仔褲，走到窗邊。",
      "00:20–00:30｜LOOK 3",
      "她穿黃色洋裝走到戶外。",
      "整體攝影要求：自然光、寫實膚質。",
    ].join("\n\n"),
  }));
  assert.equal(plan.segments.length, 3);
  assert.match(plan.segments[0].prompt, /白色連身裝/);
  assert.doesNotMatch(plan.segments[0].prompt, /藍色牛仔褲|黃色洋裝/);
  assert.match(plan.segments[1].prompt, /藍色牛仔褲/);
  assert.doesNotMatch(plan.segments[1].prompt, /白色連身裝|黃色洋裝/);
  assert.match(plan.segments[2].prompt, /黃色洋裝/);
  for (const segment of plan.segments) {
    assert.match(segment.prompt, /同一位成年女性/);
    assert.match(segment.prompt, /自然光、寫實膚質/);
    assert.match(segment.prompt, /do not preview, summarize, montage, or complete later windows/i);
  }
});

test("Motion Context capability validates the real node and input contract", () => {
  const objectInfo = Object.fromEntries(Object.entries(MOTION_CONTEXT_NODE_CONTRACT).map(([name, inputs]) => [name, { input: { required: Object.fromEntries(inputs.map((input) => [input, ["*"]])) } }]));
  assert.deepEqual(evaluateMotionContextCapability(objectInfo), { available: true, missingNodes: [], missingInputs: [] });
  delete objectInfo.MiniMaxH3MotionContextLoadLatent;
  const unavailable = evaluateMotionContextCapability(objectInfo);
  assert.equal(unavailable.available, false);
  assert.deepEqual(unavailable.missingNodes, ["MiniMaxH3MotionContextLoadLatent"]);
  assert.deepEqual(resolveMultishotContinuity("context_pin", unavailable), {
    requested: "context_pin",
    effective: "first_frame",
    fallback: true,
    warning: "context_pin is unavailable; using first_frame (MiniMaxH3MotionContextLoadLatent).",
  });
});

test("multishot validation returns stable 400 codes and persists settings", () => {
  for (const [field, value, code] of [
    ["targetDurationSeconds", 0, "TARGET_DURATION_SECONDS_INVALID"],
    ["framesPerShot", 244, "FRAMES_PER_SHOT_INVALID"],
    ["continuityMode", "decoded_reencode", "CONTINUITY_MODE_INVALID"],
    ["promptMode", "cuts", "PROMPT_MODE_INVALID"],
    ["contextFrames", 23, "CONTEXT_FRAMES_INVALID"],
    ["chainGainControl", "blur", "CHAIN_GAIN_CONTROL_INVALID"],
    ["masterNormalize", "rgb", "MASTER_NORMALIZE_INVALID"],
  ]) {
    assert.throws(() => validateSequenceInput(multishotPayload({ [field]: value })), (error) => error instanceof LongVideoError && error.status === 400 && error.code === code);
  }
  const record = createSequenceRecord(multishotPayload({ continuityMode: "context_pin", chainGainControl: "flatten", masterNormalize: "luma" }));
  assert.equal(record.shotCount, 3);
  assert.equal(record.continuityMode, "context_pin");
  assert.equal(record.contextFrames, 22);
  assert.equal(record.chainGainControl, "flatten");
  assert.equal(record.masterNormalize, "luma");
});

test("first_frame runner keeps original references separate and trims synchronized overlap", async () => {
  const generated = [];
  const trimmed = [];
  const normalizedDurations = [];
  const job = {
    ...createSequenceRecord(multishotPayload({
      inputType: "image",
      referenceMode: "multi_reference",
      inputAsset: { root: "input", name: "identity.png", kind: "image" },
      targetDurationSeconds: 20.25,
      duration: 20.25,
      timeline: timeline(2),
    }), { id: "m" }),
    outputPath: "/tmp/memory-multishot",
  };
  await runSequence(job, {
    generate: async (payload) => { generated.push(payload); return { outputPath: payload.outputPath, job: { elapsedMs: 1_234 } }; },
    normalize: async ({ outputPath, duration }) => { normalizedDurations.push(duration); return { outputPath }; },
    extractTail: async ({ outputPath }) => ({ outputPath }),
    trimOverlap: async (payload) => { trimmed.push(payload); return { outputPath: payload.outputPath, trimmedFrames: 1 }; },
    assemble: async ({ outputFolder, masterNormalize }) => ({ outputPath: `${outputFolder}/final.mp4`, revision: 1, probe: {}, masterNormalize }),
    writeManifest: async () => {},
    updateJob: async () => {},
    updateSegment: async () => {},
    log: async () => {},
  });
  assert.equal(generated[0].mode, "ref2v");
  assert.equal(generated[1].mode, "ref2v");
  assert.deepEqual(generated[1].referenceImageNames, ["identity.png"]);
  assert.match(generated[1].continuationFramePath, /tail\.png$/);
  assert.equal(trimmed.length, 1);
  assert.equal(trimmed[0].frames, 1);
  assert.deepEqual(normalizedDurations, [10.125, 10.125 + 1 / 24]);
});

test("a one-window first_frame job submits the unchanged base H3 generation path", async () => {
  const job = {
    ...createSequenceRecord(multishotPayload({ targetDurationSeconds: 10.125, duration: 10.125, timeline: timeline(1) }), { id: "q" }),
    outputPath: "/tmp/memory-one-window",
  };
  let submitted;
  let assemblyInput;
  await runSequence(job, {
    generate: async (payload) => { submitted = payload; return payload.outputPath; },
    normalize: async ({ outputPath }) => ({ outputPath }), extractTail: async ({ outputPath }) => ({ outputPath }),
    assemble: async (payload) => { assemblyInput = payload; return { outputPath: `${payload.outputFolder}/final.mp4`, revision: 1, probe: {} }; },
    writeManifest: async () => {}, updateJob: async () => {}, updateSegment: async () => {}, log: async () => {},
  });
  assert.equal(submitted.mode, "t2v");
  assert.equal(submitted.continuationFramePath, undefined);
  assert.equal(submitted.latentContinuation, undefined);
  assert.equal(assemblyInput.allowSingleSegment, true);
});

test("overlap trim removes matching video and audio time", async () => {
  let args;
  await trimLeadingOverlap({
    inputPath: "/tmp/in.mp4",
    outputPath: "/tmp/out.mp4",
    frames: 22,
    fps: 24,
    run: async (_executable, nextArgs) => { args = nextArgs; return { exitCode: 0, stderr: "" }; },
    tools: { executables: { ffmpeg: "ffmpeg" } },
  });
  assert.ok(args.includes("trim=start_frame=22,setpts=PTS-STARTPTS"));
  assert.ok(args.includes("atrim=start=0.916666667,asetpts=PTS-STARTPTS"));
});

test("health exposes unavailable context_pin capability without hiding the missing nodes", async () => {
  const response = { headersSent: false, writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
  const handled = await handleLongVideoRoute({ method: "GET", url: "/api/sequences/health", async *[Symbol.asyncIterator]() {} }, response, {
    capabilities: async () => ({ available: false, missingNodes: ["MiniMaxH3MotionContext"], missingInputs: [] }),
  });
  assert.equal(handled, true);
  assert.equal(response.status, 200);
  assert.equal(response.body.continuity.firstFrame.available, true);
  assert.equal(response.body.continuity.contextPin.available, false);
  assert.deepEqual(response.body.continuity.contextPin.missingNodes, ["MiniMaxH3MotionContext"]);
});

test("context_pin records an explicit fallback and submits first_frame instead of crashing", async () => {
  const job = {
    ...createSequenceRecord(multishotPayload({ continuityMode: "context_pin", targetDurationSeconds: 20.25, duration: 20.25, timeline: timeline(2) }), { id: "x" }),
    outputPath: "/tmp/memory-context-fallback",
  };
  const generated = [];
  await runSequence(job, {
    motionContextCapability: async () => ({ available: false, missingNodes: ["MiniMaxH3MotionContext"], missingInputs: [] }),
    generate: async (payload) => { generated.push(payload); return payload.outputPath; },
    normalize: async ({ outputPath }) => ({ outputPath }),
    extractTail: async ({ outputPath }) => ({ outputPath }),
    trimOverlap: async ({ outputPath }) => ({ outputPath, trimmedFrames: 1 }),
    assemble: async ({ outputFolder }) => ({ outputPath: `${outputFolder}/final.mp4`, revision: 1, probe: {} }),
    writeManifest: async () => {}, updateJob: async () => {}, updateSegment: async () => {}, log: async () => {},
  });
  assert.equal(job.effectiveContinuityMode, "first_frame");
  assert.equal(job.continuityFallback, true);
  assert.match(job.continuityWarning, /using first_frame/);
  assert.equal(generated[1].latentContinuation, undefined);
  assert.equal(generated[1].mode, "i2v");
});

test("available context_pin relays raw AV latent metadata and never decoded media", async () => {
  const job = {
    ...createSequenceRecord(multishotPayload({ continuityMode: "context_pin", targetDurationSeconds: 20.25, duration: 20.25, timeline: timeline(2) }), { id: "z" }),
    outputPath: "/tmp/memory-context-pin",
  };
  const generated = [];
  let assemblyDuration;
  await runSequence(job, {
    motionContextCapability: async () => ({ available: true, missingNodes: [], missingInputs: [] }),
    generate: async (payload) => { generated.push(payload); return { outputPath: payload.outputPath, job: { elapsedMs: 1_234 } }; },
    normalize: async ({ outputPath }) => ({ outputPath }), extractTail: async ({ outputPath }) => ({ outputPath }),
    assemble: async ({ outputFolder, duration }) => { assemblyDuration = duration; return { outputPath: `${outputFolder}/final.mp4`, revision: 1, probe: {} }; },
    writeManifest: async () => {}, updateJob: async () => {}, updateSegment: async () => {}, log: async () => {},
  });
  assert.equal(generated[1].latentContinuation, true);
  assert.equal(generated[1].latentContextFrames, 22);
  assert.equal(generated[1].latentDeliveryPolicy, "ceil");
  assert.equal(generated[1].latentPreviousClipIndex, 1);
  assert.equal(generated[1].inputVideoPath, undefined);
  assert.equal(generated[1].continuationFramePath, undefined);
  assert.equal(contextPinRenderedDuration(243 / 24, 1), 255 / 24);
  assert.equal(assemblyDuration, 20.25, "assembly validates the normalized timeline, not the longer raw H3 frame grid");
  assert.ok(job.segments.every((segment) => Number.isFinite(Date.parse(segment.completedAt))));
  assert.ok(job.segments.every((segment) => segment.childElapsedMs === 1_234));
  assert.ok(job.segments.every((segment) => Number.isFinite(segment.elapsedMs)));
  assert.ok(Number.isFinite(Date.parse(job.completedAt)));
  assert.ok(Number.isFinite(job.elapsedMs));
});
