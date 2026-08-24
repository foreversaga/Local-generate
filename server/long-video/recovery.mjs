import { appendEvent, listJobs, saveJob } from "./store.mjs";
import { SEQUENCE_CHECKPOINTS } from "./schema.mjs";

const ACTIVE_PARENT_STATES = new Set(["running", "queued", "assembling", "paused", "planning", "recovering"]);

function childStatus(child) {
  const status = String(child?.status || "").toLowerCase();
  if (["queued", "pending", "starting", "running", "recovering", "cancelling"].includes(status)) return "running";
  if (status === "completed" || status === "succeeded" || status === "success") return "completed";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  if (["failed", "error", "interrupted"].includes(status)) return "error";
  return status ? "unknown" : "missing";
}

function bindingFor(job, segment, index) {
  const active = job?.activeAttempt && typeof job.activeAttempt === "object" ? job.activeAttempt : {};
  const source = (segment?.attemptId || segment?.childJobId || index === Number(job?.activeSegmentIndex))
    ? { ...active, ...segment }
    : segment;
  if (!source?.attemptId && !source?.childJobId) return null;
  return {
    sequenceId: String(source.sequenceId || job?.id || ""),
    segmentId: String(source.segmentId || segment?.id || ""),
    segmentIndex: Number(source.segmentIndex ?? index),
    attempt: Number(source.attempt || segment?.attempt || 0),
    attemptId: String(source.attemptId || ""),
    childJobId: String(source.childJobId || source.generationJobId || ""),
  };
}

export function reconcileSequenceState(
  job,
  { child = null, artifact = null, comfyAvailable = true, ambiguous = false } = {},
) {
  const index = Number.isInteger(Number(job?.activeSegmentIndex)) ? Number(job.activeSegmentIndex) : -1;
  const segment = index >= 0 ? job?.segments?.[index] : null;
  const binding = segment ? bindingFor(job, segment, index) : job?.activeAttempt ? bindingFor(job, {}, index) : null;
  const status = childStatus(child);
  const retryCheckpoint = job?.status === "interrupted" && job?.recovery?.action === "retry";
  if (!ACTIVE_PARENT_STATES.has(String(job?.status || "")) && !binding && !retryCheckpoint) return { action: "noop", job, reason: "terminal_or_idle" };
  if (!binding && (
    job?.status === "queued"
    || job?.status === "assembling" && job?.segments?.every((item) => item.status === "completed")
    || retryCheckpoint
  )) {
    return { action: "restart", status: "recovering", reason: "safe_parent_checkpoint" };
  }
  if (ambiguous || !comfyAvailable) {
    return { action: "operator", status: "recovery_needs_operator", reason: ambiguous ? "ambiguous_child_binding" : "comfy_unavailable", binding };
  }
  if (!binding?.attemptId || !binding.sequenceId || !binding.segmentId) {
    return { action: "operator", status: "recovery_needs_operator", reason: "missing_attempt_binding", binding };
  }
  if (!binding.childJobId) return { action: "operator", status: "recovery_needs_operator", reason: "submission_window_without_child", binding };
  if (status === "running") return { action: "attach", status: "recovering", reason: "child_still_running", binding, child };
  if (status === "completed") {
    if (!artifact?.exists) return { action: "operator", status: "recovery_needs_operator", reason: "completed_child_artifact_missing", binding, child };
    return {
      action: "continue",
      status: "recovering",
      reason: "child_completed",
      binding,
      child,
      artifact,
      checkpoint: SEQUENCE_CHECKPOINTS.indexOf(segment?.checkpoint) >= SEQUENCE_CHECKPOINTS.indexOf("raw_verified")
        ? segment.checkpoint
        : "raw_verified",
    };
  }
  if (status === "cancelled") return { action: "retry", status: "interrupted", reason: "child_cancelled", binding, child };
  if (status === "error") return { action: "retry", status: "interrupted", reason: "child_failed", binding, child };
  return { action: "operator", status: "recovery_needs_operator", reason: "child_missing_or_unknown", binding, child };
}

function activeSequence(job) {
  return ACTIVE_PARENT_STATES.has(String(job?.status || ""));
}

