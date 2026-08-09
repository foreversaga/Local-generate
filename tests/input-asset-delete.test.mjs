import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalInputAssetName, deleteInputAsset, deleteMediaAsset, withAssetLifecycleLock } from "../local-bridge.mjs";

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
