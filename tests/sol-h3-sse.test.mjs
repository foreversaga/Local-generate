import test from "node:test";
import assert from "node:assert/strict";

import { writeSolH3SseComment, writeSolH3SseEvent, writeSolH3SseHeaders } from "../server/sol-h3/sse.mjs";

function fakeResponse() {
  return {
    status: null,
    headers: null,
    chunks: [],
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    write(chunk) { this.chunks.push(String(chunk)); return true; },
  };
}

test("writes SSE response headers", () => {
  const res = fakeResponse();
  writeSolH3SseHeaders(res);
  assert.equal(res.status, 200);
  assert.equal(res.headers["Content-Type"], "text/event-stream; charset=utf-8");
  assert.equal(res.headers["X-Accel-Buffering"], "no");
});

test("writes a JSON SSE event and keepalive comment", () => {
  const res = fakeResponse();
  writeSolH3SseEvent(res, { status: "queued" }, { eventName: "job", id: 7 });
  writeSolH3SseComment(res);
  const text = res.chunks.join("");
  assert.match(text, /id: 7/);
  assert.match(text, /event: job/);
  assert.match(text, /data: \{"status":"queued"\}/);
  assert.match(text, /: keepalive/);
});
