import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { createTrainingQueue } from "../server/lora-training/queue.mjs";
import { createLoraTrainingController } from "../server/lora-training/controller.mjs";
import { createLoraTrainingService } from "../server/lora-training/service.mjs";
import { createJobStore } from "../server/lora-training/store.mjs";
import { LoraTrainingError } from "../server/lora-training/schema.mjs";

function waitFor(predicate, message) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 2_000;
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error(message));
      setTimeout(check, 5);
    };
    check();
  });
}

function pathsFor(root) {
  return {
    root,
    runtime: path.join(root, "runtime"),
    jobs: path.join(root, "jobs"),
    cache: path.join(root, "cache"),
    scheduler: path.join(root, "scheduler.json"),
    registry: path.join(root, "registry.json"),
  };
}

test("queue reports background state errors without an unhandled rejection", async () => {
  const events = [];
  const backgroundErrors = [];
  const saved = [];
  const jobId = "11111111-1111-4111-8111-111111111111";
  const queue = createTrainingQueue({
    loadState: async () => ({ pending: [], active: null }),
    saveState: async (state) => saved.push(structuredClone(state)),
    acquireGpuLease: async () => ({ id: "lease-1", ownerId: "owner-1", jobId }),
    releaseGpuLease: async () => {},
    execute: async () => ({ status: "succeeded" }),
    onStateChange: async (event) => {
      events.push(event);
      if (event.status === "running") throw new Error("state revision conflict");
    },
    onBackgroundError: async (event) => backgroundErrors.push(event),
    ownerId: "owner-1",
    now: () => "2026-08-11T00:00:00.000Z",
  });

  await queue.enqueue(jobId, { revision: 1 });
  await waitFor(() => backgroundErrors.length > 0, "background queue error was not reported");
  const snapshot = queue.snapshot();
  assert.equal(snapshot.active, null);
  assert.deepEqual(snapshot.pending, []);
  assert.equal(events.at(-1).status, "failed");
  assert.equal(backgroundErrors[0].jobId, jobId);
  assert.match(backgroundErrors[0].phase, /notify:running/);
  assert.ok(saved.some((state) => state.active === null));
});

