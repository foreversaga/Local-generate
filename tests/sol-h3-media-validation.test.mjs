import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createSolH3MediaValidator, detectSolH3MediaMagic } from "../server/sol-h3/media-validation.mjs";

async function withTempDir(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-h3-media-"));
  try { await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

function pngBytes() {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
}

test("detects supported image and container signatures", () => {
  assert.deepEqual(detectSolH3MediaMagic(pngBytes()), { kind: "image", format: "png" });
  const mp4 = Buffer.alloc(16);
  mp4.write("ftyp", 4, "ascii");
  assert.deepEqual(detectSolH3MediaMagic(mp4), { kind: "container", format: "iso-bmff" });
});

test("rejects extension and magic mismatches", async () => {
  await withTempDir(async (root) => {
    const sourcePath = path.join(root, "fake.mp4");
    await fs.writeFile(sourcePath, pngBytes());
    const validator = createSolH3MediaValidator({
      probeMedia: async () => ({ streams: [{ codec_type: "video", width: 16, height: 16 }], format: { duration: "1" } }),
    });
    await assert.rejects(
      validator.inspect({ sourcePath, locator: { relativePath: "fake.mp4" }, expectedKinds: ["video"] }),
      { code: "SOL_H3_MEDIA_MAGIC_MISMATCH", status: 422 },
    );
  });
});

test("validates and stages an image while preserving source fingerprint", async () => {
  await withTempDir(async (root) => {
    const sourcePath = path.join(root, "source.png");
    const destination = path.join(root, "job", "inputs", "first.png");
    await fs.writeFile(sourcePath, pngBytes());
    const stat = await fs.stat(sourcePath);
    const validator = createSolH3MediaValidator({
      probeMedia: async () => ({ streams: [{ codec_type: "video", width: 100, height: 100 }], format: {} }),
    });
    const staged = await validator.stage({
      sourcePath,
      destination,
      locator: { relativePath: "source.png", fingerprint: { size: stat.size, mtimeMs: stat.mtimeMs } },
      expectedKinds: ["image"],
    });
    assert.equal(staged.kind, "image");
    assert.equal((await fs.stat(destination)).size, stat.size);
  });
});

test("rejects media that changed since the browser fingerprint", async () => {
  await withTempDir(async (root) => {
    const sourcePath = path.join(root, "source.png");
    await fs.writeFile(sourcePath, pngBytes());
    const validator = createSolH3MediaValidator({
      probeMedia: async () => ({ streams: [{ codec_type: "video", width: 100, height: 100 }], format: {} }),
    });
    await assert.rejects(
      validator.inspect({
        sourcePath,
        locator: { relativePath: "source.png", fingerprint: { size: 999999 } },
        expectedKinds: ["image"],
      }),
      { code: "SOL_H3_MEDIA_CHANGED", status: 409 },
    );
  });
});

test("enforces video duration limits from decoded metadata", async () => {
  await withTempDir(async (root) => {
    const sourcePath = path.join(root, "source.mp4");
    const bytes = Buffer.alloc(32);
    bytes.write("ftyp", 4, "ascii");
    await fs.writeFile(sourcePath, bytes);
    const validator = createSolH3MediaValidator({
      probeMedia: async () => ({ streams: [{ codec_type: "video", width: 1920, height: 1080 }], format: { duration: "121" } }),
    });
    await assert.rejects(
      validator.inspect({ sourcePath, locator: { relativePath: "source.mp4" }, expectedKinds: ["video"] }),
      { code: "SOL_H3_MEDIA_DURATION_LIMIT", status: 422 },
    );
  });
});
