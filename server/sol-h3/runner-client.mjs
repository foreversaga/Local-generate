import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
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
  const sessions = new Map();
  let activeSession = null;

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

  async function runOnce({ jobId, mode, caseFile, outputRoot, logFile, pathsFilePath,
                           durationSeconds = 5, refImageMatch = null, refStage1Attn = null }) {
    await fsApi.mkdir(path.dirname(logFile), { recursive: true }).catch(() => {});
    const command = await python(pathsFilePath);
    const args = [
      config.inferPath,
      "--paths", pathsFilePath,
      "--prompts", caseFile,
      "--task", mode,
      "--duration", String(durationSeconds),
      "--output-dir", outputRoot,
    ];
    if (refImageMatch) args.push("--ref-image-match", refImageMatch);
    if (refStage1Attn) args.push("--ref-stage1-attn", refStage1Attn);
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

  function profileKey({ mode, durationSeconds = 5, refImageMatch = null, refStage1Attn = null }) {
    return [mode, durationSeconds, refImageMatch || "default", refStage1Attn || "default"].join(":");
  }

  async function appendLog(logFile, value) {
    await fsApi.appendFile(logFile, value, "utf8").catch(() => {});
  }

  function handleSessionOutput(session, chunk, fallbackJobId) {
    const value = String(chunk);
    session.logTail = appendTail(session.logTail, value, 128 * 1024);
    session.buffer += value;
    const lines = session.buffer.split(/\r?\n/u);
    session.buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch {
        const stage = inferProgressStage(line);
        if (stage) onProgress(fallbackJobId, stage, { source: "daemon-log", line });
        continue;
      }
      if (event.type === "progress" && event.requestId) {
        onProgress(event.requestId, event.stage, event);
      } else if (event.type === "ready") {
        onProgress(fallbackJobId, "preparing", { source: "sol-h3-daemon", ...event });
      }
      if ((event.type === "result" || event.type === "error") && event.requestId) {
        const pending = session.pending.get(event.requestId);
        if (!pending) continue;
        session.pending.delete(event.requestId);
        if (event.type === "result" && event.status === "ok") {
          pending.resolve({ code: 0, signal: null, logTail: session.logTail,
                            persistent: true, result: event.result,
                            sessionReused: Boolean(event.sessionReused) });
        } else {
          pending.resolve({ code: 1, signal: null,
                            logTail: appendTail(session.logTail,
                              event.message || "Sol-H3 daemon reported an error."),
                            persistent: true });
        }
      }
    }
    void appendLog(session.logFile, value);
  }

  function waitForSessionResult(session, jobId) {
    return new Promise((resolve) => session.pending.set(jobId, { resolve }));
  }

  async function stopSession(session) {
    if (!session) return;
    sessions.delete(session.key);
    if (activeSession === session) activeSession = null;
    const child = session.child;
    if (child?.exitCode === null) {
      try {
        child.stdin?.write(JSON.stringify({ v: 1, type: "close" }) + "\n");
        child.stdin?.end?.();
      } catch {
        // The child may already have exited; its close handler will settle it.
      }
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          terminateProcessGroup(child, "SIGTERM");
          const killTimer = setTimeout(() => terminateProcessGroup(child, "SIGKILL"), CANCEL_GRACE_MS);
          killTimer.unref?.();
          resolve();
        }, 30_000);
        timer.unref?.();
        child.once?.("close", () => { clearTimeout(timer); resolve(); });
      });
    }
    for (const [jobId, pending] of session.pending) {
      pending.resolve({ code: 1, signal: "SIGTERM", logTail: session.logTail, persistent: true });
      session.pending.delete(jobId);
      children.delete(jobId);
    }
  }

  async function runPersistent({ jobId, mode, caseFile, outputRoot, logFile, pathsFilePath,
                                 durationSeconds = 5, refImageMatch = null, refStage1Attn = null }) {
    const key = profileKey({ mode, durationSeconds, refImageMatch, refStage1Attn });
    if (activeSession && activeSession.key !== key) await stopSession(activeSession);
    let session = activeSession;
    if (!session || session.child?.exitCode !== null) {
      await fsApi.mkdir(path.dirname(logFile), { recursive: true }).catch(() => {});
      const command = await python(pathsFilePath);
      const daemonPath = config.daemonPath || path.join(config.sanaPackageRoot, "runtime", "daemon.py");
      const sessionRoot = path.join(config.runtimeRoot, "persistent-sessions",
        key.replace(/[^A-Za-z0-9_.-]/gu, "_") + "-" + randomUUID());
      const args = [daemonPath, "--paths", pathsFilePath, "--task", mode,
        "--duration", String(durationSeconds), "--case-file", caseFile,
        "--output-root", outputRoot, "--session-root", sessionRoot,
        "--request-id", jobId];
      if (refImageMatch) args.push("--ref-image-match", refImageMatch);
      if (refStage1Attn) args.push("--ref-stage1-attn", refStage1Attn);
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
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      session = { key, child, buffer: "", logTail: "", pending: new Map(), logFile };
      activeSession = session;
      sessions.set(key, session);
      children.set(jobId, child);
      child.stdout?.on("data", (chunk) => handleSessionOutput(session, chunk, jobId));
      child.stderr?.on("data", (chunk) => {
        session.logTail = appendTail(session.logTail, chunk, 128 * 1024);
        void appendLog(session.logFile, chunk);
      });
      child.once?.("error", () => {});
      child.once?.("close", (code, signal) => {
        sessions.delete(key);
        if (activeSession === session) activeSession = null;
        for (const [pendingId, pending] of session.pending) {
          pending.resolve({ code: code ?? 1, signal, logTail: session.logTail, persistent: true });
          children.delete(pendingId);
        }
        session.pending.clear();
      });
      const result = await waitForSessionResult(session, jobId);
      children.delete(jobId);
      if (result.code !== 0) await stopSession(session);
      return result;
    }

    session.logFile = logFile;
    children.set(jobId, session.child);
    const result = await new Promise((resolve) => {
      session.pending.set(jobId, { resolve });
      try {
        session.child.stdin.write(JSON.stringify({ v: 1, type: "generate", requestId: jobId,
          caseFile, outputRoot }) + "\n");
      } catch {
        session.pending.delete(jobId);
        resolve({ code: 1, signal: null, logTail: session.logTail, persistent: true });
      }
    });
    children.delete(jobId);
    if (result.code !== 0) await stopSession(session);
    return result;
  }

  async function run(options) {
    if (config.persistentRunner === true) return await runPersistent(options);
    return await runOnce(options);
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
    for (const session of [...sessions.values()]) await stopSession(session);
    for (const child of children.values()) terminateProcessGroup(child, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const child of children.values()) terminateProcessGroup(child, "SIGKILL");
    children.clear();
  }

  return Object.freeze({ probeMedia, decodeMedia, pathsFile, run, cancel, close });
}
