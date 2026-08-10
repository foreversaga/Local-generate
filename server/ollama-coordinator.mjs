import { LongVideoError } from "./long-video/schema.mjs";

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_UNLOAD_TIMEOUT_MS = 30000;
const MODEL_KEY_SEPARATOR = "\u0000";

function text(value) {
  return String(value || "").trim();
}

function targetKey({ ollamaUrl, model }) {
  return `${text(ollamaUrl).replace(/\/$/, "")}${MODEL_KEY_SEPARATOR}${text(model)}`;
}

function errorInfo(error) {
  if (!error) return null;
  return {
    code: error.code,
    message: error instanceof Error ? error.message : String(error),
    ...(Number.isInteger(error.status) ? { status: error.status } : {}),
    ...(error.details && typeof error.details === "object" ? { details: error.details } : {}),
  };
}

function asError(value, fallbackMessage) {
  if (value instanceof Error) return value;
  return new Error(value ? String(value) : fallbackMessage);
}

function parseBody(value) {
  try {
    return JSON.parse(String(value || "{}"));
  } catch {
    return null;
  }
}

function requestFailure(message, details = {}) {
  return new LongVideoError("OLLAMA_REQUEST_FAILED", message, 502, details);
}

function unloadFailure(message, details = {}) {
  return new LongVideoError("OLLAMA_UNLOAD_FAILED", message, 503, details);
}

function barrierFailure(failures) {
  return new LongVideoError(
    "OLLAMA_UNLOAD_FAILED",
    "Ollama model unload did not complete; H3 generation is blocked until cleanup succeeds.",
    503,
    { failures },
  );
}

function responseFailed(response) {
  return response?.ok === false || (Number.isInteger(response?.status) && response.status >= 400);
}

/**
 * Coordinate Ollama requests with model-scoped cleanup and an exclusive H3
 * generation barrier.  The transport is injected so prompt and planner tests
 * can use a fake fetch without importing the bridge module.
 */
