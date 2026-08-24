import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createGpuResourceCoordinator } from "../server/runtime/gpu-resource-coordinator.mjs";
import {
  IMG2IMG_MODELS,
  createImg2ImgController,
} from "../server/image-generation/img2img.mjs";
import {
  SEEDVR2_REQUIRED_NODES,
  SEEDVR2_UNET_NAME,
  SEEDVR2_VAE_NAME,
  createSeedVR2Controller,
} from "../server/video-upscale/seedvr2.mjs";
import { createSeedVR2JobStore } from "../server/video-upscale/seedvr2-store.mjs";

const waitFor = async (read, predicate, message) => {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(message);
};

function imageObjectInfo() {
  return {
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [[IMG2IMG_MODELS[0]]] } } },
    LoadImage: {},
    VAEEncode: {},
    CLIPTextEncode: {},
    KSampler: {},
    VAEDecode: {},
    SaveImage: {},
  };
}

function seedObjectInfo() {
  const info = Object.fromEntries(SEEDVR2_REQUIRED_NODES.map((name) => [name, { input: { required: {} } }]));
  info.UNETLoader.input.required.unet_name = [[SEEDVR2_UNET_NAME], {}];
  info.VAELoader.input.required.vae_name = [[SEEDVR2_VAE_NAME], {}];
  return info;
}

