import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createSolH3JobStore } from "../server/sol-h3/job-store.mjs";

async function withStore(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-h3-store-"));
  try {
    const store = createSolH3JobStore({ root, clock: () => "2026-09-12T01:00:00.000Z" });
    await run({ root, store });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function job(status = "queued") {
  return {
    id: "sol-test-001",
    request: { schemaVersion: 1, mode: "t2va", prompt: "x", seed: 42, audio: { generate: true }, inputs: {} },
    status,
    stage: "test",
    progress: 0,
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    cancelRequested: false,
    events: [],
    error: "",
  };
}

test("writes immutable request.json and mutable state.json separately", async () => {
  await withStore(async ({ root, store }) => {
    const current = job();
    await store.create(current);
    const requestBefore = await fs.readFile(path.join(root, current.id, "request.json"), "utf8");
    current.stage = "changed";
    await store.save(current);
    const requestAfter = await fs.readFile(path.join(root, current.id, "request.json"), "utf8");
    assert.equal(requestAfter, requestBefore);
    const state = JSON.parse(await fs.readFile(path.join(root, current.id, "state.json"), "utf8"));
    assert.equal(state.stage, "changed");
    assert.equal(Object.hasOwn(state, "request"), false);
  });
});

test("reloads queued jobs after restart", async () => {
  await withStore(async ({ store }) => {
    const current = job("waiting_gpu");
    await store.create(current);
    const loaded = await store.load(current.id);
    const recovery = await store.recover(loaded);
    assert.equal(recovery.action, "reload");
    assert.equal(loaded.status, "queued");
  });
});

test("marks running jobs interrupted after restart", async () => {
  await withStore(async ({ store }) => {
    const current = job("stage1_running");
    await store.create(current);
    const loaded = await store.load(current.id);
    const recovery = await store.recover(loaded);
    assert.equal(recovery.action, "interrupt");
    assert.equal(loaded.status, "interrupted");
    assert.match(loaded.error, /restarted/i);
  });
});
