import { appendEvent, listJobs, saveJob } from "./store.mjs";

export async function recoverInterruptedJobs({ jobs = null, isProcessAlive = () => false } = {}) {
  const items = jobs || await listJobs();
  const recovered = [];
  for (const job of items) {
    if (!(job.status === "running" || job.status === "queued" || job.status === "assembling" || job.status === "paused" || job.status === "planning")) continue;
    if (job.processId && isProcessAlive(job.processId)) continue;
    const from = job.status;
    const segments = Array.isArray(job.segments)
      ? job.segments.map((segment) => ["queued", "rendering", "normalizing", "extracting_tail", "finalizing_prompt"].includes(segment.status)
        ? { ...segment, status: "failed", recoverable: true, error: "Interrupted by process restart." }
        : segment)
      : job.segments;
    const next = await saveJob({
      ...job,
      status: "interrupted",
      recoverable: true,
      error: { code: "RECOVERED_AFTER_RESTART", message: "Generation was interrupted by a process restart and can be retried." },
      segments,
      timeline: segments,
    }, { expectedRevision: job.revision });
    await appendEvent(job.id, { level: "warn", event: "recovery.interrupted", from, to: next.status, errorCode: "RECOVERED_AFTER_RESTART" });
    recovered.push(next);
  }
  return recovered;
}

export const recoverOnStartup = recoverInterruptedJobs;
