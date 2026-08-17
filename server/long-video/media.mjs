import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { LongVideoError } from "./schema.mjs";

function executableFromEnv(name, fallback) {
  const configured = process.env[name];
  return configured ? path.resolve(configured) : fallback;
}

export function mediaExecutables() {
  return {
    ffmpeg: executableFromEnv("FFMPEG_PATH", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"),
    ffprobe: executableFromEnv("FFPROBE_PATH", process.platform === "win32" ? "ffprobe.exe" : "ffprobe"),
  };
}

function tail(value, limit = 4000) {
  return String(value || "").slice(-limit);
}

function frameRate(stream) {
  const raw = String(stream?.avg_frame_rate || stream?.r_frame_rate || "");
  const [numerator, denominator] = raw.split("/").map(Number);
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator ? numerator / denominator : Number.NaN;
}

export function validateNormalizedProbe(probe, { duration, width, height, fps = 24 } = {}) {
  const video = probe?.video;
  const audio = probe?.audio;
  if (!video) throw new LongVideoError("NORMALIZED_VIDEO_MISSING", "Normalized output has no video stream.", 502);
  if (!audio) throw new LongVideoError("NORMALIZED_AUDIO_MISSING", "Normalized output has no audio stream.", 502);
  if (video.codec_name && video.codec_name.toLowerCase() !== "h264") throw new LongVideoError("NORMALIZED_CODEC_INVALID", "Normalized video must use H.264.", 502, { codec: video.codec_name });
  if (video.pix_fmt && video.pix_fmt !== "yuv420p") throw new LongVideoError("NORMALIZED_PIXEL_FORMAT_INVALID", "Normalized video must use yuv420p.", 502, { pixelFormat: video.pix_fmt });
  if (width && Number(video.width) && Number(video.width) !== Number(width)) throw new LongVideoError("NORMALIZED_WIDTH_INVALID", "Normalized video width does not match the sequence.", 502, { expected: width, actual: video.width });
  if (height && Number(video.height) && Number(video.height) !== Number(height)) throw new LongVideoError("NORMALIZED_HEIGHT_INVALID", "Normalized video height does not match the sequence.", 502, { expected: height, actual: video.height });
  const actualFps = frameRate(video);
  if (Number.isFinite(actualFps) && Math.abs(actualFps - fps) > 0.05) throw new LongVideoError("NORMALIZED_FPS_INVALID", "Normalized video must be 24 fps.", 502, { expected: fps, actual: actualFps });
  if (audio.codec_name && audio.codec_name.toLowerCase() !== "aac") throw new LongVideoError("NORMALIZED_AUDIO_CODEC_INVALID", "Normalized audio must use AAC.", 502, { codec: audio.codec_name });
  if (audio.sample_rate && Number(audio.sample_rate) !== 48000) throw new LongVideoError("NORMALIZED_AUDIO_RATE_INVALID", "Normalized audio must be 48 kHz.", 502, { expected: 48000, actual: audio.sample_rate });
  if (audio.channels && Number(audio.channels) !== 2) throw new LongVideoError("NORMALIZED_AUDIO_CHANNELS_INVALID", "Normalized audio must be stereo.", 502, { expected: 2, actual: audio.channels });
  const actualDuration = Number(probe?.format?.duration);
  if (Number.isFinite(actualDuration) && duration !== undefined && Math.abs(actualDuration - Number(duration)) > 0.15) throw new LongVideoError("NORMALIZED_DURATION_INVALID", "Normalized duration does not match the segment.", 502, { expected: duration, actual: actualDuration });
  return true;
}

export async function runCommand(executable, args, { cwd, timeoutMs = 300000, spawnImpl = spawn } = {}) {
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timer;
    let child;
    try { child = spawnImpl(executable, args, { cwd, windowsHide: true, shell: false }); } catch (error) { reject(error); return; }
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    timer = setTimeout(() => { child.kill?.(); reject(new LongVideoError("MEDIA_TIMEOUT", `${executable} timed out.`, 504, { stderr: tail(stderr) })); }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode: exitCode ?? -1, stdout, stderr, stderrTail: tail(stderr) });
    });
  });
}

export async function checkMediaTools({ executables = mediaExecutables(), run = runCommand } = {}) {
  const result = {};
  for (const [key, executable] of Object.entries(executables)) {
    try {
      const response = await run(executable, ["-version"]);
      result[key] = { executable, available: response.exitCode === 0, exitCode: response.exitCode, version: String(response.stdout || "").split(/\r?\n/)[0].slice(0, 200), stderrTail: tail(response.stderr) };
    } catch (error) {
      result[key] = { executable, available: false, error: error.message };
    }
  }
  if (!result.ffmpeg?.available || !result.ffprobe?.available) {
    throw new LongVideoError("MEDIA_TOOLS_UNAVAILABLE", "ffmpeg and ffprobe are required for long-video normalization; configure FFMPEG_PATH and FFPROBE_PATH.", 503, result);
  }
  return result;
}

