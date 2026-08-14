import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SEEDVR2_PROFILE,
  SEEDVR2_REQUIRED_NODES,
  SEEDVR2_UNET_NAME,
  SEEDVR2_VAE_NAME,
  createSeedVR2Controller,
} from "../server/video-upscale/seedvr2.mjs";
import { canonicalSeedVR2Job, createSeedVR2JobStore } from "../server/video-upscale/seedvr2-store.mjs";

const NOW = new Date("2026-08-12T04:00:00.000Z");

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    async text() { return JSON.stringify(payload); },
  };
}

function objectInfo() {
  const info = Object.fromEntries(SEEDVR2_REQUIRED_NODES.map((name) => [name, { input: { required: {} } }]));
  info.UNETLoader.input.required.unet_name = [[SEEDVR2_UNET_NAME], {}];
  info.VAELoader.input.required.vae_name = [[SEEDVR2_VAE_NAME], {}];
  return info;
}

function apiResponse() {
  return {
    headersSent: false,
    status: 0,
    body: null,
    writeHead(status) { this.status = status; this.headersSent = true; },
    end(value) { this.body = value ? JSON.parse(value) : null; },
  };
}

class FakeComfyWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.closed = false;
    FakeComfyWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, data) {
    for (const listener of this.listeners.get(type) || []) listener(data);
  }

  close() {
    this.closed = true;
  }
}

async function waitFor(read, predicate, message = "condition was not reached") {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(message);
}

test("job store canonicalizes the public source shape and mirrored timestamps", () => {
  const job = canonicalSeedVR2Job({
    id: "source-shape",
    source: { name: "nested/source.mp4", root: "output" },
    status: "queued",
    timestamps: {
      createdAt: "2026-08-12T03:00:00.000Z",
      updatedAt: "2026-08-12T03:01:00.000Z",
    },
  });
  assert.deepEqual(job.source, { name: "nested/source.mp4", root: "output" });
  assert.equal(job.sourceName, "nested/source.mp4");
  assert.equal(job.sourceRoot, "output");
  assert.equal(job.timestamps.createdAt, "2026-08-12T03:00:00.000Z");
  assert.equal(job.updatedAt, "2026-08-12T03:01:00.000Z");
});

async function fixture({ historyMode = "success", idFactory = () => "seedvr2-job", webSocketImpl = null, onPrompt = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "h3-seedvr2-lifecycle-"));
  const inputRoot = path.join(root, "input");
  const outputRoot = path.join(root, "output");
  const store = createSeedVR2JobStore({ root: path.join(root, "jobs") });
  await fs.mkdir(path.join(root, "models", "diffusion_models"), { recursive: true });
  await fs.mkdir(path.join(root, "models", "vae"), { recursive: true });
  await fs.mkdir(inputRoot, { recursive: true });
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.writeFile(path.join(root, "models", "diffusion_models", SEEDVR2_UNET_NAME), "model");
  await fs.writeFile(path.join(root, "models", "vae", SEEDVR2_VAE_NAME), "vae");
  await fs.writeFile(path.join(inputRoot, "source.mp4"), "source");
  await fs.writeFile(path.join(outputRoot, "seedvr2-result.mp4"), "result");

  const state = {
    historyMode,
    promptCount: 0,
    historyCount: 0,
    interruptCount: 0,
    prompts: [],
    assets: [],
  };
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith("/system_stats")) return response({ devices: [] });
    if (url.endsWith("/object_info")) return response(objectInfo());
    if (url.endsWith("/prompt")) {
      state.promptCount += 1;
      const promptId = `seedvr2-prompt-${state.promptCount}`;
      state.prompts.push(JSON.parse(init.body));
      onPrompt?.(promptId, state);
      return response({ prompt_id: promptId });
    }
    if (url.endsWith("/interrupt")) {
      state.interruptCount += 1;
      return response({});
    }
    if (url.includes("/history/")) {
      state.historyCount += 1;
      const promptId = decodeURIComponent(url.split("/history/")[1]);
      const mode = typeof state.historyMode === "function" ? state.historyMode(state.promptCount, promptId) : state.historyMode;
      if (mode === "pending") return response({ [promptId]: { status: { status_str: "running" } } });
      if (mode === "failed") return response({ [promptId]: { status: { status_str: "error", messages: [["execution_error", { exception_message: "fake failure" }]] } } });
      return response({ [promptId]: { status: { completed: true }, outputs: { "15": { videos: [{ filename: "seedvr2-result.mp4", subfolder: "", type: "output" }] } } } });
    }
    throw new Error(`unexpected endpoint ${url}`);
  };
  const controller = createSeedVR2Controller({
    comfyRoot: root,
    inputRoot,
    outputRoot,
    fetchImpl,
    fsApi: fs,
    jobStore: store,
    now: () => NOW,
    idFactory,
    webSocketImpl,
    pollIntervalMs: 1,
    toAsset: async (assetRoot, name) => {
      state.assets.push({ root: assetRoot, name });
      return { root: assetRoot, name, kind: "video", url: `/media?root=${assetRoot}&name=${encodeURIComponent(name)}` };
    },
  });
  await controller.ready();
  return { root, inputRoot, outputRoot, store, controller, state, fetchImpl };
}

