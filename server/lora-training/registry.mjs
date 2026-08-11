import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  API_ERROR_CODES,
  LoraTrainingError,
  LORA_MODEL_FAMILIES,
  REGISTRY_STATUSES,
  invalid,
  normalizeDisplayName,
  normalizeProvenance,
  normalizeRevision,
  normalizeSlug,
  normalizeTriggerWords,
  normalizeUuid,
} from './schema.mjs';
import { assertSafeRelativePath, ensureLoraTrainingLayout, LORA_PATHS } from './paths.mjs';
import { atomicWriteJson, withStorageLock } from './store.mjs';

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

function enumValue(value, allowed, field) {
  if (!allowed.includes(value)) throw invalid(`${field} is unsupported`, { allowed });
  return value;
}

function normalizeTimestamp(value, field) {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.valueOf())) throw invalid(`${field} must be a valid timestamp`);
  return timestamp.toISOString();
}

export function normalizeRegistryRecord(input, { id = input?.id, now } = {}) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) throw invalid('registry record must be an object');
  const timestamp = now === undefined ? undefined : normalizeTimestamp(now, 'now');
  const createdAt = normalizeTimestamp(input.createdAt ?? timestamp, 'createdAt');
  const updatedAt = normalizeTimestamp(input.updatedAt ?? timestamp, 'updatedAt');
  if (typeof input.hash !== 'string' || !SHA256_PATTERN.test(input.hash)) throw invalid('hash must be a SHA-256 hex digest');
  if (!Number.isSafeInteger(input.size) || input.size < 0) throw invalid('size must be a non-negative integer');
  return {
    id: normalizeUuid(id, 'registryId'),
    relativePath: assertSafeRelativePath(input.relativePath),
    family: enumValue(input.family, LORA_MODEL_FAMILIES, 'family'),
    baseProfile: normalizeSlug(input.baseProfile, 'baseProfile'),
    displayName: normalizeDisplayName(input.displayName),
    triggerWords: normalizeTriggerWords(input.triggerWords),
    hash: input.hash.toLowerCase(),
    size: input.size,
    provenance: normalizeProvenance(input.provenance),
    createdAt,
    updatedAt,
    status: enumValue(input.status ?? 'available', REGISTRY_STATUSES, 'status'),
  };
}

function registryError(message, cause) {
  return new LoraTrainingError(API_ERROR_CODES.IO_ERROR, message, {
    status: 500,
    details: cause?.code ? { reason: cause.code } : undefined,
  });
}

function revisionConflict(actualRevision) {
  return new LoraTrainingError(API_ERROR_CODES.REVISION_CONFLICT, 'revision conflict', {
    status: 409,
    details: { actualRevision },
  });
}

function normalizeRegistryDocument(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || !Array.isArray(value.items)) {
    throw invalid('stored registry is invalid');
  }
  const revision = normalizeRevision(value.revision);
  const items = value.items.map((record) => normalizeRegistryRecord(record));
  const ids = new Set();
  const paths = new Set();
  for (const item of items) {
    if (ids.has(item.id) || paths.has(item.relativePath.toLocaleLowerCase())) throw invalid('stored registry contains duplicates');
    ids.add(item.id);
    paths.add(item.relativePath.toLocaleLowerCase());
  }
  return { revision, items };
}

export function createRegistryStore({ paths = LORA_PATHS, clock = () => new Date(), idFactory = randomUUID } = {}) {
  const readRegistry = async () => {
    try {
      return normalizeRegistryDocument(JSON.parse(await readFile(paths.registry, 'utf8')));
    } catch (error) {
      if (error?.code === 'ENOENT') return { revision: 0, items: [] };
      if (error instanceof LoraTrainingError && error.code === API_ERROR_CODES.IO_ERROR) throw error;
      throw registryError('Unable to read model registry', error);
    }
  };

  const get = async (registryId) => {
    const id = normalizeUuid(registryId, 'registryId');
    const registry = await readRegistry();
    const record = registry.items.find((item) => item.id === id);
    if (!record) throw new LoraTrainingError(API_ERROR_CODES.NOT_FOUND, 'registry item not found', { status: 404 });
    return structuredClone(record);
  };

  const list = async ({ family, status, baseProfile } = {}) => {
    if (family !== undefined) enumValue(family, LORA_MODEL_FAMILIES, 'family');
    if (status !== undefined) enumValue(status, REGISTRY_STATUSES, 'status');
    const normalizedBaseProfile = baseProfile === undefined ? undefined : normalizeSlug(baseProfile, 'baseProfile');
    const registry = await readRegistry();
    return registry.items
      .filter((item) => (family === undefined || item.family === family) &&
        (status === undefined || item.status === status) &&
        (normalizedBaseProfile === undefined || item.baseProfile === normalizedBaseProfile))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((item) => structuredClone(item));
  };

  const register = async (input, { expectedRevision } = {}) => {
    const record = normalizeRegistryRecord(input, { id: input?.id ?? idFactory(), now: clock().toISOString() });
    const expected = expectedRevision === undefined ? undefined : normalizeRevision(expectedRevision, 'expectedRevision');
    return withStorageLock(paths.registry, async () => {
      await ensureLoraTrainingLayout(paths);
      const current = await readRegistry();
      if (expected !== undefined && current.revision !== expected) throw revisionConflict(current.revision);
      if (current.items.some((item) => item.id === record.id || item.relativePath.toLocaleLowerCase() === record.relativePath.toLocaleLowerCase())) {
        throw new LoraTrainingError(API_ERROR_CODES.ALREADY_EXISTS, 'registry item already exists', { status: 409 });
      }
      await atomicWriteJson(paths.registry, { revision: current.revision + 1, items: [...current.items, record] });
      return structuredClone(record);
    });
  };

  return Object.freeze({ register, list, get, readRegistry });
}

export const registryStore = createRegistryStore();
