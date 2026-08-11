import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { summarizeMediaFolders, walkMedia } from "../local-bridge.mjs";

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
