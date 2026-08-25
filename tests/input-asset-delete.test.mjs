import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalInputAssetName, deleteInputAsset, deleteMediaAsset, deleteMediaFolder, withAssetLifecycleLock } from "../local-bridge.mjs";

async function tempInputRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "h3-input-delete-"));
  await fs.mkdir(path.join(root, "nested"), { recursive: true });
  return root;
}

const noActiveUse = async () => null;

test("canonicalizes only safe relative asset names", () => {
  assert.equal(canonicalInputAssetName("nested\\frame.png"), "nested/frame.png");
  for (const value of ["", "../frame.png", "nested/../frame.png", "/tmp/frame.png", "C:\\tmp\\frame.png", "\\\\server\\share\\frame.png", "nested/\0frame.png", "nested/\u007fframe.png", "nested/file:stream.mp4", "nested//frame.png", "nested/./frame.png"]) {
    assert.throws(() => canonicalInputAssetName(value), { code: "ASSET_PATH_INVALID" });
  }
});

test("deletes one nested regular image/video and preserves the sibling", async () => {
  const root = await tempInputRoot();
  await fs.writeFile(path.join(root, "nested", "frame.png"), "image");
  await fs.writeFile(path.join(root, "nested", "clip.mp4"), "video");
  await fs.writeFile(path.join(root, "nested", "keep.jpg"), "keep");
  const image = await deleteInputAsset("nested/frame.png", { inputRoot: root, activeCheck: noActiveUse });
  const video = await deleteInputAsset("nested/clip.mp4", { inputRoot: root, activeCheck: noActiveUse });
  assert.deepEqual(image, { name: "nested/frame.png", root: "input", kind: "image", deletedCount: 1 });
  assert.deepEqual(video, { name: "nested/clip.mp4", root: "input", kind: "video", deletedCount: 1 });
  await assert.rejects(() => fs.stat(path.join(root, "nested", "frame.png")), { code: "ENOENT" });
  await assert.rejects(() => fs.stat(path.join(root, "nested", "clip.mp4")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(root, "nested", "keep.jpg"), "utf8"), "keep");
});

test("rejects unsupported and missing input assets", async () => {
  const root = await tempInputRoot();
  await fs.writeFile(path.join(root, "notes.txt"), "keep");
  await assert.rejects(() => deleteInputAsset("notes.txt", { inputRoot: root, activeCheck: noActiveUse }), { code: "ASSET_KIND_INVALID", status: 415 });
  await assert.rejects(() => deleteInputAsset("missing.mp4", { inputRoot: root, activeCheck: noActiveUse }), { code: "ASSET_NOT_FOUND", status: 404 });
  assert.equal(await fs.readFile(path.join(root, "notes.txt"), "utf8"), "keep");
});

test("rejects directories and symlink/reparse candidates without touching targets", async (t) => {
  const root = await tempInputRoot();
  await fs.mkdir(path.join(root, "nested", "folder.mp4"));
  await assert.rejects(() => deleteInputAsset("nested/folder.mp4", { inputRoot: root, activeCheck: noActiveUse }), { code: "ASSET_NOT_REGULAR", status: 409 });

  const outside = path.join(path.dirname(root), "h3-input-delete-outside.mp4");
  const link = path.join(root, "nested", "link.mp4");
  await fs.writeFile(outside, "outside");
  try {
    await fs.symlink(outside, link, "file");
  } catch (error) {
    await fs.unlink(outside).catch(() => {});
    if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
      t.skip("symlink creation is unavailable in this Windows environment");
      return;
    }
    throw error;
  }
  await assert.rejects(() => deleteInputAsset("nested/link.mp4", { inputRoot: root, activeCheck: noActiveUse }), { code: "ASSET_NOT_REGULAR", status: 409 });
  assert.equal(await fs.readFile(outside, "utf8"), "outside");
  await fs.unlink(link).catch(() => {});
  await fs.unlink(outside).catch(() => {});
});

test("blocks active references before unlink and leaves the file intact", async () => {
  const root = await tempInputRoot();
  const file = path.join(root, "clip.mp4");
  await fs.writeFile(file, "active");
  await assert.rejects(
    () => deleteInputAsset("clip.mp4", {
      inputRoot: root,
      activeCheck: async () => ({ blocked: true, code: "ASSET_IN_USE" }),
    }),
    { code: "ASSET_IN_USE", status: 409 },
  );
  assert.equal(await fs.readFile(file, "utf8"), "active");
});

