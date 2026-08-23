import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("SeedVR2 UI exposes validated upscale parameters and sends them to the API", async () => {
  const [workspace, client] = await Promise.all([
    readFile(new URL("../app/components/tools/UpscaleWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/tools/upscale-client.ts", import.meta.url), "utf8"),
  ]);

  assert.match(workspace, /SeedVR2 參數/);
  assert.match(workspace, /SEEDVR2_SCALE_MIN/);
  assert.match(workspace, /SEEDVR2_SCALE_MAX/);
  assert.match(workspace, /SEEDVR2_RESIZE_METHODS/);
  assert.match(workspace, /SEEDVR2_COLOR_CORRECTIONS/);
  assert.match(workspace, /seed: parsedSeed/);
  assert.match(workspace, /setScale\(event\.target\.value\)/);
  assert.doesNotMatch(workspace, /setScale\(Number\(event\.target\.value\)\)/);
  assert.match(workspace, /resizeMethod/);
  assert.match(workspace, /colorCorrection/);
  assert.match(client, /profile, \.\.\.parameters/);
  assert.match(client, /scale: UPSCALE_SCALE/);
});
