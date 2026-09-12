import { createHash } from "node:crypto";

import { solH3Error } from "./request.mjs";

export function normalizeIdempotencyKey(value) {
  const key = String(value || "").trim();
  if (!key) return null;
  if (key.length > 200 || /[\u0000-\u001f\u007f]/u.test(key)) {
    throw solH3Error("SOL_H3_IDEMPOTENCY_KEY_INVALID", "Idempotency-Key is invalid.", 422);
  }
  return key;
}

export function fingerprintSolH3Request(request) {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

export function assertIdempotentReplay(existing, requestFingerprint) {
  if (!existing) return null;
  if (existing.requestFingerprint !== requestFingerprint) {
    throw solH3Error(
      "SOL_H3_IDEMPOTENCY_CONFLICT",
      "Idempotency-Key was already used for a different Sol-H3 request.",
      409,
    );
  }
  return existing.jobId;
}
