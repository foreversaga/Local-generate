import { promises as fs } from "node:fs";
import path from "node:path";

import { inferSolH3MediaKind, solH3Error } from "./request.mjs";

export const DEFAULT_SOL_H3_MEDIA_LIMITS = Object.freeze({
  imageBytes: 50 * 1024 * 1024,
  videoBytes: 2 * 1024 * 1024 * 1024,
  audioBytes: 512 * 1024 * 1024,
  imagePixels: 80_000_000,
  videoPixels: 80_000_000,
  videoDurationSeconds: 120,
  audioDurationSeconds: 300,
});

const EXTENSIONS = Object.freeze({
  image: new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]),
  video: new Set([".mp4", ".mov", ".webm", ".mkv", ".avi"]),
  audio: new Set([".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"]),
});

function startsWith(buffer, bytes) {
  if (buffer.length < bytes.length) return false;
  return bytes.every((value, index) => buffer[index] === value);
}

function ascii(buffer, start, length) {
  return buffer.subarray(start, start + length).toString("ascii");
}

export function detectSolH3MediaMagic(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || []);
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: "image", format: "png" };
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return { kind: "image", format: "jpeg" };
  if (ascii(buffer, 0, 6) === "GIF87a" || ascii(buffer, 0, 6) === "GIF89a") return { kind: "image", format: "gif" };
  if (ascii(buffer, 0, 2) === "BM") return { kind: "image", format: "bmp" };
  if (ascii(buffer, 0, 4) === "RIFF" && ascii(buffer, 8, 4) === "WEBP") return { kind: "image", format: "webp" };
  if (ascii(buffer, 4, 4) === "ftyp") return { kind: "container", format: "iso-bmff" };
  if (startsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3])) return { kind: "container", format: "ebml" };
  if (ascii(buffer, 0, 4) === "RIFF" && ascii(buffer, 8, 4) === "WAVE") return { kind: "audio", format: "wav" };
  if (ascii(buffer, 0, 4) === "fLaC") return { kind: "audio", format: "flac" };
  if (ascii(buffer, 0, 4) === "OggS") return { kind: "container", format: "ogg" };
  if (ascii(buffer, 0, 3) === "ID3" || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) return { kind: "audio", format: "mpeg-audio" };
  if (buffer[0] === 0xff && (buffer[1] === 0xf1 || buffer[1] === 0xf9)) return { kind: "audio", format: "aac" };
  if (ascii(buffer, 0, 4) === "RIFF" && ascii(buffer, 8, 4) === "AVI ") return { kind: "video", format: "avi" };
  return null;
}

function sizeLimit(kind, limits) {
  if (kind === "image") return limits.imageBytes;
  if (kind === "video") return limits.videoBytes;
  if (kind === "audio") return limits.audioBytes;
  return 0;
}

function validateProbe(kind, metadata, limits) {
  const streams = Array.isArray(metadata?.streams) ? metadata.streams : [];
  const format = metadata?.format || {};
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const duration = Number(format.duration ?? video?.duration ?? audio?.duration ?? 0);

  if (kind === "image") {
    if (!video || Number(video.width) <= 0 || Number(video.height) <= 0) {
      throw solH3Error("SOL_H3_MEDIA_DECODE_FAILED", "Image could not be decoded.", 422);
    }
    const pixels = Number(video.width) * Number(video.height);
    if (!Number.isSafeInteger(pixels) || pixels > limits.imagePixels) {
      throw solH3Error("SOL_H3_MEDIA_PIXEL_LIMIT", "Image exceeds the Sol-H3 pixel limit.", 422);
    }
  } else if (kind === "video") {
    if (!video) throw solH3Error("SOL_H3_MEDIA_STREAM_INVALID", "Video input must contain a video stream.", 422);
    const pixels = Number(video.width) * Number(video.height);
    if (!Number.isSafeInteger(pixels) || pixels <= 0 || pixels > limits.videoPixels) {
      throw solH3Error("SOL_H3_MEDIA_PIXEL_LIMIT", "Video exceeds the Sol-H3 pixel limit.", 422);
    }
    if (!Number.isFinite(duration) || duration <= 0 || duration > limits.videoDurationSeconds) {
      throw solH3Error("SOL_H3_MEDIA_DURATION_LIMIT", "Video duration is outside the Sol-H3 input limit.", 422);
    }
  } else if (kind === "audio") {
    if (!audio) throw solH3Error("SOL_H3_MEDIA_STREAM_INVALID", "Audio input must contain an audio stream.", 422);
    if (!Number.isFinite(duration) || duration <= 0 || duration > limits.audioDurationSeconds) {
      throw solH3Error("SOL_H3_MEDIA_DURATION_LIMIT", "Audio duration is outside the Sol-H3 input limit.", 422);
    }
  }
  return { streams, format, duration };
}

