const installations = new WeakMap();
const VINEXT_BACKSTOP_FLAG = Symbol.for("vinext.socketErrorBackstop");

function errorRecord(reason) {
  if (reason instanceof Error) {
    return {
      name: reason.name,
      message: reason.message,
      ...(reason.code ? { code: reason.code } : {}),
      ...(reason.errno !== undefined ? { errno: reason.errno } : {}),
      ...(reason.syscall ? { syscall: reason.syscall } : {}),
      ...(reason.path ? { path: reason.path } : {}),
      ...(reason.dest ? { dest: reason.dest } : {}),
      ...(reason.stack ? { stack: reason.stack } : {}),
    };
  }
  return { name: "NonErrorRejection", message: String(reason) };
}

function writeBoundaryEvent(logger, event) {
  const line = `[process-error-boundary] ${JSON.stringify(event)}`;
  if (typeof logger?.error === "function") logger.error(line);
}

export function installProcessErrorBoundary({ processObject = process, logger = console, now = () => new Date() } = {}) {
  const existing = installations.get(processObject);
  if (existing) return existing.api;

  const state = {
    installedAt: now().toISOString(),
    unhandledRejectionCount: 0,
    uncaughtExceptionCount: 0,
    lastUnhandledRejection: null,
    lastUncaughtException: null,
  };

  const onUnhandledRejection = (reason) => {
    const event = {
      type: "unhandledRejection",
      occurredAt: now().toISOString(),
      error: errorRecord(reason),
    };
    state.unhandledRejectionCount += 1;
    state.lastUnhandledRejection = event;
    writeBoundaryEvent(logger, event);
  };

  const onUncaughtException = (error, origin) => {
    const event = {
      type: "uncaughtException",
      origin: String(origin || "uncaughtException"),
      occurredAt: now().toISOString(),
      error: errorRecord(error),
    };
    state.uncaughtExceptionCount += 1;
    state.lastUncaughtException = event;
    writeBoundaryEvent(logger, event);
  };

  const previousVinextBackstopFlag = processObject[VINEXT_BACKSTOP_FLAG];
  processObject[VINEXT_BACKSTOP_FLAG] = true;
  processObject.on("unhandledRejection", onUnhandledRejection);
  processObject.on("uncaughtException", onUncaughtException);

  const api = Object.freeze({
    snapshot() {
      return structuredClone(state);
    },
    dispose() {
      processObject.off("unhandledRejection", onUnhandledRejection);
      processObject.off("uncaughtException", onUncaughtException);
      if (previousVinextBackstopFlag === undefined) delete processObject[VINEXT_BACKSTOP_FLAG];
      else processObject[VINEXT_BACKSTOP_FLAG] = previousVinextBackstopFlag;
      installations.delete(processObject);
    },
  });
  installations.set(processObject, { api });
  return api;
}