export async function probeMedia(inputPath, { executables = mediaExecutables(), run = runCommand, logger = null } = {}) {
  const args = ["-v", "error", "-show_streams", "-show_format", "-of", "json", inputPath];
  await logger?.({ event: "media.probe.start", executable: executables.ffprobe, args, inputPath });
  let response;
  try {
    response = await run(executables.ffprobe, args);
  } catch (error) {
    await logger?.({ level: "error", event: "media.probe.failure", executable: executables.ffprobe, args, errorMessage: error.message });
    throw new LongVideoError("FFPROBE_FAILED", "ffprobe failed while inspecting media.", 502, { executable: executables.ffprobe, error: error.message });
  }
  if (response.exitCode !== 0) {
    await logger?.({ level: "error", event: "media.probe.failure", executable: executables.ffprobe, args, exitCode: response.exitCode, stderrTail: tail(response.stderr) });
    throw new LongVideoError("FFPROBE_FAILED", "ffprobe failed while inspecting media.", 502, { executable: executables.ffprobe, exitCode: response.exitCode, stderrTail: tail(response.stderr) });
  }
  let data;
  try { data = JSON.parse(response.stdout || "{}"); } catch (error) {
    await logger?.({ level: "error", event: "media.probe.failure", executable: executables.ffprobe, args, errorMessage: error.message, stderrTail: tail(response.stderr) });
    throw new LongVideoError("FFPROBE_INVALID_JSON", "ffprobe returned invalid JSON.", 502, { cause: error.message, stderrTail: tail(response.stderr) });
  }
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const result = {
    ...data,
    streams,
    video: streams.find((stream) => stream.codec_type === "video") || null,
    audio: streams.find((stream) => stream.codec_type === "audio") || null,
  };
  await logger?.({ event: "media.probe.success", executable: executables.ffprobe, args, duration: result.format?.duration || null, hasAudio: Boolean(result.audio) });
  return result;
}

export async function normalizeVideo({ inputPath, outputPath, duration, fps = 24, width, height, tools = {}, run = runCommand, logger = null }) {
  if (!inputPath || !outputPath) throw new LongVideoError("MEDIA_INPUT_REQUIRED", "Input and output paths are required.");
  const executables = tools.executables || mediaExecutables();
  const probe = tools.probe ? await tools.probe(inputPath) : await probeMedia(inputPath, { executables, run, logger });
  const args = ["-y", "-i", inputPath];
  if (!probe.audio) args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
  args.push("-map", "0:v:0", "-map", probe.audio ? "0:a:0" : "1:a:0", "-t", Number(duration).toFixed(3), "-r", String(fps));
  if (width && height) args.push("-vf", `scale=${Math.round(width)}:${Math.round(height)}:force_original_aspect_ratio=decrease,pad=${Math.round(width)}:${Math.round(height)}:(ow-iw)/2:(oh-ih)/2`);
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-af", "apad", "-shortest", outputPath);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await logger?.({ event: "media.normalize.start", executable: executables.ffmpeg, args: args.map((item) => item.length > 500 ? `${item.slice(0, 500)}…` : item), inputPath, outputPath, duration });
  let response;
  try { response = await run(executables.ffmpeg, args); } catch (error) {
    await logger?.({ level: "error", event: "media.normalize.failure", executable: executables.ffmpeg, args, errorMessage: error.message });
    throw new LongVideoError("FFMPEG_UNAVAILABLE", `Unable to execute ffmpeg: ${error.message}`, 503, { executable: executables.ffmpeg, error: error.message });
  }
  if (response.exitCode !== 0) {
    await logger?.({ level: "error", event: "media.normalize.failure", executable: executables.ffmpeg, args, exitCode: response.exitCode, stderrTail: tail(response.stderr) });
    throw new LongVideoError("FFMPEG_NORMALIZE_FAILED", "ffmpeg failed while normalizing a segment.", 502, { executable: executables.ffmpeg, exitCode: response.exitCode, stderrTail: tail(response.stderr) });
  }
  const normalizedProbe = tools.probe ? await tools.probe(outputPath) : await probeMedia(outputPath, { executables, run, logger });
  validateNormalizedProbe(normalizedProbe, { duration, width, height, fps });
  await logger?.({ event: "media.normalize.success", outputPath, exitCode: response.exitCode });
  return { outputPath, probe: normalizedProbe, inputProbe: probe, response };
}

