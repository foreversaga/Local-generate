import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { mediaExecutables, probeMedia, runCommand } from "../long-video/media.mjs";
import { LongVideoError } from "../long-video/schema.mjs";

export const REFERENCE_VIDEO_MAX_DIMENSIONS = Object.freeze([480, 720, 960, 0]);

function even(value) {
  return Math.max(2, Math.floor(Number(value) / 2) * 2);
}

export function normalizeReferenceVideoClip(input = {}, { sourceDuration, sourceWidth, sourceHeight } = {}) {
  const available = Number(sourceDuration);
  const start = Number(input.start ?? 0);
  const requestedEnd = input.end === undefined || input.end === null || input.end === "" ? available : Number(input.end);
  if (!Number.isFinite(start) || start < 0) throw new LongVideoError("REFERENCE_VIDEO_START_INVALID", "Reference video start must be zero or greater.", 400);
  if (!Number.isFinite(requestedEnd) || requestedEnd <= start) throw new LongVideoError("REFERENCE_VIDEO_END_INVALID", "Reference video end must be after the start.", 400);
  if (Number.isFinite(available) && requestedEnd > available + 0.05) {
    throw new LongVideoError("REFERENCE_VIDEO_RANGE_INVALID", "Reference video clip exceeds the source duration.", 400, { sourceDuration: available });
  }
  const duration = Number((requestedEnd - start).toFixed(3));
  if (duration < 0.5 || duration > 60) throw new LongVideoError("REFERENCE_VIDEO_DURATION_INVALID", "Reference video clip must be between 0.5 and 60 seconds.", 400);
  const maxDimension = Number(input.maxDimension ?? 720);
  if (!REFERENCE_VIDEO_MAX_DIMENSIONS.includes(maxDimension)) {
    throw new LongVideoError("REFERENCE_VIDEO_RESOLUTION_INVALID", "Reference video resolution preset is invalid.", 400);
  }
  const originalWidth = even(sourceWidth || 2);
  const originalHeight = even(sourceHeight || 2);
  let width = originalWidth;
  let height = originalHeight;
  if (maxDimension && Math.max(originalWidth, originalHeight) > maxDimension) {
    const scale = maxDimension / Math.max(originalWidth, originalHeight);
    width = even(originalWidth * scale);
    height = even(originalHeight * scale);
  }
  return { start, end: requestedEnd, duration, maxDimension, width, height };
}

export async function prepareReferenceVideoClip({
  inputPath,
  outputRoot,
  start = 0,
  end,
  maxDimension = 720,
  tools = {},
  run = runCommand,
} = {}) {
  if (!inputPath || !outputRoot) throw new LongVideoError("REFERENCE_VIDEO_INPUT_REQUIRED", "Reference video input and output root are required.", 400);
  const executables = tools.executables || mediaExecutables();
  const probe = tools.probe ? await tools.probe(inputPath) : await probeMedia(inputPath, { executables, run });
  if (!probe?.video) throw new LongVideoError("REFERENCE_VIDEO_STREAM_MISSING", "Reference media has no video stream.", 415);
  const plan = normalizeReferenceVideoClip({ start, end, maxDimension }, {
    sourceDuration: probe.format?.duration,
    sourceWidth: probe.video.width,
    sourceHeight: probe.video.height,
  });
  const folder = path.resolve(outputRoot, "h3-studio-ref2v-clips");
  const inputStat = await fs.stat(inputPath);
  const cacheKey = createHash("sha256").update(JSON.stringify({
    inputPath: path.resolve(inputPath),
    size: inputStat.size,
    modified: inputStat.mtimeMs,
    start: plan.start,
    end: plan.end,
    width: plan.width,
    height: plan.height,
  })).digest("hex").slice(0, 24);
  const outputPath = path.join(folder, `ref2v-${cacheKey}.mp4`);
  const resolvedRoot = path.resolve(outputRoot);
  if (!outputPath.startsWith(resolvedRoot + path.sep)) throw new LongVideoError("REFERENCE_VIDEO_OUTPUT_INVALID", "Reference clip path is outside the input root.", 500);
  await fs.mkdir(folder, { recursive: true });
  const cached = await fs.stat(outputPath).catch(() => null);
  if (cached?.isFile() && cached.size) return { outputPath, plan, probe, response: null, cached: true };
  const args = [
    "-y", "-ss", plan.start.toFixed(3), "-i", inputPath, "-t", plan.duration.toFixed(3),
    "-map", "0:v:0", "-an", "-r", "24",
    "-vf", `scale=${plan.width}:${plan.height}`,
    "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    outputPath,
  ];
  let response;
  try {
    response = await run(executables.ffmpeg, args);
  } catch (error) {
    throw new LongVideoError("REFERENCE_VIDEO_FFMPEG_UNAVAILABLE", `Unable to preprocess the reference video: ${error.message}`, 503);
  }
  if (response.exitCode !== 0) {
    throw new LongVideoError("REFERENCE_VIDEO_PREPROCESS_FAILED", "FFmpeg failed while trimming or resizing the reference video.", 502, { stderrTail: String(response.stderr || "").slice(-2000) });
  }
  const stat = await fs.stat(outputPath).catch(() => null);
  if (!stat?.isFile() || !stat.size) throw new LongVideoError("REFERENCE_VIDEO_OUTPUT_MISSING", "Reference video preprocessing produced no output.", 502);
  return { outputPath, plan, probe, response };
}
