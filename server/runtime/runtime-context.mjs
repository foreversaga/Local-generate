const RUNTIME_MODES = new Set(["local", "remote"]);

function runtimeError(code, message, status = 409, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  if (details !== undefined) error.details = details;
  return error;
}

function normalizeTarget(mode, target) {
  if (!target || typeof target !== "object") throw new TypeError(`Runtime target ${mode} is required.`);
  const comfyUrl = String(target.comfyUrl || "").replace(/\/$/, "");
  const ollamaUrl = String(target.ollamaUrl || "").replace(/\/$/, "");
  if (!comfyUrl || !ollamaUrl) throw new TypeError(`Runtime target ${mode} must define comfyUrl and ollamaUrl.`);
  return { mode, remote: mode === "remote", comfyUrl, ollamaUrl };
}

/**
 * Own the mutable runtime state shared by HTTP routers and model adapters.
 * Callers provide probing/startup/release hooks so this module stays free of
 * process, filesystem, and service-specific dependencies.
 */
export function createRuntimeContext({ initialMode = "local", local, remote } = {}) {
  if (!RUNTIME_MODES.has(initialMode)) throw new TypeError("initialMode must be local or remote.");
  const targets = {
    local: normalizeTarget("local", local),
    remote: normalizeTarget("remote", remote),
  };
  let mode = initialMode;
  let switching = false;
  let activeOperations = 0;

  const context = {
    get mode() { return mode; },
    get isRemote() { return mode === "remote"; },
    get comfyUrl() { return targets[mode].comfyUrl; },
    get ollamaUrl() { return targets[mode].ollamaUrl; },
    get isSwitching() { return switching; },
    get activeOperations() { return activeOperations; },
    target(modeName = mode) {
      if (!RUNTIME_MODES.has(modeName)) throw runtimeError("RUNTIME_MODE_INVALID", "Runtime mode must be local or remote.", 400);
      return { ...targets[modeName] };
    },
    snapshot() {
      return {
        mode,
        switching,
        activeOperations,
        local: { ...targets.local },
        remote: { ...targets.remote },
      };
    },
    async withOperation(operation) {
      if (typeof operation !== "function") throw new TypeError("runtime operation must be a function");
      if (switching) throw runtimeError("RUNTIME_SWITCH_BUSY", "Model runtime is switching; try again shortly.");
      activeOperations += 1;
      try {
        return await operation();
      } finally {
        activeOperations = Math.max(0, activeOperations - 1);
      }
    },
    async switchMode(nextMode, {
      busyReason,
      probe,
      startServices,
      releaseGpu,
      onSwitched,
    } = {}) {
      if (!RUNTIME_MODES.has(nextMode)) throw runtimeError("RUNTIME_MODE_INVALID", "Runtime mode must be local or remote.", 400);
      if (switching) throw runtimeError("RUNTIME_SWITCH_BUSY", "A runtime switch is already in progress.");
      if (typeof probe !== "function") throw new TypeError("runtime probe hook is required");
      switching = true;
      try {
        const busy = typeof busyReason === "function" ? await busyReason() : "";
        if (busy) throw runtimeError("RUNTIME_IN_USE", `Cannot switch model runtime: ${busy}`, 409);
        const nextTarget = context.target(nextMode);
        if (nextMode === mode) return await probe(nextMode === "remote");

        let probed = await probe(nextMode === "remote");
        if ((!probed?.comfyOnline || !probed?.ollamaOnline) && typeof startServices === "function") {
          await startServices(nextMode === "remote");
          probed = await probe(nextMode === "remote");
        }
        if (!probed?.comfyOnline || !probed?.ollamaOnline) {
          throw runtimeError(
            "RUNTIME_UNAVAILABLE",
            `${nextMode === "remote" ? "Vast" : "Local"} runtime is unavailable (ComfyUI: ${probed?.comfyOnline ? "online" : "offline"}, Ollama: ${probed?.ollamaOnline ? "online" : "offline"}).`,
            503,
            probed,
          );
        }
        if (typeof releaseGpu === "function") await releaseGpu(context.target());
        mode = nextMode;
        if (typeof onSwitched === "function") await onSwitched({ ...nextTarget, ...probed });
        return probed;
      } finally {
        switching = false;
      }
    },
  };
  return context;
}

export { RUNTIME_MODES };
