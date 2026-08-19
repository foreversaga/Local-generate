import assert from "node:assert/strict";
import test from "node:test";

const baseUrl = String(process.env.H3_STUDIO_BASE_URL || "").replace(/\/$/, "");
const routes = [
  ["/app", "H3 STUDIO"],
  ["/app/create/single", "單次影片"],
  ["/app/create/long", "長影片"],
  ["/app/jobs", "工作"],
  ["/app/library", "素材庫"],
  ["/app/tools", "工具"],
  ["/app/tools/image-to-image", "Image"],
  ["/app/tools/pose-to-image", "OpenPose"],
  ["/app/tools/upscale", "SeedVR2"],
  ["/app/tools/lora-trainer", "LoRA"],
  ["/app/settings", "設定"],
];

async function get(pathname) {
  const response = await fetch(`${baseUrl}${pathname}`, { redirect: "manual" });
  const body = await response.text();
  return { response, body };
}

test("served WebUI routes render real HTML entry points", { skip: !baseUrl }, async () => {
  for (const [pathname, marker] of routes) {
    const { response, body } = await get(pathname);
    assert.equal(response.status, 200, `${pathname} should return 200`);
    assert.match(response.headers.get("content-type") || "", /text\/html/i, `${pathname} should return HTML`);
    assert.match(body, new RegExp(marker), `${pathname} should include its visible route marker`);
  }
});

test("health endpoint exposes a ready bridge contract", { skip: !baseUrl }, async () => {
  const { response, body } = await get("/app/api/health");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /application\/json/i);
  const payload = JSON.parse(body);
  assert.equal(payload.bridge, true);
  assert.equal(typeof payload.runtime?.mode, "string");
  assert.equal(payload.comfy?.online, true);
  assert.equal(payload.ollama?.online, true);
});
