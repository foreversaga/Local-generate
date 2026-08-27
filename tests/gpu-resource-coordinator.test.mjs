import test from "node:test";
import assert from "node:assert/strict";
import { createGpuResourceCoordinator, GPU_WORKLOAD_TYPES } from "../server/runtime/gpu-resource-coordinator.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("GPU coordinator serializes workload types and exposes queue positions", async () => {
  const coordinator = createGpuResourceCoordinator({ idFactory: (() => { let index = 0; return () => `id-${++index}`; })() });
  const video = coordinator.request({ jobId: "video-1", workloadType: "video-generation", runtime: "local" });
  const lora = coordinator.request({ jobId: "lora-1", workloadType: "lora-training", runtime: "local" });
  const i2i = coordinator.request({ jobId: "img-1", workloadType: "img2img", runtime: "remote" });

  await flush();
  const videoLease = await video.granted;
  assert.equal(coordinator.active().workloadType, "video-generation");
  assert.equal(coordinator.get("lora-1").queuePosition, 1);
  assert.equal(coordinator.get("img-1").queuePosition, 2);
  assert.equal(coordinator.snapshot().totalCount, 3);

  videoLease.release();
  const loraLease = await lora.granted;
  assert.equal(coordinator.active().workloadType, "lora-training");
  assert.equal(coordinator.active().runtimeMode, "local");
  assert.equal(coordinator.get("img-1").queuePosition, 1);
  loraLease.release();
  const imageLease = await i2i.granted;
  assert.equal(coordinator.active().workloadType, "img2img");
  imageLease.release();
  await coordinator.waitForIdle();
  assert.equal(coordinator.hasWork(), false);
});

test("GPU coordinator admits the video-character workload used by its controller", async () => {
  assert.ok(GPU_WORKLOAD_TYPES.includes("video-character"));
  const coordinator = createGpuResourceCoordinator();
  const admission = coordinator.request({ jobId: "video-character-1", workloadType: "video-character", runtime: "local" });
  const lease = await admission.granted;
  assert.equal(coordinator.active().workloadType, "video-character");
  lease.release();
  await coordinator.waitForIdle();
});

test("queued cancellation removes a request without blocking the next lease", async () => {
  const coordinator = createGpuResourceCoordinator();
  const first = coordinator.request({ jobId: "first", workloadType: "seedvr2-upscale" });
  const cancelled = coordinator.request({ jobId: "cancelled", workloadType: "img2img" });
  const third = coordinator.request({ jobId: "third", workloadType: "long-video-segment" });
  await flush();
  const firstLease = await first.granted;

  assert.equal(cancelled.cancel("user requested cancellation"), true);
  await assert.rejects(cancelled.granted, { code: "GPU_LEASE_CANCELLED" });
  assert.equal(coordinator.get("cancelled"), null);
  firstLease.release();
  const thirdLease = await third.granted;
  assert.equal(coordinator.active().jobId, "third");
  thirdLease.release();
});

test("lease release in a failure path always wakes the next workload", async () => {
  const coordinator = createGpuResourceCoordinator();
  const failed = coordinator.request({ jobId: "failed", workloadType: "video-generation" });
  const next = coordinator.request({ jobId: "next", workloadType: "lora-training" });
  const failedLease = await failed.granted;
  try {
    throw Object.assign(new Error("worker crashed"), { code: "WORKER_CRASH" });
  } catch (error) {
    assert.equal(error.code, "WORKER_CRASH");
  } finally {
    failedLease.release();
  }
  const nextLease = await next.granted;
  assert.equal(coordinator.active().jobId, "next");
  nextLease.release();
});

test("expired leases recover only after the owner is confirmed dead", async () => {
  let current = 1_000;
  let ownerAlive = true;
  const coordinator = createGpuResourceCoordinator({
    leaseTtlMs: 100,
    now: () => current,
    processAlive: () => ownerAlive,
  });
  const first = coordinator.request({ jobId: "stale-owner", workloadType: "video-generation" });
  const next = coordinator.request({ jobId: "after-crash", workloadType: "img2img" });
  const lease = await first.granted;
  current += 101;
  assert.deepEqual(await coordinator.recoverStaleLeases(), { recovered: false, reason: "owner-alive" });
  assert.equal(coordinator.active().jobId, "stale-owner");
  ownerAlive = false;
  assert.deepEqual(await coordinator.recoverStaleLeases(), { recovered: true, reason: "owner-exited" });
  const nextLease = await next.granted;
  assert.equal(coordinator.active().jobId, "after-crash");
  assert.equal(lease.release(), false);
  nextLease.release();
});

test("abort signals cancel queued GPU admission", async () => {
  const coordinator = createGpuResourceCoordinator();
  const active = coordinator.request({ jobId: "active", workloadType: "video-generation" });
  const controller = new AbortController();
  const queued = coordinator.request({ jobId: "queued", workloadType: "ollama-vision", signal: controller.signal });
  await active.granted;
  controller.abort();
  await assert.rejects(queued.granted, { code: "GPU_LEASE_CANCELLED" });
  assert.equal(coordinator.get("queued"), null);
  const activeLease = await active.granted;
  activeLease.release();
});
