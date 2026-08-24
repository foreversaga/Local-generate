import { recoverInterruptedJobs, reconcileSequenceState } from "./recovery.mjs";
import { getJob } from "./store.mjs";

/**
 * Startup gate for long-video mutations.  Reads remain available while the
 * coordinator inventories existing work; all mutating routes wait for the
 * single-video recovery and the parent/child reconciliation pass.
 */
export function createRecoveryCoordinator({
  ownerId = `h3-studio-${process.pid}`,
  waitForSingleRecovery = async () => {},
  inspectChild = null,
  verifyArtifact = null,
  comfyAvailable = true,
  recover = recoverInterruptedJobs,
  claimLease = null,
  releaseLease = null,
  resumeRecovered = null,
} = {}) {
  let state = { status: "idle", error: null, recovered: [] };
  let readyPromise = null;

  async function start() {
    if (!readyPromise) {
      state = { status: "recovering", error: null, recovered: [] };
      readyPromise = Promise.resolve()
        .then(() => waitForSingleRecovery())
        .then(async () => recover({
          ownerId,
          inspectChild,
          verifyArtifact,
          comfyAvailable: typeof comfyAvailable === "function" ? await comfyAvailable() : comfyAvailable,
          claimLease,
          releaseLease,
        }))
        .then(async (recovered) => {
          if (resumeRecovered) {
            for (const job of recovered) {
              if (["attach", "continue", "restart"].includes(job.recovery?.action)) await resumeRecovered(job);
            }
          }
          state = { status: "ready", error: null, recovered };
          return state;
        })
        .catch((error) => {
          state = { status: "failed", error, recovered: [] };
          throw error;
        });
    }
    return readyPromise;
  }

  async function waitForReady() {
    const result = await start();
    if (result.status !== "ready") throw state.error || new Error("Long-video recovery is not ready.");
    return result;
  }

  function snapshot() {
    return { status: state.status, error: state.error ? { code: state.error.code, message: state.error.message } : null, recovered: state.recovered.slice() };
  }

  async function reconcile(jobOrId, options = {}) {
    const job = typeof jobOrId === "string" ? await getJob(jobOrId) : jobOrId;
    if (options.child || options.artifact || options.comfyAvailable === false || options.ambiguous) {
      return reconcileSequenceState(job, options);
    }
    const index = Number.isInteger(Number(job?.activeSegmentIndex)) ? Number(job.activeSegmentIndex) : -1;
    const segment = index >= 0 ? job.segments?.[index] : null;
    const binding = job.activeAttempt || segment;
    const child = inspectChild && binding ? await inspectChild(binding, job) : null;
    const resolvedBinding = child?.id && !binding?.childJobId ? { ...binding, childJobId: child.id } : binding;
    const artifact = verifyArtifact && resolvedBinding ? await verifyArtifact(resolvedBinding, job, child) : null;
    const available = typeof comfyAvailable === "function" ? await comfyAvailable() : comfyAvailable;
    return reconcileSequenceState({ ...job, ...(resolvedBinding ? { activeAttempt: resolvedBinding } : {}) }, {
      child,
      artifact,
      comfyAvailable: available,
      ambiguous: Boolean(job.recovery?.ambiguous),
    });
  }

  return Object.freeze({ start, waitForReady, reconcile, snapshot });
}