test("applies the same safe deletion contract to output assets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "h3-output-delete-"));
  await fs.mkdir(path.join(root, "nested"), { recursive: true });
  await fs.writeFile(path.join(root, "nested", "render.mp4"), "video");
  const outputDelete = (name, options = {}) => deleteMediaAsset("output", name, { rootPath: root, activeCheck: noActiveUse, ...options });
  const deleted = await outputDelete("nested/render.mp4");
  assert.deepEqual(deleted, { name: "nested/render.mp4", root: "output", kind: "video", deletedCount: 1 });
  await assert.rejects(() => outputDelete("nested/render.mp4"), { code: "ASSET_NOT_FOUND", status: 404 });
  await assert.rejects(() => outputDelete("nested/notes.txt"), { code: "ASSET_KIND_INVALID", status: 415 });
  await fs.writeFile(path.join(root, "nested", "active.mp4"), "active");
  await assert.rejects(() => deleteMediaAsset("output", "nested/active.mp4", {
    rootPath: root,
    activeCheck: async () => ({ blocked: true, code: "ASSET_IN_USE" }),
  }), { code: "ASSET_IN_USE", status: 409 });
  assert.equal(await fs.readFile(path.join(root, "nested", "active.mp4"), "utf8"), "active");
});

test("deletes a nested media folder recursively and reports its contents", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "h3-folder-delete-"));
  await fs.mkdir(path.join(root, "characters", "alice"), { recursive: true });
  await fs.writeFile(path.join(root, "characters", "alice", "01.png"), "image");
  await fs.writeFile(path.join(root, "characters", "alice", "02.jpg"), "image");
  await fs.writeFile(path.join(root, "characters", "clip.mp4"), "video");
  const deleted = await deleteMediaFolder("input", "characters", { rootPath: root });
  assert.deepEqual(deleted, { name: "characters", root: "input", kind: "folder", deletedCount: 3, deletedFolderCount: 2 });
  await assert.rejects(() => fs.stat(path.join(root, "characters")), { code: "ENOENT" });
});

test("deletes an empty media folder", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "h3-empty-folder-delete-"));
  await fs.mkdir(path.join(root, "empty"), { recursive: true });
  const deleted = await deleteMediaFolder("input", "empty", { rootPath: root });
  assert.deepEqual(deleted, { name: "empty", root: "input", kind: "folder", deletedCount: 0, deletedFolderCount: 1 });
  await assert.rejects(() => fs.stat(path.join(root, "empty")), { code: "ENOENT" });
});

test("deletes an owned long-video output folder with its sequence manifest", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "h3-folder-delete-sequence-"));
  const folder = path.join(root, "sequence-output");
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, "final.mp4"), "video");
  await fs.writeFile(path.join(folder, ".h3-sequence.json"), JSON.stringify({
    id: "seq-owned-output",
    outputFolder: "sequence-output",
    outputAllocated: true,
  }));
  const deleted = await deleteMediaFolder("output", "sequence-output", { rootPath: root, activeCheck: noActiveUse });
  assert.deepEqual(deleted, { name: "sequence-output", root: "output", kind: "folder", deletedCount: 1, deletedFolderCount: 1 });
  await assert.rejects(() => fs.stat(folder), { code: "ENOENT" });
});

test("rejects invalid or misplaced sequence manifests before deleting media", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "h3-folder-delete-invalid-sequence-"));
  const outputFolder = path.join(root, "output-folder");
  await fs.mkdir(outputFolder, { recursive: true });
  await fs.writeFile(path.join(outputFolder, "final.mp4"), "video");
  await fs.writeFile(path.join(outputFolder, ".h3-sequence.json"), JSON.stringify({
    id: "seq-other-output",
    outputFolder: "different-folder",
    outputAllocated: true,
  }));
  await assert.rejects(
    () => deleteMediaFolder("output", "output-folder", { rootPath: root, activeCheck: noActiveUse }),
    { code: "ASSET_FOLDER_MANIFEST_INVALID", status: 409 },
  );
  assert.equal(await fs.readFile(path.join(outputFolder, "final.mp4"), "utf8"), "video");

  const inputFolder = path.join(root, "input-folder");
  await fs.mkdir(inputFolder, { recursive: true });
  await fs.writeFile(path.join(inputFolder, "frame.png"), "image");
  await fs.writeFile(path.join(inputFolder, ".h3-sequence.json"), JSON.stringify({
    id: "seq-input-folder",
    outputFolder: "input-folder",
    outputAllocated: true,
  }));
  await assert.rejects(
    () => deleteMediaFolder("input", "input-folder", { rootPath: root, activeCheck: noActiveUse }),
    { code: "ASSET_FOLDER_UNSUPPORTED_CONTENT", status: 409 },
  );
  assert.equal(await fs.readFile(path.join(inputFolder, "frame.png"), "utf8"), "image");
});

