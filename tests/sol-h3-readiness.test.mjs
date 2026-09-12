import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createSolH3RuntimeConfig } from "../server/sol-h3/runtime-config.mjs";
import { inspectSolH3Readiness } from "../server/sol-h3/readiness.mjs";

async function makeReadyFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-h3-readiness-"));
  const checkpointRoot = path.join(root, "checkpoints");
  const h3Root = path.join(checkpointRoot, "MiniMax-H3");
  const ltxRoot = path.join(checkpointRoot, "LTX-2.5");
  const adapter = path.join(checkpointRoot, "adapter");
  await fs.mkdir(path.join(h3Root, "transformer"), { recursive: true });
  await fs.mkdir(path.join(h3Root, "transformer_ref"), { recursive: true });
  await fs.mkdir(path.join(h3Root, "vae"), { recursive: true });
  await fs.mkdir(path.join(ltxRoot, "vae"), { recursive: true });
  await fs.mkdir(path.join(ltxRoot, "loras"), { recursive: true });
  await fs.mkdir(path.join(adapter), { recursive: true });
  const shardIndex = JSON.stringify({ weight_map: { layer: "shard.safetensors" } });
  for (const component of ["transformer", "transformer_ref"]) {
    await fs.writeFile(path.join(h3Root, component, "config.json"), "{}");
    await fs.writeFile(path.join(h3Root, component, "diffusion_pytorch_model.safetensors.index.json"), shardIndex);
    await fs.writeFile(path.join(h3Root, component, "shard.safetensors"), "fixture");
  }
  await fs.writeFile(path.join(h3Root, "vae", "config.json"), "{}");
  const files = {
    qwen_checkpoint: path.join(checkpointRoot, "qwen.safetensors"),
    transformer: path.join(ltxRoot, "transformer.safetensors"),
    refiner_lora: path.join(ltxRoot, "loras", "distilled.safetensors"),
    output_video_vae: path.join(ltxRoot, "vae", "video.safetensors"),
    audio_vae: path.join(ltxRoot, "vae", "audio.safetensors"),
    vsa_lora: path.join(checkpointRoot, "vsa.safetensors"),
    ref2va_lora: path.join(checkpointRoot, "ref2va.safetensors"),
    h3_upscaler_checkpoint: path.join(checkpointRoot, "upscaler.safetensors"),
    prompt_cache: path.join(root, "prompt-cache.bin"),
  };
  for (const file of Object.values(files)) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "fixture");
  }
  await fs.writeFile(path.join(adapter, "config.json"), "{}");
  await fs.writeFile(path.join(adapter, "model.safetensors"), "fixture");
  const inferPath = path.join(root, "infer.py");
  await fs.writeFile(inferPath, "print('fixture')");
  const pathsFile = path.join(root, "paths.json");
  await fs.writeFile(pathsFile, JSON.stringify({
    h3_model: h3Root,
    ...files,
    adapter_dir: adapter,
    qwen_python: process.execPath,
    stage1_python: process.execPath,
    stage2_python: process.execPath,
  }));
  const config = createSolH3RuntimeConfig({
    projectRoot: root,
    env: {
      SOL_H3_ENABLED: "1",
      SOL_H3_RUNTIME_ROOT: root,
      SOL_H3_CHECKPOINT_ROOT: checkpointRoot,
      SOL_H3_SANA_ROOT: root,
      SOL_H3_INFER_PATH: inferPath,
      SOL_H3_PATHS_FILE: pathsFile,
    },
  });
  return { root, config, files };
}

test("readiness separates installed checkpoints from explicit runtime/hash gates", async () => {
  const fixture = await makeReadyFixture();
  try {
    const pending = await inspectSolH3Readiness(fixture.config, { env: {} });
    assert.equal(pending.ready, false);
    assert.equal(pending.checkpoints.installed, true);
    assert.equal(pending.checkpoints.verified, false);
    assert.ok(pending.modes.t2va.missing.includes("runtime_probe"));
    assert.ok(pending.modes.t2va.missing.includes("checkpoint_hash_lock"));

    const ready = await inspectSolH3Readiness(fixture.config, {
      env: { SOL_H3_RUNTIME_READY: "1", SOL_H3_CHECKPOINTS_VERIFIED: "1" },
    });
    assert.equal(ready.ready, true);
    assert.equal(ready.modes.t2va.ready, true);
    assert.equal(ready.modes.fl2va.ready, true);
    assert.equal(ready.modes.ref2va.ready, true);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
