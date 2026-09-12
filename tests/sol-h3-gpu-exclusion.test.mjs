import test from "node:test";
import assert from "node:assert/strict";

import { createGpuResourceCoordinator } from "../server/runtime/gpu-resource-coordinator.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("Sol-H3 waits for existing ComfyUI GPU work and blocks the next ComfyUI job", async () => {
  const coordinator = createGpuResourceCoordinator();
  const comfyBefore = coordinator.request({ jobId: "video-before", workloadType: "video-generation", runtime: "local" });
  const sol = coordinator.request({ jobId: "sol-h3:job-1", workloadType: "sol-h3", runtime: "local" });
  const comfyAfter = coordinator.request({ jobId: "video-after", workloadType: "video-generation", runtime: "local" });

  await flush();
  const beforeLease = await comfyBefore.granted;
  assert.equal(coordinator.active().workloadType, "video-generation");
  assert.equal(coordinator.get("sol-h3:job-1").queuePosition, 1);
  assert.equal(coordinator.get("video-after").queuePosition, 2);

  beforeLease.release();
  const solLease = await sol.granted;
  assert.equal(coordinator.active().workloadType, "sol-h3");
  assert.equal(coordinator.get("video-after").status, "queued");

  solLease.release();
  const afterLease = await comfyAfter.granted;
  assert.equal(coordinator.active().jobId, "video-after");
  afterLease.release();
  await coordinator.waitForIdle();
});

test("cancelling queued Sol-H3 admission does not leave an accelerator lease", async () => {
  const coordinator = createGpuResourceCoordinator();
  const active = coordinator.request({ jobId: "active-video", workloadType: "video-generation" });
  const sol = coordinator.request({ jobId: "sol-h3:cancelled", workloadType: "sol-h3" });
  const activeLease = await active.granted;
  assert.equal(sol.cancel("cancelled before GPU admission"), true);
  await assert.rejects(sol.granted, { code: "GPU_LEASE_CANCELLED" });
  assert.equal(coordinator.get("sol-h3:cancelled"), null);
  activeLease.release();
  await coordinator.waitForIdle();
  assert.equal(coordinator.hasWork(), false);
});