export async function recoverInterruptedJobs({
  jobs = null,
  isProcessAlive = () => false,
  inspectChild = null,
  verifyArtifact = null,
  comfyAvailable = true,
  ownerId = `h3-studio-${process.pid}`,
  claimLease = null,
  releaseLease = null,
} = {}) {
  const items = jobs || await listJobs();
  const recovered = [];
  for (const job of items) {
    if (!activeSequence(job)) continue;
    if (!claimLease && job.processId && isProcessAlive(job.processId)) continue;
    let lease = null;
    if (claimLease) {
      try {
        lease = await claimLease(job.id, ownerId);
      } catch (error) {
        if (error?.code === "SEQUENCE_LEASE_HELD") continue;
        throw error;
      }
    }
    const index = Number.isInteger(Number(job.activeSegmentIndex)) ? Number(job.activeSegmentIndex) : -1;
    const segment = index >= 0 ? job.segments?.[index] : null;
    const binding = segment ? bindingFor(job, segment, index) : job.activeAttempt ? bindingFor(job, {}, index) : null;
    let child = null;
    let ambiguous = Boolean(job.recovery?.ambiguous);
    if (inspectChild && binding) {
      try {
        child = await inspectChild(binding, job);
      } catch (error) {
        if (error?.code === "CHILD_BINDING_AMBIGUOUS") ambiguous = true;
        else child = null;
      }
    }
    const resolvedBinding = child?.id && !binding?.childJobId ? { ...binding, childJobId: child.id } : binding;
    const artifact = verifyArtifact && resolvedBinding ? await verifyArtifact(resolvedBinding, job, child).catch(() => null) : null;
    const result = reconcileSequenceState({
      ...job,
      ...(resolvedBinding ? { activeAttempt: resolvedBinding } : {}),
    }, { child, artifact, comfyAvailable, ambiguous });
    if (result.action === "noop") continue;
    const nextSegments = Array.isArray(job.segments) ? job.segments.map((item, itemIndex) => {
      if (itemIndex !== index) return item;
      if (result.action === "restart") return item;
      if (result.action === "continue") return { ...item, status: "generated", checkpoint: result.checkpoint || "raw_verified", recoverable: true, rawAsset: artifact?.asset || item.rawAsset, error: null };
      if (result.action === "attach") return { ...item, status: "rendering", checkpoint: "child_running", recoverable: true, error: null };
      if (result.action === "retry") return { ...item, status: "failed", recoverable: true, attemptId: null, childJobId: null, childJobProvenance: null, checkpoint: "pending", error: { code: "CHILD_RECOVERABLE", message: `Child generation ${result.reason} after restart.` } };
      return { ...item, status: "failed", recoverable: true, error: { code: "RECOVERY_NEEDS_OPERATOR", message: `Recovery stopped: ${result.reason}.` } };
    }) : job.segments;
    const from = job.status;
    const next = await saveJob({
      ...job,
      status: result.status,
      executionPhase: ["attach", "continue", "restart"].includes(result.action)
        ? "recovering"
        : result.action === "retry" ? "interrupted" : "recovery_needs_operator",
      recoverable: true,
      recovery: {
        reason: result.reason,
        action: result.action,
        recoveredBy: ownerId,
        recoveredAt: new Date().toISOString(),
        ...(result.binding ? { binding: result.binding } : {}),
      },
      error: result.action === "operator" ? { code: "RECOVERY_NEEDS_OPERATOR", message: `Recovery stopped: ${result.reason}.` } : null,
      segments: nextSegments,
      timeline: nextSegments,
      generationJobId: result.action === "retry" ? null : job.generationJobId,
      activeAttempt: ["attach", "continue"].includes(result.action) && result.binding
        ? { ...result.binding, checkpoint: result.checkpoint || nextSegments[index]?.checkpoint || "child_running" }
        : result.action === "retry" ? null : job.activeAttempt,
    }, { expectedRevision: job.revision });
    await appendEvent(job.id, {
      level: result.action === "operator" ? "error" : "warn",
      event: result.action === "operator" ? "recovery.needs_operator" : "recovery.reconciled",
      from,
      to: next.status,
      recoveryAction: result.action,
      recoveryReason: result.reason,
      ...(result.binding ? { attemptId: result.binding.attemptId, childJobId: result.binding.childJobId, segmentIndex: result.binding.segmentIndex } : {}),
    });
    recovered.push(next);
    if (!["attach", "continue", "restart"].includes(result.action) && lease && releaseLease) {
      await releaseLease(job.id, lease).catch(() => {});
    }
  }
  return recovered;
}

export const recoverOnStartup = recoverInterruptedJobs;
export { childStatus };
