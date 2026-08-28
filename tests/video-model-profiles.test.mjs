import test from "node:test";
import assert from "node:assert/strict";

import {
  LONG_VIDEO_MODEL_OPTIONS,
  resolveVideoModelProfile,
  videoModelOptionsForMode,
  videoModelSupportsMode,
} from "../app/lib/video-model-profiles.mjs";

test("10Eros is selectable for H3 FL2VA modes", () => {
  for (const mode of ["t2v", "i2v", "fl2v", "l2v"]) {
    assert.ok(videoModelOptionsForMode(mode).some((profile) => profile.value === "10eros_max_beta2_nvfp4"));
    assert.equal(resolveVideoModelProfile("10eros_max_beta2_nvfp4", mode), "10eros_max_beta2_nvfp4");
  }
});

test("10Eros is not offered to Ref2VA or replacement workflows", () => {
  for (const mode of ["ref2v", "ref2v_motion", "replace"]) {
    assert.equal(videoModelOptionsForMode(mode).some((profile) => profile.value === "10eros_max_beta2_nvfp4"), false);
  }
  assert.equal(resolveVideoModelProfile("10eros_max_beta2_nvfp4", "ref2v"), null);
  assert.equal(videoModelSupportsMode("10eros_max_beta2_nvfp4", "ref2v"), false);
});

test("long-video model options come from the shared registry", () => {
  assert.ok(LONG_VIDEO_MODEL_OPTIONS.some((profile) => profile.value === "10eros_max_beta2_nvfp4"));
  assert.equal(resolveVideoModelProfile("nvfp4_blackwell", "ref2v"), "ref2va_pruned_nvfp4");
});