test("controller commits queue position before running transition", async () => {
  const jobId = "22222222-2222-4222-8222-222222222222";
  const timestamp = "2026-08-11T00:00:00.000Z";
  let job = {
    id: jobId,
    revision: 0,
    slug: "queue-race",
    displayName: "Queue race",
    status: "ready",
    family: "sdxl",
    captionReviewMode: "auto",
    triggerWords: ["subject"],
    assetIds: [],
    config: { family: "sdxl", orchestration: { preflight: { status: "pass", token: "token" } } },
    provenance: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  let runningRead = false;
  let queuePositionCommitted = false;
  let releaseRunning;
  const runningGate = new Promise((resolve) => { releaseRunning = resolve; });
  const backgroundErrors = [];
  let controller;
  const store = {
    readJob: async () => structuredClone(job),
    updateJob: async (_id, patch, { expectedRevision }) => {
      if (job.revision !== expectedRevision) throw new LoraTrainingError("REVISION_CONFLICT", "revision conflict", { status: 409, details: { actualRevision: job.revision } });
      if (patch.status === "running") {
        runningRead = true;
        if (!queuePositionCommitted) {
          await runningGate;
          if (job.revision !== expectedRevision) throw new LoraTrainingError("REVISION_CONFLICT", "revision conflict", { status: 409, details: { actualRevision: job.revision } });
        }
      }
      job = { ...job, ...structuredClone(patch), revision: job.revision + 1, updatedAt: timestamp };
      if (patch.config?.orchestration?.queuePosition !== undefined) {
        queuePositionCommitted = true;
        releaseRunning();
      }
      return structuredClone(job);
    },
  };
  const queue = {
    position: () => null,
    enqueue: async (_id, _payload, options = {}) => {
      // This deliberately models the pre-fix queue: old callers that omit
      // autoDrain start running before queuePosition is persisted.
      if (options.autoDrain !== false) {
        const running = controller.onQueueStateChange({ jobId, status: "running" });
        void running.catch((error) => backgroundErrors.push(error));
        await Promise.resolve();
      }
      return 1;
    },
    start: () => (async () => {
      await controller.onQueueStateChange({ jobId, status: "running" });
      await controller.onQueueStateChange({ jobId, status: "succeeded" });
    })(),
  };
  controller = createLoraTrainingController({
    store,
    queue,
    dataset: { readManifest: async () => ({ images: [] }) },
    captions: { readCaptions: async () => ({ records: [] }) },
    preflight: { run: async () => ({ status: "pass", token: "token" }) },
    now: () => new Date(timestamp),
  });

  await controller.enqueue(jobId, { expectedRevision: 0, preflightToken: "token" });
  await waitFor(() => job.status === "succeeded", "queue did not finish after serialized transition");
  assert.equal(runningRead, true);
  assert.deepEqual(backgroundErrors, []);
  assert.equal(job.status, "succeeded");
});

test("real queue path has no revision conflict between queued and running", async () => {
  const jobId = "33333333-3333-4333-8333-333333333333";
  const timestamp = "2026-08-11T00:00:00.000Z";
  let job = {
    id: jobId,
    revision: 0,
    slug: "real-queue",
    displayName: "Real queue",
    status: "ready",
    family: "sdxl",
    captionReviewMode: "auto",
    triggerWords: ["subject"],
    assetIds: [],
    config: { family: "sdxl", orchestration: { preflight: { status: "pass", token: "token" } } },
    provenance: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const queueState = { pending: [], active: null };
  const backgroundErrors = [];
  let controller;
  const store = {
    readJob: async () => structuredClone(job),
    updateJob: async (_id, patch, { expectedRevision }) => {
      if (job.revision !== expectedRevision) throw new LoraTrainingError("REVISION_CONFLICT", "revision conflict", { status: 409, details: { actualRevision: job.revision } });
      job = { ...job, ...structuredClone(patch), revision: job.revision + 1, updatedAt: timestamp };
      return structuredClone(job);
    },
  };
  const queue = createTrainingQueue({
    loadState: async () => structuredClone(queueState),
    saveState: async (next) => Object.assign(queueState, structuredClone(next)),
    acquireGpuLease: async () => ({ id: "lease-real", ownerId: "owner-real", jobId }),
    releaseGpuLease: async () => {},
    execute: async () => ({ status: "succeeded" }),
    onStateChange: async (event) => controller.onQueueStateChange(event),
    onBackgroundError: async (event) => backgroundErrors.push(event),
    ownerId: "owner-real",
    progressIntervalMs: 0,
  });
  controller = createLoraTrainingController({
    store,
    queue,
    dataset: { readManifest: async () => ({ images: [] }) },
    captions: { readCaptions: async () => ({ records: [] }) },
    preflight: { run: async () => ({ status: "pass", token: "token" }) },
    now: () => new Date(timestamp),
  });

  await controller.enqueue(jobId, { expectedRevision: 0, preflightToken: "token" });
  await waitFor(() => job.status === "succeeded", "real queue did not finish");
  assert.deepEqual(backgroundErrors, []);
  assert.equal(queue.snapshot().active, null);
  assert.deepEqual(queue.snapshot().pending, []);
});

test("service recovery clears stale active state and preserves an existing training failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-lora-recovery-"));
  const paths = pathsFor(root);
  try {
    await mkdir(paths.cache, { recursive: true });
    const store = createJobStore({ paths, clock: () => new Date("2026-08-11T00:00:00.000Z") });
    const created = await store.createJob({
      slug: "recovery-job",
      displayName: "Recovery job",
      family: "sdxl",
      captionReviewMode: "auto",
      triggerWords: ["subject"],
      assetIds: [],
      config: { family: "sdxl", baseProfile: "sdxl-base-1.0", outputName: "recovery" },
    });
    const failed = await store.updateJob(created.id, {
      status: "failed",
      config: {
        ...created.config,
        orchestration: {
          phase: "failed",
          error: { code: "TRAINER_FAILED", message: "real trainer failure", retryable: true },
        },
      },
    }, { expectedRevision: created.revision });
    const staleLease = { id: "stale-lease", ownerId: "old-owner", jobId: failed.id, acquiredAt: "2026-08-11T00:01:00.000Z" };
    await writeFile(paths.scheduler, JSON.stringify({
      schemaVersion: 1,
      pending: [],
      active: { jobId: failed.id, ownerId: staleLease.ownerId, lease: staleLease, startedAt: "2026-08-11T00:01:00.000Z" },
    }));
    await writeFile(path.join(root, "gpu-lease.json"), JSON.stringify({ schemaVersion: 1, lease: staleLease }));

    const service = createLoraTrainingService({
      paths,
      store,
      resolveBaseModel: async () => null,
      comfyLoraDirectory: path.join(root, "loras"),
    });
    const recovery = await service.initialize();
    assert.equal(recovery.recoveredJobId, failed.id);
    const recovered = await store.readJob(failed.id);
    assert.equal(recovered.status, "failed");
    assert.deepEqual(recovered.config.orchestration.error, {
      code: "TRAINER_FAILED", message: "real trainer failure", retryable: true,
    });
    const scheduler = JSON.parse(await readFile(paths.scheduler, "utf8"));
    assert.equal(scheduler.active, null);
    assert.equal(await readFile(path.join(root, "gpu-lease.json"), "utf8").then(() => true).catch(() => false), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("service recovery marks a nonterminal active job interrupted and releases its lease", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-lora-recovery-active-"));
  const paths = pathsFor(root);
  try {
    const store = createJobStore({ paths, clock: () => new Date("2026-08-11T00:00:00.000Z") });
    const created = await store.createJob({
      slug: "active-recovery",
      displayName: "Active recovery",
      family: "sdxl",
      captionReviewMode: "auto",
      triggerWords: ["subject"],
      assetIds: [],
      config: { family: "sdxl", baseProfile: "sdxl-base-1.0", outputName: "active-recovery" },
    });
    const lease = { id: "stale-active-lease", ownerId: "old-owner", jobId: created.id, acquiredAt: "2026-08-11T00:01:00.000Z" };
    await writeFile(paths.scheduler, JSON.stringify({ schemaVersion: 1, pending: [], active: { jobId: created.id, ownerId: lease.ownerId, lease, startedAt: lease.acquiredAt } }));
    await writeFile(path.join(root, "gpu-lease.json"), JSON.stringify({ schemaVersion: 1, lease }));

    const service = createLoraTrainingService({ paths, store, resolveBaseModel: async () => null, comfyLoraDirectory: path.join(root, "loras") });
    await service.initialize();
    const recovered = await store.readJob(created.id);
    assert.equal(recovered.status, "failed");
    assert.deepEqual(recovered.config.orchestration.error, {
      code: "TRAINING_FAILED", message: "training interrupted during service restart", retryable: true,
    });
    const scheduler = JSON.parse(await readFile(paths.scheduler, "utf8"));
    assert.equal(scheduler.active, null);
    assert.equal(await readFile(path.join(root, "gpu-lease.json"), "utf8").then(() => true).catch(() => false), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
