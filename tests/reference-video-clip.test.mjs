import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promises as fs } from "node:fs";
import { normalizeReferenceVideoClip, prepareReferenceVideoClip } from "../server/video-generation/reference-video-clip.mjs";

test("normalizes a bounded clip and preserves aspect ratio under the resolution cap", () => {
  assert.deepEqual(normalizeReferenceVideoClip({ start: 2, end: 8, maxDimension: 720 }, {
    sourceDuration: 20,
    sourceWidth: 1920,
    sourceHeight: 1080,
  }), { start: 2, end: 8, duration: 6, maxDimension: 720, width: 720, height: 404 });
  assert.throws(() => normalizeReferenceVideoClip({ start: 8, end: 2 }, { sourceDuration: 20 }), { code: "REFERENCE_VIDEO_END_INVALID" });
  assert.throws(() => normalizeReferenceVideoClip({ start: 0, end: 61 }, { sourceDuration: 100 }), { code: "REFERENCE_VIDEO_DURATION_INVALID" });
});

test("prepares a silent H.264 clip with explicit trim and scale arguments", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ref2v-clip-"));
  const inputPath = path.join(root, "source.mp4");
  await fs.writeFile(inputPath, "source");
  const calls = [];
  const result = await prepareReferenceVideoClip({
    inputPath,
    outputRoot: root,
    start: 1.25,
    end: 5.75,
    maxDimension: 480,
    tools: { executables: { ffmpeg: "ffmpeg-test" }, probe: async () => ({ format: { duration: 10 }, video: { width: 1280, height: 720 } }) },
    run: async (executable, args) => {
      calls.push({ executable, args });
      await fs.writeFile(args.at(-1), "video");
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(calls[0].executable, "ffmpeg-test");
  assert.deepEqual(calls[0].args.slice(0, 10), ["-y", "-ss", "1.250", "-i", inputPath, "-t", "4.500", "-map", "0:v:0", "-an"]);
  assert.ok(calls[0].args.includes("scale=480:270"));
  assert.equal(result.plan.duration, 4.5);
});

test("removes a partial reference clip when preprocessing fails", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ref2v-clip-failure-"));
  const inputPath = path.join(root, "source.mp4");
  await fs.writeFile(inputPath, "source");
  await assert.rejects(() => prepareReferenceVideoClip({
    inputPath,
    outputRoot: root,
    end: 2,
    tools: { executables: { ffmpeg: "ffmpeg-test" }, probe: async () => ({ format: { duration: 10 }, video: { width: 1280, height: 720 } }) },
    run: async (_executable, args) => {
      await fs.writeFile(args.at(-1), "partial");
      return { exitCode: 7, stdout: "", stderr: "failed" };
    },
  }), { code: "REFERENCE_VIDEO_PREPROCESS_FAILED" });
  assert.deepEqual(await fs.readdir(path.join(root, "h3-studio-ref2v-clips")), []);
});