test("SeedVR2 persistence keeps request, prompt, progress, output, timestamps, and provenance", async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const queued = await value.controller.enqueue({ sourceName: "source.mp4", sourceRoot: "input", scale: 2, profile: SEEDVR2_PROFILE, seed: 42 });
  const completed = await waitFor(() => value.store.read(queued.id), (job) => job?.status === "completed");

  assert.equal(completed.source.name, "source.mp4");
  assert.equal(completed.source.root, "input");
  assert.equal(completed.scale, 2);
  assert.equal(completed.profile, SEEDVR2_PROFILE);
  assert.equal(completed.seed, 42);
  assert.equal(completed.prompt["10"].inputs.seed, 42);
  assert.equal(completed.stage, "Completed");
  assert.equal(completed.progress, 100);
  assert.equal(completed.output.name, "seedvr2-result.mp4");
  assert.equal(completed.provenance.request.seed, 42);
  assert.equal(completed.provenance.attempt, 1);
  assert.equal(completed.attempt, 1);
  assert.ok(completed.createdAt && completed.updatedAt && completed.completedAt);
  assert.equal(value.state.assets.length, 1, "completed output must be registered through the Library asset callback");

  const listResponse = apiResponse();
  await value.controller.handleRoute({ method: "GET", url: "/api/upscale/jobs" }, listResponse);
  assert.equal(listResponse.status, 200);
  assert.equal(listResponse.body.jobs.find((job) => job.id === queued.id).output.name, "seedvr2-result.mp4");
  assert.equal(listResponse.body.jobs.find((job) => job.id === queued.id).prompt["10"].inputs.seed, 42);
});

test("SeedVR2 prefers matching ComfyUI WebSocket progress and still reads the history artifact", async (t) => {
  FakeComfyWebSocket.instances = [];
  const value = await fixture({
    historyMode: "pending",
    webSocketImpl: FakeComfyWebSocket,
    onPrompt: (promptId) => {
      setTimeout(() => {
        const socket = FakeComfyWebSocket.instances.at(-1);
        socket?.emit("open");
        const emit = (type, data) => socket?.emit("message", JSON.stringify({ type, data }));
        emit("execution_start", { prompt_id: promptId });
        emit("executing", { prompt_id: promptId, node: "10", display_node: "10" });
        emit("progress", { prompt_id: promptId, node: "10", value: 3, max: 4 });
      }, 0);
    },
  });
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));

  const queued = await value.controller.enqueue({ sourceName: "source.mp4", sourceRoot: "input", scale: 2, seed: 42 });
  const running = await waitFor(
    () => value.store.read(queued.id),
    (job) => job?.status === "running" && job.progress >= 64 && /KSampler.*3\/4/.test(job.stage || ""),
    "native SeedVR2 WebSocket progress was not persisted",
  );
  assert.ok(running.progress >= 64);
  assert.match(running.stage, /KSampler.*3\/4/);
  assert.equal(FakeComfyWebSocket.instances[0].url, "ws://127.0.0.1:8188/ws?clientId=h3-seedvr2");

  FakeComfyWebSocket.instances[0].emit("message", JSON.stringify({ type: "execution_success", data: { prompt_id: running.promptId } }));
  value.state.historyMode = "success";
  const completed = await waitFor(() => value.store.read(queued.id), (job) => job?.status === "completed");
  assert.equal(completed.output.name, "seedvr2-result.mp4");
  assert.equal(FakeComfyWebSocket.instances[0].closed, true);
});

test("SeedVR2 turns a matching WebSocket execution_error into a failed job without waiting for poll timeout", async (t) => {
  FakeComfyWebSocket.instances = [];
  const value = await fixture({
    historyMode: "pending",
    webSocketImpl: FakeComfyWebSocket,
    onPrompt: (promptId) => {
      setTimeout(() => {
        const socket = FakeComfyWebSocket.instances.at(-1);
        socket?.emit("open");
        socket?.emit("message", JSON.stringify({
          type: "execution_error",
          data: { prompt_id: promptId, node_id: "10", exception_message: "simulated SeedVR2 failure" },
        }));
      }, 0);
    },
  });
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));

  const queued = await value.controller.enqueue({ sourceName: "source.mp4", sourceRoot: "input", scale: 2 });
  const failed = await waitFor(() => value.store.read(queued.id), (job) => job?.status === "failed");
  assert.match(failed.error, /simulated SeedVR2 failure/);
  assert.equal(FakeComfyWebSocket.instances[0].closed, true);
});

