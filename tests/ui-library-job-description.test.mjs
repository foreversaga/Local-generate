import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { adaptJob } from "../app/lib/job-adapter.mjs";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("job history exposes the original prompt description across supported generation sources", () => {
  assert.equal(adaptJob({ id: "video", initialDescription: "原始單影片描述" }, "video").description, "原始單影片描述");
  assert.equal(adaptJob({ id: "legacy-video", provenance: { request: { initialDescription: "provenance 描述" } } }, "video").description, "provenance 描述");
  assert.equal(adaptJob({ id: "long", inputText: "長影片故事描述" }, "long").description, "長影片故事描述");
  assert.equal(adaptJob({ id: "image", promptDescription: "把背景改成海邊" }, "img2img").description, "把背景改成海邊");
});

test("job detail shows prompt description separately from the generated prompt", async () => {
  const detail = await source("app/components/jobs/JobDetailWorkspace.tsx");
  assert.match(detail, /提示詞與描述/);
  assert.match(detail, /提示詞描述/);
  assert.match(detail, /job\.description/);
  assert.match(detail, /showPromptText/);
});

test("long job detail lists every child elapsed time and the overall elapsed time", async () => {
  const detail = await source("app/components/jobs/JobDetailWorkspace.tsx");
  const client = await source("app/components/jobs/job-client.ts");
  assert.match(detail, /工作耗時/);
  assert.match(detail, /各子工作耗時與整體長影片總耗時/);
  assert.match(detail, /segment\.childElapsedMs/);
  assert.match(detail, /job\.elapsedMs/);
  assert.match(detail, /segment\.childJobId/);
  assert.match(client, /childElapsedMs/);
  assert.match(client, /api\/jobs/);
});

test("upscale job detail shows native SeedVR2 tile progress", async () => {
  const detail = await source("app/components/jobs/JobDetailWorkspace.tsx");
  assert.match(detail, /升階分塊進度/);
  assert.match(detail, /SeedVR2TilingUpscaler/);
  assert.match(detail, /分塊完成率/);
  assert.match(detail, /job\.progressSource === "native"/);
});

test("img2img persists prompt descriptions into new jobs, provenance, retry, and local history", async () => {
  const workspace = await source("app/components/tools/ImageToImageWorkspace.tsx");
  const client = await source("app/components/tools/img2img-client.ts");
  const server = await source("server/image-generation/img2img.mjs");
  assert.match(workspace, /promptDescription: promptDescription\.trim\(\)/);
  assert.match(workspace, /record\.promptDescription/);
  assert.match(client, /promptDescription\?: string;/);
  assert.match(server, /const promptDescription = typeof input\.promptDescription/);
  assert.match(server, /promptDescription: source\.promptDescription/);
});

test("successful library deletion closes preview and asset thumbnails never crop media", async () => {
  const workspace = await source("app/components/library/LibraryWorkspace.tsx");
  const assetClient = await source("app/components/library/asset-client.ts");
  const libraryCss = await source("app/components/library/LibraryWorkspace.module.css");
  const pickerCss = await source("app/components/library/AssetPickerButton.module.css");
  assert.match(workspace, /setSelectionMode\(false\);\s*setPreview\(null\);\s*await refresh\(\);/);
  assert.match(workspace, /catch \(reason\)[\s\S]*await refresh\(\);[\s\S]*setPendingDelete\(null\);[\s\S]*setError\(message\);/);
  assert.match(assetClient, /payload\.code\?`\$\{payload\.code\}: \$\{payload\.error\|\|fallback\}`/);
  assert.match(libraryCss, /\.previewButton img,\.previewButton video\{[^}]*object-fit:contain/);
  assert.doesNotMatch(libraryCss, /\.previewButton img,\.previewButton video\{[^}]*object-fit:cover/);
  assert.match(pickerCss, /\.thumb img,\.thumb video\{[^}]*object-fit:contain/);
  assert.doesNotMatch(pickerCss, /\.thumb img,\.thumb video\{[^}]*object-fit:cover/);
});
