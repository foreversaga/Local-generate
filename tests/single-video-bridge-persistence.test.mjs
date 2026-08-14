import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import test, { after } from "node:test";

import { createSingleVideoJobStore } from "../server/video-generation/single-job-store.mjs";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "h3-single-video-bridge-"));
const dataRoot = path.join(tempRoot, "single-jobs");
const h3Root = path.join(tempRoot, "h3-local");
const comfyRoot = path.join(tempRoot, "comfy");
const logsRoot = path.join(tempRoot, "logs");
await mkdir(path.join(h3Root, "src"), { recursive: true });
await mkdir(path.join(comfyRoot, "input"), { recursive: true });
await mkdir(path.join(comfyRoot, "output"), { recursive: true });
await mkdir(logsRoot, { recursive: true });
await writeFile(path.join(h3Root, "src", "generate.py"), "setTimeout(() => { process.exitCode = 1; }, 250);\n", "utf8");

const environmentKeys = [
  "MINIMAX_H3_SINGLE_VIDEO_DATA_ROOT",
  "MINIMAX_H3_SINGLE_VIDEO_AUTO_RESUME",
  "MINIMAX_H3_SINGLE_VIDEO_OWNER_ID",
  "MINIMAX_H3_ROOT",
  "COMFYUI_ROOT",
  "MINIMAX_H3_LOGS_ROOT",
  "MINIMAX_H3_PYTHON",
];
const previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
process.env.MINIMAX_H3_SINGLE_VIDEO_DATA_ROOT = dataRoot;
process.env.MINIMAX_H3_SINGLE_VIDEO_AUTO_RESUME = "0";
process.env.MINIMAX_H3_SINGLE_VIDEO_OWNER_ID = "bridge-test-owner";
process.env.MINIMAX_H3_ROOT = h3Root;
process.env.COMFYUI_ROOT = comfyRoot;
process.env.MINIMAX_H3_LOGS_ROOT = logsRoot;
process.env.MINIMAX_H3_PYTHON = process.execPath;

const store = createSingleVideoJobStore({ root: dataRoot });
const request = {
  mode: "t2v",
  prompt: [
    "integrated_multimodal_description: [Shot 1] A subject crosses a room.",
    "",
    "overall_soundscape: Footsteps and room tone.",
    "",
    "non_diegetic_music: N/A",
  ].join("\n"),
  negativePrompt: "blur",
  modelProfile: "nvfp4_blackwell",
  width: 736,
  height: 416,
  duration: 5,
  steps: 20,
  seed: 42,
  timeoutSeconds: 3600,
  outputName: "retry-me.mp4",
};
await store.create({ ...request, id: "sv-completed-api", status: "completed", stage: "completed", progress: 100, output: { root: "output", name: "done.mp4" }, exitCode: 0 });
await store.create({ ...request, id: "sv-queued-api", status: "queued", stage: "waiting", progress: 2 });
await store.create({ ...request, id: "sv-running-api", status: "running", stage: "sampling", progress: 42, execution: { ownerId: "old-owner", pid: 123 } });
await store.create({
  ...request,
  id: "sv-failed-api",
  status: "failed",
  stage: "failed",
  progress: 48,
  error: "generator failed",
  exitCode: 1,
  attempt: 1,
  provenance: { request, attempt: 1 },
});

const bridge = await import(`../local-bridge.mjs?single-video-persistence=${randomUUID()}`);

after(async () => {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(tempRoot, { recursive: true, force: true });
});

function getRequest(pathname) {
  const req = Readable.from([]);
  req.method = "GET";
  req.url = pathname;
  req.headers = {};
  return req;
}

function postRequest(pathname, payload = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))]);
  req.method = "POST";
  req.url = pathname;
  req.headers = {};
  return req;
}

async function invoke(req) {
  let body = "";
  const response = {
    headersSent: false,
    setHeader() {},
    writeHead(status) { this.status = status; },
    end(chunk) { body += String(chunk || ""); },
  };
  await bridge.route(req, response);
  return { status: response.status, body: JSON.parse(body || "{}") };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return await predicate();
}

test("Jobs API reads durable history and recovery never exposes a ghost running job", async () => {
  const response = await invoke(getRequest("/api/jobs"));
  assert.equal(response.status, 200);
  const jobs = response.body.jobs;
  assert.deepEqual(new Set(jobs.map((job) => job.id)), new Set(["sv-completed-api", "sv-queued-api", "sv-running-api", "sv-failed-api"]));
  assert.equal(jobs.find((job) => job.id === "sv-completed-api").status, "completed");
  assert.equal(jobs.find((job) => job.id === "sv-queued-api").status, "queued");
  const interrupted = jobs.find((job) => job.id === "sv-running-api");
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.recoverable, true);
  assert.equal(interrupted.recovery.reason, "bridge_restart");
  assert.equal((await invoke(getRequest("/api/jobs/sv-completed-api"))).body.output.name, "done.mp4");
  assert.equal((await invoke(getRequest("/api/jobs/sv-running-api"))).body.status, "interrupted");
});

test("retry creates a new attempt with edited prompt and render parameters", async () => {
  const edited = {
    prompt: `${request.prompt}\n\nintegrated_multimodal_description: [Retry] Keep the same subject, use a shorter test shot.`,
    negativePrompt: "edited negative prompt",
    modelProfile: "nvfp4_blackwell",
    width: 704,
    height: 1056,
    duration: 8,
    steps: 8,
    seed: 777,
    timeoutSeconds: 7200,
    outputName: "retry-edited.mp4",
  };
  const response = await invoke(postRequest("/api/jobs/sv-failed-api/retry", edited));
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const retried = response.body.job;
  assert.notEqual(retried.id, "sv-failed-api");
  assert.equal(retried.attempt, 2);
  assert.equal(retried.retryOf, "sv-failed-api");
  assert.equal(retried.provenance.retryOf, "sv-failed-api");
  assert.equal(retried.prompt, edited.prompt);
  assert.equal(retried.negativePrompt, edited.negativePrompt);
  assert.equal(retried.provenance.request.prompt, edited.prompt);
  assert.equal(retried.provenance.request.seed, edited.seed);
  assert.equal(retried.provenance.request.width, edited.width);
  assert.equal(retried.provenance.request.height, edited.height);
  assert.equal(retried.provenance.request.duration, edited.duration);
  assert.equal(retried.provenance.request.steps, edited.steps);
  assert.equal(retried.provenance.request.timeoutSeconds, edited.timeoutSeconds);
  assert.equal(retried.outputName, edited.outputName);

  const cancelled = await invoke(postRequest(`/api/jobs/${encodeURIComponent(retried.id)}/cancel`));
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.job.status, "cancelling");

  const finished = await waitFor(async () => {
    const job = await store.read(retried.id);
    return job?.status === "cancelled" ? job : null;
  });
  assert.equal(finished.attempt, 2);
  assert.equal(finished.provenance.retryOf, "sv-failed-api");
  assert.equal((await store.read("sv-failed-api")).attempt, 1);
});
