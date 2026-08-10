import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Tools landing exposes both tool workflows", async () => {
  const page = await readFile(new URL("../app/(studio)/tools/page.tsx", import.meta.url), "utf8");

  assert.match(page, /RouteGrid/);
  assert.match(page, /title="Video Upscale"[\s\S]*href="\/app\/tools\/upscale"/);
  assert.match(page, /title="Image to Image \/ 以圖生圖"[\s\S]*href="\/app\/tools\/image-to-image"/);
});

test("Create landing provides a discoverable Image-to-Image quick link", async () => {
  const page = await readFile(new URL("../app/components/create/CreateLanding.tsx", import.meta.url), "utf8");

  assert.match(page, /Image-to-Image/);
  assert.match(page, /href="\/app\/tools\/image-to-image"/);
  assert.match(page, /href="\/app\/tools\/upscale"/);
});
