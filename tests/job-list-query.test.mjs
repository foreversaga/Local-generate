import assert from "node:assert/strict";
import test from "node:test";

import { jobListLimit, summarizeJobRecord, wantsJobSummary } from "../app/lib/job-list-query.mjs";

test("job list query limits are optional, bounded, and reject invalid values", () => {
  assert.equal(jobListLimit("/api/jobs", { fallback: 20 }), 20);
  assert.equal(jobListLimit("/api/jobs?limit=5", { fallback: 20 }), 5);
  assert.equal(jobListLimit("/api/jobs?limit=500", { fallback: 20, max: 100 }), 100);
  assert.equal(jobListLimit("/api/jobs?limit=0", { fallback: 20 }), 20);
  assert.equal(wantsJobSummary("/api/jobs?summary=1"), true);
  assert.equal(wantsJobSummary("/api/jobs?summary=true"), true);
  assert.equal(wantsJobSummary("/api/jobs"), false);
});

test("job summaries preserve list metadata while dropping heavy detail collections", () => {
  const summary = summarizeJobRecord({
    id: "job-1",
    status: "running",
    prompt: "x".repeat(500),
    duration: 10,
    etaMs: 45_000,
    etaLowerMs: 38_000,
    etaUpperMs: 55_000,
    etaSource: "hybrid",
    etaConfidence: "medium",
    timingSampleCount: 4,
    segments: [{ prompt: "large" }, { prompt: "large" }],
    items: [{ output: "large" }],
    training: { stage: "training", step: 2, totalSteps: 10, internal: "drop" },
    dataset: { imageCount: 12, records: ["drop"] },
  });
  assert.equal(summary.id, "job-1");
  assert.equal(summary.prompt.length, 240);
  assert.equal(summary.segmentCount, 2);
  assert.equal(summary.etaMs, 45_000);
  assert.equal(summary.etaSource, "hybrid");
  assert.equal(summary.timingSampleCount, 4);
  assert.equal(summary.items, undefined);
  assert.equal(summary.segments, undefined);
  assert.deepEqual(summary.training, { stage: "training", step: 2, totalSteps: 10 });
  assert.deepEqual(summary.dataset, { imageCount: 12 });
});