test("shared coordinator serializes real img2img and SeedVR2 adapters", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "h3-gpu-integration-"));
  const imageRoot = path.join(root, "image");
  const seedRoot = path.join(root, "seed");
  await fs.mkdir(path.join(imageRoot, "input"), { recursive: true });
  await fs.mkdir(path.join(imageRoot, "output"), { recursive: true });
  await fs.mkdir(path.join(seedRoot, "input"), { recursive: true });
  await fs.mkdir(path.join(seedRoot, "output"), { recursive: true });
  await fs.mkdir(path.join(seedRoot, "models", "diffusion_models"), { recursive: true });
  await fs.mkdir(path.join(seedRoot, "models", "vae"), { recursive: true });
  await fs.writeFile(path.join(imageRoot, "input", "source.png"), Buffer.from([137, 80, 78, 71]));
  await fs.writeFile(path.join(seedRoot, "input", "source.mp4"), "source");
  await fs.writeFile(path.join(seedRoot, "output", "seed-result.mp4"), "result");
  await fs.writeFile(path.join(seedRoot, "models", "diffusion_models", SEEDVR2_UNET_NAME), "model");
  await fs.writeFile(path.join(seedRoot, "models", "vae", SEEDVR2_VAE_NAME), "vae");

  let releaseImage;
  const imageStarted = new Promise((resolve) => {
    releaseImage = resolve;
  });
  let signalImageReady;
  const imageEntered = new Promise((resolve) => {
    signalImageReady = resolve;
  });
  const coordinator = createGpuResourceCoordinator({ ownerId: "integration-test" });

  const imageFetch = async (url, init = {}) => {
    const endpoint = String(url).replace("http://image-comfy", "");
    if (endpoint === "/system_stats") return new Response("{}");
    if (endpoint === "/object_info") return new Response(JSON.stringify(imageObjectInfo()));
    if (endpoint === "/upload/image") return new Response(JSON.stringify({ name: "source.png", subfolder: "h3-studio-img2img", type: "input" }));
    if (endpoint === "/prompt") return new Response(JSON.stringify({ prompt_id: "image-prompt" }));
    if (endpoint === "/history/image-prompt") return new Response(JSON.stringify({
      "image-prompt": { status: { status_str: "success", completed: true }, outputs: { "8": { images: [{ filename: "result.png", subfolder: "img2img", type: "output" }] } } },
    }));
    if (endpoint.startsWith("/view?")) return new Response(Buffer.from([137, 80, 78, 71, 13, 10]));
    throw new Error(`Unexpected img2img endpoint: ${endpoint} ${init.method || "GET"}`);
  };

  const seedFetch = async (url) => {
    const endpoint = String(url).replace("http://seed-comfy", "");
    if (endpoint === "/system_stats") return new Response("{}");
    if (endpoint === "/object_info") return new Response(JSON.stringify(seedObjectInfo()));
    if (endpoint === "/prompt") return new Response(JSON.stringify({ prompt_id: "seed-prompt" }));
    if (endpoint === "/history/seed-prompt") return new Response(JSON.stringify({
      "seed-prompt": { status: { completed: true }, outputs: { "15": { videos: [{ filename: "seed-result.mp4", subfolder: "", type: "output" }] } } },
    }));
    throw new Error(`Unexpected SeedVR2 endpoint: ${endpoint}`);
  };

  const imageController = createImg2ImgController({
    comfyUrl: "http://image-comfy",
    remote: true,
    inputRoot: path.join(imageRoot, "input"),
    outputRoot: path.join(imageRoot, "output"),
    storeRoot: path.join(imageRoot, "jobs"),
    fetchImpl: imageFetch,
    pollIntervalMs: 1,
    idFactory: () => "image-job",
    gpuCoordinator: coordinator,
    gpuRuntime: "remote",
    beforeRun: async () => {
      signalImageReady();
      await imageStarted;
    },
    toAsset: async (_root, name) => ({ root: "output", name, kind: "image" }),
  });
  const seedController = createSeedVR2Controller({
    jobStore: createSeedVR2JobStore({ root: path.join(seedRoot, "jobs") }),
    comfyUrl: "http://seed-comfy",
    comfyRoot: seedRoot,
    inputRoot: path.join(seedRoot, "input"),
    outputRoot: path.join(seedRoot, "output"),
    fetchImpl: seedFetch,
    pollIntervalMs: 1,
    idFactory: () => "seed-job",
    gpuCoordinator: coordinator,
    gpuRuntime: "local",
    toAsset: async (_root, name) => ({ root: "output", name, kind: "video" }),
  });

  t.after(async () => {
    releaseImage?.();
    await Promise.allSettled([
      waitFor(() => imageController.getJob("image-job"), (job) => ["completed", "failed", "cancelled"].includes(job?.status), "img2img cleanup timed out"),
      waitFor(() => seedController.getJob("seed-job"), (job) => ["completed", "failed", "cancelled"].includes(job?.status), "SeedVR2 cleanup timed out"),
    ]);
    await coordinator.waitForIdle();
    await fs.rm(root, { recursive: true, force: true });
  });

  const imageJob = await imageController.enqueue({ sourceName: "source.png", prompt: "integration" });
  await imageEntered;
  assert.deepEqual(coordinator.snapshot().active?.workloadType, "img2img");

  const seedJob = await seedController.enqueue({ sourceName: "source.mp4", sourceRoot: "input", scale: 2 });
  assert.equal(seedJob.gpu.workloadType, "seedvr2-upscale");
  assert.equal(seedJob.gpu.status, "queued");
  assert.equal(seedJob.gpu.queuePosition, 1);
  assert.equal(coordinator.snapshot().active.workloadType, "img2img");
  assert.equal(coordinator.snapshot().queue[0].workloadType, "seedvr2-upscale");

  releaseImage();
  const completedImage = await waitFor(() => imageController.getJob(imageJob.id), (job) => ["completed", "failed"].includes(job?.status), "img2img did not finish");
  const completedSeed = await waitFor(() => seedController.getJob(seedJob.id), (job) => ["completed", "failed"].includes(job?.status), "SeedVR2 did not finish");
  assert.equal(completedImage.status, "completed", completedImage.error);
  assert.equal(completedSeed.status, "completed", completedSeed.error);
  assert.equal(completedSeed.gpu, undefined, "released GPU admissions must not leak into completed jobs");
  assert.equal(coordinator.hasWork(), false);
});
