export function createAssetLibraryCache({ loadRoot, watchRoot = () => null } = {}) {
  if (typeof loadRoot !== "function") throw new TypeError("loadRoot must be a function.");

  const values = new Map();
  const builds = new Map();
  const revisions = new Map();
  const watchers = new Map();

  function revision(rootName) {
    return revisions.get(rootName) || 0;
  }

  function invalidate(rootName) {
    if (rootName) {
      revisions.set(rootName, revision(rootName) + 1);
      values.delete(rootName);
      return;
    }
    for (const name of new Set([...values.keys(), ...builds.keys(), ...watchers.keys()])) {
      revisions.set(name, revision(name) + 1);
    }
    values.clear();
  }

  function ensureWatcher(rootName) {
    if (watchers.has(rootName)) return;
    try {
      const watcher = watchRoot(rootName, () => invalidate(rootName));
      if (!watcher) return;
      watchers.set(rootName, watcher);
      watcher.on?.("error", () => {
        watcher.close?.();
        watchers.delete(rootName);
        invalidate(rootName);
      });
    } catch {
      // Explicit upload/delete invalidation still keeps app-owned writes fresh.
    }
  }

  async function get(rootName) {
    ensureWatcher(rootName);
    if (values.has(rootName)) return values.get(rootName);
    if (builds.has(rootName)) return await builds.get(rootName);

    const startedAtRevision = revision(rootName);
    const build = Promise.resolve(loadRoot(rootName)).then((value) => {
      if (revision(rootName) === startedAtRevision) values.set(rootName, value);
      return value;
    }).finally(() => {
      if (builds.get(rootName) === build) builds.delete(rootName);
    });
    builds.set(rootName, build);
    return await build;
  }

  function close() {
    for (const watcher of watchers.values()) watcher.close?.();
    watchers.clear();
    values.clear();
    builds.clear();
  }

  return { close, get, invalidate };
}