test("rejects unrelated hidden files and active marker-only output folders without partial deletion", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "h3-folder-delete-hidden-"));
  const hiddenFolder = path.join(root, "hidden-output");
  await fs.mkdir(hiddenFolder, { recursive: true });
  await fs.writeFile(path.join(hiddenFolder, "final.mp4"), "video");
  await fs.writeFile(path.join(hiddenFolder, ".keep"), "keep");
  await assert.rejects(
    () => deleteMediaFolder("output", "hidden-output", { rootPath: root, activeCheck: noActiveUse }),
    { code: "ASSET_FOLDER_UNSUPPORTED_CONTENT", status: 409 },
  );
  assert.equal(await fs.readFile(path.join(hiddenFolder, "final.mp4"), "utf8"), "video");

  const activeFolder = path.join(root, "active-output");
  await fs.mkdir(activeFolder, { recursive: true });
  await fs.writeFile(path.join(activeFolder, ".h3-sequence.json"), JSON.stringify({
    id: "seq-active-output",
    outputFolder: "active-output",
    outputAllocated: true,
  }));
  await assert.rejects(
    () => deleteMediaFolder("output", "active-output", {
      rootPath: root,
      activeCheck: async () => ({ blocked: true, code: "ASSET_IN_USE" }),
    }),
    { code: "ASSET_IN_USE", status: 409 },
  );
  assert.equal(await fs.readFile(path.join(activeFolder, ".h3-sequence.json"), "utf8").then(Boolean), true);
});

test("does not allow deleting a sequence manifest as an individual asset", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "h3-folder-delete-manifest-file-"));
  await fs.writeFile(path.join(root, ".h3-sequence.json"), "{}");
  await assert.rejects(
    () => deleteMediaAsset("output", ".h3-sequence.json", { rootPath: root, activeCheck: noActiveUse }),
    { code: "ASSET_KIND_INVALID", status: 415 },
  );
  assert.equal(await fs.readFile(path.join(root, ".h3-sequence.json"), "utf8"), "{}");
});

test("refuses recursive deletion when an unsupported file is present", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "h3-folder-delete-unsupported-"));
  await fs.mkdir(path.join(root, "characters"), { recursive: true });
  await fs.writeFile(path.join(root, "characters", "01.png"), "image");
  await fs.writeFile(path.join(root, "characters", "metadata.json"), "keep");
  await assert.rejects(() => deleteMediaFolder("input", "characters", { rootPath: root }), { code: "ASSET_FOLDER_UNSUPPORTED_CONTENT", status: 409 });
  assert.equal(await fs.readFile(path.join(root, "characters", "01.png"), "utf8"), "image");
  assert.equal(await fs.readFile(path.join(root, "characters", "metadata.json"), "utf8"), "keep");
});

test("rejects output symlink candidates without touching the target", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "h3-output-link-"));
  const outside = path.join(path.dirname(root), "h3-output-delete-outside.mp4");
  const link = path.join(root, "link.mp4");
  await fs.writeFile(outside, "outside");
  try {
    await fs.symlink(outside, link, "file");
  } catch (error) {
    await fs.unlink(outside).catch(() => {});
    if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
      t.skip("symlink creation is unavailable in this Windows environment");
      return;
    }
    throw error;
  }
  await assert.rejects(() => deleteMediaAsset("output", "link.mp4", { rootPath: root, activeCheck: noActiveUse }), { code: "ASSET_NOT_REGULAR", status: 409 });
  assert.equal(await fs.readFile(outside, "utf8"), "outside");
  await fs.unlink(link).catch(() => {});
  await fs.unlink(outside).catch(() => {});
});

test("serializes asset admission and deletion operations with a FIFO lifecycle lock", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const order = [];
  const completion = withAssetLifecycleLock(async () => {
    order.push("completion-enter");
    await gate;
    order.push("completion-exit");
  });
  const deletion = withAssetLifecycleLock(async () => {
    order.push("delete");
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["completion-enter"]);
  release();
  await Promise.all([completion, deletion]);
  assert.deepEqual(order, ["completion-enter", "completion-exit", "delete"]);
});
