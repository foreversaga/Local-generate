import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteJson } from "./img2img-store.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BATCH_ITEM_CHUNK_SIZE = 10;
const writes = new Map();
const shardedBatches = new Set();

function defaultBatchesRoot() {
  return path.resolve(process.env.H3_TEXT2IMG_BATCH_DATA_ROOT || path.join(PROJECT_ROOT, "data", "text2img", "batches"));
}

function safeId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(id)) {
    const error = new Error("Invalid text-to-image batch id.");
    error.code = "TEXT2IMG_BATCH_ID_INVALID";
    error.status = 400;
    throw error;
  }
  return id;
}

function inside(root, candidate) {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  return absoluteCandidate === absoluteRoot || absoluteCandidate.startsWith(absoluteRoot + path.sep);
}

export function createText2ImgBatchStore({ root = defaultBatchesRoot(), fsApi = fs } = {}) {
  const batchesRoot = path.resolve(root);

  function batchDir(id) {
    const candidate = path.resolve(batchesRoot, safeId(id));
    if (!inside(batchesRoot, candidate)) {
      const error = new Error("Text-to-image batch path is unsafe.");
      error.code = "TEXT2IMG_BATCH_PATH_INVALID";
      error.status = 400;
      throw error;
    }
    return candidate;
  }

  function batchFile(id) {
    return path.join(batchDir(id), "batch.json");
  }

  function chunkFile(id, chunkIndex) {
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 99_999) {
      const error = new Error("Invalid text-to-image batch chunk index.");
      error.code = "TEXT2IMG_BATCH_CHUNK_INDEX_INVALID";
      error.status = 400;
      throw error;
    }
    return path.join(batchDir(id), "items", `${String(chunkIndex).padStart(5, "0")}.json`);
  }

  async function readFileAfterPendingWrite(filePath) {
    const pendingWrite = writes.get(filePath);
    if (pendingWrite) await pendingWrite;
    return JSON.parse(await fsApi.readFile(filePath, "utf8"));
  }

  async function read(id) {
    const filePath = batchFile(id);
    try {
      const metadata = await readFileAfterPendingWrite(filePath);
      if (Array.isArray(metadata.items)) return metadata;
      if (metadata.storageVersion !== 2 || metadata.itemChunkSize !== BATCH_ITEM_CHUNK_SIZE
        || !Number.isSafeInteger(metadata.itemCount) || metadata.itemCount < 0) return null;
      const items = [];
      for (let chunkIndex = 0; items.length < metadata.itemCount; chunkIndex += 1) {
        const chunk = await readFileAfterPendingWrite(chunkFile(id, chunkIndex));
        if (!Array.isArray(chunk)) throw new Error(`Text-to-image batch chunk ${chunkIndex} is invalid.`);
        items.push(...chunk);
      }
      items.length = metadata.itemCount;
      shardedBatches.add(filePath);
      const batch = { ...metadata };
      delete batch.storageVersion;
      delete batch.itemCount;
      delete batch.itemChunkSize;
      return { ...batch, items };
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async function queueWrite(filePath, payload) {
    const previous = writes.get(filePath) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => atomicWriteJson(filePath, payload, fsApi));
    writes.set(filePath, next);
    next.finally(() => {
      if (writes.get(filePath) === next) writes.delete(filePath);
    }).catch(() => {});
    await next;
  }

  async function save(batch, { itemIndexes = null } = {}) {
    if (!batch?.id) throw new Error("Text-to-image batch id is required.");
    if (!Array.isArray(batch.items)) throw new Error("Text-to-image batch items are required.");
    const filePath = batchFile(batch.id);
    const indexes = shardedBatches.has(filePath) && Array.isArray(itemIndexes)
      ? [...new Set(itemIndexes)]
      : batch.items.map((_item, index) => index);
    const chunkIndexes = [...new Set(indexes.map((index) => {
      if (!batch.items[index]) throw new Error(`Text-to-image batch item ${index} is missing.`);
      return Math.floor(index / BATCH_ITEM_CHUNK_SIZE);
    }))];
    for (let cursor = 0; cursor < chunkIndexes.length; cursor += 8) {
      await Promise.all(chunkIndexes.slice(cursor, cursor + 8).map((chunkIndex) => {
        const start = chunkIndex * BATCH_ITEM_CHUNK_SIZE;
        return queueWrite(chunkFile(batch.id, chunkIndex), batch.items.slice(start, start + BATCH_ITEM_CHUNK_SIZE));
      }));
    }
    const metadata = { ...batch };
    delete metadata.items;
    await queueWrite(filePath, { ...metadata, storageVersion: 2, itemCount: batch.items.length, itemChunkSize: BATCH_ITEM_CHUNK_SIZE });
    shardedBatches.add(filePath);
    return structuredClone(batch);
  }

  async function list() {
    const entries = await fsApi.readdir(batchesRoot, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    const batches = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const batch = await read(entry.name);
      if (batch && typeof batch === "object" && batch.id) batches.push(batch);
    }
    return batches.sort((left, right) => String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")));
  }

  return Object.freeze({ root: batchesRoot, batchDir, batchFile, chunkFile, read, save, list });
}

export const TEXT2IMG_BATCH_DATA_ROOT = defaultBatchesRoot;
