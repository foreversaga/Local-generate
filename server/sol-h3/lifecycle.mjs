const closers = new Set();
let shutdownPromise = null;

export function registerSolH3Lifecycle(close) {
  if (typeof close !== "function") throw new TypeError("Sol-H3 lifecycle close callback is required.");
  closers.add(close);
  return () => closers.delete(close);
}

export async function shutdownSolH3Controllers() {
  if (shutdownPromise) return await shutdownPromise;
  shutdownPromise = (async () => {
    const callbacks = [...closers];
    closers.clear();
    const results = await Promise.allSettled(callbacks.map((close) => close()));
    const rejected = results.filter((result) => result.status === "rejected");
    if (rejected.length) {
      throw new AggregateError(rejected.map((result) => result.reason), "One or more Sol-H3 controllers failed to shut down cleanly.");
    }
  })();
  try {
    await shutdownPromise;
  } finally {
    shutdownPromise = null;
  }
}
