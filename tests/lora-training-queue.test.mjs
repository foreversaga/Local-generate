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

test("queue does not requeue a persisted active job before service recovery", async () => {
  const active = { jobId: "restart-active", ownerId: "old-owner", startedAt: "2026-08-11T00:00:00.000Z" };
  const pending = [
    { jobId: "pending-first", enqueuedAt: "2026-08-11T00:00:01.000Z" },
    { jobId: "pending-second", enqueuedAt: "2026-08-11T00:00:02.000Z" },
  ];
  const saved = [];
  const queue = createTrainingQueue({
    loadState: async () => ({ pending, active }),
    saveState: async (state) => saved.push(structuredClone(state)),
    acquireGpuLease: async () => null,
    releaseGpuLease: async () => {},
    execute: async () => ({ status: "succeeded" }),
  });

  await assert.rejects(queue.initialize(), (error) => error.code === "QUEUE_RECOVERY_REQUIRED");
  assert.deepEqual(queue.snapshot().pending.map(({ jobId }) => jobId), ["pending-first", "pending-second"]);
  assert.deepEqual(queue.snapshot().active, active);
  assert.deepEqual(saved, []);
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

test("preflight validates expected revision and returns the canonical revision for enqueue", async () => {
  const jobId = "44444444-4444-4444-8444-444444444444";
  const timestamp = "2026-08-11T00:00:00.000Z";
  let job = {
    id: jobId,
    revision: 3,
    slug: "preflight-revision",
    displayName: "Preflight revision",
    status: "draft",
    family: "sdxl",
    captionReviewMode: "auto",
    triggerWords: ["subject"],
    assetIds: [],
    config: { family: "sdxl", orchestration: {} },
    provenance: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const queue = { position: () => null, enqueue: async () => 1, start: () => Promise.resolve() };
  const store = {
    readJob: async () => structuredClone(job),
    updateJob: async (_id, patch, { expectedRevision }) => {
      assert.equal(expectedRevision, job.revision);
      job = {
        ...job,
        ...structuredClone(patch),
        config: patch.config ? structuredClone(patch.config) : job.config,
        revision: job.revision + 1,
        updatedAt: timestamp,
      };
      return structuredClone(job);
    },
  };
  const controller = createLoraTrainingController({
    store,
    queue,
    dataset: { readManifest: async () => ({ images: [] }) },
    captions: { readCaptions: async () => ({ records: [] }) },
    preflight: { run: async () => ({ status: "pass", checks: [], token: "fresh-token" }) },
    now: () => new Date(timestamp),
  });

  await assert.rejects(
    controller.runPreflight(jobId, { expectedRevision: 2 }),
    (error) => error.code === "REVISION_CONFLICT" && error.status === 409 && error.details.actualRevision === 3,
  );
  const report = await controller.runPreflight(jobId, { expectedRevision: 3 });
  assert.equal(report.revision, 4);
  const queued = await controller.enqueue(jobId, { expectedRevision: report.revision, preflightToken: report.token });
  assert.equal(queued.job.status, "queued");
  assert.equal(queued.job.revision, 6);
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

function retryFixture({ sourceStatus = "failed", preflight = { status: "pass", token: "fresh-token" } } = {}) {
  const sourceId = "44444444-4444-4444-8444-444444444444";
  const retryId = "55555555-5555-4555-8555-555555555555";
  const timestamp = "2026-08-11T00:00:00.000Z";
  const jobs = new Map([[sourceId, {
    id: sourceId,
    revision: 3,
    slug: "retry-source",
    displayName: "Retry source",
    status: sourceStatus,
    family: "sdxl",
    captionReviewMode: "auto",
    triggerWords: ["subject"],
    assetIds: ["input:retry-source.png"],
    config: {
      family: "sdxl",
      baseProfile: "sdxl-base-1.0",
      presetId: "sdxl-character-balanced",
      outputName: "retry-source",
      overrides: { rank: 32, alpha: 16, epochs: 12 },
      orchestration: {
        phase: sourceStatus,
        attempt: 1,
        datasetRevision: 4,
        captionRevision: 7,
        preflight: { status: "pass", token: "source-token", jobId: sourceId, jobRevision: 3 },
        progress: { stage: "failed", step: 9, totalSteps: 9 },
      },
    },
    provenance: { attempt: 1, sourceAssets: ["input:retry-source.png"], datasetRevision: 4, captionRevision: 7 },
    createdAt: timestamp,
    updatedAt: timestamp,
  }]]);
  const cloneCalls = [];
  const captionCalls = [];
  const queueState = { pending: [], active: null };
  const backgroundErrors = [];
  let controller;
  const store = {
    readJob: async (id) => structuredClone(jobs.get(id)),
    createJob: async (input) => {
      const created = { ...structuredClone(input), id: retryId, revision: 0, createdAt: timestamp, updatedAt: timestamp };
      jobs.set(retryId, created);
      return structuredClone(created);
    },
    updateJob: async (id, patch, { expectedRevision }) => {
      const current = jobs.get(id);
      if (!current || current.revision !== expectedRevision) throw new LoraTrainingError("REVISION_CONFLICT", "revision conflict", { status: 409 });
      const next = { ...current, ...structuredClone(patch), revision: current.revision + 1, updatedAt: timestamp };
      jobs.set(id, next);
      return structuredClone(next);
    },
  };
  const dataset = {
    cloneDataset: async (source, destination) => { cloneCalls.push({ source, destination }); },
    readManifest: async () => ({ images: [{ id: "66666666-6666-4666-8666-666666666666" }] }),
  };
  const captions = {
    generate: async (id) => { captionCalls.push(id); return { failed: 0 }; },
    readCaptions: async () => ({ records: [] }),
  };
  const queue = createTrainingQueue({
    loadState: async () => structuredClone(queueState),
    saveState: async (next) => Object.assign(queueState, structuredClone(next)),
    acquireGpuLease: async () => null,
    releaseGpuLease: async () => {},
    execute: async () => ({ status: "succeeded" }),
    onStateChange: async (event) => controller.onQueueStateChange(event),
    onBackgroundError: async (event) => backgroundErrors.push(event),
    ownerId: "retry-test-owner",
    now: () => timestamp,
  });
  controller = createLoraTrainingController({
    store,
    dataset,
    captions,
    queue,
    preflight: { run: async () => structuredClone(preflight) },
    now: () => new Date(timestamp),
  });
  return { controller, sourceId, retryId, jobs, cloneCalls, captionCalls, queueState, backgroundErrors };
}

test("retry revalidates a failed job and leaves the new revision in the scheduler", async () => {
  const fixture = retryFixture();
  const result = await fixture.controller.retry(fixture.sourceId);

  assert.equal(result.job.id, fixture.retryId);
  assert.equal(result.job.status, "queued");
  assert.ok(result.job.revision > 0, "retry must not remain a revision-zero draft");
  assert.equal(result.job.provenance.attempt, 2);
  assert.equal(result.job.provenance.retryOf, fixture.sourceId);
  assert.deepEqual(result.job.triggerWords, ["subject"]);
  assert.deepEqual(result.job.assetIds, ["input:retry-source.png"]);
  assert.equal(result.job.config.presetId, "sdxl-character-balanced");
  assert.equal(result.job.config.outputName, "retry-source");
  assert.deepEqual(result.job.config.overrides, { rank: 32, alpha: 16, epochs: 12 });
  assert.deepEqual(result.job.provenance.sourceAssets, ["input:retry-source.png"]);
  assert.equal(result.job.provenance.datasetRevision, 4);
  assert.equal(result.job.provenance.captionRevision, 7);
  assert.equal(result.job.config.orchestration.datasetRevision, 4);
  assert.equal(result.job.config.orchestration.captionRevision, 7);
  assert.equal(result.job.config.orchestration.preflight.token, "fresh-token");
  assert.deepEqual(fixture.cloneCalls, [{ source: fixture.sourceId, destination: fixture.retryId }]);
  assert.deepEqual(fixture.captionCalls, [fixture.retryId]);
  assert.deepEqual(fixture.queueState.pending.map(({ jobId }) => jobId), [fixture.retryId]);
  assert.deepEqual(fixture.queueState.active, null);
  assert.deepEqual(fixture.backgroundErrors, []);
});

test("retry stops safely when the new preflight fails", async () => {
  const fixture = retryFixture({ preflight: { status: "fail", token: "rejected-token", checks: [{ id: "gpu", status: "fail" }] } });
  const result = await fixture.controller.retry(fixture.sourceId);

  assert.equal(result.job.status, "failed");
  assert.equal(result.job.config.orchestration.preflight.status, "fail");
  assert.equal(result.job.config.orchestration.error.code, "PREFLIGHT_FAILED");
  assert.deepEqual(fixture.queueState.pending, []);
  assert.equal(fixture.queueState.active, null);
});

test("retry rejects active jobs instead of creating a duplicate queue entry", async () => {
  const fixture = retryFixture({ sourceStatus: "running" });
  await assert.rejects(
    fixture.controller.retry(fixture.sourceId),
    (error) => error.code === "RETRY_NOT_ALLOWED" && error.status === 409,
  );
  assert.equal(fixture.jobs.has(fixture.retryId), false);
  assert.deepEqual(fixture.cloneCalls, []);
  assert.deepEqual(fixture.queueState.pending, []);
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
    await writeFile(paths.scheduler, JSON.stringify({ schemaVersion: 1, pending: [{ jobId: "pending-one" }, { jobId: "pending-two" }], active: { jobId: created.id, ownerId: lease.ownerId, lease, startedAt: lease.acquiredAt } }));
    await writeFile(path.join(root, "gpu-lease.json"), JSON.stringify({ schemaVersion: 1, lease }));

    const service = createLoraTrainingService({ paths, store, resolveBaseModel: async () => null, comfyLoraDirectory: path.join(root, "loras") });
    await service.initialize();
    const recovered = await store.readJob(created.id);
    assert.equal(recovered.status, "failed");
    assert.deepEqual(recovered.config.orchestration.error, {
      code: "TRAINING_INTERRUPTED", message: "training was interrupted by service restart; retry is available", retryable: true,
      details: { recoverable: true, reason: "service_restart" },
    });
    const scheduler = JSON.parse(await readFile(paths.scheduler, "utf8"));
    assert.equal(scheduler.active, null);
    assert.deepEqual(scheduler.pending.map(({ jobId }) => jobId), ["pending-one", "pending-two"]);
    assert.equal(await readFile(path.join(root, "gpu-lease.json"), "utf8").then(() => true).catch(() => false), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("service recovery preserves a live GPU lease instead of stealing it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-lora-recovery-live-lease-"));
  const paths = pathsFor(root);
  try {
    const store = createJobStore({ paths, clock: () => new Date("2026-08-11T00:00:00.000Z") });
    const created = await store.createJob({
      slug: "live-lease-recovery",
      displayName: "Live lease recovery",
      family: "sdxl",
      captionReviewMode: "auto",
      triggerWords: ["subject"],
      assetIds: [],
      config: { family: "sdxl", baseProfile: "sdxl-base-1.0", outputName: "live-lease-recovery" },
    });
    const lease = {
      id: "live-lease", ownerId: "live-owner", ownerPid: 4242, jobId: created.id,
      acquiredAt: "2026-08-11T00:00:00.000Z", expiresAt: "2026-08-11T01:00:00.000Z",
    };
    await writeFile(paths.scheduler, JSON.stringify({ schemaVersion: 1, pending: [], active: { jobId: created.id, ownerId: lease.ownerId, lease, startedAt: lease.acquiredAt } }));
    await writeFile(path.join(root, "gpu-lease.json"), JSON.stringify({ schemaVersion: 1, lease }));

    const service = createLoraTrainingService({
      paths,
      store,
      now: () => "2026-08-11T00:10:00.000Z",
      isProcessAlive: async (pid) => pid === 4242,
      resolveBaseModel: async () => null,
      comfyLoraDirectory: path.join(root, "loras"),
    });
    const recovery = await service.initialize();
    const recovered = await store.readJob(created.id);
    assert.equal(recovered.status, "failed");
    assert.equal(recovery.leaseCleared, false);
    assert.equal(recovery.leaseCleanupReason, "owner-live-or-unknown");
    assert.equal(await readFile(path.join(root, "gpu-lease.json"), "utf8").then(() => true).catch(() => false), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("service recovery clears a lease whose owner process has exited", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-lora-recovery-dead-owner-"));
  const paths = pathsFor(root);
  try {
    const store = createJobStore({ paths, clock: () => new Date("2026-08-11T00:00:00.000Z") });
    const created = await store.createJob({
      slug: "dead-owner-recovery",
      displayName: "Dead owner recovery",
      family: "sdxl",
      captionReviewMode: "auto",
      triggerWords: ["subject"],
      assetIds: [],
      config: { family: "sdxl", baseProfile: "sdxl-base-1.0", outputName: "dead-owner-recovery" },
    });
    const lease = {
      id: "dead-owner-lease", ownerId: "dead-owner", ownerPid: 4343, jobId: created.id,
      acquiredAt: "2026-08-11T00:00:00.000Z", expiresAt: "2026-08-11T01:00:00.000Z",
    };
    await writeFile(paths.scheduler, JSON.stringify({ schemaVersion: 1, pending: [], active: { jobId: created.id, ownerId: lease.ownerId, lease, startedAt: lease.acquiredAt } }));
    await writeFile(path.join(root, "gpu-lease.json"), JSON.stringify({ schemaVersion: 1, lease }));

    const service = createLoraTrainingService({
      paths,
      store,
      now: () => "2026-08-11T00:10:00.000Z",
      isProcessAlive: async () => false,
      resolveBaseModel: async () => null,
      comfyLoraDirectory: path.join(root, "loras"),
    });
    const recovery = await service.initialize();
    assert.equal(recovery.leaseCleared, true);
    assert.equal(recovery.leaseCleanupReason, "owner-exited");
    assert.equal(await readFile(path.join(root, "gpu-lease.json"), "utf8").then(() => true).catch(() => false), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
