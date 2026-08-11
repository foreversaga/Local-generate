import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const assetClient = await readFile(new URL("../app/components/library/asset-client.ts", import.meta.url), "utf8");
const singleCreate = await readFile(new URL("../app/components/create/SingleCreateForm.tsx", import.meta.url), "utf8");
const longCreate = await readFile(new URL("../app/components/create/LongCreateForm.tsx", import.meta.url), "utf8");

test("library upload client sends File bytes through the raw upload contract", () => {
  assert.match(assetClient, /Content-Type":"application\/octet-stream/);
  assert.match(assetClient, /body:file/);
  assert.match(assetClient, /X-Asset-Mime/);
  assert.doesNotMatch(assetClient, /FileReader|readAsDataURL|fileToBase64|base64/);
});

test("Single and Long upload callers share the raw client without JSON binary payloads", () => {
  assert.match(singleCreate, /uploadAssets\(candidates\)/);
  assert.match(longCreate, /uploadAssets\(candidates\)/);
  assert.doesNotMatch(singleCreate, /fileToBase64|readAsDataURL/);
  assert.doesNotMatch(longCreate, /fileToBase64|readAsDataURL/);
  assert.doesNotMatch(singleCreate, /api\/assets\/upload[\s\S]{0,400}JSON\.stringify/);
  assert.doesNotMatch(longCreate, /api\/assets\/upload[\s\S]{0,400}JSON\.stringify/);
});
