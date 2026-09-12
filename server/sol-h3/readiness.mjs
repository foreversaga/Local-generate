import { promises as fs } from "node:fs";
import path from "node:path";

import { SOL_H3_MODES, SOL_H3_OUTPUT_SPEC } from "./request.mjs";
import { DEFAULT_SOL_H3_RUNTIME_CONFIG } from "./runtime-config.mjs";

async function lstat(fsApi, filePath) {
  return await fsApi.lstat(filePath).catch(() => null);
}

async function regularFile(fsApi, filePath) {
  const stat = await lstat(fsApi, filePath);
  return Boolean(stat?.isFile() && !stat.isSymbolicLink());
}

async function directory(fsApi, directoryPath) {
  const stat = await lstat(fsApi, directoryPath);
  return Boolean(stat?.isDirectory() && !stat.isSymbolicLink());
}

async function readJson(fsApi, filePath) {
  if (!(await regularFile(fsApi, filePath))) return null;
  try {
    const value = JSON.parse(await fsApi.readFile(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function fileValue(paths, key, fallback) {
  const value = typeof paths?.[key] === "string" ? paths[key].trim() : "";
  return value ? path.resolve(value) : path.resolve(fallback);
}

function runtimeCommand(paths, env, key) {
  const environmentKey = key === "qwen" ? "SOL_H3_QWEN_PYTHON" : key === "stage1" ? "SOL_H3_STAGE1_PYTHON" : "SOL_H3_STAGE2_PYTHON";
  return String(env[environmentKey] || paths?.[key + "_python"] || "").trim();
}

async function runtimeStatus(fsApi, command, name, runtimeVerified) {
  const configured = Boolean(command);
  const executable = command && (command.includes("/") || /^[A-Za-z]:[\\/]/u.test(command))
    ? Boolean(await fsApi.stat(command).then((stat) => stat.isFile()).catch(() => false))
    : configured;
  return {
    name,
    configured,
    executable,
    probe: runtimeVerified ? "passed-by-operator" : "not-run",
    ready: Boolean(configured && executable && runtimeVerified),
  };
}

async function shardedComponent(fsApi, root, logicalName) {
  const result = { logicalName, rootExists: await directory(fsApi, root), files: 0, missing: [] };
  if (!result.rootExists) {
    result.missing.push(logicalName);
    return result;
  }
  if (!(await regularFile(fsApi, path.join(root, "config.json")))) result.missing.push(logicalName + "/config.json");
  const indexPath = path.join(root, "diffusion_pytorch_model.safetensors.index.json");
  const index = await readJson(fsApi, indexPath);
  if (!index) {
    result.missing.push(logicalName + "/diffusion_pytorch_model.safetensors.index.json");
    return result;
  }
  const weightMap = index.weight_map && typeof index.weight_map === "object" ? index.weight_map : {};
  const filenames = [...new Set(Object.values(weightMap).filter((value) => typeof value === "string"))];
  result.files = filenames.length;
  for (const filename of filenames) {
    if (!(await regularFile(fsApi, path.join(root, filename)))) result.missing.push(logicalName + "/" + filename);
  }
  if (!filenames.length) result.missing.push(logicalName + "/weight_map");
  return result;
}

async function componentFile(fsApi, value, logicalName) {
  const filePath = path.resolve(value);
  return {
    logicalName,
    present: await regularFile(fsApi, filePath),
    size: (await lstat(fsApi, filePath))?.size || 0,
  };
}

async function componentDirectory(fsApi, value, logicalName, files = ["config.json", "model.safetensors"]) {
  const directoryPath = path.resolve(value);
  const present = await directory(fsApi, directoryPath);
  const missing = [];
  if (!present) missing.push(logicalName);
  for (const filename of files) {
    if (!(await regularFile(fsApi, path.join(directoryPath, filename)))) missing.push(logicalName + "/" + filename);
  }
  return { logicalName, present: present && missing.length === 0, missing };
}

function publicPaths(paths, config) {
  const source = paths === null ? "not-found" : "prepared";
  return {
    source,
    h3Revision: config.pinnedH3Revision,
    hasPreparedRuntimePaths: Boolean(paths),
  };
}

async function readTaskManifests(fsApi, config) {
  const files = config.taskPaths && typeof config.taskPaths === "object" ? config.taskPaths : {};
  const entries = await Promise.all(Object.entries(files).map(async ([mode, filePath]) => [mode, await readJson(fsApi, filePath)]));
  return Object.fromEntries(entries);
}

export async function inspectSolH3Readiness(
  config = DEFAULT_SOL_H3_RUNTIME_CONFIG,
  { fsApi = fs, env = process.env, gpu = null, conflicts = [] } = {},
) {
  if (!config.enabled) {
    return {
      enabled: false,
      ready: false,
      code: { source: false, sanaCommit: null },
      paths: { source: "disabled", h3Revision: config.pinnedH3Revision, hasPreparedRuntimePaths: false },
      runtimes: {},
      modes: Object.fromEntries(SOL_H3_MODES.map((mode) => [mode, { ready: false, missing: ["feature_disabled"] }])),
      gpu: gpu || { active: null, queue: [], activeCount: 0, queuedCount: 0, totalCount: 0 },
      conflicts: [...conflicts],
      output: { ...SOL_H3_OUTPUT_SPEC },
    };
  }

  const genericPaths = await readJson(fsApi, config.pathsFile);
  const taskManifests = await readTaskManifests(fsApi, config);
  const fallbackPaths = await readJson(fsApi, config.fallbackCheckpointPathsFile);
  const paths = genericPaths || Object.values(taskManifests).find(Boolean) || fallbackPaths;
  const modePaths = {
    t2va: taskManifests.t2va || genericPaths || {},
    fl2va: taskManifests.fl2va || taskManifests.t2va || genericPaths || {},
    ref2va: taskManifests.ref2va || genericPaths || {},
  };
  const modeFileValue = (mode, key, fallback) => fileValue(modePaths[mode], key, fileValue(paths, key, fallback));
  const h3Model = fileValue(paths, "h3_model", path.join(config.checkpointRoot, "MiniMax-H3"));
  const ltxTransformer = fileValue(paths, "transformer", path.join(config.checkpointRoot, "LTX-2.5", "diffusion_models", "ltx-2.5-22b-dev-transformer-bf16.safetensors"));
  const refinerLora = fileValue(paths, "refiner_lora", path.join(config.checkpointRoot, "LTX-2.5", "loras", "ltx-2.5-22b-distilled-lora-450-bf16.safetensors"));
  const outputVideoVae = fileValue(paths, "output_video_vae", path.join(config.checkpointRoot, "LTX-2.5", "vae", "ltx-2.5-video-vae-conv-bf16.safetensors"));
  const audioVae = fileValue(paths, "audio_vae", path.join(config.checkpointRoot, "LTX-2.5", "vae", "ltx-2.5-audio-vae-bf16.safetensors"));
  const qwen = fileValue(paths, "qwen_checkpoint", path.join(config.checkpointRoot, "Comfy-MiniMax-H3", "text_encoders", "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"));
  const vsa = fileValue(paths, "vsa_lora", path.join(config.checkpointRoot, "FastH3-VSA", "vsa-datafree", "adapter_model.safetensors"));
  const ref2va = fileValue(paths, "ref2va_lora", path.join(config.checkpointRoot, "Minimax-h3-Turbo", "minimax_h3_ref2v_turbo_4step_v0.1_bf16.safetensors"));
  const upscaler = fileValue(paths, "h3_upscaler_checkpoint", path.join(config.checkpointRoot, "H3-upscaler", "minimax_h3_latent_upscaler_3d_bf16.safetensors"));
  const adapter = fileValue(paths, "adapter_dir", path.join(config.checkpointRoot, "H3-to-LTX-Latent-Adapter"));
  const promptCache = fileValue(paths, "prompt_cache", config.promptCache);
  const infer = await regularFile(fsApi, config.inferPath);
  const runtimeVerified = String(env.SOL_H3_RUNTIME_READY || "").trim() === "1";
  const runtimes = {
    qwen: await runtimeStatus(fsApi, runtimeCommand(paths, env, "qwen"), "qwen", runtimeVerified),
    stage1: await runtimeStatus(fsApi, runtimeCommand(paths, env, "stage1"), "stage1", runtimeVerified),
    stage2: await runtimeStatus(fsApi, runtimeCommand(paths, env, "stage2"), "stage2", runtimeVerified),
  };
  const runtimeReady = Object.values(runtimes).every((item) => item.ready);
  const common = [
    await componentFile(fsApi, qwen, "qwen_checkpoint"),
    await componentFile(fsApi, ltxTransformer, "ltx_transformer"),
    await componentFile(fsApi, refinerLora, "ltx_distilled_lora"),
    await componentFile(fsApi, outputVideoVae, "ltx_video_vae"),
    await componentFile(fsApi, audioVae, "ltx_audio_vae"),
    await componentFile(fsApi, upscaler, "h3_upscaler"),
    await componentDirectory(fsApi, adapter, "h3_to_ltx_adapter"),
    await componentFile(fsApi, promptCache, "prompt_cache"),
  ];
  const stage1 = await shardedComponent(fsApi, path.join(h3Model, "transformer"), "h3/transformer");
  const stage1Ref = await shardedComponent(fsApi, path.join(h3Model, "transformer_ref"), "h3/transformer_ref");
  const nativeVae = await componentDirectory(fsApi, path.join(h3Model, "vae"), "h3/native_vae", ["config.json"]);
  const modes = {};
  for (const mode of SOL_H3_MODES) {
    const missing = [];
    if (!infer) missing.push("sana/infer.py");
    if (!runtimeReady) missing.push("runtime_probe");
    for (const item of common) if (!item.present) missing.push(item.logicalName);
    if (mode === "t2va" || mode === "fl2va") {
      missing.push(...stage1.missing);
      const taskVsa = modeFileValue(mode, "vsa_lora", vsa);
      if (!(await componentFile(fsApi, taskVsa, "vsa_lora")).present) missing.push("vsa_lora");
    }
    if (mode === "fl2va") missing.push(...nativeVae.missing);
    if (mode === "ref2va") {
      missing.push(...stage1Ref.missing, ...nativeVae.missing);
      const taskRef2va = modeFileValue(mode, "ref2va_lora", ref2va);
      if (!(await componentFile(fsApi, taskRef2va, "ref2va_lora")).present) missing.push("ref2va_lora");
    }
    const uniqueMissing = [...new Set(missing)];
    const modeComponents = mode === "t2va"
      ? { transformer: stage1, vsa: await componentFile(fsApi, modeFileValue(mode, "vsa_lora", vsa), "vsa_lora") }
      : mode === "fl2va"
        ? { transformer: stage1, nativeVae }
        : { transformer: stage1Ref, nativeVae, ref2va: await componentFile(fsApi, modeFileValue(mode, "ref2va_lora", ref2va), "ref2va_lora") };
    const checkpointVerified = String(env.SOL_H3_CHECKPOINTS_VERIFIED || "").trim() === "1";
    modeComponents.ready = uniqueMissing.length === 0;
    modeComponents.missing = uniqueMissing;
    modeComponents.verification = "size/layout checked; sha256/runtime load must be recorded by provisioning";
    modeComponents.ready = modeComponents.ready && checkpointVerified;
    if (!checkpointVerified) modeComponents.missing.push("checkpoint_hash_lock");
    modeComponents.ready = modeComponents.ready && Boolean(config.enabled);
    modeComponents.missing = [...new Set(modeComponents.missing)];
    modeComponents.output = { ...SOL_H3_OUTPUT_SPEC };
    modeComponents.inputs = mode === "t2va" ? "none" : mode === "fl2va" ? "firstFrame+lastFrame" : "one reference";
    // Do not expose local absolute paths in the HTTP response.
    modes[mode] = modeComponents;
  }

  const allReady = SOL_H3_MODES.every((mode) => modes[mode].ready);
  const weightComponents = common.filter((item) => item.logicalName !== "prompt_cache");
  return {
    enabled: true,
    ready: allReady,
    code: { source: infer, sanaCommit: String(env.SOL_H3_SANA_COMMIT || "") || null },
    paths: publicPaths(paths, config),
    runtimes,
    modes,
    checkpoints: {
      installed: weightComponents.every((item) => item.present) && stage1.missing.length === 0,
      verified: String(env.SOL_H3_CHECKPOINTS_VERIFIED || "").trim() === "1",
      promptCache: (await regularFile(fsApi, promptCache)),
    },
    gpu: gpu || { active: null, queue: [], activeCount: 0, queuedCount: 0, totalCount: 0 },
    conflicts: [...conflicts],
    output: { ...SOL_H3_OUTPUT_SPEC },
  };
}

export function createSolH3Readiness(options = {}) {
  const config = options.config || DEFAULT_SOL_H3_RUNTIME_CONFIG;
  return Object.freeze({
    inspect: (context = {}) => inspectSolH3Readiness(config, { ...options, ...context }),
  });
}
