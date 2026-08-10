import assert from "node:assert/strict";
import test from "node:test";
import { activeJobCount, adaptJob, mergeJobCollections, normalizeJobStatus } from "../app/lib/job-adapter.mjs";

test("job adapter normalizes backend statuses into five UI states", () => {
  assert.equal(normalizeJobStatus("queued"), "queued");
  assert.equal(normalizeJobStatus("planning"), "running");
  assert.equal(normalizeJobStatus("paused"), "running");
  assert.equal(normalizeJobStatus("completed"), "complete");
  assert.equal(normalizeJobStatus("failed"), "error");
  assert.equal(normalizeJobStatus("cancelled"), "cancelled");
});

test("job adapter preserves source-specific actions without inventing unsupported cancel APIs", () => {
  assert.equal(adaptJob({ id: "v", status: "running" }, "video").canCancel, true);
  assert.equal(adaptJob({ id: "u", status: "running", sourceName: "a.mp4" }, "upscale").canCancel, false);
  assert.equal(adaptJob({ id: "i", status: "failed", sourceName: "a.png" }, "img2img").canRetry, true);
  assert.equal(adaptJob({ id: "l", status: "paused" }, "long").canResume, true);
  assert.equal(adaptJob({ id: "done", status: "completed" }, "long").canRetry, false);
});

test("merged jobs sort recent first and count active states", () => {
  const jobs = mergeJobCollections([
    { source: "video", jobs: [{ id: "a", status: "completed", finishedAt: "2026-01-01T00:00:00Z" }] },
    { source: "long", jobs: [{ id: "b", status: "running", updatedAt: "2026-01-02T00:00:00Z" }] },
    { source: "upscale", jobs: [{ id: "c", status: "queued", createdAt: "2026-01-03T00:00:00Z" }] },
  ]);
  assert.deepEqual(jobs.map((job) => job.id), ["c", "b", "a"]);
  assert.equal(activeJobCount(jobs), 2);
});
