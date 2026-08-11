import { randomUUID } from 'node:crypto';

function clone(value) {
  return structuredClone(value);
}

export function createTrainingQueue({
  loadState = async () => ({ pending: [], active: null }),
  saveState,
  acquireGpuLease,
  releaseGpuLease,
  execute,
  onStateChange = async () => {},
  onRecovery = async () => {},
  now = () => new Date().toISOString(),
  ownerId = randomUUID(),
  progressIntervalMs = 500,
} = {}) {
  if (typeof saveState !== 'function' || typeof acquireGpuLease !== 'function' ||
      typeof releaseGpuLease !== 'function' || typeof execute !== 'function') {
    throw new TypeError('saveState, acquireGpuLease, releaseGpuLease, and execute callbacks are required');
  }
  let state = { pending: [], active: null };
  let initialized = false;
  let initializing = null;
  let draining = null;
  let activeAbort = null;
  let lastProgressAt = 0;

  const persist = async () => saveState(clone(state));
  const notify = async (jobId, status, details = {}) => onStateChange({ jobId, status, at: now(), ...clone(details) });

  async function initialize() {
    if (initialized) return snapshot();
    if (!initializing) initializing = (async () => {
      const loaded = await loadState();
      state = {
        pending: Array.isArray(loaded?.pending) ? clone(loaded.pending) : [],
        active: loaded?.active ? clone(loaded.active) : null,
      };
      if (state.active) {
        const interrupted = state.active;
        if (!state.pending.some((entry) => entry.jobId === interrupted.jobId)) state.pending.unshift({ jobId: interrupted.jobId, enqueuedAt: interrupted.startedAt ?? now(), recovered: true });
        state.active = null;
        await onRecovery(clone(interrupted));
        await notify(interrupted.jobId, 'queued', { recovered: true });
        await persist();
      }
      initialized = true;
    })().finally(() => { initializing = null; });
    await initializing;
    return snapshot();
  }

  function snapshot() {
    return clone({ ...state, positions: Object.fromEntries(state.pending.map((entry, index) => [entry.jobId, index + 1])) });
  }

  function position(jobId) {
    if (state.active?.jobId === jobId) return 0;
    const index = state.pending.findIndex((entry) => entry.jobId === jobId);
    return index < 0 ? null : index + 1;
  }

  async function enqueue(jobId, payload = {}) {
    await initialize();
    if (typeof jobId !== 'string' || !jobId) throw new TypeError('jobId is required');
    if (state.active?.jobId === jobId || state.pending.some((entry) => entry.jobId === jobId)) throw new Error('job is already queued');
    state.pending.push({ jobId, payload: clone(payload), enqueuedAt: now() });
    await persist();
    await notify(jobId, 'queued', { queuePosition: position(jobId) });
    void drain();
    return position(jobId);
  }

  async function cancel(jobId) {
    await initialize();
    const index = state.pending.findIndex((entry) => entry.jobId === jobId);
    if (index >= 0) {
      state.pending.splice(index, 1);
      await persist();
      await notify(jobId, 'canceled');
      return true;
    }
    if (state.active?.jobId === jobId && activeAbort) {
      state.active.cancelRequested = true;
      await persist();
      activeAbort.abort();
      return true;
    }
    return false;
  }

  async function drain() {
    await initialize();
    if (draining) return draining;
    draining = (async () => {
      while (!state.active && state.pending.length) {
        const next = state.pending[0];
        const lease = await acquireGpuLease({ ownerId, jobId: next.jobId });
        if (!lease) break;
        state.pending.shift();
        state.active = { ...next, ownerId, lease, startedAt: now(), cancelRequested: false };
        try { await persist(); }
        catch (error) {
          state.pending.unshift(next);
          state.active = null;
          await releaseGpuLease({ ownerId, jobId: next.jobId, lease });
          throw error;
        }
        await notify(next.jobId, 'running');
        activeAbort = new AbortController();
        const reportProgress = async (progress) => {
          const timestamp = Date.now();
          if (timestamp - lastProgressAt < progressIntervalMs) return;
          lastProgressAt = timestamp;
          await notify(next.jobId, 'running', { progress });
        };
        let outcome = 'failed';
        let failure;
        try {
          const result = await execute(clone(next), { signal: activeAbort.signal, lease: clone(lease), reportProgress });
          outcome = state.active.cancelRequested || activeAbort.signal.aborted ? 'canceled' : (result?.status ?? 'succeeded');
          if (!['succeeded', 'failed', 'canceled'].includes(outcome)) throw new Error('execute returned an invalid terminal status');
        } catch (error) {
          outcome = activeAbort.signal.aborted ? 'canceled' : 'failed';
          failure = error;
        } finally {
          const finished = state.active;
          state.active = null;
          activeAbort = null;
          await persist();
          try { await releaseGpuLease({ ownerId, jobId: next.jobId, lease: finished.lease }); }
          finally { await notify(next.jobId, outcome, failure ? { error: failure.message } : {}); }
        }
      }
    })().finally(() => { draining = null; });
    return draining;
  }

  return Object.freeze({ initialize, enqueue, cancel, drain, position, snapshot });
}
