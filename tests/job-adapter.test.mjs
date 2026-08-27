import assert from "node:assert/strict";
import test from "node:test";
import { activeJobCount, adaptJob, mergeJobCollections, normalizeJobStatus, outputAvailability } from "../app/lib/job-adapter.mjs";

test("job adapter normalizes backend statuses into five UI states", () => {
  assert.equal(normalizeJobStatus("queued"), "queued");
  assert.equal(normalizeJobStatus("planning"), "running");
  assert.equal(normalizeJobStatus("paused"), "running");
  assert.equal(normalizeJobStatus("recovering"), "running");
  assert.equal(normalizeJobStatus("recovery_needs_operator"), "error");
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
  assert.equal(adaptJob({ id: "vc", status: "running" }, "video-character").canCancel, true);
  assert.equal(adaptJob({ id: "vc-failed", status: "failed" }, "video-character").canRetry, false);
});

test("video character jobs expose their persisted settings and measured progress", () => {
  const job = adaptJob({
    id: "vc-running",
    mode: "replace",
    status: "running",
    stage: "generate",
    phase: "generation",
    nativeCurrent: 5,
    nativeMaximum: 10,
    chunkIndex: 1,
    chunkCount: 4,
    references: [{ root: "input", name: "front.jpg" }, { root: "input", name: "side.jpg" }],
    settings: {
      prompt: "keep the original scene",
      negativePrompt: "cropped limbs",
      width: 768,
      height: 432,
      fps: 24,
      steps: 20,
      seed: 42,
      timeoutSeconds: 900,
    },
  }, "video-character");
  assert.equal(job.title, "原場景換人物");
  assert.equal(job.subtitle, "768×432 · 24 FPS · 2 張參考圖");
  assert.equal(job.prompt, "keep the original scene");
  assert.equal(job.negativePrompt, "cropped limbs");
  assert.deepEqual([job.width, job.height, job.steps, job.seed, job.timeoutSeconds], [768, 432, 20, 42, 900]);
  assert.equal(job.progress, 38);
  assert.equal(job.chunkIndex, 1);
  assert.equal(job.chunkCount, 4);
});

test("text-to-image batch jobs retain their parent lifecycle in the workspace", () => {
  const running = adaptJob({
    id: "batch-running",
    status: "prompting",
    promptModel: "qwen3.8-27b",
    total: 4,
    prompted: 2,
    submitted: 1,
    completed: 1,
    failed: 0,
    cancelled: 0,
  }, "text2img-batch");
  assert.equal(running.status, "running");
  assert.equal(running.title, "文字生圖批次 · 4 張");
  assert.equal(running.subtitle, "1/4 張完成 · qwen3.8-27b");
  assert.equal(running.progress, 38);
  assert.equal(running.canCancel, true);
  assert.equal(running.canRetry, false);

  const cancelled = adaptJob({ id: "batch-cancelled", status: "cancelled", total: 4, prompted: 0, completed: 0, failed: 0, cancelled: 4 }, "text2img-batch");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.canCancel, false);
});

test("job adapter exposes reusable prompts for single, long, and image jobs regardless of status", () => {
  const completed = adaptJob({ id: "done", status: "completed", prompt: "final prompt", negativePrompt: "watermark" }, "video");
  const unfinished = adaptJob({ id: "draft", status: "ready", inputText: "story prompt", negativePrompt: "flicker" }, "long");
  const failedImage = adaptJob({ id: "image", status: "failed", prompt: "image prompt", negativePrompt: "blur" }, "img2img");
  assert.deepEqual([completed.prompt, completed.negativePrompt], ["final prompt", "watermark"]);
  assert.deepEqual([unfinished.prompt, unfinished.negativePrompt], ["story prompt", "flicker"]);
  assert.deepEqual([failedImage.prompt, failedImage.negativePrompt], ["image prompt", "blur"]);
});

test("failed long jobs distinguish completed segment files from the unassembled final video", () => {
  const job = adaptJob({
    id: "long-partial",
    status: "failed",
    duration: 60,
    error: { message: "fetch failed" },
    segments: [
      { status: "completed", duration: 10.125, renderedDuration: 10.125 },
      { status: "failed", duration: 10.125 },
      ...Array.from({ length: 4 }, () => ({ status: "pending", duration: 10.125 })),
    ],
  }, "long");
  assert.equal(job.subtitle, "1/6 段完成 · 目標 60 秒");
  assert.match(job.error, /第 2\/6 段失敗/);
  assert.match(job.error, /約 10\.1 秒/);
  assert.match(job.error, /尚未合併成最終影片/);
});

