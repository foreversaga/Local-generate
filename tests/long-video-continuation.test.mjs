import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildDeterministicContinuationPrompt,
  createContinuationPromptFinalizer,
} from "../server/long-video/continuation-finalizer.mjs";
import { buildI2VAPrompt, buildRef2VAPrompt, buildT2VAPrompt } from "../server/long-video/prompt-builder.mjs";
import { appendMultiReferenceTail, runSequence } from "../server/long-video/runner.mjs";
import { validatePrompt } from "../server/long-video/prompt-validator.mjs";
import { sequenceAttemptFile } from "../server/long-video/paths.mjs";

test("vision finalizer sends actual normalized tail bytes and all continuation context", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-tail-vision-"));
  const tailPath = path.join(root, "normalized-tail.png");
  const tailBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
  await writeFile(tailPath, tailBytes);
  const draftPrompt = buildI2VAPrompt({ description: "the locked next action continues toward the doorway" });
  let request;
  const finalizer = createContinuationPromptFinalizer({
    model: "vision-test-model",
    tailRoot: root,
    request: async (input) => {
      request = input;
      return { payload: { response: draftPrompt } };
    },
  });
  const result = await finalizer({
    mode: "i2v",
    segment: { prompt: draftPrompt },
    draftPrompt,
    previousTail: tailPath,
    tailRoot: root,
    previousEndingState: "the subject's left hand is raised and the camera is moving left",
    continuityBible: { visualStyle: "documentary", motionDirection: "left" },
  });

  assert.equal(request.model, "vision-test-model");
  assert.deepEqual(request.body.images, [tailBytes.toString("base64")]);
  assert.equal(request.tailImage.mimeType, "image/png");
  assert.equal(request.tailImage.byteLength, tailBytes.length);
  assert.match(request.body.prompt, /CONTINUITY BIBLE/);
  assert.match(request.body.prompt, /the subject's left hand is raised/);
  assert.match(request.body.prompt, /locked next action continues/);
  assert.equal(result.prompt, draftPrompt);
  assert.deepEqual(result.provenance, {
    provider: "ollama-vision",
    model: "vision-test-model",
    fallback: false,
    reason: "vision_success",
  });
  assert.doesNotMatch(JSON.stringify(result), /normalized-tail|base64|iVBOR/);
});

test("coordinator continuation exposes cleanup completion and blocks on explicit unload failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-tail-coordinator-"));
  const tailPath = path.join(root, "normalized-tail.png");
  await writeFile(tailPath, Buffer.from([137, 80, 78, 71]));
  const draftPrompt = buildI2VAPrompt({ description: "continue the locked movement" });
  const successful = createContinuationPromptFinalizer({
    model: "vision-test-model",
    tailRoot: root,
    ollamaCoordinator: {
      generate: async () => ({ payload: { response: draftPrompt } }),
    },
  });
  const result = await successful({
    mode: "i2v",
    segment: { prompt: draftPrompt },
    draftPrompt,
    previousTail: tailPath,
    tailRoot: root,
    continuityBible: {},
  });
  assert.deepEqual(await result.ollamaPromptBarrier, { ok: true, scope: "continuation-prompt" });

  const failed = createContinuationPromptFinalizer({
    model: "vision-test-model",
    tailRoot: root,
    ollamaCoordinator: {
      generate: async () => {
        throw Object.assign(new Error("explicit stop denied"), { code: "OLLAMA_UNLOAD_FAILED" });
      },
    },
  });
  await assert.rejects(
    failed({
      mode: "i2v",
      segment: { prompt: draftPrompt },
      draftPrompt,
      previousTail: tailPath,
      tailRoot: root,
      continuityBible: {},
    }),
    (error) => error?.code === "OLLAMA_UNLOAD_FAILED" && /explicit stop denied/.test(error.message),
  );
});

