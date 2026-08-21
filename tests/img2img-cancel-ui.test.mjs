import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("img2img restores an active batch after navigation and exposes a prominent interrupt action", async () => {
  const [workspace, client] = await Promise.all([
    readFile(new URL("../app/components/tools/ImageToImageWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/tools/img2img-client.ts", import.meta.url), "utf8"),
  ]);

  assert.match(workspace, /setJob\(\(current\) => current \|\| sorted\.find\(\(record\) => isImg2ImgActive\(record\)\) \|\| null\)/);
  assert.match(workspace, /batchTotal > 1 \? "中斷批次生成" : "中斷生成"/);
  assert.match(workspace, /cancelImg2ImgJob\(job\.id, "使用者中斷圖片生成。"\)/);
  assert.match(client, /\/api\/img2img\/jobs\/\$\{encodeURIComponent\(id\)\}\/cancel/);
});
