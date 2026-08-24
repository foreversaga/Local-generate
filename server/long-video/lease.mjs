import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { LongVideoError } from "./schema.mjs";
import { sequenceJobDir } from "./paths.mjs";

export const DEFAULT_SEQUENCE_LEASE_TTL_MS = 30_000;
const LOCK_RETRY_MS = 20;
const LOCK_MAX_WAIT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

function validSequenceId(id) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(String(id || ""));
}

function leasePath(id) {
  if (!validSequenceId(id)) throw new LongVideoError("JOB_ID_INVALID", "Invalid sequence id.", 400);
  return path.join(sequenceJobDir(id), "lease.json");
}

function lockPath(filePath) {
  return `${filePath}.lock`;
}

function nowMs(value = Date.now()) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return Date.parse(value);
  return Number(value);
}

function iso(value) {
  return new Date(nowMs(value)).toISOString();
}

function leaseExpired(lease, at = Date.now()) {
  const expiresAt = nowMs(lease?.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= nowMs(at);
}

function leaseMatches(current, lease) {
  return Boolean(
    current && lease
    && String(current.ownerId || "") === String(lease.ownerId || "")
    && String(current.token || "") === String(lease.token || "")
    && Number(current.epoch) === Number(lease.epoch),
  );
}

function normalizeOwner(ownerId) {
  const owner = String(ownerId || "").trim();
  if (!owner || owner.length > 160) throw new LongVideoError("SEQUENCE_OWNER_INVALID", "A sequence lease owner is required.", 400);
  return owner;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withLeaseFileLock(filePath, operation) {
  const lock = lockPath(filePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const started = Date.now();
  while (true) {
    try {
      await fs.mkdir(lock, { recursive: false });
      try {
        return await operation();
      } finally {
        await fs.rm(lock, { recursive: true, force: true }).catch(() => {});
      }
    } catch (error) {
      if (error?.code !== "EEXIST" || Date.now() - started >= LOCK_MAX_WAIT_MS) throw error;
      const stat = await fs.stat(lock).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
        await fs.rm(lock, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
}

async function readLeaseFile(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeLeaseFile(filePath, lease) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(lease, null, 2) + "\n", "utf8");
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

export function isSequenceLeaseValid(lease, at = Date.now()) {
  return Boolean(lease?.ownerId && lease?.token && Number.isInteger(Number(lease.epoch)) && !leaseExpired(lease, at));
}

export function sequenceLeaseFile(id) {
  return leasePath(id);
}

export async function readSequenceLease(sequenceId) {
  return readLeaseFile(leasePath(sequenceId));
}

export async function acquireSequenceLease(
  sequenceId,
  { ownerId = `h3-studio-${process.pid}`, ttlMs = DEFAULT_SEQUENCE_LEASE_TTL_MS, now = Date.now() } = {},
) {
  const filePath = leasePath(sequenceId);
  const owner = normalizeOwner(ownerId);
  const ttl = Math.max(5_000, Number(ttlMs) || DEFAULT_SEQUENCE_LEASE_TTL_MS);
  return withLeaseFileLock(filePath, async () => {
    const current = await readLeaseFile(filePath);
    if (isSequenceLeaseValid(current, now) && String(current.ownerId) !== owner) {
      throw new LongVideoError("SEQUENCE_LEASE_HELD", "Another process currently controls this sequence.", 409, {
        ownerId: current.ownerId,
        epoch: current.epoch,
        expiresAt: current.expiresAt,
      });
    }
    const sameOwner = isSequenceLeaseValid(current, now) && String(current.ownerId) === owner;
    const epoch = sameOwner ? Number(current.epoch) : Math.max(0, Number(current?.epoch) || 0) + 1;
    const token = sameOwner ? current.token : randomUUID();
    const heartbeatAt = iso(now);
    const lease = {
      ownerId: owner,
      epoch,
      token,
      acquiredAt: sameOwner ? current.acquiredAt : heartbeatAt,
      heartbeatAt,
      expiresAt: iso(nowMs(now) + ttl),
    };
    await writeLeaseFile(filePath, lease);
    return lease;
  });
}

export async function renewSequenceLease(
  sequenceId,
  lease,
  { ttlMs = DEFAULT_SEQUENCE_LEASE_TTL_MS, now = Date.now() } = {},
) {
  const filePath = leasePath(sequenceId);
  if (!lease?.ownerId || !lease?.token) throw new LongVideoError("SEQUENCE_LEASE_INVALID", "A sequence lease token is required.", 409);
  const ttl = Math.max(5_000, Number(ttlMs) || DEFAULT_SEQUENCE_LEASE_TTL_MS);
  return withLeaseFileLock(filePath, async () => {
    const current = await readLeaseFile(filePath);
    if (!leaseMatches(current, lease) || leaseExpired(current, now)) {
      throw new LongVideoError("SEQUENCE_LEASE_LOST", "The sequence lease is no longer valid.", 409, { sequenceId });
    }
    const renewed = { ...current, heartbeatAt: iso(now), expiresAt: iso(nowMs(now) + ttl) };
    await writeLeaseFile(filePath, renewed);
    return renewed;
  });
}

export async function assertSequenceLease(sequenceId, lease, { now = Date.now() } = {}) {
  const current = await readLeaseFile(leasePath(sequenceId));
  if (!leaseMatches(current, lease) || leaseExpired(current, now)) {
    throw new LongVideoError("SEQUENCE_LEASE_LOST", "The sequence lease is no longer valid.", 409, {
      sequenceId,
      expectedEpoch: lease?.epoch,
      actualEpoch: current?.epoch,
    });
  }
  return current;
}

export async function releaseSequenceLease(sequenceId, lease) {
  const filePath = leasePath(sequenceId);
  if (!lease?.ownerId || !lease?.token) return false;
  return withLeaseFileLock(filePath, async () => {
    const current = await readLeaseFile(filePath);
    if (!leaseMatches(current, lease)) return false;
    await fs.unlink(filePath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    return true;
  });
}

export function leaseErrorIsFenced(error) {
  return error?.code === "SEQUENCE_LEASE_LOST" || error?.code === "SEQUENCE_LEASE_HELD";
}