test("vision timeout and unsafe tail use deterministic fallback without rejecting", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-tail-fallback-"));
  const tailPath = path.join(root, "normalized-tail.png");
  await writeFile(tailPath, Buffer.from("tail-bytes"));
  const draftPrompt = buildI2VAPrompt({ description: "keep the locked subject walking forward" });
  const timeoutFinalizer = createContinuationPromptFinalizer({
    model: "vision-test-model",
    tailRoot: root,
    request: async () => { throw Object.assign(new Error("vision timed out"), { code: "VISION_TIMEOUT" }); },
  });
  const timedOut = await timeoutFinalizer({
    mode: "i2v",
    segment: { prompt: draftPrompt },
    draftPrompt,
    previousTail: tailPath,
    tailRoot: root,
    previousEndingState: "walking with the right foot forward",
    continuityBible: {},
  });
  assert.equal(timedOut.provenance.provider, "ollama-vision");
  assert.equal(timedOut.provenance.model, "vision-test-model");
  assert.equal(timedOut.provenance.fallback, true);
  assert.equal(timedOut.provenance.errorCode, "VISION_TIMEOUT");
  assert.match(timedOut.prompt, /actual normalized previous-segment tail frame/i);
  assert.match(timedOut.prompt, /walking with the right foot forward/);
  assert.match(timedOut.prompt, /locked subject walking forward/);

  const unsafe = await timeoutFinalizer({
    mode: "i2v",
    segment: { prompt: draftPrompt },
    draftPrompt,
    previousTail: path.join(root, "..", "outside.png"),
    tailRoot: root,
    previousEndingState: "walking with the right foot forward",
    continuityBible: {},
  });
  assert.equal(unsafe.provenance.fallback, true);
  assert.equal(unsafe.provenance.errorCode, "TAIL_IMAGE_OUTSIDE_SEQUENCE");
  assert.doesNotMatch(unsafe.prompt, /outside\.png/);
});

test("runner invokes finalizer only for later segments and persists previous-ending provenance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-runner-finalizer-"));
  const previousDataRoot = process.env.H3_SEQUENCE_DATA_ROOT;
  const previousOutputRoot = process.env.COMFYUI_OUTPUT_ROOT;
  process.env.H3_SEQUENCE_DATA_ROOT = path.join(root, "data");
  process.env.COMFYUI_OUTPUT_ROOT = path.join(root, "output");
  const output = path.join(root, "output", "runner-finalizer");
  const firstPrompt = buildT2VAPrompt({ description: "opening scene" });
  const secondPrompt = buildI2VAPrompt({ description: "locked second-segment action" });
  const thirdPrompt = buildI2VAPrompt({ description: "locked third-segment action" });
  const job = {
    id: "runner-finalizer",
    inputType: "text",
    outputPath: output,
    outputFolder: "runner-finalizer",
    status: "ready",
    revision: 1,
    width: 736,
    height: 416,
    steps: 2,
    seed: 10,
    continuityBible: { motionDirection: "left" },
    segments: [
      { id: "s1", start: 0, end: 5, duration: 5, description: "opening", endingState: "left hand raised", prompt: firstPrompt },
      { id: "s2", start: 5, end: 10, duration: 5, description: "second", endingState: "near doorway", prompt: secondPrompt },
      { id: "s3", start: 10, end: 15, duration: 5, description: "third", endingState: "door opens", prompt: thirdPrompt },
    ],
  };
  const finalizerCalls = [];
  try {
    const result = await runSequence(job, {
      finalizePrompt: async (context) => {
        finalizerCalls.push(context);
        return {
          prompt: context.draftPrompt,
          provenance: { provider: "test-vision", model: "fixture-model", fallback: false, reason: "fixture_success" },
        };
      },
      generate: async ({ outputPath, segmentIndex }) => ({ rawPath: outputPath, id: `generation-${segmentIndex}` }),
      normalize: async () => {},
      extractTail: async () => {},
      assemble: async ({ outputFolder, segmentPaths }) => ({ outputPath: path.join(outputFolder, "final.mp4"), segmentPaths }),
      updateJob: async (target, patch) => Object.assign(target, patch),
      updateSegment: async (target, index, patch) => Object.assign(target.segments[index], patch),
      writeManifest: async () => {},
      log: async () => {},
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(finalizerCalls.map((call) => call.segmentIndex), [1, 2]);
    assert.equal(finalizerCalls[0].previousEndingState, "left hand raised");
    assert.equal(finalizerCalls[1].previousEndingState, "near doorway");
    assert.equal(finalizerCalls[0].draftPrompt, secondPrompt);
    assert.equal(finalizerCalls[0].tailRoot, output);
    const attempt = JSON.parse(await readFile(sequenceAttemptFile(job.id, 1, 1), "utf8"));
    assert.deepEqual(attempt.promptFinalization, {
      provider: "test-vision",
      model: "fixture-model",
      fallback: false,
      reason: "fixture_success",
    });
    assert.deepEqual(job.segments[1].promptFinalization, attempt.promptFinalization);
    assert.doesNotMatch(JSON.stringify(attempt), /base64|normalized-tail/);
  } finally {
    if (previousDataRoot === undefined) delete process.env.H3_SEQUENCE_DATA_ROOT;
    else process.env.H3_SEQUENCE_DATA_ROOT = previousDataRoot;
    if (previousOutputRoot === undefined) delete process.env.COMFYUI_OUTPUT_ROOT;
    else process.env.COMFYUI_OUTPUT_ROOT = previousOutputRoot;
  }
});

