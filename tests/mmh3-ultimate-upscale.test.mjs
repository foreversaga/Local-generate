import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  H3_LATENT_AUDIO_VAE_NAME,
  H3_LATENT_DIFFUSION_NAMES,
  H3_LATENT_ENCODER_NAME,
  H3_LATENT_VAE_NAME,
  createSeedVR2Controller,
} from "../server/video-upscale/seedvr2.mjs";
import {
  MMH3_ULTIMATE_PASS2_SIGMAS,
  MMH3_ULTIMATE_PROFILE,
  MMH3_ULTIMATE_REQUIRED_NODES,
  buildMMH3UltimatePrompt,
  evaluateMMH3UltimateReadiness,
} from "../server/video-upscale/mmh3-ultimate.mjs";
import { createSeedVR2JobStore } from "../server/video-upscale/seedvr2-store.mjs";

function objectInfo() {
  const info = Object.fromEntries(MMH3_ULTIMATE_REQUIRED_NODES.map((name) => [name, { input: { required: {} } }]));
  info.UNETLoader.input.required.unet_name = ["COMBO", { options: H3_LATENT_DIFFUSION_NAMES }];
  info.CLIPLoader.input.required.clip_name = ["COMBO", { options: [H3_LATENT_ENCODER_NAME] }];
  info.VAELoader.input.required.vae_name = ["COMBO", { options: [H3_LATENT_VAE_NAME, H3_LATENT_AUDIO_VAE_NAME] }];
  return info;
}

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    async text() { return JSON.stringify(payload); },
  };
}

test("builds an isolated MMH3 tiled 2x workflow", () => {
  const graph = buildMMH3UltimatePrompt({
    sourceName: "clips/source.mp4",
    filenamePrefix: "h3ultimate/test",
    diffusionName: H3_LATENT_DIFFUSION_NAMES[0],
    encoderName: H3_LATENT_ENCODER_NAME,
    vaeName: H3_LATENT_VAE_NAME,
    audioVaeName: H3_LATENT_AUDIO_VAE_NAME,
    seed: 41,
  });
  const classTypes = Object.values(graph).map((node) => node.class_type);

  assert.equal(Object.keys(graph).length, 27);
  assert.equal(graph["3"].inputs.resize_type, "scale to multiple");
  assert.equal(graph["3"].inputs["resize_type.multiple"], 16);
  assert.deepEqual(graph["16"].inputs["values.a"], ["4", 0]);
  assert.deepEqual(graph["17"].inputs["values.a"], ["4", 1]);
  assert.deepEqual(graph["18"].inputs.width, ["16", 1]);
  assert.deepEqual(graph["18"].inputs.height, ["17", 1]);
  assert.equal(graph["19"].inputs.chunk_length, 85);
  assert.equal(graph["20"].inputs.tile_width, 512);
  assert.deepEqual(graph["23"].inputs.latent, ["14", 1]);
  assert.deepEqual(graph["23"].inputs.temporal_split_param, ["19", 0]);
  assert.deepEqual(graph["23"].inputs.spatial_split_param, ["20", 0]);
  assert.equal(graph["22"].inputs.sigmas, MMH3_ULTIMATE_PASS2_SIGMAS);
  assert.equal(graph["27"].inputs.filename_prefix, "h3ultimate/test");
  assert.equal(classTypes.includes("MMH3UltimateUpscale"), true);
  assert.equal(classTypes.includes("MiniMaxH3LatentUpscale"), false);
  assert.equal(classTypes.includes("H3CleanLatentUpscale2x"), false);
  assert.equal(classTypes.some((name) => name.startsWith("SeedVR2")), false);
});

test("requires only MMH3 tiled nodes and the existing H3 model set", () => {
  const modelFiles = {
    diffusion: { [H3_LATENT_DIFFUSION_NAMES[0]]: true },
    encoder: true,
    videoVae: true,
    audioVae: true,
  };
  const options = {
    diffusionNames: H3_LATENT_DIFFUSION_NAMES,
    encoderName: H3_LATENT_ENCODER_NAME,
    vaeName: H3_LATENT_VAE_NAME,
    audioVaeName: H3_LATENT_AUDIO_VAE_NAME,
    modelFiles,
  };
  const ready = evaluateMMH3UltimateReadiness(objectInfo(), options);
  assert.equal(ready.ready, true);
  assert.equal(ready.preset.tileWidth, 512);

  const missingNodeInfo = objectInfo();
  delete missingNodeInfo.MMH3UltimateUpscale;
  const missing = evaluateMMH3UltimateReadiness(missingNodeInfo, options);
  assert.equal(missing.ready, false);
  assert.equal(missing.nodes.MMH3UltimateUpscale, false);
});

test("controller rejects the removed MMH3 profile", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "h3-ultimate-controller-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const inputRoot = path.join(root, "input");
  const outputRoot = path.join(root, "output");
  await fs.mkdir(path.join(root, "models", "diffusion_models"), { recursive: true });
  await fs.mkdir(path.join(root, "models", "text_encoders"), { recursive: true });
  await fs.mkdir(path.join(root, "models", "vae"), { recursive: true });
  await fs.mkdir(inputRoot, { recursive: true });
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.writeFile(path.join(root, "models", "diffusion_models", H3_LATENT_DIFFUSION_NAMES[0]), "model");
  await fs.writeFile(path.join(root, "models", "text_encoders", H3_LATENT_ENCODER_NAME), "encoder");
  await fs.writeFile(path.join(root, "models", "vae", H3_LATENT_VAE_NAME), "video vae");
  await fs.writeFile(path.join(root, "models", "vae", H3_LATENT_AUDIO_VAE_NAME), "audio vae");

  const controller = createSeedVR2Controller({
    comfyRoot: root,
    inputRoot,
    outputRoot,
    jobStore: createSeedVR2JobStore({ root: path.join(root, "jobs") }),
    fetchImpl: async (url) => {
      if (url.endsWith("/system_stats")) return response({ devices: [] });
      if (url.endsWith("/object_info")) return response(objectInfo());
      throw new Error(`unexpected endpoint ${url}`);
    },
  });

  await assert.rejects(
    controller.checkReadiness(MMH3_ULTIMATE_PROFILE, "video"),
    { code: "PROFILE_INVALID", status: 400 },
  );
});