export function createOllamaCoordinator({
  fetchImpl = (...args) => globalThis.fetch(...args),
  beforeRequest = null,
  unloadTimeoutMs = DEFAULT_UNLOAD_TIMEOUT_MS,
} = {}) {
  const states = new Map();
  let generationWaiters = 0;
  let generationHeld = false;
  let wakeResolve;
  let wake = new Promise((resolve) => { wakeResolve = resolve; });

  function notify() {
    const resolve = wakeResolve;
    wake = new Promise((nextResolve) => { wakeResolve = nextResolve; });
    resolve();
  }

  async function waitUntil(predicate) {
    while (!predicate()) {
      const observed = wake;
      await observed;
    }
  }

  function stateFor(target) {
    const key = targetKey(target);
    let state = states.get(key);
    if (!state) {
      state = {
        key,
        ollamaUrl: text(target.ollamaUrl).replace(/\/$/, ""),
        model: text(target.model),
        active: 0,
        unloading: null,
        failure: null,
      };
      states.set(key, state);
    }
    return state;
  }

  function hasActiveWork() {
    for (const state of states.values()) {
      if (state.active > 0 || state.unloading) return true;
    }
    return false;
  }

  function failures() {
    return [...states.values()]
      .filter((state) => state.failure)
      .map((state) => ({
        ollamaUrl: state.ollamaUrl,
        model: state.model,
        error: errorInfo(state.failure),
      }));
  }

  async function acquireModel(target) {
    const snapshot = {
      ollamaUrl: text(target.ollamaUrl).replace(/\/$/, ""),
      model: text(target.model),
      comfyUrl: text(target.comfyUrl).replace(/\/$/, ""),
      remoteComfy: Boolean(target.remoteComfy),
    };
    if (!snapshot.ollamaUrl || !snapshot.model) throw new TypeError("Ollama URL and model are required.");
    const state = stateFor(snapshot);
    for (;;) {
      await waitUntil(() => generationWaiters === 0 && !generationHeld && !state.unloading);
      // A generation waiter can be inserted while the previous wait above was
      // suspended. Re-check immediately before admitting the model lease.
      if (generationWaiters !== 0 || generationHeld || state.unloading) continue;
      state.active += 1;
      notify();
      return { state, snapshot };
    }
  }

  async function unloadState(state, requestFetch = fetchImpl) {
    const target = { ollamaUrl: state.ollamaUrl, model: state.model };
    const response = await requestFetch(`${state.ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: state.model, prompt: "", stream: false, keep_alive: 0 }),
      signal: AbortSignal.timeout(unloadTimeoutMs),
    });
    if (!response) throw unloadFailure(`Ollama unload returned no response for model ${state.model}.`, target);
    const body = typeof response?.text === "function"
      ? await response.text()
      : JSON.stringify(await response?.json?.() ?? {});
    parseBody(body);
    if (responseFailed(response)) {
      throw unloadFailure(
        `Ollama failed to unload model ${state.model} (${response.status || "unknown"}).`,
        { ...target, status: response.status, body: body.slice(-2000) },
      );
    }
  }

  async function releaseModel(lease) {
    const { state } = lease;
    state.active = Math.max(0, state.active - 1);
    if (state.active !== 0) {
      notify();
      return;
    }
    const operation = (async () => {
      try {
        await unloadState(state, lease.requestFetch);
        state.failure = null;
      } catch (error) {
        state.failure = error?.code === "OLLAMA_UNLOAD_FAILED"
          ? error
          : unloadFailure(`Unable to unload Ollama model ${state.model}: ${error instanceof Error ? error.message : String(error)}`, {
              ollamaUrl: state.ollamaUrl,
              model: state.model,
              cause: errorInfo(error),
            });
        throw state.failure;
      } finally {
        state.unloading = null;
        notify();
      }
    })();
    state.unloading = operation;
    notify();
    await operation;
  }

  async function generate({
    ollamaUrl,
    model,
    comfyUrl = "",
    remoteComfy = false,
    body = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    before = null,
    requestFetch = fetchImpl,
  } = {}) {
    const lease = await acquireModel({ ollamaUrl, model, comfyUrl, remoteComfy });
    lease.requestFetch = requestFetch;
    const requestBody = {
      ...body,
      model: lease.snapshot.model,
      stream: false,
      keep_alive: 0,
    };
    let result = null;
    let primaryError = null;
    try {
      const requestTarget = { ...lease.snapshot, requestFetch };
      if (typeof before === "function") await before(requestTarget);
      else if (typeof beforeRequest === "function") await beforeRequest(requestTarget);
      const response = await requestFetch(`${lease.snapshot.ollamaUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response) throw requestFailure("Ollama request returned no response.", { model: lease.snapshot.model, ollamaUrl: lease.snapshot.ollamaUrl });
      const bodyText = typeof response?.text === "function"
        ? await response.text()
        : JSON.stringify(await response?.json?.() ?? {});
      if (responseFailed(response)) {
        throw requestFailure(
          `Ollama request failed (${response.status || "unknown"}).`,
          { model: lease.snapshot.model, ollamaUrl: lease.snapshot.ollamaUrl, status: response.status, body: bodyText.slice(-2000) },
        );
      }
      // Parse (best effort) before entering cleanup.  Callers still receive
      // the original text when Ollama returns malformed JSON so their
      // existing validation/repair diagnostics remain intact.
      result = { text: bodyText, payload: parseBody(bodyText) };
    } catch (error) {
      primaryError = asError(error, "Ollama request failed.");
    }

    let cleanupError = null;
    try {
      await releaseModel(lease);
    } catch (error) {
      cleanupError = asError(error, `Unable to unload Ollama model ${lease.snapshot.model}.`);
    }
    if (primaryError) {
      if (cleanupError) {
        primaryError.details = {
          ...(primaryError.details && typeof primaryError.details === "object" ? primaryError.details : {}),
          unloadError: errorInfo(cleanupError),
        };
        primaryError.cause = cleanupError;
      }
      throw primaryError;
    }
    if (cleanupError) throw cleanupError;
    return result;
  }

  async function acquireGenerationBarrier() {
    generationWaiters += 1;
    notify();
    try {
      for (;;) {
        await waitUntil(() => !generationHeld && !hasActiveWork());
        // Active work or another barrier may have been admitted after the
        // predicate resolved but before this continuation resumed.
        if (generationHeld || hasActiveWork()) continue;
        const barrierFailures = failures();
        if (barrierFailures.length) throw barrierFailure(barrierFailures);
        generationHeld = true;
        generationWaiters = Math.max(0, generationWaiters - 1);
        notify();
        let released = false;
        return {
          release() {
            if (released) return;
            released = true;
            generationHeld = false;
            notify();
          },
        };
      }
    } catch (error) {
      generationWaiters = Math.max(0, generationWaiters - 1);
      notify();
      throw error;
    }
  }

  async function waitForIdle() {
    await waitUntil(() => generationWaiters === 0 && !generationHeld && !hasActiveWork());
    const barrierFailures = failures();
    if (barrierFailures.length) throw barrierFailure(barrierFailures);
  }

  return {
    generate,
    acquireGenerationBarrier,
    waitForIdle,
    snapshot() {
      return [...states.values()].map((state) => ({
        ollamaUrl: state.ollamaUrl,
        model: state.model,
        active: state.active,
        unloading: Boolean(state.unloading),
        failure: errorInfo(state.failure),
      }));
    },
  };
}
