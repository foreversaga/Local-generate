import "./test-isolation.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireSequenceLease, assertSequenceLease, readSequenceLease, releaseSequenceLease, renewSequenceLease } from "../server/long-video/lease.mjs";
import { reconcileSequenceState } from "../server/long-video/recovery.mjs";
import { createRecoveryCoordinator } from "../server/long-video/recovery-coordinator.mjs";

function boundJob(overrides = {}) {
  const segment = {
    id: "segment-001",
    index: 0,
    status: "rendering",
    attempt: 1,
    attemptId: "attempt-abc",
    childJobId: "child-abc",
    checkpoint: "child_running",
  };
  return {
    id: "seq-recovery-test",
    status: "running",
    activeSegmentIndex: 0,
    activeAttempt: {
      sequenceId: "seq-recovery-test",
      segmentId: "segment-001",
      segmentIndex: 0,
      attempt: 1,
      attemptId: "attempt-abc",
      childJobId: "child-abc",
      checkpoint: "child_running",
    },
    segments: [segment],
    ...overrides,
  };
}

test("reconciliation fails closed for every missing or ambiguous child state", () => {
  const cases = [
    [{ child: null }, "recovery_needs_operator", "child_missing_or_unknown"],
    [{ child: { status: "mystery" } }, "recovery_needs_operator", "child_missing_or_unknown"],
    [{ child: { status: "running" }, comfyAvailable: false }, "recovery_needs_operator", "comfy_unavailable"],
    [{ child: { status: "running" }, ambiguous: true }, "recovery_needs_operator", "ambiguous_child_binding"],
    [{ child: { status: "completed" }, artifact: { exists: false } }, "recovery_needs_operator", "completed_child_artifact_missing"],
  ];
  for (const [input, status, reason] of cases) {
    const result = reconcileSequenceState(boundJob(), input);
    assert.equal(result.status, status);
    assert.equal(result.reason, reason);
    assert.equal(result.action, "operator");
  }
});

test("reconciliation attaches running children and continues completed artifacts", () => {
  const running = reconcileSequenceState(boundJob(), { child: { id: "child-abc", status: "queued" } });
  assert.deepEqual({ action: running.action, status: running.status, childJobId: running.binding.childJobId }, { action: "attach", status: "recovering", childJobId: "child-abc" });
  const completed = reconcileSequenceState(boundJob(), { child: { id: "child-abc", status: "completed" }, artifact: { exists: true, path: "/tmp/clip.mp4" } });
  assert.equal(completed.action, "continue");
  assert.equal(completed.checkpoint, "raw_verified");
});

test("reconciliation restarts only durable parent checkpoints without a child", () => {
  const queued = reconcileSequenceState({ id: "seq-queued", status: "queued", segments: [] });
  assert.deepEqual({ action: queued.action, reason: queued.reason }, { action: "restart", reason: "safe_parent_checkpoint" });
  const interrupted = reconcileSequenceState({
    id: "seq-retry",
    status: "interrupted",
    recovery: { action: "retry" },
    segments: [],
  });
  assert.equal(interrupted.action, "restart");
  const unknown = reconcileSequenceState({ id: "seq-unknown", status: "running", segments: [] });
  assert.deepEqual({ action: unknown.action, reason: unknown.reason }, { action: "operator", reason: "missing_attempt_binding" });
});

test("reconciliation treats a null active segment as no active child while assembling", () => {
  const result = reconcileSequenceState({
    id: "seq-assembling",
    status: "assembling",
    activeSegmentIndex: null,
    activeAttempt: null,
    segments: [{ status: "completed" }, { status: "completed" }],
  }, { comfyAvailable: false });
  assert.deepEqual({ action: result.action, reason: result.reason }, { action: "restart", reason: "safe_parent_checkpoint" });
});

test("startup coordinator schedules every safely recovered runner before opening mutations", async () => {
  const calls = [];
  const coordinator = createRecoveryCoordinator({
    waitForSingleRecovery: async () => calls.push("single"),
    recover: async () => {
      calls.push("recover");
      return [
        { id: "seq-attach", recovery: { action: "attach" } },
        { id: "seq-restart", recovery: { action: "restart" } },
        { id: "seq-operator", recovery: { action: "operator" } },
      ];
    },
    resumeRecovered: async (job) => calls.push(`resume:${job.id}`),
  });
  await coordinator.waitForReady();
  assert.deepEqual(calls, ["single", "recover", "resume:seq-attach", "resume:seq-restart"]);
  assert.equal(coordinator.snapshot().status, "ready");
});

test("lease fencing rejects the old owner after a new epoch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-lease-test-"));
  const previous = process.env.H3_SEQUENCE_DATA_ROOT;
  process.env.H3_SEQUENCE_DATA_ROOT = path.join(root, "data");
  try {
    const first = await acquireSequenceLease("seq-recovery-test", { ownerId: "owner-a", ttlMs: 5_000 });
    await assert.rejects(() => acquireSequenceLease("seq-recovery-test", { ownerId: "owner-b", ttlMs: 5_000 }), { code: "SEQUENCE_LEASE_HELD" });
    const expired = { ...first, expiresAt: new Date(Date.now() - 1_000).toISOString() };
    await (await import("node:fs/promises")).writeFile(`${path.join(root, "data", "jobs", "seq-recovery-test", "lease.json")}`, JSON.stringify(expired), "utf8");
    const second = await acquireSequenceLease("seq-recovery-test", { ownerId: "owner-b", ttlMs: 5_000 });
    assert.equal(second.epoch, first.epoch + 1);
    await assert.rejects(() => assertSequenceLease("seq-recovery-test", first), { code: "SEQUENCE_LEASE_LOST" });
    const renewed = await renewSequenceLease("seq-recovery-test", second, { ttlMs: 5_000 });
    assert.equal(renewed.ownerId, "owner-b");
    assert.deepEqual((await readSequenceLease("seq-recovery-test")).token, renewed.token);
    assert.equal(await releaseSequenceLease("seq-recovery-test", renewed), true);
    await assert.rejects(() => readFile(path.join(root, "data", "jobs", "seq-recovery-test", "lease.json")), { code: "ENOENT" });
  } finally {
    if (previous === undefined) delete process.env.H3_SEQUENCE_DATA_ROOT;
    else process.env.H3_SEQUENCE_DATA_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});
