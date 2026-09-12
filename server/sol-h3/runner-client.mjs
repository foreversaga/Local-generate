import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { solH3Error } from "./request.mjs";

const CANCEL_GRACE_MS = 10_000;
const PROCESS_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 60_000;
const DECODE_TIMEOUT_MS = 10 * 60_000;

function publicProcessError(error) {
  return String(error?.message || error || "Sol-H3 subprocess failed.")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .slice(-2000);
}

function terminateProcessGroup(child, signal) {
  if (!child?.pid) return false;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
    return true;
  } catch {
    try { return child.kill(signal); } catch { return false; }
  }
}

function appendTail(value, chunk, max = 256 * 1024) {
  return (value + String(chunk)).slice(-max);
}

function inferProgressStage(line) {
  const lower = String(line || "").toLowerCase();
  const stages = [
    ["qwen", "qwen_running"],
    ["stage1", "stage1_running"],
    ["stage 1", "stage1_running"],
    ["upscal", "upscaling"],
    ["adapter", "adapting"],
    ["stage2", "stage2_running"],
    ["stage 2", "stage2_running"],
    ["mux", "validating"],
  ];
  return stages.find(([needle]) => lower.includes(needle))?.[1] || null;
}

export function createSolH3RunnerClient({
  config,
  fsApi = fs,
  spawnApi = spawn,
  onProgress = () => {},
} = {}) {
  if (!config?.inferPath || !config?.sanaPackageRoot) {
    throw new TypeError("Sol-H3 runner config is incomplete.");
  }
  const children = new Map();

  function runCommand(command, args, { cwd, env, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnApi(command, args, {
          cwd,
          env,
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        reject(error);
        return;
      }
      let stdout = "";
      let stderr = "";
      let settled = false;
      let killTimer = null;
      child.stdout?.on("data", (chunk) => { stdout = appendTail(stdout, chunk); });
      child.stderr?.on("data", (chunk) => { stderr = appendTail(stderr, chunk); });
      const timer = setTimeout(() => {
        if (settled) return;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => { if (!settled) child.kill("SIGKILL"); }, CANCEL_GRACE_MS);
        killTimer.unref?.();
      }, timeoutMs);
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        reject(error);
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        resolve({ code, signal, stdout, stderr });
      });
    });
  }

  async function probeMedia(filePath) {
    const ffprobe = String(process.env.FFPROBE_PATH || "ffprobe");
    const result = await runCommand(ffprobe, [
      "-v", "error",
      "-count_frames",
      "-show_entries", "stream=index,codec_type,codec_name,width,height,nb_read_frames,nb_frames,r_frame_rate,avg_frame_rate,duration",
      "-show_entries", "format=format_name,duration",
      "-of", "json",
      filePath,
    ], { timeoutMs: PROBE_TIMEOUT_MS }).catch((error) => {
      throw solH3Error("SOL_H3_FFPROBE_UNAVAILABLE", "ffprobe is required to validate Sol-H3 media.", 503, { cause: publicProcessError(error) });
    });
    if (result.code !== 0) {
      throw solH3Error("SOL_H3_MEDIA_DECODE_FAILED", "ffprobe could not decode Sol-H3 media.", 422, { stderr: publicProcessError(result.stderr) });
    }
    try { return JSON.parse(result.stdout); }
    catch { throw solH3Error("SOL_H3_MEDIA_DECODE_FAILED", "ffprobe returned invalid media metadata.", 422); }
  }

  async function decodeMedia(filePath) {
    const ffmpeg = String(process.env.FFMPEG_PATH || "ffmpeg");
    const result = await runCommand(ffmpeg, [
      "-v", "error",
      "-i", filePath,
      "-map", "0:v:0?",
      "-map", "0:a:0?",
      "-f", "null",
      "-",
    ], { timeoutMs: DECODE_TIMEOUT_MS }).catch((error) => {
      throw solH3Error("SOL_H3_FFMPEG_UNAVAILABLE", "ffmpeg is required for full Sol-H3 output decode validation.", 503, { cause: publicProcessError(error) });
    });
    if (result.code !== 0) {
      throw solH3Error("SOL_H3_OUTPUT_DECODE_FAILED", "Sol-H3 output failed full decode validation.", 502, { stderr: publicProcessError(result.stderr) });
    }
  }

  async function pathsFile(task) {
    const requiredKey = task === "ref2va" ? "ref2va_lora" : "vsa_lora";
    const candidates = [config.taskPaths?.[task], config.pathsFile, config.fallbackCheckpointPathsFile].filter(Boolean);
    for (const candidate of candidates) {
      const manifest = await fsApi.readFile(candidate, "utf8").then(JSON.parse).catch(() => null);
      if (manifest && typeof manifest[requiredKey] === "string" && manifest[requiredKey].trim()) return candidate;
    }
    throw solH3Error("SOL_H3_PATHS_NOT_READY", "No task-compatible Sol-H3 path manifest is prepared.", 503, { task });
  }

  async function python(pathsFilePath) {
    if (config.inferPython) return config.inferPython;
    const manifest = await fsApi.readFile(pathsFilePath, "utf8").then(JSON.parse).catch(() => null);
    return String(manifest?.stage2_python || manifest?.qwen_python || "python3").trim() || "python3";
  }

  async function run({ jobId, mode, caseFile, outputRoot, logFile, pathsFilePath }) {
    const command = await python(pathsFilePath);
    const args = [
      config.inferPath,
      "--paths", pathsFilePath,
      "--prompts", caseFile,
      "--task", mode,
      "--output-dir", outputRoot,
    ];
    const child = spawnApi(command, args, {
      cwd: config.sanaPackageRoot,
      env: {
        ...process.env,
        HF_HUB_OFFLINE: "1",
        TRANSFORMERS_OFFLINE: "1",
        HF_HUB_DISABLE_IMPLICIT_TOKEN: "1",
        PYTHONUNBUFFERED: "1",
        PYTHONPATH: [config.sanaPackageRoot, process.env.PYTHONPATH || ""].filter(Boolean).join(path.delimiter),
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    children.set(jobId, child);
    let logTail = "";
    const handleOutput = (chunk) => {
      const text = String(chunk);
      logTail = appendTail(logTail, text, 128 * 1024);
      text.split(/\r?\n/u).forEach((line) => {
        const stage = inferProgressStage(line);
        if (stage) onProgress(jobId, stage);
      });
      void fsApi.appendFile(logFile, text, "utf8").catch(() => {});
    };
    child.stdout?.on("data", handleOutput);
    child.stderr?.on("data", handleOutput);

    return await new Promise((resolve, reject) => {
      let settled = false;
      let killTimer = null;
      const timer = setTimeout(() => {
        if (settled) return;
        terminateProcessGroup(child, "SIGTERM");
        killTimer = setTimeout(() => { if (!settled) terminateProcessGroup(child, "SIGKILL"); }, CANCEL_GRACE_MS);
        killTimer.unref?.();
      }, PROCESS_TIMEOUT_MS);
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        children.delete(jobId);
        reject(error);
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        children.delete(jobId);
        resolve({ code, signal, logTail });
      });
    });
  }

  function cancel(jobId) {
    const child = children.get(jobId);
    if (!child) return false;
    terminateProcessGroup(child, "SIGTERM");
    const pid = child.pid;
    const timer = setTimeout(() => {
      const current = children.get(jobId);
      if (current?.pid === pid) terminateProcessGroup(current, "SIGKILL");
    }, CANCEL_GRACE_MS);
    timer.unref?.();
    return true;
  }

  async function close() {
    for (const child of children.values()) terminateProcessGroup(child, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const child of children.values()) terminateProcessGroup(child, "SIGKILL");
    children.clear();
  }

  return Object.freeze({ probeMedia, decodeMedia, pathsFile, run, cancel, close });
}