test("long job adapter preserves detailed segment and native progress", () => {
  const segments = [{ status: "rendering", progress: 42 }, { status: "pending" }];
  const job = adaptJob({ id: "long-progress", status: "running", progress: 21, activeSegmentIndex: 0, segmentProgress: 42, segmentStage: "採樣生成影格", progressSource: "native", nativeCurrent: 6, nativeMaximum: 20, segments }, "long");
  assert.equal(job.activeSegmentIndex, 0);
  assert.equal(job.segmentProgress, 42);
  assert.equal(job.segmentStage, "採樣生成影格");
  assert.equal(job.nativeCurrent, 6);
  assert.equal(job.nativeMaximum, 20);
  assert.deepEqual(job.segments, segments);
});

test("long job adapter preserves a null active segment instead of coercing it to segment zero", () => {
  const job = adaptJob({ id: "long-assembling", status: "assembling", activeSegmentIndex: null, segments: [{ status: "completed" }] }, "long");
  assert.equal(job.activeSegmentIndex, null);
});

test("long job adapter exposes child and overall elapsed time with legacy event fallback", () => {
  const job = adaptJob({
    id: "long-history",
    status: "completed",
    updatedAt: "2026-08-25T01:03:00.000Z",
    segments: [
      { id: "s1", childJobId: "child-1", status: "completed", completedAt: "2026-08-25T01:01:00.000Z", childElapsedMs: 10_000 },
      { id: "s2", childJobId: "child-2", status: "completed" },
    ],
    events: [
      { event: "runner.start", timestamp: "2026-08-25T01:00:00.000Z" },
      { event: "generation.start", segmentIndex: 1, timestamp: "2026-08-25T01:01:30.000Z" },
      { event: "segment.completed", segmentIndex: 1, timestamp: "2026-08-25T01:02:00.000Z" },
      { event: "runner.success", timestamp: "2026-08-25T01:03:00.000Z" },
    ],
  }, "long");
  assert.equal(job.segments[0].completedAt, "2026-08-25T01:01:00.000Z");
  assert.equal(job.segments[1].completedAt, "2026-08-25T01:02:00.000Z");
  assert.equal(job.segments[0].childElapsedMs, 10_000);
  assert.equal(job.segments[1].elapsedMs, 30_000);
  assert.equal(job.completedAt, "2026-08-25T01:03:00.000Z");
  assert.equal(job.elapsedMs, 180_000);
});

test("job adapter names every image generation and upscale function distinctly", () => {
  assert.match(adaptJob({ id: "text", prompt: "night market", modelLabel: "FLUX.2 Dev", width: 1024, height: 1024, steps: 20, cfg: 4 }, "text2img").title, /^文字生圖/);
  assert.equal(adaptJob({ id: "text", prompt: "night market", modelLabel: "FLUX.2 Dev", cfg: 4 }, "text2img").cfg, 4);
  assert.match(adaptJob({ id: "pose", sourceName: "person.png", poseName: "pose.png" }, "img2img").title, /^OpenPose 骨架生圖/);
  assert.match(adaptJob({ id: "image-upscale", sourceName: "portrait.png" }, "upscale").title, /^圖片升頻/);
  assert.match(adaptJob({ id: "video-upscale", sourceName: "clip.mp4" }, "upscale").title, /^影片升頻/);
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

test("terminal job history prefers its real completion time over a later recovery write", () => {
  const failed = adaptJob({
    id: "historical-failure",
    status: "failed",
    createdAt: "2026-08-19T09:00:00.000Z",
    finishedAt: "2026-08-19T09:16:51.736Z",
    updatedAt: "2026-08-25T14:11:33.711Z",
  }, "video");
  assert.equal(failed.createdAt, "2026-08-19T09:00:00.000Z");
  assert.equal(failed.updatedAt, "2026-08-19T09:16:51.736Z");

  const active = adaptJob({
    id: "active-job",
    status: "running",
    createdAt: "2026-08-25T14:00:00.000Z",
    updatedAt: "2026-08-25T14:12:00.000Z",
  }, "video");
  assert.equal(active.updatedAt, "2026-08-25T14:12:00.000Z");
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

  const hybridEta = adaptJob({ id: "video-running", status: "running", elapsedMs: 12_500, estimatedDurationMs: 72_500, etaMs: 60_000, etaLowerMs: 48_000, etaUpperMs: 75_000, etaSource: "hybrid", etaConfidence: "medium", timingSampleCount: 4 }, "video");
  assert.equal(hybridEta.elapsedMs, 12_500);
  assert.equal(hybridEta.estimatedDurationMs, 72_500);
  assert.equal(hybridEta.etaLowerMs, 48_000);
  assert.equal(hybridEta.etaUpperMs, 75_000);
  assert.equal(hybridEta.etaSource, "hybrid");
  assert.equal(hybridEta.timingSampleCount, 4);

  const missingTiming = adaptJob({ id: "video-queued", status: "queued", elapsedMs: "invalid", estimatedDurationMs: -1 }, "video");
  assert.equal(missingTiming.elapsedMs, null);
  assert.equal(missingTiming.estimatedDurationMs, null);

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
