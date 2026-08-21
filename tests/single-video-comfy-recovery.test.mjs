import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectComfyPrompt,
  inspectComfyPromptPayloads,
  timingFromHistory,
  videoArtifactFromHistory,
} from "../server/video-generation/comfy-prompt-recovery.mjs";

const PROMPT_ID = "11111111-1111-4111-8111-111111111111";

test("prompt payload inspection distinguishes active, missing, and uncorrelated queue work", () => {
  const running = [3, PROMPT_ID, {}, { client_id: "client" }];
  assert.equal(inspectComfyPromptPayloads({
    queuePayload: { queue_running: [running], queue_pending: [] },
    historyPayload: {},
    promptId: PROMPT_ID,
  }).state, "running");
  assert.equal(inspectComfyPromptPayloads({
    queuePayload: { queue_running: [], queue_pending: [] },
    historyPayload: {},
    promptId: PROMPT_ID,
  }).state, "missing");
  assert.equal(inspectComfyPromptPayloads({
    queuePayload: { queue_running: [running], queue_pending: [] },
  }).state, "uncorrelated_busy");
});

test("history timing uses ComfyUI execution timestamps and detects interruption", () => {
  const record = {
    status: {
      status_str: "error",
      completed: false,
      messages: [
        ["execution_start", { prompt_id: PROMPT_ID, timestamp: 1_000 }],
        ["execution_interrupted", { prompt_id: PROMPT_ID, timestamp: 6_250 }],
      ],
    },
    outputs: {},
  };
  assert.deepEqual(timingFromHistory(record), {
    startedAtMs: 1_000,
    finishedAtMs: 6_250,
    elapsedMs: 5_250,
  });
  const result = inspectComfyPromptPayloads({
    queuePayload: { queue_running: [], queue_pending: [] },
    historyPayload: { [PROMPT_ID]: record },
    promptId: PROMPT_ID,
  });
  assert.equal(result.state, "interrupted");
  assert.equal(result.timing.elapsedMs, 5_250);
});

test("completed history exposes the existing video artifact", () => {
  const record = {
    status: { status_str: "success", completed: true },
    outputs: {
      25: { images: [{ filename: "recovered.mp4", subfolder: "h3", type: "output" }] },
    },
  };
  assert.equal(videoArtifactFromHistory(record).filename, "recovered.mp4");
  const result = inspectComfyPromptPayloads({
    queuePayload: { queue_running: [], queue_pending: [] },
    historyPayload: { [PROMPT_ID]: record },
    promptId: PROMPT_ID,
  });
  assert.equal(result.state, "completed");
  assert.equal(result.artifact.subfolder, "h3");
});

test("network uncertainty fails closed instead of treating a prompt as missing", async () => {
  const result = await inspectComfyPrompt({
    comfyUrl: "http://127.0.0.1:8188",
    promptId: PROMPT_ID,
    fetchJson: async () => { throw new Error("offline"); },
  });
  assert.equal(result.state, "unavailable");
});