test("restart reconciles queued work and turns a stale running job into recoverable interrupted history", async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  await value.store.create({
    id: "queued-restart",
    sourceName: "source.mp4",
    sourceRoot: "input",
    status: "queued",
    createdAt: "2026-08-12T03:00:00.000Z",
  });
  await value.store.create({
    id: "running-restart",
    sourceName: "source.mp4",
    sourceRoot: "input",
    status: "running",
    startedAt: "2026-08-12T03:01:00.000Z",
    createdAt: "2026-08-12T03:00:00.000Z",
  });

  const restarted = createSeedVR2Controller({
    comfyRoot: value.root,
    inputRoot: value.inputRoot,
    outputRoot: value.outputRoot,
    fetchImpl: value.fetchImpl,
    jobStore: value.store,
    now: () => NOW,
    idFactory: () => "restart-new",
    pollIntervalMs: 1,
    toAsset: async (_root, name) => ({ root: "output", name, kind: "video" }),
  });
  await restarted.ready();
  const interrupted = await value.store.read("running-restart");
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.recoverable, true);
  assert.equal(interrupted.recovery.reason, "bridge_restart");
  const interruptedApi = apiResponse();
  await restarted.handleRoute({ method: "GET", url: "/api/upscale/jobs/running-restart" }, interruptedApi);
  assert.equal(interruptedApi.body.job.recovery.reason, "bridge_restart");
  const queuedSnapshot = await restarted.getJob("queued-restart");
  assert.ok(queuedSnapshot);
  assert.equal(queuedSnapshot.recovery.reason, "bridge_restart");
  const requeued = await waitFor(() => value.store.read("queued-restart"), (job) => job?.status === "completed" || job?.status === "failed");
  assert.notEqual(requeued.status, "running", "restart must not leave a ghost running state");
});

test("queued cancel is durable and never submits a ComfyUI prompt", async (t) => {
  const value = await fixture({ historyMode: "pending", idFactory: (() => { const ids = ["active-job", "queued-job"]; return () => ids.shift(); })() });
  t.after(async () => {
    await value.controller.cancel("active-job", "test cleanup").catch(() => {});
    await waitFor(() => value.store.read("active-job"), (job) => job?.status === "cancelled").catch(() => null);
    await fs.rm(value.root, { recursive: true, force: true });
  });
  await value.controller.enqueue({ sourceName: "source.mp4", sourceRoot: "input", scale: 2, seed: 1 });
  await waitFor(() => value.store.read("active-job"), (job) => Boolean(job?.promptId));
  const queued = await value.controller.enqueue({ sourceName: "source.mp4", sourceRoot: "input", scale: 2, seed: 2 });
  const result = apiResponse();
  await value.controller.handleRoute({ method: "POST", url: `/api/upscale/jobs/${queued.id}/cancel` }, result, {
    readJson: async () => ({ reason: "No longer needed" }),
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.job.status, "cancelled");
  const saved = await value.store.read(queued.id);
  assert.equal(saved.status, "cancelled");
  assert.equal(saved.cancelReason, "No longer needed");
  assert.equal(value.state.promptCount, 1);
  assert.equal(value.state.interruptCount, 0);
});

test("active cancel interrupts ComfyUI, prevents output registration, and persists reason/status", async (t) => {
  const value = await fixture({ historyMode: "pending" });
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const queued = await value.controller.enqueue({ sourceName: "source.mp4", sourceRoot: "input", scale: 2, seed: 9 });
  await waitFor(() => value.store.read(queued.id), (job) => Boolean(job?.promptId));
  const result = apiResponse();
  await value.controller.handleRoute({ method: "POST", url: `/api/upscale/jobs/${queued.id}/cancel` }, result, {
    readJson: async () => ({ reason: "User stopped this upscale" }),
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.job.status, "cancelling");

  const cancelled = await waitFor(() => value.store.read(queued.id), (job) => job?.status === "cancelled");
  assert.equal(cancelled.cancelReason, "User stopped this upscale");
  assert.equal(cancelled.stage, "Cancelled");
  assert.equal(cancelled.output, null);
  assert.equal(value.state.interruptCount, 1);
  assert.equal(value.state.assets.length, 0);
});

test("retry creates a new attempt while preserving SeedVR2 provenance", async (t) => {
  const value = await fixture({ historyMode: (promptCount) => promptCount === 1 ? "failed" : "success", idFactory: (() => { const ids = ["failed-job", "retry-job"]; return () => ids.shift(); })() });
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const failed = await value.controller.enqueue({ sourceName: "source.mp4", sourceRoot: "input", scale: 2, profile: SEEDVR2_PROFILE, seed: 77 });
  await waitFor(() => value.store.read(failed.id), (job) => job?.status === "failed");
  const result = apiResponse();
  await value.controller.handleRoute({ method: "POST", url: `/api/upscale/jobs/${failed.id}/retry` }, result);
  assert.equal(result.status, 201);
  const retried = result.body.job;
  assert.equal(retried.retryOf, failed.id);
  assert.equal(retried.attempt, 2);
  assert.equal(retried.provenance.retryOf, failed.id);
  assert.equal(retried.provenance.originalId, failed.id);
  assert.equal(retried.provenance.request.sourceName, "source.mp4");
  assert.equal(retried.provenance.request.seed, 77);
  assert.equal(retried.seed, 77);
  const completed = await waitFor(() => value.store.read(retried.id), (job) => job?.status === "completed");
  assert.equal(completed.attempt, 2);
  assert.equal((await value.store.read(failed.id)).attempt, 1);
});
