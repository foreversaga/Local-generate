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
  onBackgroundError = async () => {},
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

  // Queue execution is intentionally fire-and-forget for HTTP callers.  Keep
  // every rejection observable without allowing it to become an unhandled
  // promise rejection that takes down the web process.
  const reportBackgroundError = async (error, details = {}) => {
    try {
      await onBackgroundError({ error, ...clone(details) });
    } catch {
      // Error reporting must never create a second unhandled rejection.
    }
  };

  const safeNotify = async (jobId, status, details = {}) => {
    try {
      await notify(jobId, status, details);
    } catch (error) {
      await reportBackgroundError(error, { phase: `notify:${status}`, jobId });
    }
  };

  async function initialize() {
    if (initialized) return snapshot();
    if (!initializing) initializing = (async () => {
      const loaded = await loadState();
      state = {
        pending: Array.isArray(loaded?.pending) ? clone(loaded.pending) : [],
        active: loaded?.active ? clone(loaded.active) : null,
      };
      if (state.active) {
        // Restart recovery belongs to the service, which can reconcile the
        // persisted job, scheduler order, and GPU lease together.  A queue
        // must never turn a persisted active entry into a second queued
        // attempt: that used to race the service's failed/recoverable path.
        const error = new Error('training queue requires service restart recovery before it can initialize');
        error.code = 'QUEUE_RECOVERY_REQUIRED';
        throw error;
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

  async function enqueue(jobId, payload = {}, { autoDrain = true } = {}) {
    await initialize();
    if (typeof jobId !== 'string' || !jobId) throw new TypeError('jobId is required');
    if (state.active?.jobId === jobId || state.pending.some((entry) => entry.jobId === jobId)) throw new Error('job is already queued');
    state.pending.push({ jobId, payload: clone(payload), enqueuedAt: now() });
    await persist();
    await notify(jobId, 'queued', { queuePosition: position(jobId) });
    if (autoDrain) start();
    return position(jobId);
  }

  async function cancel(jobId) {
    await initialize();
    const index = state.pending.findIndex((entry) => entry.jobId === jobId);
    if (index >= 0) {
      state.pending.splice(index, 1);
      await persist();
      // The controller's cancel API is still holding the per-job lock while
      // this notification is emitted. Mark it so the controller can queue the
      // persistence update without awaiting the same lock recursively.
      await notify(jobId, 'canceled', { queueCancel: true });
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
        let lease;
        try {
          lease = await acquireGpuLease({ ownerId, jobId: next.jobId });
        } catch (error) {
          await reportBackgroundError(error, { phase: 'acquire', jobId: next.jobId });
          break;
        }
        if (!lease) break;
        state.pending.shift();
        state.active = { ...next, ownerId, lease, startedAt: now(), cancelRequested: false };
        let outcome = 'failed';
        let failure;
        try { await persist(); }
        catch (error) {
          state.pending.unshift(next);
          state.active = null;
          try { await releaseGpuLease({ ownerId, jobId: next.jobId, lease }); }
          catch (releaseError) { await reportBackgroundError(releaseError, { phase: 'release', jobId: next.jobId }); }
          await reportBackgroundError(error, { phase: 'persist-active', jobId: next.jobId });
          break;
        }
        try {
          await notify(next.jobId, 'running');
        } catch (error) {
          failure = error;
          await reportBackgroundError(error, { phase: 'notify:running', jobId: next.jobId });
        }
        if (!failure) {
          activeAbort = new AbortController();
          const reportProgress = async (progress) => {
            const timestamp = Date.now();
            if (timestamp - lastProgressAt < progressIntervalMs) return;
            lastProgressAt = timestamp;
            await safeNotify(next.jobId, 'running', { progress });
          };
          try {
            const result = await execute(clone(next), { signal: activeAbort.signal, lease: clone(lease), reportProgress });
            outcome = state.active.cancelRequested || activeAbort.signal.aborted ? 'canceled' : (result?.status ?? 'succeeded');
            if (!['succeeded', 'failed', 'canceled'].includes(outcome)) throw new Error('execute returned an invalid terminal status');
          } catch (error) {
            outcome = activeAbort.signal.aborted ? 'canceled' : 'failed';
            failure = error;
          }
        }
        const finished = state.active;
        state.active = null;
        activeAbort = null;
        try { await persist(); }
        catch (error) { await reportBackgroundError(error, { phase: 'persist-final', jobId: next.jobId }); }
        try { await releaseGpuLease({ ownerId, jobId: next.jobId, lease: finished?.lease ?? lease }); }
        catch (error) { await reportBackgroundError(error, { phase: 'release', jobId: next.jobId }); }
        // Preserve the service's safe structured failure (exit code, signal,
        // bounded stderr tail, or a distinct artifact code).  Legacy callers
        // that throw a plain Error still receive the old string shape.
        const failureDetails = failure ? {
          error: failure?.code || failure?.details ? {
            ...(failure.code ? { code: failure.code } : {}),
            message: failure.message,
            ...(failure.retryable !== undefined ? { retryable: failure.retryable } : {}),
            ...(failure.details ? { details: failure.details } : {}),
          } : failure.message,
        } : {};
        await safeNotify(next.jobId, outcome, failureDetails);
      }
    })().finally(() => { draining = null; });
    return draining;
  }

  function start() {
    let promise;
    try { promise = drain(); }
    catch (error) {
      void reportBackgroundError(error, { phase: 'start' });
      return Promise.resolve();
    }
    void Promise.resolve(promise).catch((error) => reportBackgroundError(error, { phase: 'drain' }));
    return promise;
  }

  return Object.freeze({ initialize, enqueue, cancel, drain, start, position, snapshot });
}
