import assert from "node:assert/strict";
import test from "node:test";
import { activeJobCount, adaptJob, mergeJobCollections, normalizeJobStatus, outputAvailability } from "../app/lib/job-adapter.mjs";

test("job adapter normalizes backend statuses into five UI states", () => {
  assert.equal(normalizeJobStatus("queued"), "queued");
  assert.equal(normalizeJobStatus("planning"), "running");
  assert.equal(normalizeJobStatus("paused"), "running");
  assert.equal(normalizeJobStatus("completed"), "complete");
  assert.equal(normalizeJobStatus("failed"), "error");
  assert.equal(normalizeJobStatus("cancelled"), "cancelled");
});

test("job adapter exposes only the actions backed by each source contract", () => {
  assert.equal(adaptJob({ id: "v", status: "running" }, "video").canCancel, true);
  assert.equal(adaptJob({ id: "u", status: "running", sourceName: "a.mp4" }, "upscale").canCancel, true);
  assert.equal(adaptJob({ id: "i", status: "failed", sourceName: "a.png" }, "img2img").canRetry, true);
  const interrupted = adaptJob({ id: "v-recoverable", status: "interrupted", recoverable: true, attempt: 1 }, "video");
  assert.equal(interrupted.status, "error");
  assert.equal(interrupted.canRetry, true);
  assert.equal(adaptJob({ id: "v-completed", status: "completed" }, "video").canRetry, true);
  assert.equal(adaptJob({ id: "l", status: "paused" }, "long").canResume, true);
  assert.equal(adaptJob({ id: "done", status: "completed" }, "long").canRetry, false);
});

test("job adapter exposes reusable prompts for single, long, and image jobs regardless of status", () => {
  const completed = adaptJob({ id: "done", status: "completed", prompt: "final prompt", negativePrompt: "watermark" }, "video");
  const unfinished = adaptJob({ id: "draft", status: "ready", inputText: "story prompt", negativePrompt: "flicker" }, "long");
  const failedImage = adaptJob({ id: "image", status: "failed", prompt: "image prompt", negativePrompt: "blur" }, "img2img");
  assert.deepEqual([completed.prompt, completed.negativePrompt], ["final prompt", "watermark"]);
  assert.deepEqual([unfinished.prompt, unfinished.negativePrompt], ["story prompt", "flicker"]);
  assert.deepEqual([failedImage.prompt, failedImage.negativePrompt], ["image prompt", "blur"]);
});

test("job output references are marked unavailable when their media key is stale", () => {
  const available = new Set(["output:valid/render.mp4"]);
  assert.equal(outputAvailability({ root: "output", name: "valid/render.mp4" }, available), true);
  assert.equal(outputAvailability({ root: "output", name: "missing/render.mp4", url: "/app/media?root=output&name=missing%2Frender.mp4" }, available), false);
  assert.equal(adaptJob({ id: "stale", status: "completed", output: { root: "output", name: "missing/render.mp4" } }, "video").outputAvailable, false);
  assert.equal(outputAvailability({ downloadUrl: "/app/api/lora-training/jobs/lora/artifact/download" }), true);
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

test("job adapter preserves image batch summaries and treats partial as terminal", () => {
  assert.equal(normalizeJobStatus("partial"), "partial");
  const raw = {
    id: "img-batch",
    status: "partial",
    model: "sdxl.safetensors",
    batchCount: 3,
    completedCount: 2,
    failedCount: 1,
    randomRanges: { denoise: { min: 0.4, max: 0.8 } },
    items: [{ index: 0, status: "completed", parameters: { seed: 10 } }],
  };
  const adapted = adaptJob(raw, "img2img");
  assert.equal(adapted.status, "partial");
  assert.equal(adapted.progress, 100);
  assert.equal(adapted.batchCount, 3);
  assert.equal(adapted.completedCount, 2);
  assert.equal(adapted.failedCount, 1);
  assert.deepEqual(adapted.items, raw.items);
  assert.deepEqual(adapted.randomRanges, raw.randomRanges);
  assert.equal(adapted.raw, raw);
});

test("job adapter integrates LoRA status, training progress, ETA, artifact and actions", () => {
  const queued = adaptJob({
    id: "lora-queued",
    status: "queued",
    displayName: "my-character-lora",
    family: "illustrious",
    dataset: { imageCount: 39 },
    orchestration: { progress: { completed: 39, total: 39 } },
    updatedAt: "2026-01-04T00:00:00Z",
  }, "lora");
  assert.equal(queued.status, "queued");
  assert.equal(queued.progress, 0, "caption completion must not make a queued training job complete");
  assert.equal(queued.canCancel, true);
  assert.match(queued.title, /my-character-lora/);
  assert.match(queued.subtitle, /39 張圖片/);

  const training = adaptJob({ id: "lora-running", status: "training", training: { step: 25, totalSteps: 100, eta: "01:30" } }, "lora");
  assert.equal(training.status, "running");
  assert.equal(training.progress, 25);
  assert.equal(training.etaMs, 90_000);

  const hybridEta = adaptJob({ id: "video-running", status: "running", etaMs: 60_000, etaLowerMs: 48_000, etaUpperMs: 75_000, etaSource: "hybrid", etaConfidence: "medium", timingSampleCount: 4 }, "video");
  assert.equal(hybridEta.etaLowerMs, 48_000);
  assert.equal(hybridEta.etaUpperMs, 75_000);
  assert.equal(hybridEta.etaSource, "hybrid");
  assert.equal(hybridEta.timingSampleCount, 4);

  const overrunTraining = adaptJob({ id: "lora-overrun", status: "training", training: { step: 101, totalSteps: 100 } }, "lora");
  assert.equal(overrunTraining.progress, 99, "active training must not report terminal 100% progress");

  const completedTraining = adaptJob({ id: "lora-completed", status: "completed", training: { step: 101, totalSteps: 100 } }, "lora");
  assert.equal(completedTraining.progress, 100, "only terminal completion may report 100% progress");

  const captioning = adaptJob({ id: "lora-captioning", status: "captioning", training: { completed: 39, total: 39 } }, "lora");
  assert.equal(captioning.status, "running");
  assert.equal(captioning.progress, 100);

  const installed = adaptJob({ id: "lora-installed", status: "training", training: { stage: "installed" } }, "lora");
  assert.equal(installed.status, "running");
  assert.equal(installed.progress, 99, "an active job must wait for the terminal event before reporting 100% progress");

  const succeeded = adaptJob({
    id: "lora-done", status: "succeeded", artifact: { registryId: "reg-1", fileName: "my-character-lora.safetensors", downloadUrl: "/app/api/lora-training/jobs/lora-done/artifact/download" },
  }, "lora");
  assert.equal(succeeded.status, "complete");
  assert.equal(succeeded.progress, 100);
  assert.equal(succeeded.output.downloadUrl, "/app/api/lora-training/jobs/lora-done/artifact/download");
  assert.equal(succeeded.canRetry, false);

  const failed = adaptJob({ id: "lora-failed", status: "preflight_failed" }, "lora");
  assert.equal(failed.status, "error");
  assert.equal(failed.canRetry, true);
});
