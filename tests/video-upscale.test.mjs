import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SEEDVR2_REQUIRED_NODES,
  SEEDVR2_UNET_NAME,
  SEEDVR2_VAE_NAME,
  buildSeedVR2Prompt,
  createSeedVR2Controller,
  evaluateSeedVR2Readiness,
  normalizeVideoAssetName,
  parseSeedVR2History,
} from "../server/video-upscale/seedvr2.mjs";

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    async text() { return JSON.stringify(payload); },
  };
}

function binaryResponse(bytes, status = 200) {
  const body = Buffer.from(bytes);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    async text() { return body.toString("utf8"); },
    async arrayBuffer() { return body; },
  };
}

function objectInfo() {
  const info = Object.fromEntries(SEEDVR2_REQUIRED_NODES.map((name) => [name, { input: { required: {} } }]));
  info.UNETLoader.input.required.unet_name = [[SEEDVR2_UNET_NAME], {}];
  info.VAELoader.input.required.vae_name = [[SEEDVR2_VAE_NAME], {}];
  return info;
}

function apiResponse() {
  return {
    headersSent: false,
    status: 0,
    body: null,
    writeHead(status) { this.status = status; this.headersSent = true; },
    end(value) { this.body = value ? JSON.parse(value) : null; },
  };
}

test("builds corrected 15-node SeedVR2 graph with dynamic inputs", () => {
  const graph = buildSeedVR2Prompt({ sourceName: "clips/source.mp4", seed: 7 });
  assert.equal(Object.keys(graph).length, 15);
  assert.equal(graph["1"].class_type, "LoadVideo");
  assert.equal(graph["1"].inputs.file, "clips/source.mp4");
  assert.deepEqual(graph["9"].inputs, { latent: ["6", 0], temporal_overlap: 0, chunking_mode: "auto" });
  assert.deepEqual(graph["8"].inputs.vae_conditioning, ["9", 0]);
  assert.deepEqual(graph["10"].inputs.latent_image, ["9", 0]);
  assert.deepEqual(graph["11"].inputs, { latents: ["10", 0], temporal_overlap: ["9", 1] });
  assert.equal(graph["3"].inputs.resize_type, "scale by multiplier");
  assert.equal(graph["3"].inputs["resize_type.multiplier"], 2);
  assert.equal(graph["13"].inputs.color_correction_method, "none");
  assert.deepEqual(graph["14"].inputs.fps, ["2", 2]);
  assert.deepEqual(graph["14"].inputs.audio, ["2", 1]);
  assert.equal("bit_depth" in graph["14"].inputs, false);
  assert.equal(graph["15"].inputs.filename_prefix.includes("/"), false);
  assert.equal(graph["15"].inputs["codec.encoding"], "re-encode");
  assert.equal(graph["15"].inputs["codec.encoding.crf"], 18);
});

test("readiness requires native nodes and exact model combos", () => {
  const ready = evaluateSeedVR2Readiness(objectInfo(), { modelFiles: { unet: true, vae: true } });
  assert.equal(ready.ready, true);
  assert.equal(ready.models.unet.name, SEEDVR2_UNET_NAME);
  assert.equal(ready.models.vae.name, SEEDVR2_VAE_NAME);
  const missing = evaluateSeedVR2Readiness(objectInfo(), { modelFiles: { unet: false, vae: true } });
  assert.equal(missing.ready, false);
  assert.equal(missing.models.unet.available, false);
});

test("normalizes source paths and rejects traversal/non-video names", () => {
  assert.equal(normalizeVideoAssetName("nested\\clip.MP4"), "nested/clip.MP4");
  assert.throws(() => normalizeVideoAssetName("../clip.mp4"), { code: "SOURCE_NAME_INVALID" });
  assert.throws(() => normalizeVideoAssetName("C:\\clip.mp4"), { code: "SOURCE_NAME_INVALID" });
  assert.throws(() => normalizeVideoAssetName("frame.png"), { code: "SOURCE_KIND_INVALID" });
  assert.equal(parseSeedVR2History({ p: { status: { status_str: "error", messages: [["execution_error", { exception_message: "bad node" }]] } } }, "p").state, "failed");
});

