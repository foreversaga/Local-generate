import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createSolH3OutputValidator, validateSolH3OutputMetadata } from "../server/sol-h3/output-validation.mjs";

function validMetadata() {
  return {
    streams: [
      { codec_type: "video", codec_name: "h264", width: 1344, height: 768, nb_read_frames: "121", r_frame_rate: "24/1" },
      { codec_type: "audio", codec_name: "aac" },
    ],
    format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "5.04" },
  };
}

test("accepts the fixed MP4/AAC output contract", () => {
  const result = validateSolH3OutputMetadata(validMetadata());
  assert.deepEqual(result.video, { width: 1344, height: 768, frames: 121, fps: 24 });
  assert.equal(result.audio.codec, "aac");
});

test("rejects wrong frame count and missing AAC", () => {
  const metadata = validMetadata();
  metadata.streams[0].nb_read_frames = "120";
  metadata.streams[1].codec_name = "opus";
  assert.throws(
    () => validateSolH3OutputMetadata(metadata),
    (error) => error.code === "SOL_H3_OUTPUT_CONTRACT_FAILED"
      && error.details.failures.includes("frames")
      && error.details.failures.includes("audio_codec"),
  );
});

test("performs full decode callback and records sha256 artifact fingerprint", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-h3-output-"));
  try {
    const filePath = path.join(root, "final.mp4");
    await fs.writeFile(filePath, Buffer.from("fake validated bytes"));
    let decoded = false;
    const validator = createSolH3OutputValidator({
      probeMedia: async () => validMetadata(),
      decodeMedia: async (candidate) => { assert.equal(candidate, filePath); decoded = true; },
    });
    const result = await validator.validate(filePath, { pipelineFingerprint: "pipeline-abc" });
    assert.equal(decoded, true);
    assert.equal(result.artifact.size, 20);
    assert.match(result.artifact.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(result.artifact.pipelineFingerprint, "pipeline-abc");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
