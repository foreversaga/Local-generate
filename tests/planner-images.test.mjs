import assert from "node:assert/strict";
import test from "node:test";
import { normalizePlannerImages } from "../local-bridge.mjs";

const imageData = Buffer.from("bounded-image-bytes").toString("base64");

test("normalizes planner image data URLs to bounded pure base64", () => {
  assert.deepEqual(
    normalizePlannerImages([
      { role: "picture_1", data: `data:image/jpeg;base64,${imageData}` },
    ], { inputType: "image" }),
    [{ role: "picture_1", data: imageData }],
  );
});

test("text planning drops stale planner image payloads", () => {
  assert.deepEqual(
    normalizePlannerImages([{ role: "picture_1", data: `data:image/jpeg;base64,${imageData}` }], { inputType: "text" }),
    [],
  );
});

test("rejects malformed or oversized planner image payloads", () => {
  assert.throws(
    () => normalizePlannerImages([{ data: "not base64?" }], { inputType: "image" }),
    { code: "PLANNER_IMAGE_INVALID" },
  );
  assert.throws(
    () => normalizePlannerImages(Array.from({ length: 9 }, () => ({ data: imageData })), { referenceMode: "multi_reference" }),
    { code: "PLANNER_IMAGES_LIMIT" },
  );
});