test("parses SaveVideo history artifacts and ignores unsafe output paths", () => {
  const result = parseSeedVR2History({
    p: {
      status: { completed: true },
      outputs: { "15": { images: [{ filename: "seedvr2_00001_.mp4", subfolder: "", type: "output" }] } },
    },
  }, "p");
  assert.deepEqual(result, { state: "completed", artifact: "seedvr2_00001_.mp4" });
  const unsafe = parseSeedVR2History({ p: { status: { completed: true }, outputs: { "15": { videos: [{ filename: "../escape.mp4" }] } } } }, "p");
  assert.deepEqual(unsafe, { state: "completed" });
});

test("controller queues one active job, preserves public shape, and cleans output staging", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "h3-seedvr2-"));
  const inputRoot = path.join(root, "input");
  const outputRoot = path.join(root, "output");
  await fs.mkdir(path.join(root, "models", "diffusion_models"), { recursive: true });
  await fs.mkdir(path.join(root, "models", "vae"), { recursive: true });
  await fs.mkdir(inputRoot, { recursive: true });
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.writeFile(path.join(root, "models", "diffusion_models", SEEDVR2_UNET_NAME), "model");
  await fs.writeFile(path.join(root, "models", "vae", SEEDVR2_VAE_NAME), "vae");
  await fs.writeFile(path.join(outputRoot, "source.mp4"), "source");
  await fs.writeFile(path.join(outputRoot, "seedvr2_result.mp4"), "result");
  let promptSeen = null;
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith("/system_stats")) return response({ devices: [] });
    if (url.endsWith("/object_info")) return response(objectInfo());
    if (url.endsWith("/prompt")) {
      promptSeen = JSON.parse(init.body);
      return response({ prompt_id: "prompt-test" });
    }
    if (url.includes("/history/prompt-test")) {
      return response({ "prompt-test": { status: { completed: true }, outputs: { "15": { images: [{ filename: "seedvr2_result.mp4", subfolder: "", type: "output" }] } } } });
    }
    throw new Error(`unexpected endpoint ${url}`);
  };
  const controller = createSeedVR2Controller({
    comfyRoot: root,
    inputRoot,
    outputRoot,
    fetchImpl,
    pollIntervalMs: 1,
    toAsset: async (_root, name) => ({ name, root: "output", kind: "video" }),
    idFactory: () => "job-output",
  });
  const queued = await controller.enqueue({ sourceName: "source.mp4", sourceRoot: "output", scale: 2 });
  assert.equal(queued.status, "queued");
  assert.equal(queued.sourceRoot, "output");
  assert.equal(queued.startedAt, null);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await controller.getJob("job-output");
    if (current?.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const completed = await controller.getJob("job-output");
  assert.equal(completed.status, "completed");
  assert.equal(completed.output.name, "seedvr2_result.mp4");
  assert.equal(await fs.stat(path.join(inputRoot, "seedvr2_temp_job-output.mp4")).catch(() => null), null);
  assert.equal(promptSeen.prompt["5"].inputs.vae_name, SEEDVR2_VAE_NAME);
  assert.equal(promptSeen.prompt["7"].inputs.unet_name, SEEDVR2_UNET_NAME);
});

