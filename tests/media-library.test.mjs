import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applyAssetLimit, mapWithConcurrency, summarizeMediaFolders, walkMedia } from "../local-bridge.mjs";
import { createAssetLibraryCache } from "../server/media/asset-library-cache.mjs";

test("asset library keeps every asset when no finite limit is requested", () => {
  const assets = Array.from({ length: 101 }, (_, index) => ({ name: `nested/asset-${index}.png` }));
  assert.equal(applyAssetLimit(assets).length, 101);
  assert.equal(applyAssetLimit(assets, Infinity).length, 101);
  assert.equal(applyAssetLimit(assets, 100).length, 100);
});

test("bounded asset metadata work preserves order without exceeding its concurrency", async () => {
  let active = 0;
  let maximum = 0;
  const values = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 3, async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(values, [2, 4, 6, 8, 10, 12]);
  assert.equal(maximum, 3);
});

test("asset library cache reuses and coalesces scans until a file change invalidates the root", async () => {
  let loads = 0;
  let notifyChange = null;
  const cache = createAssetLibraryCache({
    async loadRoot(rootName) {
      loads += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { rootName, loads };
    },
    watchRoot(_rootName, invalidate) {
      notifyChange = invalidate;
      return { close() {}, on() {} };
    },
  });
  try {
    const [first, concurrent] = await Promise.all([cache.get("input"), cache.get("input")]);
    assert.strictEqual(first, concurrent);
    assert.equal(loads, 1);
    assert.strictEqual(await cache.get("input"), first);
    notifyChange();
    const refreshed = await cache.get("input");
    assert.equal(loads, 2);
    assert.notStrictEqual(refreshed, first);
  } finally {
    cache.close();
  }
});

test("summarizeMediaFolders preserves empty folders and nested media counts", () => {
  const summary = summarizeMediaFolders(
    "input",
    [{ relativeName: "empty" }, { relativeName: "shots" }, { relativeName: "shots/deep" }],
    [{ relativeName: "shots/clip.mp4" }, { relativeName: "shots/deep/frame.png" }],
  );
  assert.deepEqual(summary, [
    { root: "input", path: "empty", count: 0, imageCount: 0, videoCount: 0 },
    { root: "input", path: "shots", count: 2, imageCount: 1, videoCount: 1 },
    { root: "input", path: "shots/deep", count: 1, imageCount: 1, videoCount: 0 },
  ]);
});

test("walkMedia returns direct and nested media folders, including empty directories", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "h3-media-library-"));
  const outside = path.join(path.dirname(root), "h3-media-library-outside.png");
  try {
    await fs.mkdir(path.join(root, "empty", "nested"), { recursive: true });
    await fs.mkdir(path.join(root, "shots", "deep"), { recursive: true });
    await fs.writeFile(path.join(root, "shots", "clip.mp4"), "video");
    await fs.writeFile(path.join(root, "shots", "deep", "frame.png"), "image");
    await fs.writeFile(path.join(root, "shots", "notes.txt"), "not media");

    const tree = await walkMedia(root);
    assert.deepEqual(
      tree.files.map(({ relativeName }) => relativeName).sort(),
      ["shots/clip.mp4", "shots/deep/frame.png"],
    );
    assert.deepEqual(
      tree.folders.map(({ relativeName }) => relativeName).sort(),
      ["empty", "empty/nested", "shots", "shots/deep"],
    );

    await fs.writeFile(outside, "outside");
    try {
      await fs.symlink(outside, path.join(root, "outside.png"), "file");
    } catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
        t.diagnostic("symlink creation unavailable; regular tree assertions still passed");
        return;
      }
      throw error;
    }
    const treeWithLink = await walkMedia(root);
    assert.equal(treeWithLink.files.some(({ relativeName }) => relativeName === "outside.png"), false);
    assert.equal(await fs.readFile(outside, "utf8"), "outside");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { force: true });
  }
});
