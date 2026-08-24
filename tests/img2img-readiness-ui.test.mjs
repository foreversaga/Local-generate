import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("img2img hides duplicate environment readiness and shows only actionable model failures", async () => {
  const [workspace, styles] = await Promise.all([
    readFile(new URL("../app/components/tools/ImageToImageWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/tools/ImageToImageWorkspace.module.css", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(workspace, /<h2 id="img2img-readiness-title">執行環境<\/h2>/);
  assert.doesNotMatch(workspace, /styles\.readinessList/);
  assert.match(workspace, /const readinessNotice = healthError \|\| readinessBlockingMessage/);
  assert.match(workspace, /\{readinessNotice && \(/);
  assert.match(workspace, /id="img2img-readiness-status" role="alert"/);
  assert.match(workspace, /所選模型目前無法生成/);
  assert.match(workspace, /onClick=\{\(\) => void refreshHealth\(\)\}/);
  assert.match(workspace, /readiness: "img2img-model"/);
  assert.doesNotMatch(styles, /\.readinessList/);
});

test("img2img exposes Klein 9B native edit controls without SD denoise or pose", async () => {
  const workspace = await readFile(new URL("../app/components/tools/ImageToImageWorkspace.tsx", import.meta.url), "utf8");
  assert.match(workspace, /value: "flux-2-klein-9b-fp8\.safetensors"/);
  assert.match(workspace, /label: "FLUX\.2 Klein 9B · FP8"/);
  assert.match(workspace, /supportsLora: true/);
  assert.match(workspace, /supportsPose: false/);
  assert.match(workspace, /disabled=\{active \|\| flux2Edit\}/);
  assert.match(workspace, /FLUX\.2 Klein 使用 ReferenceLatent/);
});
