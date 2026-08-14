import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSingleVideoJobStore } from "../server/video-generation/single-job-store.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-single-video-store-"));
  const timestamps = [
    "2026-08-12T00:00:00.000Z",
    "2026-08-12T00:00:01.000Z",
    "2026-08-12T00:00:02.000Z",
    "2026-08-12T00:00:03.000Z",
  ];
  let index = 0;
  const store = createSingleVideoJobStore({
    root,
    idFactory: () => `sv-test-${index}`,
    clock: () => new Date(timestamps[Math.min(index, timestamps.length - 1)]),
  });
  return { root, store, nextTime: () => timestamps[Math.min(index++, timestamps.length - 1)] };
}

test("Single Video store writes durable safe records without transient process handles", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));

  const job = await value.store.create({
    id: "sv-durable-1",
    mode: "t2v",
    prompt: "A subject crosses a room.",
    negativePrompt: "blur",
    modelProfile: "nvfp4_blackwell",
    width: 736,
    height: 416,
    duration: 5,
    seed: 42,
    inputRefs: { inputImage: "reference/frame.png" },
    status: "completed",
    stage: "completed",
    progress: 100,
    output: { root: "output", name: "single-result.mp4" },
    error: "",
    exitCode: 0,
    promptId: "11111111-1111-4111-8111-111111111111",
    runtimeMode: "remote",
    attempt: 1,
    provenance: { request: { mode: "t2v", prompt: "A subject crosses a room.", inputImageName: "reference/frame.png" }, attempt: 1 },
    execution: { ownerId: "secret-owner", pid: 1234, child: { kill() {} } },
    outputPath: "C:\\private\\output\\single-result.mp4",
  });

  assert.equal(job.id, "sv-durable-1");
  assert.deepEqual(job.dimensions, { width: 736, height: 416 });
  assert.equal(job.output.name, "single-result.mp4");
  const saved = JSON.parse(await readFile(value.store.jobFile(job.id), "utf8"));
  assert.equal(saved.exitCode, 0);
  assert.equal(saved.promptId, "11111111-1111-4111-8111-111111111111");
  assert.equal(saved.runtimeMode, "remote");
  assert.equal(saved.inputRefs.inputImage, "reference/frame.png");
  assert.equal(Object.hasOwn(saved, "execution"), false);
  assert.equal(Object.hasOwn(saved, "outputPath"), false);
  assert.doesNotMatch(JSON.stringify(saved), /private|secret-owner|kill/);
});

test("startup recovery preserves terminal history, requeues queued jobs, and interrupts running jobs", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const base = { mode: "t2v", prompt: "A stable prompt", modelProfile: "nvfp4_blackwell", width: 736, height: 416, duration: 5, seed: 1, attempt: 1 };
  await value.store.create({ ...base, id: "sv-completed-1", status: "completed", stage: "completed", progress: 100, finishedAt: value.nextTime() });
  await value.store.create({ ...base, id: "sv-queued-1", status: "queued", stage: "waiting", progress: 2 });
  await value.store.create({ ...base, id: "sv-running-1", status: "running", stage: "sampling", progress: 46, startedAt: value.nextTime(), execution: { ownerId: "old-owner", pid: 999 } });

  const recovered = await value.store.recover({ ownerId: "new-owner", recoveredAt: "2026-08-12T00:01:00.000Z" });
  assert.deepEqual(recovered.requeued.map((job) => job.id), ["sv-queued-1"]);
  assert.deepEqual(recovered.interrupted.map((job) => job.id), ["sv-running-1"]);
  assert.equal((await value.store.read("sv-completed-1")).status, "completed");
  assert.equal((await value.store.read("sv-queued-1")).status, "queued");
  const interrupted = await value.store.read("sv-running-1");
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.recoverable, true);
  assert.equal(interrupted.recovery.reason, "bridge_restart");
  assert.equal(interrupted.recovery.recoveredBy, "new-owner");
  assert.doesNotMatch(JSON.stringify(recovered.jobs), /old-owner|999/);
});

test("retention removes only old terminal jobs and keeps active or recoverable history", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const base = { mode: "t2v", prompt: "Retention", width: 736, height: 416, duration: 5, seed: 2 };
  await value.store.create({ ...base, id: "sv-terminal-1", status: "completed", updatedAt: "2026-08-12T00:00:01.000Z" });
  await value.store.create({ ...base, id: "sv-terminal-2", status: "failed", updatedAt: "2026-08-12T00:00:02.000Z" });
  await value.store.create({ ...base, id: "sv-queued-2", status: "queued", updatedAt: "2026-08-12T00:00:03.000Z" });
  await value.store.create({ ...base, id: "sv-recoverable-2", status: "interrupted", recoverable: true, updatedAt: "2026-08-12T00:00:04.000Z" });

  const result = await value.store.prune({ maxTerminalJobs: 1 });
  assert.deepEqual(result.removed, ["sv-terminal-1"]);
  assert.equal(await value.store.read("sv-terminal-1"), null);
  assert.equal((await value.store.read("sv-terminal-2")).status, "failed");
  assert.equal((await value.store.read("sv-queued-2")).status, "queued");
  assert.equal((await value.store.read("sv-recoverable-2")).recoverable, true);
});

test("serialized updates do not lose concurrent lifecycle patches", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  await value.store.create({ id: "sv-concurrent-1", status: "queued", stage: "queued", progress: 2, mode: "t2v" });
  await Promise.all([
    value.store.update("sv-concurrent-1", { status: "running" }),
    value.store.update("sv-concurrent-1", { stage: "sampling" }),
    value.store.update("sv-concurrent-1", { progress: 42 }),
  ]);
  const final = await value.store.read("sv-concurrent-1");
  assert.equal(final.status, "running");
  assert.equal(final.stage, "sampling");
  assert.equal(final.progress, 42);
});
