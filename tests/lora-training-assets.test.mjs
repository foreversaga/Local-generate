import assert from "node:assert/strict";
import test from "node:test";

import { mediaContentDisposition, mergeLoraTrainingAssetLibrary, publicLoraTrainingJob, resolveLoraTriggerWords } from "../local-bridge.mjs";
import { normalizeAssetIds } from "../server/lora-training/schema.mjs";

test("accepts nested training image asset keys", () => {
  assert.deepEqual(
    normalizeAssetIds(["training:characters/海灘女生/portrait.png"]),
    ["training:characters/海灘女生/portrait.png"],
  );
});

test("merges Comfy input/output assets with nested training folders", () => {
  const asset = (root, name, modified) => ({
    root,
    name,
    kind: "image",
    mime: "image/png",
    size: 1,
    modified,
    url: `/media?root=${root}&name=${encodeURIComponent(name)}`,
  });
  const merged = mergeLoraTrainingAssetLibrary(
    {
      assets: [asset("input", "shots/source.png", "2026-01-01T00:00:00.000Z")],
      folders: [{ root: "input", path: "shots", count: 1, imageCount: 1, videoCount: 0 }],
    },
    [asset("training", "characters/hero/portrait.png", "2026-01-02T00:00:00.000Z")],
  );

  assert.deepEqual(
    merged.assets.map((item) => `${item.root}:${item.name}`),
    ["training:characters/hero/portrait.png", "input:shots/source.png"],
  );
  assert.deepEqual(
    merged.folders.filter((folder) => folder.root === "training"),
    [
      { root: "training", path: "characters", count: 1, imageCount: 1, videoCount: 0 },
      { root: "training", path: "characters/hero", count: 1, imageCount: 1, videoCount: 0 },
    ],
  );
});

test("encodes Unicode training media basenames for HTTP headers", () => {
  const header = mediaContentDisposition("training", "海灘女生/訓練照片.png", false);
  assert.match(header, /^inline; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
  assert.match(header, /%E8%A8%93%E7%B7%B4%E7%85%A7%E7%89%87/);
  assert.ok([...header].every((character) => character.charCodeAt(0) <= 0xff));
});

test("encodes Unicode input and output media basenames for HTTP headers", () => {
  for (const root of ["input", "output"]) {
    const header = mediaContentDisposition(root, "live-2d/\u6D77\u7058\u5973\u751F/\u8A13\u7DF4\u7167\u7247.png", false);
    assert.match(header, /^inline; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
    assert.match(header, /%E8%A8%93%E7%B7%B4%E7%85%A7%E7%89%87/);
    assert.ok([...header].every((character) => character.charCodeAt(0) <= 0xff));
  }
});

test("resolves empty trigger word arrays from character name before legacy output-name fallback", () => {
  assert.deepEqual(
    resolveLoraTriggerWords({ triggerWords: [], config: { triggerWords: ["custom_subject"], outputName: "ignored" } }),
    ["custom_subject"],
  );
  assert.deepEqual(
    resolveLoraTriggerWords({ triggerWords: [], config: { triggerWords: [], characterName: "character-name", outputName: "ignored" } }),
    ["character-name"],
  );
  assert.deepEqual(
    resolveLoraTriggerWords({ triggerWords: [], config: { triggerWords: [], outputName: "海灘女生 LoRA" } }),
    ["海灘女生 LoRA"],
  );
  assert.deepEqual(
    resolveLoraTriggerWords({ triggerWords: [], config: { triggerWords: [], outputName: "!!!" } }),
    ["character"],
  );
});

test("public LoRA jobs retain validated source references without exposing manifest paths", () => {
  const publicJob = publicLoraTrainingJob({
    job: {
      id: "job-1",
      revision: 2,
      slug: "subject",
      displayName: "Subject",
      status: "queued",
      family: "sdxl",
      captionReviewMode: "auto",
      triggerWords: ["subject"],
      assetIds: ["training:subjects/portrait.png"],
      config: { family: "sdxl", characterName: "Subject", outputName: "Subject", triggerWords: ["subject"], orchestration: { phase: "queued" } },
      provenance: { sourceAssets: ["training:subjects/portrait.png"] },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    dataset: { images: [], manifestPath: "C:\\private\\manifest.json" },
  });
  assert.deepEqual(publicJob.provenance.sourceAssets, ["training:subjects/portrait.png"]);
  assert.equal(publicJob.provenance.sourceAssetCount, 1);
  assert.equal(publicJob.characterName, "Subject");
  assert.equal(publicJob.config.characterName, "Subject");
  assert.deepEqual(publicJob.config.triggerWords, ["subject"]);
  assert.equal(Object.hasOwn(publicJob.dataset, "manifestPath"), false);
});

test("public LoRA jobs expose manual caption review as a distinct retry state", () => {
  const publicJob = publicLoraTrainingJob({
    job: {
      id: "job-2",
      revision: 2,
      slug: "subject-review",
      displayName: "Subject review",
      status: "ready",
      family: "sdxl",
      captionReviewMode: "manual",
      triggerWords: ["subject"],
      assetIds: [],
      config: { family: "sdxl", outputName: "Subject review", orchestration: { phase: "caption_review" } },
      provenance: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    dataset: { images: [] },
  });
  assert.equal(publicJob.status, "caption_review");
});
