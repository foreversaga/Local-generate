import assert from "node:assert/strict";
import test from "node:test";

async function render(pathname) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("renders the routed Single Create UI after Vinext build", async () => {
  const response = await render("/create/single");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /單次影片/);
  assert.match(html, /提示詞助理/);
  assert.match(html, /single-prompt/);
  assert.match(html, /文字生片/);
  assert.match(html, /多圖參考生片/);
  assert.match(html, /角色動作參考/);
  assert.match(html, /開始生成影片|完成必要欄位後生成/);
  assert.doesNotMatch(html, /Single 表單遷移中|Migration/);
});
