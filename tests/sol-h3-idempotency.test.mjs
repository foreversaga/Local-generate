import test from "node:test";
import assert from "node:assert/strict";

import {
  assertIdempotentReplay,
  fingerprintSolH3Request,
  normalizeIdempotencyKey,
} from "../server/sol-h3/idempotency.mjs";

test("normalizes an optional idempotency key", () => {
  assert.equal(normalizeIdempotencyKey(undefined), null);
  assert.equal(normalizeIdempotencyKey("  browser-submit-1  "), "browser-submit-1");
});

test("rejects unsafe idempotency keys", () => {
  assert.throws(() => normalizeIdempotencyKey("bad\nkey"), { code: "SOL_H3_IDEMPOTENCY_KEY_INVALID", status: 422 });
});

test("fingerprints normalized requests deterministically", () => {
  const request = { schemaVersion: 1, mode: "t2va", prompt: "x", seed: 42, audio: { generate: true }, inputs: {} };
  assert.equal(fingerprintSolH3Request(request), fingerprintSolH3Request(request));
});

test("replays matching requests and rejects key reuse with a different request", () => {
  const existing = { jobId: "sol-123", requestFingerprint: "abc" };
  assert.equal(assertIdempotentReplay(existing, "abc"), "sol-123");
  assert.throws(() => assertIdempotentReplay(existing, "def"), { code: "SOL_H3_IDEMPOTENCY_CONFLICT", status: 409 });
});
