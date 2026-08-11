import assert from "node:assert/strict";
import test from "node:test";

import { mediaContentDisposition, publicLoraTrainingJob, resolveLoraTriggerWords } from "../local-bridge.mjs";
import { normalizeAssetIds } from "../server/lora-training/schema.mjs";

test("accepts nested training image asset keys", () => {
  assert.deepEqual(
    normalizeAssetIds(["training:characters/海灘女生/portrait.png"]),
    ["training:characters/海灘女生/portrait.png"],
  );
});

test("encodes Unicode training media basenames for HTTP headers", () => {
  const header = mediaContentDisposition("training", "海灘女生/訓練照片.png", false);
  assert.match(header, /^inline; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
  assert.match(header, /%E8%A8%93%E7%B7%B4%E7%85%A7%E7%89%87/);
  assert.ok([...header].every((character) => character.charCodeAt(0) <= 0xff));
});

test("resolves empty trigger word arrays through config and output-name fallbacks", () => {
  assert.deepEqual(
    resolveLoraTriggerWords({ triggerWords: [], config: { triggerWords: ["custom_subject"], outputName: "ignored" } }),
    ["custom_subject"],
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
      config: { family: "sdxl", outputName: "Subject", orchestration: { phase: "queued" } },
      provenance: { sourceAssets: ["training:subjects/portrait.png"] },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    dataset: { images: [], manifestPath: "C:\\private\\manifest.json" },
  });
  assert.deepEqual(publicJob.provenance.sourceAssets, ["training:subjects/portrait.png"]);
  assert.equal(publicJob.provenance.sourceAssetCount, 1);
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
