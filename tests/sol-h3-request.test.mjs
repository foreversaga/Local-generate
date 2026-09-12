import test from "node:test";
import assert from "node:assert/strict";

import {
  inferSolH3MediaKind,
  normalizeSolH3Request,
} from "../server/sol-h3/request.mjs";

test("normalizes the t2va contract and forces native audio", () => {
  assert.deepEqual(
    normalizeSolH3Request({ mode: "t2va", prompt: "海邊的風聲", seed: 7 }),
    {
      schemaVersion: 1,
      mode: "t2va",
      prompt: "海邊的風聲",
      seed: 7,
      audio: { generate: true },
      inputs: {},
    },
  );
});

test("rejects media attached to t2va and incomplete fl2va", () => {
  assert.throws(
    () => normalizeSolH3Request({ mode: "t2va", prompt: "x", inputs: { firstFrame: {} } }),
    { code: "SOL_H3_T2VA_INPUTS_UNSUPPORTED", status: 422 },
  );
  assert.throws(
    () => normalizeSolH3Request({ mode: "fl2va", prompt: "x", inputs: { firstFrame: { root: "comfyui-input", relativePath: "a.png" } } }),
    { code: "SOL_H3_FL2VA_FRAMES_REQUIRED", status: 422 },
  );
});

test("accepts documented ComfyUI roots and normalizes them for the local media resolver", () => {
  const request = normalizeSolH3Request({
    mode: "fl2va",
    prompt: "自然過渡",
    inputs: {
      firstFrame: { root: "comfyui-input", relativePath: "start.png" },
      lastFrame: { root: "comfyui-output", relativePath: "renders/end.png" },
    },
  });
  assert.equal(request.inputs.firstFrame.root, "input");
  assert.equal(request.inputs.lastFrame.root, "output");
});

test("keeps compatibility with jobs from the first adapter revision", () => {
  const request = normalizeSolH3Request({
    mode: "ref2va",
    prompt: "保持人物特徵",
    inputs: { references: [{ root: "output", relativePath: "clips/source.mp4", kind: "video" }] },
  });
  assert.equal(request.inputs.references[0].root, "output");
});

test("limits ref2va MVP to one safe media locator", () => {
  const request = normalizeSolH3Request({
    mode: "ref2va",
    prompt: "保持人物特徵",
    inputs: { references: [{ root: "comfyui-output", relativePath: "clips/source.mp4", kind: "video" }] },
  });
  assert.equal(request.inputs.references[0].relativePath, "clips/source.mp4");
  assert.throws(
    () => normalizeSolH3Request({ mode: "ref2va", prompt: "x", inputs: { references: [] } }),
    { code: "SOL_H3_REF2VA_REFERENCE_COUNT", status: 422 },
  );
  assert.throws(
    () => normalizeSolH3Request({ mode: "ref2va", prompt: "x", inputs: { references: [{ root: "comfyui-input", relativePath: "../secret.png" }] } }),
    { code: "SOL_H3_MEDIA_PATH_INVALID", status: 422 },
  );
});

test("counts prompt length by Unicode code points rather than UTF-16 units", () => {
  assert.doesNotThrow(() => normalizeSolH3Request({ mode: "t2va", prompt: "😀".repeat(4000) }));
  assert.throws(
    () => normalizeSolH3Request({ mode: "t2va", prompt: "😀".repeat(4001) }),
    { code: "SOL_H3_PROMPT_TOO_LONG", status: 422 },
  );
});

test("rejects unsupported locator and fingerprint fields", () => {
  assert.throws(
    () => normalizeSolH3Request({
      mode: "ref2va",
      prompt: "x",
      inputs: { references: [{ root: "comfyui-output", relativePath: "a.mp4", absolutePath: "/tmp/a.mp4" }] },
    }),
    { code: "SOL_H3_FIELD_UNSUPPORTED", status: 422 },
  );
  assert.throws(
    () => normalizeSolH3Request({
      mode: "ref2va",
      prompt: "x",
      inputs: { references: [{ root: "comfyui-output", relativePath: "a.mp4", fingerprint: { size: -1 } }] },
    }),
    { code: "SOL_H3_MEDIA_FINGERPRINT_INVALID", status: 422 },
  );
});

test("infers the official reference media kinds", () => {
  assert.equal(inferSolH3MediaKind("start.PNG"), "image");
  assert.equal(inferSolH3MediaKind("source.webm"), "video");
  assert.equal(inferSolH3MediaKind("voice.wav"), "audio");
});
