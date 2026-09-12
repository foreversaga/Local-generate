import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function envFlag(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  return !/^(?:0|false|no|off)$/i.test(String(value).trim());
}

function absolute(value, fallback) {
  const text = String(value || "").trim();
  return path.resolve(text || fallback);
}

function splitUrls(value) {
  return [...new Set(String(value || "")
    .split(",")
    .map((item) => item.trim().replace(/\/+$/, ""))
    .filter((item) => /^https?:\/\//i.test(item)))];
}

export function createSolH3RuntimeConfig({ env = process.env, projectRoot = MODULE_ROOT } = {}) {
  const root = path.resolve(projectRoot);
  const runtimeRoot = absolute(env.SOL_H3_RUNTIME_ROOT, path.join(root, "..", "sol-h3-runtime"));
  const checkpointRoot = absolute(env.SOL_H3_CHECKPOINT_ROOT, path.join(runtimeRoot, "checkpoints"));
  const sanaRoot = absolute(env.SOL_H3_SANA_ROOT, path.join(root, "..", "Sana"));
  const checkpointPathsFile = absolute(env.SOL_H3_PATHS_FILE, path.join(runtimeRoot, "paths.json"));
  const fallbackCheckpointPathsFile = path.join(checkpointRoot, "checkpoint-paths.json");
  const taskPaths = Object.freeze({
    t2va: absolute(env.SOL_H3_T2VA_PATHS_FILE, path.join(runtimeRoot, "paths-t2va.json")),
    fl2va: absolute(env.SOL_H3_FL2VA_PATHS_FILE, path.join(runtimeRoot, "paths-fl2va.json")),
    ref2va: absolute(env.SOL_H3_REF2VA_PATHS_FILE, path.join(runtimeRoot, "paths-ref2va.json")),
  });
  const jobRoot = absolute(env.SOL_H3_JOB_ROOT, path.join(runtimeRoot, "jobs"));
  const promptCache = absolute(env.SOL_H3_PROMPT_CACHE, path.join(runtimeRoot, "prompt-cache.bin"));
  const inferPath = absolute(
    env.SOL_H3_INFER_PATH,
    path.join(sanaRoot, "models", "minimax_h3", "Sol-H3-Spark", "infer.py"),
  );
  const inferPython = String(env.SOL_H3_INFER_PYTHON || "").trim();
  const conflictUrls = splitUrls(env.SOL_H3_CONFLICT_URLS || env.VLLM_URL || env.SGLANG_URL || "");

  return Object.freeze({
    enabled: envFlag(env.SOL_H3_ENABLED, true),
    projectRoot: root,
    runtimeRoot,
    checkpointRoot,
    sanaRoot,
    jobRoot,
    pathsFile: checkpointPathsFile,
    fallbackCheckpointPathsFile,
    taskPaths,
    promptCache,
    inferPath,
    inferPython,
    hostLockFile: path.join(runtimeRoot, "sol-h3.lock"),
    conflictUrls,
    sanaPackageRoot: path.join(sanaRoot, "models", "minimax_h3", "Sol-H3-Spark"),
    pinnedH3Revision: String(env.SOL_H3_H3_REVISION || "9bfb6693f2cf6de171db46d1aa586f67d773a1da"),
    outputWidth: 1344,
    outputHeight: 768,
    outputFrames: 121,
    outputFps: 24,
    schemaVersion: 1,
  });
}

export const DEFAULT_SOL_H3_RUNTIME_CONFIG = createSolH3RuntimeConfig({
  projectRoot: MODULE_ROOT,
});