test("planner cleanup receipt gates only the initial H3 segment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-runner-planner-receipt-"));
  const previousDataRoot = process.env.H3_SEQUENCE_DATA_ROOT;
  const previousOutputRoot = process.env.COMFYUI_OUTPUT_ROOT;
  process.env.H3_SEQUENCE_DATA_ROOT = path.join(root, "data");
  process.env.COMFYUI_OUTPUT_ROOT = path.join(root, "output");
  const output = path.join(root, "output", "planner-receipt");
  const job = {
    id: "planner-receipt",
    inputType: "text",
    outputPath: output,
    outputFolder: "planner-receipt",
    status: "ready",
    revision: 1,
    width: 736,
    height: 416,
    steps: 2,
    seed: 1,
    planMeta: { ollamaPromptReceipt: "ollama-prompt-1234567890abcdef1234" },
    continuityBible: {},
    segments: [
      { id: "s1", start: 0, end: 5, duration: 5, description: "opening", prompt: buildT2VAPrompt({ description: "opening" }) },
      { id: "s2", start: 5, end: 10, duration: 5, description: "continue", prompt: buildI2VAPrompt({ description: "continue" }) },
    ],
  };
  const generationCalls = [];
  try {
    const result = await runSequence(job, {
      generate: async (payload) => { generationCalls.push(payload); return { rawPath: payload.outputPath }; },
      normalize: async () => {},
      extractTail: async () => {},
      assemble: async ({ outputFolder }) => ({ outputPath: path.join(outputFolder, "final.mp4") }),
      updateJob: async (target, patch) => Object.assign(target, patch),
      updateSegment: async (target, index, patch) => Object.assign(target.segments[index], patch),
      writeManifest: async () => {},
      log: async () => {},
    });
    assert.equal(result.status, "completed");
    assert.equal(generationCalls[0].ollamaPromptReceipt, job.planMeta.ollamaPromptReceipt);
    assert.equal("ollamaPromptReceipt" in generationCalls[1], false);
  } finally {
    if (previousDataRoot === undefined) delete process.env.H3_SEQUENCE_DATA_ROOT;
    else process.env.H3_SEQUENCE_DATA_ROOT = previousDataRoot;
    if (previousOutputRoot === undefined) delete process.env.COMFYUI_OUTPUT_ROOT;
    else process.env.COMFYUI_OUTPUT_ROOT = previousOutputRoot;
  }
});

test("runner continues after a rejected vision finalizer under strict unhandled rejection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-runner-fallback-"));
  const previousDataRoot = process.env.H3_SEQUENCE_DATA_ROOT;
  const previousOutputRoot = process.env.COMFYUI_OUTPUT_ROOT;
  process.env.H3_SEQUENCE_DATA_ROOT = path.join(root, "data");
  process.env.COMFYUI_OUTPUT_ROOT = path.join(root, "output");
  const output = path.join(root, "output", "runner-fallback");
  const job = {
    id: "runner-fallback",
    inputType: "text",
    outputPath: output,
    outputFolder: "runner-fallback",
    status: "ready",
    revision: 1,
    width: 736,
    height: 416,
    steps: 2,
    seed: 1,
    continuityBible: {},
    segments: [
      { id: "s1", start: 0, end: 5, duration: 5, description: "opening", endingState: "subject stops", prompt: buildT2VAPrompt({ description: "opening" }) },
      { id: "s2", start: 5, end: 10, duration: 5, description: "continue locked walk", prompt: buildI2VAPrompt({ description: "continue locked walk" }) },
    ],
  };
  try {
    const result = await runSequence(job, {
      finalizePrompt: async () => { throw Object.assign(new Error("vision model unavailable"), { code: "OLLAMA_UNAVAILABLE" }); },
      generate: async ({ outputPath }) => ({ rawPath: outputPath }),
      normalize: async () => {},
      extractTail: async () => {},
      assemble: async ({ outputFolder }) => ({ outputPath: path.join(outputFolder, "final.mp4") }),
      updateJob: async (target, patch) => Object.assign(target, patch),
      updateSegment: async (target, index, patch) => Object.assign(target.segments[index], patch),
      writeManifest: async () => {},
      log: async () => {},
    });
    assert.equal(result.status, "completed");
    assert.equal(job.segments[1].promptFinalization.fallback, true);
    assert.equal(job.segments[1].promptFinalization.errorCode, "OLLAMA_UNAVAILABLE");
    assert.match(job.segments[1].prompt, /actual normalized previous-segment tail frame/i);
    assert.match(job.segments[1].prompt, /continue locked walk/);
  } finally {
    if (previousDataRoot === undefined) delete process.env.H3_SEQUENCE_DATA_ROOT;
    else process.env.H3_SEQUENCE_DATA_ROOT = previousDataRoot;
    if (previousOutputRoot === undefined) delete process.env.COMFYUI_OUTPUT_ROOT;
    else process.env.COMFYUI_OUTPUT_ROOT = previousOutputRoot;
  }
});

