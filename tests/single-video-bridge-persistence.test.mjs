import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import test, { after } from "node:test";

import { calculateAspectRatioDimensions } from "../app/lib/single-image-resolution.mjs";
import { createSingleVideoJobStore } from "../server/video-generation/single-job-store.mjs";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "h3-single-video-bridge-"));
const dataRoot = path.join(tempRoot, "single-jobs");
const h3Root = path.join(tempRoot, "h3-local");
const comfyRoot = path.join(tempRoot, "comfy");
const logsRoot = path.join(tempRoot, "logs");
const activePromptId = "22222222-2222-4222-8222-222222222222";
let promptActive = false;
let promptErrored = false;
let targetedCancelStopsPrompt = true;
const comfyCancelRequests = [];
const comfyServer = createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.method === "POST" && req.url === `/api/jobs/${activePromptId}/cancel`) {
    comfyCancelRequests.push(req.url);
    if (targetedCancelStopsPrompt) promptActive = false;
    res.end(JSON.stringify({ cancelled: true }));
    return;
  }
  if (req.method === "POST" && req.url === "/queue") {
    comfyCancelRequests.push(req.url);
    res.end("{}");
    return;
  }
  if (req.method === "POST" && req.url === "/interrupt") {
    comfyCancelRequests.push(req.url);
    promptActive = false;
    res.end("{}");
    return;
  }
  if (req.url === "/queue") {
    res.end(JSON.stringify({
      queue_running: promptActive ? [[1, activePromptId, {}, { client_id: "test" }]] : [],
      queue_pending: [],
    }));
    return;
  }
  if (req.url === `/history/${activePromptId}`) {
    res.end(JSON.stringify(promptErrored ? {
      [activePromptId]: { status: { status_str: "error", completed: false }, outputs: {} },
    } : {}));
    return;
  }
  res.end("{}");
});
await new Promise((resolve) => comfyServer.listen(0, "127.0.0.1", resolve));
const comfyAddress = comfyServer.address();
const comfyUrl = `http://127.0.0.1:${comfyAddress.port}`;
await mkdir(path.join(h3Root, "src"), { recursive: true });
await mkdir(path.join(comfyRoot, "input"), { recursive: true });
await mkdir(path.join(comfyRoot, "output"), { recursive: true });
await mkdir(logsRoot, { recursive: true });
await writeFile(path.join(h3Root, "src", "generate.py"), "setTimeout(() => { process.exitCode = 1; }, 250);\n", "utf8");
await writeFile(path.join(comfyRoot, "input", "legacy-reference.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

const environmentKeys = [
  "MINIMAX_H3_SINGLE_VIDEO_DATA_ROOT",
  "MINIMAX_H3_TEST_ENABLE_SINGLE_VIDEO_RECOVERY",
  "MINIMAX_H3_SINGLE_VIDEO_AUTO_RESUME",
  "MINIMAX_H3_SINGLE_VIDEO_OWNER_ID",
  "MINIMAX_H3_ROOT",
  "COMFYUI_ROOT",
  "MINIMAX_H3_LOGS_ROOT",
  "MINIMAX_H3_PYTHON",
  "LOCAL_COMFY_URL",
];
const previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
process.env.MINIMAX_H3_SINGLE_VIDEO_DATA_ROOT = dataRoot;
process.env.MINIMAX_H3_TEST_ENABLE_SINGLE_VIDEO_RECOVERY = "1";
process.env.MINIMAX_H3_SINGLE_VIDEO_AUTO_RESUME = "0";
process.env.MINIMAX_H3_SINGLE_VIDEO_OWNER_ID = "bridge-test-owner";
process.env.MINIMAX_H3_ROOT = h3Root;
process.env.COMFYUI_ROOT = comfyRoot;
process.env.MINIMAX_H3_LOGS_ROOT = logsRoot;
process.env.MINIMAX_H3_PYTHON = process.execPath;
process.env.LOCAL_COMFY_URL = comfyUrl;

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
  mode: "i2v",
  inputImageName: "legacy-reference.png",
  id: "sv-failed-api",
  status: "failed",
  stage: "failed",
  progress: 48,
  error: "generator failed",
  exitCode: 1,
  attempt: 1,
  provenance: {
    request: {
      ...request,
      mode: "i2v",
      inputImageName: "legacy-reference.png",
      referenceImageName: "legacy-reference.png",
      referenceImageNames: ["legacy-reference.png"],
      referenceImageRoots: ["input"],
      inputRefs: { referenceImage: "legacy-reference.png", referenceImages: ["legacy-reference.png"] },
    },
    attempt: 1,
  },
});
await store.create({
  ...request,
  id: "sv-active-prompt-api",
  status: "failed",
  stage: "failed",
  progress: 31,
  promptId: activePromptId,
  attempt: 1,
  provenance: { request, attempt: 1 },
});

const bridge = await import(`../local-bridge.mjs?single-video-persistence=${randomUUID()}`);