export function createSolH3MediaValidator({ fsApi = fs, probeMedia, limits = DEFAULT_SOL_H3_MEDIA_LIMITS } = {}) {
  if (typeof probeMedia !== "function") throw new TypeError("Sol-H3 media probe is required.");

  async function inspect({ sourcePath, locator, expectedKinds }) {
    const stat = await fsApi.lstat(sourcePath).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      throw solH3Error("SOL_H3_MEDIA_NOT_REGULAR", "Input media must be a regular file.", 422);
    }
    const extension = path.extname(locator.relativePath).toLowerCase();
    const kind = inferSolH3MediaKind(locator.relativePath, locator.kind);
    if (!kind || !expectedKinds.includes(kind) || !EXTENSIONS[kind]?.has(extension)) {
      throw solH3Error("SOL_H3_MEDIA_KIND_INVALID", "The selected media type is not valid for this mode.", 422, { expected: expectedKinds, actual: kind });
    }
    const limit = sizeLimit(kind, limits);
    if (!Number.isSafeInteger(stat.size) || stat.size <= 0 || stat.size > limit) {
      throw solH3Error("SOL_H3_MEDIA_SIZE_LIMIT", "Input media exceeds the Sol-H3 size limit.", 422, { kind, size: stat.size, limit });
    }
    if (locator.fingerprint?.size !== undefined && locator.fingerprint.size !== stat.size) {
      throw solH3Error("SOL_H3_MEDIA_CHANGED", "The selected media changed before staging.", 409);
    }
    if (locator.fingerprint?.mtimeMs !== undefined && Math.abs(locator.fingerprint.mtimeMs - stat.mtimeMs) > 1) {
      throw solH3Error("SOL_H3_MEDIA_CHANGED", "The selected media changed before staging.", 409);
    }

    const handle = await fsApi.open(sourcePath, "r");
    const header = Buffer.alloc(32);
    try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
    const magic = detectSolH3MediaMagic(header);
    if (!magic) throw solH3Error("SOL_H3_MEDIA_MAGIC_INVALID", "Input media signature is not supported.", 422);
    if (magic.kind !== "container" && magic.kind !== kind) {
      throw solH3Error("SOL_H3_MEDIA_MAGIC_MISMATCH", "Input media extension does not match its file signature.", 422, { expected: kind, actual: magic.kind });
    }

    const metadata = await probeMedia(sourcePath);
    validateProbe(kind, metadata, limits);
    return { kind, stat, metadata, magic };
  }

  async function stage({ sourcePath, destination, locator, expectedKinds }) {
    const before = await inspect({ sourcePath, locator, expectedKinds });
    await fsApi.mkdir(path.dirname(destination), { recursive: true });
    await fsApi.copyFile(sourcePath, destination);
    const [sourceAfter, staged] = await Promise.all([
      fsApi.stat(sourcePath),
      fsApi.stat(destination),
    ]);
    if (sourceAfter.size !== before.stat.size || Math.abs(sourceAfter.mtimeMs - before.stat.mtimeMs) > 1) {
      await fsApi.unlink(destination).catch(() => {});
      throw solH3Error("SOL_H3_MEDIA_CHANGED", "The selected media changed while staging.", 409);
    }
    if (!staged.isFile() || staged.size !== before.stat.size) {
      await fsApi.unlink(destination).catch(() => {});
      throw solH3Error("SOL_H3_MEDIA_STAGE_FAILED", "Staged media did not match the source.", 409);
    }
    return {
      path: destination,
      kind: before.kind,
      size: staged.size,
      sourceMtimeMs: before.stat.mtimeMs,
      metadata: before.metadata,
    };
  }

  return Object.freeze({ inspect, stage });
}
