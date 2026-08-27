import { randomUUID } from "node:crypto";

export const GPU_WORKLOAD_TYPES = Object.freeze([
  "video-generation",
  "long-video-segment",
  "img2img",
  "seedvr2-upscale",
  "video-character",
  "lora-training",
  "ollama-vision",
]);

const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;

function coordinatorError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function timestamp(now) {
  const value = typeof now === "function" ? now() : now;
  const number = value instanceof Date ? value.valueOf() : Number(value);
  if (typeof value === "string" && !Number.isFinite(number)) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.isFinite(number) ? number : Date.now();
}

function cloneMetadata(value) {
  if (!value || typeof value !== "object") return {};
  try { return structuredClone(value); } catch { return {}; }
}

/**
 * Serialize every GPU-heavy workload in one process-wide FIFO.  The
 * coordinator owns admission and lease lifecycle; feature queues may still
 * persist their public job records, but they cannot enter their execution
 * phase without a coordinator lease.
 */
export function createGpuResourceCoordinator({
  leaseTtlMs = DEFAULT_LEASE_TTL_MS,
  now = () => Date.now(),
  idFactory = randomUUID,
  ownerId = `gpu-coordinator-${process.pid}`,
  processAlive = () => true,
  runtimeMode = () => null,
  onChange = async () => {},
} = {}) {
  const ttl = Number(leaseTtlMs);
  const normalizedTtl = Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_LEASE_TTL_MS;
  const pending = [];
  const requests = new Map();
  const requestsByJob = new Map();
  const idleWaiters = new Set();
  let active = null;
  let pumping = false;

  function removeRequest(record) {
    requests.delete(record.requestId);
    if (record.jobId && requestsByJob.get(record.jobId) === record) requestsByJob.delete(record.jobId);
  }

  function publicRecord(record, position = null) {
    if (!record) return null;
    const lease = record.lease;
    return {
      requestId: record.requestId,
      jobId: record.jobId || null,
      workloadType: record.workloadType,
      runtimeMode: record.runtimeMode,
      ownerId: record.ownerId,
      metadata: cloneMetadata(record.metadata),
      status: active === record ? "active" : record.cancelled ? "cancelled" : "queued",
      queuePosition: active === record ? 0 : position,
      enqueuedAt: record.enqueuedAt,
      ...(lease ? {
        leaseId: lease.id,
        acquiredAt: lease.acquiredAt,
        expiresAt: lease.expiresAt,
        cancelRequested: Boolean(record.cancelRequested),
      } : {}),
    };
  }

  function snapshot() {
    return {
      active: active ? publicRecord(active, 0) : null,
      queue: pending.map((record, index) => publicRecord(record, index + 1)),
      activeCount: active ? 1 : 0,
      queuedCount: pending.length,
      totalCount: pending.length + (active ? 1 : 0),
    };
  }

  function emitChange() {
    Promise.resolve().then(() => onChange(snapshot())).catch(() => {});
  }

  function resolveIdleWaiters() {
    if (active || pending.length) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  }

  function schedulePump() {
    queueMicrotask(() => { void pump(); });
  }

  async function recoverStaleLeases() {
    if (!active) return { recovered: false, reason: "none" };
    const current = timestamp(now);
    if (timestamp(active.lease.expiresAt) > current) return { recovered: false, reason: "not-expired" };
    let alive = null;
    try { alive = await processAlive(active.ownerPid); } catch { alive = null; }
    // Unknown is deliberately conservative: an expired lease is not removed
    // while the owning process might still be running.
    if (alive !== false) {
      active.staleCheck = alive === true ? "owner-alive" : "owner-unknown";
      emitChange();
      return { recovered: false, reason: active.staleCheck };
    }
    const stale = active;
    active = null;
    stale.recovered = true;
    stale.lease.recovered = true;
    stale.lease.release = () => false;
    removeRequest(stale);
    emitChange();
    resolveIdleWaiters();
    schedulePump();
    return { recovered: true, reason: "owner-exited" };
  }

  function leaseSnapshot(record) {
    return publicRecord(record, 0);
  }

  function release(record) {
    if (active !== record) return false;
    active = null;
    record.released = true;
    removeRequest(record);
    emitChange();
    resolveIdleWaiters();
    schedulePump();
    return true;
  }

  function heartbeat(record) {
    if (active !== record || record.released || record.recovered) return false;
    const current = timestamp(now);
    record.lease.expiresAt = new Date(current + normalizedTtl).toISOString();
    record.lease.heartbeatAt = new Date(current).toISOString();
    emitChange();
    return true;
  }

  function cancel(record, reason = "GPU workload cancelled.") {
    if (!record || record.cancelled || record.released || record.recovered) return false;
    record.cancelRequested = true;
    if (active === record) {
      emitChange();
      return true;
    }
    const index = pending.indexOf(record);
    if (index < 0) return false;
    pending.splice(index, 1);
    record.cancelled = true;
    removeRequest(record);
    record.rejectGrant(coordinatorError("GPU_LEASE_CANCELLED", reason));
    emitChange();
    resolveIdleWaiters();
    return true;
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      await recoverStaleLeases();
      if (active || !pending.length) return;
      const record = pending.shift();
      if (!record || record.cancelled) return;
      const current = timestamp(now);
      const acquiredAt = new Date(current).toISOString();
      const lease = {
        id: String(idFactory()),
        requestId: record.requestId,
        jobId: record.jobId || null,
        workloadType: record.workloadType,
        ownerId: record.ownerId,
        runtimeMode: record.runtimeMode,
        acquiredAt,
        expiresAt: new Date(current + normalizedTtl).toISOString(),
        release: () => release(record),
        heartbeat: () => heartbeat(record),
        cancel: (reason) => cancel(record, reason),
        snapshot: () => leaseSnapshot(record),
      };
      record.lease = lease;
      active = record;
      record.resolveGrant(lease);
      emitChange();
    } finally {
      pumping = false;
      resolveIdleWaiters();
    }
  }

  function request({
    requestId = idFactory(),
    jobId = null,
    workloadType,
    runtime,
    metadata = {},
    owner = ownerId,
    signal,
  } = {}) {
    const normalizedType = String(workloadType || "").trim();
    if (!GPU_WORKLOAD_TYPES.includes(normalizedType)) {
      throw coordinatorError("GPU_WORKLOAD_INVALID", `Unsupported GPU workload type: ${normalizedType || "(empty)"}.`);
    }
    const normalizedJobId = jobId == null ? null : String(jobId);
    if (normalizedJobId && requestsByJob.has(normalizedJobId)) {
      throw coordinatorError("GPU_WORKLOAD_DUPLICATE", `GPU workload ${normalizedJobId} is already admitted.`);
    }
    let resolveGrant;
    let rejectGrant;
    const granted = new Promise((resolve, reject) => {
      resolveGrant = resolve;
      rejectGrant = reject;
    });
    // A cancelled queued request may be cancelled by a feature queue before
    // its execution promise starts awaiting the grant.
    granted.catch(() => {});
    const record = {
      requestId: String(requestId),
      jobId: normalizedJobId,
      workloadType: normalizedType,
      runtimeMode: runtime ?? runtimeMode(),
      metadata: cloneMetadata(metadata),
      ownerId: String(owner),
      ownerPid: process.pid,
      enqueuedAt: new Date(timestamp(now)).toISOString(),
      resolveGrant,
      rejectGrant,
      lease: null,
      cancelled: false,
      cancelRequested: false,
    };
    requests.set(record.requestId, record);
    if (normalizedJobId) requestsByJob.set(normalizedJobId, record);
    pending.push(record);
    if (signal) {
      if (signal.aborted) cancel(record, "GPU workload was cancelled before admission.");
      else signal.addEventListener("abort", () => cancel(record, "GPU workload was cancelled."), { once: true });
    }
    emitChange();
    schedulePump();
    return Object.freeze({
      id: record.requestId,
      granted,
      cancel: (reason) => cancel(record, reason),
      status: () => publicRecord(record, pending.indexOf(record) + 1),
    });
  }

  function get(jobIdOrRequestId) {
    const record = requestsByJob.get(String(jobIdOrRequestId)) || requests.get(String(jobIdOrRequestId));
    return publicRecord(record, record ? pending.indexOf(record) + 1 : null);
  }

  function waitForIdle() {
    if (!active && !pending.length) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.add(resolve));
  }

  return Object.freeze({
    request,
    get,
    snapshot,
    hasWork: () => Boolean(active || pending.length),
    active: () => active ? publicRecord(active, 0) : null,
    queue: () => pending.map((record, index) => publicRecord(record, index + 1)),
    recoverStaleLeases,
    waitForIdle,
  });
}