test("deterministic continuation keeps Ref2VA static references before the tail slot", () => {
  const references = Array.from({ length: 8 }, (_, index) => ({ root: "input", name: `static-${index + 1}.png`, kind: "image" }));
  const prompt = buildRef2VAPrompt({ description: "preserve the subject" }, {}, { assets: references });
  const continuation = buildDeterministicContinuationPrompt({
    draftPrompt: prompt,
    segment: { description: "preserve the subject" },
    mode: "ref2v",
    references: [...references, { root: "output", name: "segment-001-tail.png", kind: "image" }],
    previousEndingState: "subject faces left",
  });
  assert.match(continuation, /subject faces left/);
  assert.match(continuation, /<Picture 8>/);
  assert.doesNotMatch(continuation, /<Picture 9>.*frame 0/i);
  const withTail = appendMultiReferenceTail(continuation, [...references, { root: "output", name: "segment-001-tail.png" }], "segment-001-tail.png");
  validatePrompt(withTail, { mode: "ref2v" });
  assert.match(withTail, /<Picture 9> is the previous segment's normalized tail frame/);
});

test("runner keeps eight static Ref2VA references ordered and appends one tail as slot nine", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-ref2v-tail-order-"));
  const previousDataRoot = process.env.H3_SEQUENCE_DATA_ROOT;
  const previousOutputRoot = process.env.COMFYUI_OUTPUT_ROOT;
  process.env.H3_SEQUENCE_DATA_ROOT = path.join(root, "data");
  process.env.COMFYUI_OUTPUT_ROOT = path.join(root, "output");
  const output = path.join(root, "output", "ref2v-tail-order");
  const staticRefs = Array.from({ length: 8 }, (_, index) => ({ root: "input", name: `static-${index + 1}.png`, kind: "image" }));
  const prompt = buildRef2VAPrompt({ description: "preserve the ordered reference subject" }, {}, { assets: staticRefs });
  const job = {
    id: "ref2v-tail-order",
    inputType: "text",
    referenceMode: "multi_reference",
    inputAsset: staticRefs[0],
    referenceAssets: staticRefs.slice(1),
    outputPath: output,
    outputFolder: "ref2v-tail-order",
    status: "ready",
    revision: 1,
    width: 736,
    height: 416,
    steps: 1,
    seed: 1,
    continuityBible: {},
    segments: [
      { id: "s1", start: 0, end: 5, duration: 5, description: "first", prompt },
      { id: "s2", start: 5, end: 10, duration: 5, description: "second", prompt },
    ],
  };
  const calls = [];
  try {
    const result = await runSequence(job, {
      generate: async (payload) => { calls.push(payload); return { rawPath: payload.outputPath }; },
      normalize: async () => {},
      extractTail: async () => {},
      assemble: async ({ outputFolder }) => ({ outputPath: path.join(outputFolder, "final.mp4") }),
      updateJob: async (target, patch) => Object.assign(target, patch),
      updateSegment: async (target, index, patch) => Object.assign(target.segments[index], patch),
      writeManifest: async () => {},
      log: async () => {},
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(calls[0].referenceImageNames, staticRefs.map((reference) => reference.name));
    assert.equal(calls[1].referenceImageNames.length, 9);
    assert.deepEqual(calls[1].referenceImageNames.slice(0, 8), staticRefs.map((reference) => reference.name));
    assert.match(calls[1].referenceImageNames[8], /segment-001-attempt-001-tail\.png$/);
    assert.equal(calls[1].referenceAssets[8].root, "output");
  } finally {
    if (previousDataRoot === undefined) delete process.env.H3_SEQUENCE_DATA_ROOT;
    else process.env.H3_SEQUENCE_DATA_ROOT = previousDataRoot;
    if (previousOutputRoot === undefined) delete process.env.COMFYUI_OUTPUT_ROOT;
    else process.env.COMFYUI_OUTPUT_ROOT = previousOutputRoot;
  }
});
