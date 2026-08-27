import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { cleanupVideoCharacterStaging, createVideoCharacterController } from "../server/video-character/controller.mjs";

test("video-character copies video and image assets from both input and output roots", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "video-character-assets-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));

  const mediaRoot = path.join(temporary, "media");
  const dataRoot = path.join(temporary, "data");
  const inputRoot = path.join(temporary, "input");
  const outputRoot = path.join(temporary, "output");
  const requested = [];
  for (const [root, name, contents] of [
    ["input", "clips/source-input.mp4", "input-video"],
    ["output", "clips/source.mp4", "video"],
    ["input", "people/front.png", "front"],
    ["output", "people/back.webp", "back"],
  ]) {
    const target = path.join(mediaRoot, root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }

  const controller = createVideoCharacterController({
    dataRoot,
    inputRoot,
    outputRoot,
    runtimeRoot: temporary,
    resolveMediaPath: async (root, name) => {
      requested.push({ root, name });
      return path.join(mediaRoot, root, name);
    },
    toAsset: async () => null,
    getPython: async () => null,
    runWithGpu: async () => new Promise(() => {}),
  });

  const job = await controller.create({
    mode: "replace",
    source: { root: "output", name: "clips/source.mp4" },
    references: [
      { root: "input", name: "people/front.png" },
      { root: "output", name: "people/back.webp" },
    ],
  });

  assert.deepEqual(requested, [
    { root: "output", name: "clips/source.mp4" },
    { root: "input", name: "people/front.png" },
    { root: "output", name: "people/back.webp" },
  ]);
  assert.deepEqual(job.source, { root: "output", name: "clips/source.mp4" });
  assert.deepEqual(job.references, [
    { root: "input", name: "people/front.png" },
    { root: "output", name: "people/back.webp" },
  ]);
  assert.equal(await fs.readFile(path.join(dataRoot, job.workspace.path, "source", "driving.mp4"), "utf8"), "video");
  assert.equal(await fs.readFile(path.join(dataRoot, job.workspace.path, "references", "reference-01.png"), "utf8"), "front");
  assert.equal(await fs.readFile(path.join(dataRoot, job.workspace.path, "references", "reference-02.webp"), "utf8"), "back");

  const inputVideoJob = await controller.create({
    mode: "dwpose",
    source: { root: "input", name: "clips/source-input.mp4" },
    references: [{ root: "output", name: "people/back.webp" }],
  });
  assert.deepEqual(inputVideoJob.source, { root: "input", name: "clips/source-input.mp4" });
  assert.equal(await fs.readFile(path.join(dataRoot, inputVideoJob.workspace.path, "source", "driving.mp4"), "utf8"), "input-video");
});

test("video-character cleanup removes only the job-scoped ComfyUI staging", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "video-character-staging-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const inputRoot = path.join(temporary, "input");
  const outputRoot = path.join(temporary, "output");
  const jobId = "vc-cleanup-test";

  for (const root of [inputRoot, outputRoot]) {
    await fs.mkdir(path.join(root, ".video-character-staging", jobId), { recursive: true });
    await fs.writeFile(path.join(root, ".video-character-staging", jobId, "partial.bin"), "temporary");
    await fs.mkdir(path.join(root, ".video-character-staging", "vc-other-job"), { recursive: true });
    await fs.writeFile(path.join(root, ".video-character-staging", "vc-other-job", "keep.bin"), "keep");
  }

  await cleanupVideoCharacterStaging({ inputRoot, outputRoot, id: jobId });

  for (const root of [inputRoot, outputRoot]) {
    await assert.rejects(fs.access(path.join(root, ".video-character-staging", jobId)), { code: "ENOENT" });
    assert.equal(await fs.readFile(path.join(root, ".video-character-staging", "vc-other-job", "keep.bin"), "utf8"), "keep");
  }
});

test("video-character startup marks active jobs interrupted and clears their staging", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "video-character-restart-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const dataRoot = path.join(temporary, "data");
  const inputRoot = path.join(temporary, "input");
  const outputRoot = path.join(temporary, "output");
  const jobId = "vc-restart-test";
  await fs.mkdir(path.join(dataRoot, "jobs"), { recursive: true });
  await fs.writeFile(path.join(dataRoot, "jobs", `${jobId}.json`), JSON.stringify({
    id: jobId,
    mode: "replace",
    status: "running",
    stage: "生成中",
    progress: 50,
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    source: { root: "input", name: "source.mp4" },
    references: [{ root: "input", name: "reference.png" }],
    settings: {},
    workspaceRelative: `workspaces/${jobId}`,
    workspaceExists: true,
    memory: [],
  }));
  for (const root of [inputRoot, outputRoot]) {
    await fs.mkdir(path.join(root, ".video-character-staging", jobId), { recursive: true });
    await fs.writeFile(path.join(root, ".video-character-staging", jobId, "partial.bin"), "temporary");
  }

  const controller = createVideoCharacterController({
    dataRoot,
    inputRoot,
    outputRoot,
    runtimeRoot: temporary,
    resolveMediaPath: async () => "",
    toAsset: async () => null,
    getPython: async () => null,
  });
  const jobs = await controller.list();

  assert.equal(jobs[0].status, "interrupted");
  for (const root of [inputRoot, outputRoot]) {
    await assert.rejects(fs.access(path.join(root, ".video-character-staging", jobId)), { code: "ENOENT" });
  }
});
