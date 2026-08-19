import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPosePreviewGraph,
  decodePosePreviewImage,
  normalizePosePreviewResolution,
} from "../server/routes/bridge-domain-routes.mjs";

test("pose preview graph uses the same DWPose contract as img2img pose control", () => {
  const graph = buildPosePreviewGraph("pose-to-image/source.png", 768);

  assert.equal(graph["1"].class_type, "LoadImage");
  assert.equal(graph["1"].inputs.image, "pose-to-image/source.png");
  assert.equal(graph["2"].class_type, "DWPreprocessor");
  assert.equal(graph["2"].inputs.detect_hand, "enable");
  assert.equal(graph["2"].inputs.detect_body, "enable");
  assert.equal(graph["2"].inputs.detect_face, "disable");
  assert.equal(graph["2"].inputs.resolution, 768);
  assert.equal(graph["2"].inputs.bbox_detector, "yolox_l.onnx");
  assert.equal(graph["2"].inputs.pose_estimator, "dw-ll_ucoco_384_bs5.torchscript.pt");
  assert.equal(graph["2"].inputs.scale_stick_for_xinsr_cn, "enable");
  assert.equal(graph["3"].class_type, "PreviewImage");
  assert.deepEqual(graph["3"].inputs.images, ["2", 0]);
});

test("pose preview input accepts supported base64 image data", () => {
  const decoded = decodePosePreviewImage("data:image/png;base64,aGVsbG8=");
  assert.equal(decoded.mime, "image/png");
  assert.equal(decoded.bytes.toString("utf8"), "hello");
});

test("pose preview rejects unsupported image data and invalid resolution", () => {
  assert.throws(
    () => decodePosePreviewImage("data:text/plain;base64,aGVsbG8="),
    (error) => error?.code === "POSE_PREVIEW_IMAGE_INVALID" && error?.status === 415,
  );
  assert.throws(
    () => normalizePosePreviewResolution(700),
    (error) => error?.code === "POSE_PREVIEW_RESOLUTION_INVALID" && error?.status === 400,
  );
  assert.equal(normalizePosePreviewResolution(undefined), 768);
});
