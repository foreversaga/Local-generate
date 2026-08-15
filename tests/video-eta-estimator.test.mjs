import assert from "node:assert/strict";
import test from "node:test";

import {
  combineEta,
  estimateHistoricalDuration,
  estimateNativeRemaining,
  recordNativeProgress,
} from "../server/video-generation/eta-estimator.mjs";

test("history estimator extrapolates nearby work instead of requiring a 10 percent match", () => {
  const estimate = estimateHistoricalDuration([
    { width: 640, height: 960, duration: 15, steps: 20, elapsedMs: 600_000, mode: "i2v", modelProfile: "nvfp4_blackwell" },
    { width: 736, height: 1088, duration: 8, steps: 20, elapsedMs: 390_000, mode: "i2v", modelProfile: "nvfp4_blackwell" },
    { width: 512, height: 768, duration: 10, steps: 20, elapsedMs: 300_000, mode: "i2v", modelProfile: "nvfp4_blackwell" },
  ], { width: 768, height: 1152, duration: 14, steps: 20, mode: "i2v", modelProfile: "nvfp4_blackwell" });
  assert.ok(estimate.durationMs > 500_000);
  assert.equal(estimate.sampleCount, 3);
  assert.ok(estimate.upperMs > estimate.lowerMs);
});

test("native estimator uses robust recent step timing", () => {
  const job = {};
  recordNativeProgress(job, 1, 10, 1_000);
  recordNativeProgress(job, 2, 10, 2_100);
  recordNativeProgress(job, 3, 10, 3_000);
  recordNativeProgress(job, 4, 10, 4_000);
  const estimate = estimateNativeRemaining(job.nativeProgressSamples, 4, 10, 5_000);
  assert.equal(estimate.perStepMs, 1_000);
  assert.equal(estimate.remainingMs, 11_000);
  assert.equal(estimate.confidence, "medium");
});

test("hybrid ETA increasingly favors live native progress", () => {
  const eta = combineEta({
    elapsedMs: 20_000,
    historical: { durationMs: 100_000, lowerMs: 80_000, upperMs: 130_000, confidence: "medium" },
    native: { remainingMs: 50_000, lowerMs: 42_000, upperMs: 58_000, sampleCount: 5, confidence: "high" },
  });
  assert.equal(eta.source, "hybrid");
  assert.equal(eta.remainingMs, 56_000);
  assert.equal(eta.confidence, "high");
});