export async function extractTailFrame({ inputPath, outputPath, tools = {}, run = runCommand, logger = null }) {
  const executables = tools.executables || mediaExecutables();
  // `format=png` is not a pixel format and is rejected by FFmpeg 9.  Select
  // the PNG encoder explicitly and let swscale convert the decoded frame to
  // RGB24 before writing the single image.
  const args = ["-y", "-sseof", "-0.05", "-i", inputPath, "-map", "0:v:0", "-frames:v", "1", "-c:v", "png", "-pix_fmt", "rgb24", outputPath];
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await logger?.({ event: "media.tail.start", executable: executables.ffmpeg, args, inputPath, outputPath });
  let response;
  try { response = await run(executables.ffmpeg, args); } catch (error) {
    await logger?.({ level: "error", event: "media.tail.failure", executable: executables.ffmpeg, args, errorMessage: error.message });
    throw new LongVideoError("FFMPEG_UNAVAILABLE", `Unable to execute ffmpeg: ${error.message}`, 503, { executable: executables.ffmpeg, error: error.message });
  }
  if (response.exitCode !== 0) {
    await logger?.({ level: "error", event: "media.tail.failure", executable: executables.ffmpeg, args, exitCode: response.exitCode, stderrTail: tail(response.stderr) });
    throw new LongVideoError("FFMPEG_TAIL_FAILED", "ffmpeg failed while extracting a normalized tail frame.", 502, { executable: executables.ffmpeg, exitCode: response.exitCode, stderrTail: tail(response.stderr) });
  }
  const outputStat = await fs.stat(outputPath).catch(() => null);
  if (!outputStat?.isFile()) throw new LongVideoError("TAIL_OUTPUT_MISSING", "Tail frame extraction completed without an output file.", 502, { outputPath });
  await logger?.({ event: "media.tail.success", outputPath, exitCode: response.exitCode });
  return { outputPath, response };
}

/**
 * Keep a short, normalized visual reference for the next H3 storyboard shot.
 * Audio is excluded by default so an independent shot cannot accidentally
 * copy dialogue or ambience from the preceding shot. The legacy caller may
 * still opt into paired audio explicitly.
 */
export async function extractTailAvContext({ inputPath, outputPath, duration = 2, fps = 24, includeAudio = false, tools = {}, run = runCommand, logger = null }) {
  if (!inputPath || !outputPath) throw new LongVideoError("MEDIA_INPUT_REQUIRED", "Input and output paths are required.");
  const contextDuration = Math.min(2, Math.max(0.25, Number(duration) || 1.5));
  const executables = tools.executables || mediaExecutables();
  const args = [
    "-y", "-sseof", `-${contextDuration.toFixed(3)}`, "-i", inputPath,
    "-map", "0:v:0", ...(includeAudio ? ["-map", "0:a:0?"] : ["-an"]), "-t", contextDuration.toFixed(3),
    "-r", String(fps), "-c:v", "libx264", "-pix_fmt", "yuv420p",
    ...(includeAudio ? ["-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest"] : []), outputPath,
  ];
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await logger?.({ event: "media.context.start", executable: executables.ffmpeg, args, inputPath, outputPath, duration: contextDuration });
  let response;
  try { response = await run(executables.ffmpeg, args); } catch (error) {
    await logger?.({ level: "error", event: "media.context.failure", executable: executables.ffmpeg, args, errorMessage: error.message });
    throw new LongVideoError("FFMPEG_UNAVAILABLE", `Unable to execute ffmpeg: ${error.message}`, 503, { executable: executables.ffmpeg, error: error.message });
  }
  if (response.exitCode !== 0) {
    await logger?.({ level: "error", event: "media.context.failure", executable: executables.ffmpeg, args, exitCode: response.exitCode, stderrTail: tail(response.stderr) });
    throw new LongVideoError("FFMPEG_CONTEXT_FAILED", "ffmpeg failed while extracting the storyboard visual reference.", 502, { executable: executables.ffmpeg, exitCode: response.exitCode, stderrTail: tail(response.stderr) });
  }
  const outputStat = await fs.stat(outputPath).catch(() => null);
  if (!outputStat?.isFile()) throw new LongVideoError("CONTEXT_OUTPUT_MISSING", "AV context extraction completed without an output file.", 502, { outputPath });
  await logger?.({ event: "media.context.success", outputPath, exitCode: response.exitCode, duration: contextDuration });
  return { outputPath, duration: contextDuration, response };
}

export { tail as stderrTail };
export const normalizeSegment = normalizeVideo;
export const extractNormalizedTail = extractTailFrame;
export const extractNormalizedTailAvContext = extractTailAvContext;
