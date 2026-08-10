import assert from "node:assert/strict";
import test from "node:test";
import { formatVram, vramToGiB } from "../app/components/settings/vram.mjs";

test("formats ComfyUI byte values as binary GiB", () => {
  assert.equal(formatVram(15_767_437_312), "14.7 GiB");
  assert.equal(formatVram(17_094_475_776), "15.9 GiB");
});

test("formats legacy KiB values as the same GiB values", () => {
  assert.equal(formatVram(15_397_888), "14.7 GiB");
  assert.equal(formatVram(16_693_824), "15.9 GiB");
  assert.equal(vramToGiB(15_397_888, "KiB").toFixed(1), "14.7");
});

test("formats explicit units and missing values safely", () => {
  assert.equal(formatVram(15_767_437_312, "bytes"), "14.7 GiB");
  assert.equal(formatVram(undefined), "—");
  assert.equal(formatVram(null), "—");
  assert.equal(formatVram(Number.NaN), "—");
});