test("remote controller uploads source video and downloads the ComfyUI artifact", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "h3-seedvr2-remote-"));
  const inputRoot = path.join(root, "input");
  const outputRoot = path.join(root, "output");
  await fs.mkdir(path.join(root, "models", "diffusion_models"), { recursive: true });
  await fs.mkdir(path.join(root, "models", "vae"), { recursive: true });
  await fs.mkdir(inputRoot, { recursive: true });
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.writeFile(path.join(root, "models", "diffusion_models", SEEDVR2_UNET_NAME), "model");
  await fs.writeFile(path.join(root, "models", "vae", SEEDVR2_VAE_NAME), "vae");
  await fs.writeFile(path.join(outputRoot, "source.mp4"), "source-video");

  let uploadSeen = null;
  let promptSeen = null;
  let viewSeen = null;
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith("/system_stats")) return response({ devices: [] });
    if (url.endsWith("/object_info")) return response(objectInfo());
    if (url.endsWith("/upload/image")) {
      uploadSeen = init;
      assert.equal(init.method, "POST");
      assert.equal(init.body.get("subfolder"), "h3-studio-seedvr2");
      assert.equal(init.body.get("type"), "input");
      assert.equal(init.body.get("overwrite"), "true");
      assert.equal(typeof init.body.get("image").arrayBuffer, "function");
      return response({ name: "remote-source.mp4", subfolder: "h3-studio-seedvr2", type: "input" });
    }
    if (url.endsWith("/prompt")) {
      promptSeen = JSON.parse(init.body);
      return response({ prompt_id: "prompt-remote" });
    }
    if (url.includes("/history/prompt-remote")) {
      return response({ "prompt-remote": {
        status: { completed: true },
        outputs: { "15": { videos: [{ filename: "remote-result.mp4", subfolder: "seedvr2-out", type: "output" }] } },
      } });
    }
    if (url.includes("/view?")) {
      const requestUrl = new URL(url);
      viewSeen = requestUrl;
      assert.equal(requestUrl.searchParams.get("filename"), "remote-result.mp4");
      assert.equal(requestUrl.searchParams.get("subfolder"), "seedvr2-out");
      assert.equal(requestUrl.searchParams.get("type"), "output");
      return binaryResponse("remote-result");
    }
    throw new Error(`unexpected endpoint ${url}`);
  };
  const controller = createSeedVR2Controller({
    comfyUrl: "http://remote.test",
    remote: true,
    comfyRoot: root,
    inputRoot,
    outputRoot,
    fetchImpl,
    pollIntervalMs: 1,
    toAsset: async (_root, name) => ({ name, root: "output", kind: "video" }),
    idFactory: () => "remote-job",
  });
  const queued = await controller.enqueue({ sourceName: "source.mp4", sourceRoot: "output", scale: 2 });
  assert.equal(queued.status, "queued");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await controller.getJob("remote-job");
    if (current?.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const completed = await controller.getJob("remote-job");
  assert.equal(completed.status, "completed");
  assert.equal(completed.output.root, "output");
  assert.equal(completed.output.kind, "video");
  assert.match(completed.output.name, /^seedvr2\/seedvr2_source_remote-/);
  assert.equal(await fs.readFile(path.join(outputRoot, completed.output.name), "utf8"), "remote-result");
  assert.equal(promptSeen.prompt["1"].inputs.file, "h3-studio-seedvr2/remote-source.mp4");
  assert.ok(uploadSeen);
  assert.ok(viewSeen);
  assert.equal(await fs.stat(path.join(inputRoot, "seedvr2_temp_remote-job.mp4")).catch(() => null), null);
});

test("controller route reports 503 when ComfyUI readiness is false", async () => {
  const controller = createSeedVR2Controller({
    inputRoot: path.join(os.tmpdir(), "h3-seedvr2-input-missing"),
    outputRoot: path.join(os.tmpdir(), "h3-seedvr2-output-missing"),
    fetchImpl: async () => { throw new Error("offline"); },
  });
  const res = apiResponse();
  const handled = await controller.handleRoute({ method: "POST", url: "/api/upscale" }, res, {
    readJson: async () => ({ sourceName: "clip.mp4", sourceRoot: "input", scale: 2 }),
  });
  assert.equal(handled, true);
  assert.equal(res.status, 503);
  assert.equal(res.body.health.ready, false);
});
