import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = new URL("../app/(studio)/tools/upscale/page.tsx", import.meta.url);
const workspace = new URL("../app/components/tools/UpscaleWorkspace.tsx", import.meta.url);
const client = new URL("../app/components/tools/upscale-client.ts", import.meta.url);

test("Upscale route mounts the real workspace instead of the migration placeholder", async () => {
  const source = await readFile(route, "utf8");
  assert.match(source, /UpscaleWorkspace/);
  assert.doesNotMatch(source, /MigrationPanel/);
});

test("Upscale workspace keeps the SeedVR2 source, readiness, polling, and retry contract", async () => {
  const [source, styles] = await Promise.all([
    readFile(workspace, "utf8"),
    readFile(new URL("../app/components/tools/UpscaleWorkspace.module.css", import.meta.url), "utf8"),
  ]);
  assert.match(source, /AssetPickerButton/);
  assert.match(source, /uploadAssets/);
  assert.match(source, /fetchUpscaleHealth/);
  assert.match(source, /fetchUpscaleJob/);
  assert.match(source, /1500/);
  assert.match(source, /Retry upscale/);
  assert.match(source, /Cancel upscale/);
  assert.match(source, /if \(!source\) \{[\s\S]*upscale-source-picker/);
  assert.match(source, /disabled=\{active \|\| Boolean\(busy\)\}/);
  assert.match(source, /id="upscale-readiness"/);
  assert.match(source, /role="progressbar"/);
  assert.match(styles, /\.textButton\{min-height:44px/);
  assert.match(styles, /\.textLink\{display:inline-flex;min-height:44px/);
});

test("Upscale client sends fixed 2x requests and exposes output media URLs", async () => {
  const source = await readFile(client, "utf8");
  assert.match(source, /\/api\/upscale\/health/);
  assert.match(source, /\/api\/upscale`/);
  assert.match(source, /sourceName: source\.name/);
  assert.match(source, /sourceRoot: source\.root/);
  assert.match(source, /scale: UPSCALE_SCALE/);
  assert.match(source, /\/api\/upscale\/jobs\/\$\{encodeURIComponent\(id\)\}/);
  assert.match(source, /\/api\/upscale\/jobs\/\$\{encodeURIComponent\(id\)\}\/cancel/);
  assert.match(source, /\/api\/upscale\/jobs\/\$\{encodeURIComponent\(id\)\}\/retry/);
  assert.match(source, /\/media\?root=/);
});
