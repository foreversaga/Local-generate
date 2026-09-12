import test from "node:test";
import assert from "node:assert/strict";

import {
  assertSolH3JobTransition,
  canTransitionSolH3Job,
  recoveryStateForSolH3Job,
} from "../server/sol-h3/state-machine.mjs";

test("allows the documented happy-path state sequence", () => {
  const sequence = [
    "queued",
    "waiting_gpu",
    "preparing",
    "qwen_running",
    "stage1_running",
    "upscaling",
    "adapting",
    "stage2_running",
    "validating",
    "succeeded",
  ];
  for (let index = 1; index < sequence.length; index += 1) {
    assert.equal(canTransitionSolH3Job(sequence[index - 1], sequence[index]), true);
  }
});

test("rejects transitions out of terminal states", () => {
  assert.equal(canTransitionSolH3Job("succeeded", "queued"), false);
  assert.throws(
    () => assertSolH3JobTransition("failed", "stage1_running"),
    { code: "SOL_H3_JOB_TRANSITION_INVALID", status: 409 },
  );
});

test("allows cancellation from queued and active states", () => {
  for (const state of ["queued", "waiting_gpu", "preparing", "qwen_running", "stage2_running", "validating"]) {
    assert.equal(canTransitionSolH3Job(state, "cancel_requested"), true);
  }
  assert.equal(canTransitionSolH3Job("cancel_requested", "cancelled"), true);
});

test("reloads queued work but interrupts running work after service restart", () => {
  assert.deepEqual(recoveryStateForSolH3Job("queued"), { action: "reload", status: "queued" });
  assert.deepEqual(recoveryStateForSolH3Job("waiting_gpu"), { action: "reload", status: "queued" });
  assert.deepEqual(recoveryStateForSolH3Job("stage1_running"), { action: "interrupt", status: "interrupted" });
  assert.deepEqual(recoveryStateForSolH3Job("cancel_requested"), { action: "interrupt", status: "interrupted" });
  assert.deepEqual(recoveryStateForSolH3Job("succeeded"), { action: "keep", status: "succeeded" });
});
