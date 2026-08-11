import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";

import { atomicWriteJson, createJobStore, withStorageLock } from "../server/lora-training/store.mjs";
import { createLoraTrainingController } from "../server/lora-training/controller.mjs";
import { createDatasetService } from "../server/lora-training/dataset.mjs";
import { LoraTrainingError } from "../server/lora-training/schema.mjs";

function errno(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function testPaths(root) {
  return {
    root,
    runtime: path.join(root, "runtime"),
    jobs: path.join(root, "jobs"),
    cache: path.join(root, "cache"),
    scheduler: path.join(root, "scheduler.json"),
    registry: path.join(root, "registry.json"),
  };
}

test("atomic JSON replace retries transient rename errors and cleans up", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-lora-atomic-success-"));
  try {
    const target = path.join(root, "job.json");
    let calls = 0;
    const waits = [];
    await atomicWriteJson(target, { revision: 3 }, {
      renameImpl: async (from, to) => {
        calls += 1;
        if (calls < 3) throw errno("EPERM", "file is temporarily locked");
        return rename(from, to);
      },
      sleep: async (milliseconds) => waits.push(milliseconds),
    });
    assert.equal(calls, 3);
    assert.deepEqual(waits, [25, 75]);
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { revision: 3 });
    assert.deepEqual(await readdir(root), ["job.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("atomic JSON replace reports bounded IO_ERROR after rename exhaustion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-lora-atomic-fail-"));
  try {
    const target = path.join(root, "job.json");
    let calls = 0;
    const error = await atomicWriteJson(target, { revision: 4 }, {
      renameImpl: async () => {
        calls += 1;
        throw errno("EBUSY", "sharing violation");
      },
      sleep: async () => {},
    }).then(() => null, (failure) => failure);
    assert.equal(error?.code, "IO_ERROR");
    assert.equal(error?.status, 500);
    assert.deepEqual(error?.details, { retryable: true, operation: "rename", attempts: 5, target: "job.json", reason: "EBUSY" });
    assert.equal(calls, 5);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("atomic JSON replace does not retry permanent rename errors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-lora-atomic-permanent-"));
  try {
    const target = path.join(root, "job.json");
    let calls = 0;
    let waits = 0;
    await assert.rejects(
      atomicWriteJson(target, { revision: 5 }, {
        renameImpl: async () => {
          calls += 1;
          throw errno("EACCES", "access denied");
        },
        sleep: async () => { waits += 1; },
      }),
      (error) => error?.code === "IO_ERROR"
        && error?.details?.operation === "rename"
        && error?.details?.attempts === 1
        && error?.details?.reason === "EACCES",
    );
    assert.equal(calls, 1);
    assert.equal(waits, 0);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("storage lock rejection has no duplicate unhandled tracker promise", async () => {
  const failure = errno("EPERM", "simulated write failure");
  await assert.rejects(withStorageLock("strict-test-lock", async () => { throw failure; }), /simulated write failure/);
  await new Promise((resolve) => setImmediate(resolve));
});

test("dataset retry clone remaps a complete caption checkpoint and sidecar", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-lora-clone-captions-"));
  try {
    const paths = testPaths(root);
    await mkdir(paths.cache, { recursive: true });
    const sourceId = "12121212-1212-4121-8121-121212121212";
    const destinationId = "13131313-1313-4131-8131-131313131313";
    const ids = [sourceId, destinationId];
    const store = createJobStore({ paths, idFactory: () => ids.shift(), clock: () => new Date(NOW) });
    const request = (slug) => ({ slug, displayName: slug, family: "sdxl", triggerWords: ["subject"], assetIds: [], config: { family: "sdxl" } });
    const source = await store.createJob(request("clone-source"));
    await store.createJob(request("clone-destination"));
    const sourceFile = path.join(paths.cache, "source.png");
    await writeFile(sourceFile, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]));
    const dataset = createDatasetService({
      paths,
      clock: () => new Date(NOW),
      resolveSource: async () => ({ path: sourceFile, fileName: "source.png", mimeType: "image/png" }),
    });
    await dataset.importImages(source.id, [{ assetId: "input:source.png" }]);
    const sourceImage = (await dataset.readManifest(source.id)).images[0];
    const sourceLocations = dataset.getLocations(source.id);
    await writeFile(path.join(sourceLocations.captions, "manifest.json"), JSON.stringify({
      schemaVersion: 1,
      jobId: source.id,
      revision: 1,
      records: [{ imageId: sourceImage.id, imageFile: sourceImage.fileName, status: "ready", caption: "subject, portrait" }],
    }));
    await writeFile(path.join(sourceLocations.captions, `${sourceImage.id}.txt`), "subject, portrait\n");

    await dataset.cloneDataset(source.id, destinationId);
    const destinationManifest = await dataset.readManifest(destinationId);
    const destinationCaptions = JSON.parse(await readFile(path.join(dataset.getLocations(destinationId).captions, "manifest.json"), "utf8"));
    assert.notEqual(destinationManifest.images[0].id, sourceImage.id);
    assert.equal(destinationCaptions.records[0].imageId, destinationManifest.images[0].id);
    assert.equal(destinationCaptions.datasetRevision, destinationManifest.revision);
    assert.equal(await readFile(path.join(dataset.getLocations(destinationId).captions, `${destinationManifest.images[0].id}.txt`), "utf8"), "subject, portrait\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const JOB_ID = "77777777-7777-4777-8777-777777777777";
const SOURCE_ID = "88888888-8888-4888-8888-888888888888";
const RETRY_ID = "99999999-9999-4999-8999-999999999999";
const IMAGE_IDS = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];
const NOW = "2026-08-11T00:00:00.000Z";

function job(id, status = "draft", revision = 0, provenance = {}) {
  return {
    id,
    revision,
    slug: `job-${id.slice(0, 4)}`,
    displayName: "Checkpoint job",
    status,
    family: "sdxl",
    captionReviewMode: "auto",
    triggerWords: ["subject"],
    assetIds: [],
    config: { family: "sdxl", baseProfile: "sdxl-base-1-0", outputName: "checkpoint", orchestration: {} },
    provenance,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function controllerFixture({ source, existing } = {}) {
  const jobs = new Map();
  if (source) jobs.set(source.id, structuredClone(source));
  if (existing) jobs.set(existing.id, structuredClone(existing));
  const images = IMAGE_IDS.map((id) => ({ id, fileName: `${id}.png`, relativePath: `images/${id}.png` }));
  const records = images.map((image) => ({ imageId: image.id, imageFile: image.fileName, status: "ready", caption: "subject, portrait" }));
  const calls = { create: 0, clone: 0, generate: 0, preflight: 0, enqueue: 0 };
  const store = {
    readJob: async (id) => structuredClone(jobs.get(id)),
    listJobs: async () => [...jobs.values()].map((item) => structuredClone(item)),
    createJob: async (input) => {
      calls.create += 1;
      const created = { ...structuredClone(input), id: RETRY_ID, revision: 0, createdAt: NOW, updatedAt: NOW };
      jobs.set(created.id, created);
      return structuredClone(created);
    },
    updateJob: async (id, patch, { expectedRevision }) => {
      const current = jobs.get(id);
      if (!current || current.revision !== expectedRevision) throw new LoraTrainingError("REVISION_CONFLICT", "revision conflict", { status: 409 });
      const next = { ...current, ...structuredClone(patch), revision: current.revision + 1, updatedAt: NOW };
      jobs.set(id, next);
      return structuredClone(next);
    },
  };
  const dataset = {
    readManifest: async () => ({ schemaVersion: 1, revision: 1, images: structuredClone(images) }),
    cloneDataset: async () => { calls.clone += 1; },
  };
  const captions = {
    checkpoint: async () => ({ complete: true, records: structuredClone(records), total: images.length, failed: 0 }),
    readCaptions: async () => ({ records: structuredClone(records) }),
    generate: async () => { calls.generate += 1; throw new Error("checkpoint should have skipped generation"); },
  };
  const queue = {
    position: () => null,
    enqueue: async () => { calls.enqueue += 1; return 1; },
    start: () => {},
  };
  const preflight = {
    run: async () => { calls.preflight += 1; return { status: "pass", token: "fresh-preflight" }; },
  };
  return { controller: createLoraTrainingController({ store, dataset, captions, preflight, queue, now: () => new Date(NOW) }), calls, jobs };
}

test("complete caption checkpoint skips generation but still runs fresh preflight and enqueue", async () => {
  const fixture = controllerFixture({ source: job(JOB_ID) });
  const result = await fixture.controller.start(JOB_ID, { expectedRevision: 0 });
  assert.equal(result.job.status, "queued");
  assert.equal(fixture.calls.generate, 0);
  assert.equal(fixture.calls.preflight, 1);
  assert.equal(fixture.calls.enqueue, 1);
  assert.equal(result.job.config.orchestration.preflight.token, "fresh-preflight");
});

test("retry returns the existing nonterminal attempt instead of duplicating it", async () => {
  const source = job(SOURCE_ID, "failed", 3, { attempt: 1 });
  const existing = job(RETRY_ID, "draft", 0, { retryOf: SOURCE_ID, attempt: 2 });
  const fixture = controllerFixture({ source, existing });
  const result = await fixture.controller.retry(SOURCE_ID);
  assert.equal(result.job.id, RETRY_ID);
  assert.equal(result.job.status, "queued");
  assert.equal(fixture.calls.create, 0);
  assert.equal(fixture.calls.clone, 0);
  assert.equal(fixture.calls.generate, 0);
  assert.equal(fixture.calls.preflight, 1);
  assert.equal(fixture.calls.enqueue, 1);
});

test("controller IO rejection remains observable without an unhandled rejection", async () => {
  const source = job(JOB_ID);
  const controller = createLoraTrainingController({
    store: {
      readJob: async () => structuredClone(source),
      updateJob: async () => { throw new LoraTrainingError("IO_ERROR", "simulated persistence failure", { status: 500 }); },
    },
    dataset: { readManifest: async () => ({ images: IMAGE_IDS.map((id) => ({ id, fileName: `${id}.png` })) }) },
    captions: { generate: async () => ({ failed: 0 }), readCaptions: async () => ({ records: [] }) },
    preflight: { run: async () => ({ status: "pass", token: "token" }) },
    queue: { enqueue: async () => 1 },
  });
  await assert.rejects(controller.start(JOB_ID), (error) => error?.code === "IO_ERROR");
  await new Promise((resolve) => setImmediate(resolve));
});
