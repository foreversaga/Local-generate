import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { createCaptionService } from "../server/lora-training/captioner.mjs";

const JOB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const IMAGE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SECOND_IMAGE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

async function fixture({ requestFailure = false, stopExitCode = 0, imageCount = 1 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-caption-lifecycle-"));
  const images = path.join(root, "images");
  const captions = path.join(root, "captions");
  await mkdir(images, { recursive: true });
  await mkdir(captions, { recursive: true });
  await writeFile(path.join(images, "subject.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (imageCount > 1) await writeFile(path.join(images, "subject-2.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 2]));
  const calls = [];
  const stops = [];
  const manifestImages = [
    { id: IMAGE_ID, fileName: "subject.png", relativePath: "subject.png" },
    ...(imageCount > 1 ? [{ id: SECOND_IMAGE_ID, fileName: "subject-2.png", relativePath: "subject-2.png" }] : []),
  ];
  const dataset = {
    getLocations: () => ({ dataset: images, captions }),
    readManifest: async () => ({
      schemaVersion: 1,
      jobId: JOB_ID,
      revision: 1,
      images: manifestImages,
    }),
  };
  const fetchImpl = async (_url, init = {}) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.prompt === "") return { ok: true, status: 200, text: async () => "{}" };
    if (requestFailure) return { ok: false, status: 502, text: async () => "caption request failed" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ response: JSON.stringify({ caption: "portrait" }) }) };
  };
  const service = createCaptionService({
    dataset,
    fetchImpl,
    ollamaUrl: "http://ollama.test:11434",
    model: "caption-model",
    maxAttempts: 2,
    commandRunner: async (executable, args, options) => {
      stops.push({ executable, args, options });
      return { exitCode: stopExitCode, stdout: "", stderr: stopExitCode ? "stop failed" : "" };
    },
  });
  return { root, service, calls, stops, captions };
}

test("LoRA caption success preserves request fields and performs explicit stop", async () => {
  const value = await fixture();
  try {
    const record = await value.service.generateOne(JOB_ID, IMAGE_ID, ["subject"]);
    assert.equal(record.status, "ready");
    assert.equal(value.calls.length, 2);
    assert.deepEqual(value.calls[0], {
      model: "caption-model",
      prompt: "Describe this training image as concise comma-separated visual tags. Return only JSON with one string property named caption.\nRequired trigger words: subject",
      images: [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64")],
      format: "json",
      stream: false,
      keep_alive: 0,
    });
    assert.deepEqual(value.calls[1], { model: "caption-model", prompt: "", stream: false, keep_alive: 0 });
    assert.deepEqual(value.stops.map(({ executable, args }) => ({ executable, args })), [{
      executable: process.platform === "win32" ? "ollama.exe" : "ollama",
      args: ["stop", "caption-model"],
    }]);
    assert.equal(value.stops[0].options.shell, false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("LoRA caption request failure still explicitly stops and records the failure", async () => {
  const value = await fixture({ requestFailure: true });
  try {
    await assert.rejects(
      value.service.generateOne(JOB_ID, IMAGE_ID, ["subject"]),
      (error) => error?.code === "OLLAMA_UNAVAILABLE",
    );
    assert.equal(value.calls.filter((body) => body.prompt !== "").length, 2, "request failures retain caption retry semantics");
    assert.equal(value.calls.filter((body) => body.prompt === "").length, 2);
    assert.equal(value.stops.length, 2, "each failed request attempt has explicit cleanup");
    const manifest = JSON.parse(await readFile(path.join(value.captions, "manifest.json"), "utf8"));
    assert.equal(manifest.records[0].status, "failed");
    assert.equal(manifest.records[0].error.code, "OLLAMA_UNAVAILABLE");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("LoRA caption explicit stop failure is surfaced and not retried as a new caption request", async () => {
  const value = await fixture({ stopExitCode: 17 });
  try {
    await assert.rejects(
      value.service.generateOne(JOB_ID, IMAGE_ID, ["subject"]),
      (error) => error?.code === "OLLAMA_UNLOAD_FAILED",
    );
    assert.equal(value.calls.filter((body) => body.prompt !== "").length, 1);
    assert.equal(value.calls.filter((body) => body.prompt === "").length, 1);
    assert.equal(value.stops.length, 1);
    const manifest = JSON.parse(await readFile(path.join(value.captions, "manifest.json"), "utf8"));
    assert.equal(manifest.records[0].status, "failed");
    assert.equal(manifest.records[0].error.code, "OLLAMA_UNLOAD_FAILED");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("LoRA caption batch keeps one model session and unloads only after all images", async () => {
  const value = await fixture({ imageCount: 2 });
  try {
    const result = await value.service.generate(JOB_ID, ["subject"]);
    assert.equal(result.failed, 0);
    assert.equal(result.records.length, 2);
    const captionCalls = value.calls.filter((body) => body.prompt !== "");
    const unloadCalls = value.calls.filter((body) => body.prompt === "");
    assert.equal(captionCalls.length, 2);
    assert.equal(captionCalls.every((body) => body.keep_alive === -1), true, "every batch request keeps the shared model resident");
    assert.equal(unloadCalls.length, 1, "the batch performs one final unload");
    assert.deepEqual(unloadCalls[0], { model: "caption-model", prompt: "", stream: false, keep_alive: 0 });
    assert.equal(value.stops.length, 1, "the batch explicitly stops the model once");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("LoRA caption batch retries without unloading between attempts", async () => {
  const value = await fixture({ imageCount: 2, requestFailure: true });
  try {
    const result = await value.service.generate(JOB_ID, ["subject"]);
    assert.equal(result.failed, 2);
    const captionCalls = value.calls.filter((body) => body.prompt !== "");
    const unloadCalls = value.calls.filter((body) => body.prompt === "");
    assert.equal(captionCalls.length, 4, "two images each retain two request attempts");
    assert.equal(captionCalls.every((body) => body.keep_alive === -1), true);
    assert.equal(unloadCalls.length, 1, "failed attempts do not unload the shared model early");
    assert.equal(value.stops.length, 1);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
