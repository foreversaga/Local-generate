import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeImageResolution,
  readImageDimensions,
  resolutionGridForMode,
} from "../app/lib/single-image-resolution.mjs";

test("image resolution uses the H3 grid and preserves landscape, portrait, and square ratios", () => {
  assert.equal(resolutionGridForMode("i2v"), 32);
  assert.deepEqual(normalizeImageResolution(1600, 900, "i2v"), {
    originalWidth: 1600,
    originalHeight: 900,
    width: 1600,
    height: 896,
    grid: 32,
    scaled: false,
    adjusted: true,
  });
  assert.deepEqual(normalizeImageResolution(900, 1600, "i2v").width, 896);
  assert.deepEqual(normalizeImageResolution(900, 1600, "i2v").height, 1600);
  assert.deepEqual(normalizeImageResolution(1000, 1000, "i2v").width, 992);
  assert.deepEqual(normalizeImageResolution(1000, 1000, "i2v").height, 992);
});

test("image resolution caps oversized sources before snapping to the legal grid", () => {
  const normalized = normalizeImageResolution(4000, 3000, "i2v");
  assert.equal(normalized.width, 2048);
  assert.equal(normalized.height, 1536);
  assert.equal(normalized.scaled, true);
  assert.equal(normalized.adjusted, true);
});

test("Wan Animate uses its 16px grid without stretching the source ratio", () => {
  const normalized = normalizeImageResolution(1000, 600, "replace");
  assert.equal(resolutionGridForMode("replace"), 16);
  assert.equal(normalized.width % 16, 0);
  assert.equal(normalized.height % 16, 0);
  assert.equal(normalized.width, 1008);
  assert.equal(normalized.height, 608);
});

test("invalid intrinsic dimensions are rejected before they can overwrite UI state", () => {
  assert.throws(() => normalizeImageResolution(0, 900, "i2v"), /invalid dimensions/);
  assert.throws(() => normalizeImageResolution(900, Number.NaN, "i2v"), /invalid dimensions/);
});

test("image dimension reader resolves intrinsic dimensions and exposes decode failures", async () => {
  class FakeImage {
    naturalWidth = 1600;
    naturalHeight = 900;
    onload = () => {};
    onerror = () => {};

    set src(value) {
      assert.equal(value, "/app/media?name=source.png");
      queueMicrotask(() => this.onload());
    }
  }

  assert.deepEqual(await readImageDimensions("/app/media?name=source.png", FakeImage), {
    width: 1600,
    height: 900,
  });

  class BrokenImage {
    onload = () => {};
    onerror = () => {};

    set src(_value) {
      queueMicrotask(() => this.onerror());
    }
  }

  await assert.rejects(
    readImageDimensions("/app/media?name=broken.png", BrokenImage),
    /could not be decoded/,
  );
});
