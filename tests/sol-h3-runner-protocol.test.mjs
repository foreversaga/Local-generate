import test from "node:test";
import assert from "node:assert/strict";

import { createSolH3JsonlParser, validateSolH3WorkerEvent } from "../server/sol-h3/runner-protocol.mjs";

test("parses partial JSONL chunks without losing events", () => {
  const events = [];
  const parser = createSolH3JsonlParser({ onEvent: (event) => events.push(event) });
  parser.push('{"v":1,"type":"hello","worker":"stage1","pid":12}\n{"v":1,"type":"pro');
  parser.push('gress","requestId":"req-1","stage":"stage1","current":2,"total":4}\n');
  parser.end('{"v":1,"type":"result","requestId":"req-1","status":"ok"}');
  assert.deepEqual(events.map((event) => event.type), ["hello", "progress", "result"]);
});

test("rejects logging text mixed into worker stdout", () => {
  const parser = createSolH3JsonlParser({ onEvent: () => {} });
  assert.throws(() => parser.push("loading model...\n"), { code: "SOL_H3_WORKER_STDOUT_INVALID", status: 502 });
});

test("validates request-scoped progress and result fields", () => {
  assert.throws(
    () => validateSolH3WorkerEvent({ v: 1, type: "progress", stage: "stage1", current: 1, total: 2 }),
    { code: "SOL_H3_WORKER_REQUEST_ID_REQUIRED", status: 502 },
  );
  assert.throws(
    () => validateSolH3WorkerEvent({ v: 1, type: "progress", requestId: "r", stage: "stage1", current: 3, total: 2 }),
    { code: "SOL_H3_WORKER_PROGRESS_INVALID", status: 502 },
  );
  assert.doesNotThrow(() => validateSolH3WorkerEvent({ v: 1, type: "result", requestId: "r", status: "ok" }));
});