after(async () => {
  await new Promise((resolve) => comfyServer.close(resolve));
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
  const failedUpdatedAt = (await store.read("sv-failed-api")).updatedAt;
  const response = await invoke(getRequest("/api/jobs"));
  assert.equal(response.status, 200);
  const jobs = response.body.jobs;
  assert.deepEqual(new Set(jobs.map((job) => job.id)), new Set(["sv-completed-api", "sv-queued-api", "sv-running-api", "sv-failed-api", "sv-active-prompt-api"]));
  assert.equal(jobs.find((job) => job.id === "sv-completed-api").status, "completed");
  assert.equal(jobs.find((job) => job.id === "sv-queued-api").status, "queued");
  const interrupted = jobs.find((job) => job.id === "sv-running-api");
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.recoverable, true);
  assert.equal(interrupted.recovery.reason, "bridge_restart");
  assert.equal((await invoke(getRequest("/api/jobs/sv-completed-api"))).body.output.name, "done.mp4");
  assert.equal((await invoke(getRequest("/api/jobs/sv-running-api"))).body.status, "interrupted");
  assert.equal((await store.read("sv-failed-api")).updatedAt, failedUpdatedAt, "reading an already canonical terminal record must not rewrite its history time");
});

test("a recovered running Comfy prompt can be cancelled after a bridge restart", async () => {
  promptActive = true;
  const response = await invoke(postRequest("/api/jobs/sv-active-prompt-api/retry"));
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.code, "SINGLE_VIDEO_PROMPT_STILL_ACTIVE");
  assert.equal((await store.read("sv-active-prompt-api")).status, "running");

  const cancelledResponse = await invoke(postRequest("/api/jobs/sv-active-prompt-api/cancel"));
  assert.equal(cancelledResponse.status, 200, JSON.stringify(cancelledResponse.body));
  assert.equal(cancelledResponse.body.job.status, "cancelled");
  assert.equal(promptActive, false);
  assert.deepEqual(comfyCancelRequests, [`/api/jobs/${activePromptId}/cancel`]);

  const finished = await waitFor(async () => {
    const job = await store.read("sv-active-prompt-api");
    return job?.status === "cancelled" ? job : null;
  }, 4000);
  assert.equal(finished.status, "cancelled");
  assert.equal(finished.recovery.reason, "recovered_comfy_prompt_cancelled");
});

test("an unconfirmed targeted cancel falls back to queue deletion and interrupt", async () => {
  targetedCancelStopsPrompt = false;
  promptActive = true;
  comfyCancelRequests.length = 0;
  await store.update("sv-active-prompt-api", {
    status: "running",
    stage: "Reattached to the running ComfyUI prompt",
    recoverable: false,
    finishedAt: null,
  });

  const response = await invoke(postRequest("/api/jobs/sv-active-prompt-api/cancel"));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.job.status, "cancelling");
  assert.deepEqual(comfyCancelRequests, [
    `/api/jobs/${activePromptId}/cancel`,
    "/queue",
    "/interrupt",
  ]);

  const finished = await waitFor(async () => {
    const job = await store.read("sv-active-prompt-api");
    return job?.status === "cancelled" ? job : null;
  }, 4000);
  assert.equal(finished.status, "cancelled");
  targetedCancelStopsPrompt = true;
});

test("completed video jobs can create an edited retry attempt", async () => {
  const response = await invoke(postRequest("/api/jobs/sv-completed-api/retry", {
    prompt: `${request.prompt}\n\nintegrated_multimodal_description: [Retry] Use a new camera angle.`,
    seed: 99,
    outputName: "completed-retry.mp4",
  }));
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.job.retryOf, "sv-completed-api");
  assert.equal(response.body.job.attempt, 2);
  assert.equal(response.body.job.seed, 99);
  assert.equal(response.body.job.outputName, "completed-retry.mp4");

  const cancelled = await invoke(postRequest(`/api/jobs/${encodeURIComponent(response.body.job.id)}/cancel`));
  assert.equal(cancelled.status, 200);
  const finished = await waitFor(async () => {
    const job = await store.read(response.body.job.id);
    return job?.status === "cancelled" ? job : null;
  });
  assert.equal(finished.retryOf, "sv-completed-api");
  assert.equal((await store.read("sv-completed-api")).status, "completed");
});

test("retry creates a new attempt with edited prompt and render parameters", async () => {
  const retryDimensions = calculateAspectRatioDimensions("9:16", 704, "width");
  const edited = {
    prompt: `${request.prompt}\n\nintegrated_multimodal_description: [Retry] Keep the same subject, use a shorter test shot.`,
    negativePrompt: "edited negative prompt",
    modelProfile: "nvfp4_blackwell",
    width: retryDimensions.width,
    height: retryDimensions.height,
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
  assert.equal(retried.provenance.request.inputImageName, "legacy-reference.png");
  assert.equal(Object.hasOwn(retried.provenance.request, "referenceImageNames"), false);
  assert.equal(Object.hasOwn(retried.provenance.request, "referenceImageName"), false);
  assert.equal(retried.provenance.request.inputRefs.inputImage, "legacy-reference.png");
  assert.deepEqual(retried.provenance.request.inputRefs.referenceImages, []);
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
