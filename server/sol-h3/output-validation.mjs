import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";

import { SOL_H3_OUTPUT_SPEC, solH3Error } from "./request.mjs";

function frameRate(value) {
  const text = String(value || "").trim();
  if (!text) return NaN;
  if (!text.includes("/")) return Number(text);
  const [numerator, denominator] = text.split("/").map(Number);
  return denominator ? numerator / denominator : NaN;
}

export function validateSolH3OutputMetadata(metadata, spec = SOL_H3_OUTPUT_SPEC) {
  const streams = Array.isArray(metadata?.streams) ? metadata.streams : [];
  const videos = streams.filter((stream) => stream.codec_type === "video");
  const audios = streams.filter((stream) => stream.codec_type === "audio");
  const formatNames = String(metadata?.format?.format_name || "").split(",").map((value) => value.trim().toLowerCase());
  const video = videos[0];
  const fps = frameRate(video?.r_frame_rate || video?.avg_frame_rate);
  const frames = Number(video?.nb_read_frames ?? video?.nb_frames);

  const failures = [];
  if (videos.length !== 1) failures.push("video_stream_count");
  if (audios.length < 1) failures.push("audio_stream_missing");
  if (!formatNames.some((name) => name === "mp4" || name === "mov")) failures.push("container");
  if (Number(video?.width) !== spec.width || Number(video?.height) !== spec.height) failures.push("resolution");
  if (frames !== spec.frames) failures.push("frames");
  if (!Number.isFinite(fps) || Math.abs(fps - spec.fps) > 0.01) failures.push("fps");
  if (!audios.some((stream) => String(stream.codec_name || "").toLowerCase() === spec.audioCodec)) failures.push("audio_codec");

  if (failures.length) {
    throw solH3Error(
      "SOL_H3_OUTPUT_CONTRACT_FAILED",
      "Sol-H3 output did not meet the MP4/AAC/frames/FPS contract.",
      502,
      {
        failures,
        video: video ? { width: Number(video.width), height: Number(video.height), frames, fps } : null,
        audio: audios.map((stream) => ({ codec: stream.codec_name || null })),
        format: metadata?.format?.format_name || null,
      },
    );
  }

  return {
    container: "mp4",
    video: { width: spec.width, height: spec.height, frames: spec.frames, fps: spec.fps },
    audio: { codec: spec.audioCodec, streams: audios.length },
    duration: Number(metadata?.format?.duration) || null,
  };
}

async function sha256File(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

export function createSolH3OutputValidator({ fsApi = fs, probeMedia, decodeMedia, spec = SOL_H3_OUTPUT_SPEC } = {}) {
  if (typeof probeMedia !== "function" || typeof decodeMedia !== "function") {
    throw new TypeError("Sol-H3 output validator requires probeMedia and decodeMedia.");
  }

  async function validate(filePath, { producer = "official-sol-h3-infer", pipelineFingerprint = null } = {}) {
    const stat = await fsApi.lstat(filePath).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
      throw solH3Error("SOL_H3_OUTPUT_INVALID", "Sol-H3 output must be a non-empty regular file.", 502);
    }
    const metadata = await probeMedia(filePath);
    const contract = validateSolH3OutputMetadata(metadata, spec);
    await decodeMedia(filePath);
    const sha256 = await sha256File(filePath);
    return {
      ...contract,
      artifact: {
        name: "final.mp4",
        size: stat.size,
        sha256,
        producer,
        pipelineFingerprint,
      },
    };
  }

  return Object.freeze({ validate });
}
