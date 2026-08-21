import { randomUUID } from 'node:crypto';

export const JOB_STATUSES = Object.freeze([
  'draft',
  'ready',
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
]);

export const CAPTION_REVIEW_MODES = Object.freeze(['auto', 'manual']);
export const TRAINABLE_MODEL_FAMILIES = Object.freeze(['sdxl', 'illustrious']);
export const LORA_MODEL_FAMILIES = Object.freeze(['sdxl', 'illustrious', 'sd15', 'wan22-animate']);
export const MODEL_FAMILIES = TRAINABLE_MODEL_FAMILIES;
export const REGISTRY_STATUSES = Object.freeze(['available', 'unavailable']);

export const API_ERROR_CODES = Object.freeze({
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_IDENTIFIER: 'INVALID_IDENTIFIER',
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  REVISION_CONFLICT: 'REVISION_CONFLICT',
  IO_ERROR: 'IO_ERROR',
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const SAFE_TOKEN_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,79}$/u;
const WINDOWS_RESERVED_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const STUDIO_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

function hasControlCharacters(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

export class LoraTrainingError extends Error {
  constructor(code, message, { status = 400, details } = {}) {
    super(message);
    this.name = 'LoraTrainingError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export function invalid(message, details) {
  return new LoraTrainingError(API_ERROR_CODES.INVALID_REQUEST, message, { status: 400, details });
}

export function normalizeUuid(value, field = 'id') {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new LoraTrainingError(API_ERROR_CODES.INVALID_IDENTIFIER, `${field} must be a UUID`, { status: 400 });
  }
  return value.toLowerCase();
}

export function normalizeRevision(value, field = 'revision') {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid(`${field} must be a non-negative integer`);
  return value;
}

export function normalizeSlug(value, field = 'slug') {
  if (typeof value !== 'string') throw invalid(`${field} must be a string`);
  const slug = value.trim().toLowerCase();
  if (!SAFE_SLUG_PATTERN.test(slug) || WINDOWS_RESERVED_PATTERN.test(slug)) {
    throw invalid(`${field} contains unsafe characters`);
  }
  return slug;
}

export function normalizeDisplayName(value, field = 'displayName') {
  if (typeof value !== 'string') throw invalid(`${field} must be a string`);
  const result = value.trim();
  if (!result || result.length > 120 || hasControlCharacters(result)) throw invalid(`${field} is invalid`);
  return result;
}

export function normalizeTriggerWords(value) {
  const values = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(values) || values.length < 1 || values.length > 20) {
    throw invalid('triggerWords must contain between 1 and 20 values');
  }
  const result = values.map((word) => {
    if (typeof word !== 'string') throw invalid('triggerWords must contain strings');
    const normalized = word.trim();
    if (!SAFE_TOKEN_PATTERN.test(normalized) || WINDOWS_RESERVED_PATTERN.test(normalized)) {
      throw invalid('triggerWords contains an unsafe value');
    }
    return normalized;
  });
  if (new Set(result.map((item) => item.toLocaleLowerCase())).size !== result.length) {
    throw invalid('triggerWords must be unique');
  }
  return result;
}

export function normalizeCaption(value, field = 'caption') {
  if (typeof value !== 'string') throw invalid(`${field} must be a string`);
  const caption = value.trim();
  if (!caption || caption.length > 4096 || hasControlCharacters(caption.replace(/[\r\n\t]/g, ''))) {
    throw invalid(`${field} is invalid`);
  }
  return caption;
}

export function normalizeAssetIds(value = []) {
  if (!Array.isArray(value) || value.length > 10000) throw invalid('assetIds must be an array');
  const result = value.map((id) => {
    if (typeof id !== 'string') throw invalid('assetId must be a UUID or Studio asset key');
    if (UUID_PATTERN.test(id)) return normalizeUuid(id, 'assetId');
    if (id.length > 256 || id !== id.trim() || hasControlCharacters(id)) {
      throw invalid('assetId must be a UUID or Studio asset key');
    }
    const match = /^(input|output|training):(.+)$/.exec(id);
    if (!match) throw invalid('assetId must be a UUID or Studio asset key');
    const [, prefix, relativePath] = match;
    if (relativePath.length > 220 || relativePath.startsWith('/') || relativePath.startsWith('\\') ||
        relativePath.includes('\\') || relativePath.includes(':')) {
      throw invalid('Studio asset path is unsafe');
    }
    const segments = relativePath.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.length > 120 ||
        segment !== segment.trim() || /[<>"|?*]/.test(segment) || segment.endsWith('.') ||
        WINDOWS_RESERVED_PATTERN.test(segment))) {
      throw invalid('Studio asset path is unsafe');
    }
    const fileName = segments.at(-1);
    const dotIndex = fileName.lastIndexOf('.');
    const extension = dotIndex < 0 ? '' : fileName.slice(dotIndex).toLowerCase();
    if (!STUDIO_IMAGE_EXTENSIONS.has(extension)) throw invalid('Studio asset image format is unsupported');
    return `${prefix}:${segments.join('/')}`;
  });
  if (new Set(result.map((id) => id.toLocaleLowerCase())).size !== result.length) throw invalid('assetIds must be unique');
  return result;
}

function cloneSafeJson(value, path = 'value', depth = 0) {
  if (depth > 20) throw invalid(`${path} is too deeply nested`);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string' && (value.length > 100000 || hasControlCharacters(value.replace(/[\r\n\t]/g, '')))) {
      throw invalid(`${path} contains an invalid string`);
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid(`${path} must contain finite numbers`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 10000) throw invalid(`${path} is too large`);
    return value.map((item, index) => cloneSafeJson(item, `${path}[${index}]`, depth + 1));
  }
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value);
    if (entries.length > 1000) throw invalid(`${path} has too many keys`);
    return Object.fromEntries(entries.map(([key, item]) => {
      if (!key || key.length > 128 || hasControlCharacters(key) || key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw invalid(`${path} contains an invalid key`);
      }
      return [key, cloneSafeJson(item, `${path}.${key}`, depth + 1)];
    }));
  }
  throw invalid(`${path} must be JSON-compatible`);
}

export function normalizeConfig(value = {}) {
  const config = cloneSafeJson(value, 'config');
  if (!config || Array.isArray(config) || typeof config !== 'object') throw invalid('config must be an object');
  if (JSON.stringify(config).length > 1_000_000) throw invalid('config is too large');
  return config;
}

export function normalizeProvenance(value = {}) {
  const provenance = cloneSafeJson(value, 'provenance');
  if (!provenance || Array.isArray(provenance) || typeof provenance !== 'object') {
    throw invalid('provenance must be an object');
  }
  if (JSON.stringify(provenance).length > 250_000) throw invalid('provenance is too large');
  return provenance;
}

function enumValue(value, allowed, field) {
  if (!allowed.includes(value)) throw invalid(`${field} is unsupported`, { allowed });
  return value;
}

// WAI is the user-facing name for the existing Illustrious/WAI checkpoint
// profile. Keep the persisted family canonical so older jobs and registry
// consumers continue to use `illustrious` while accepting the concise API
// alias at the boundary.
export function normalizeTrainingFamily(value, field = 'family') {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : value;
  return enumValue(normalized === 'wai' ? 'illustrious' : normalized, MODEL_FAMILIES, field);
}

export function normalizeJobCreate(input, { id = randomUUID(), now = new Date().toISOString() } = {}) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) throw invalid('job request must be an object');
  const timestamp = new Date(now);
  if (Number.isNaN(timestamp.valueOf())) throw invalid('now must be a valid timestamp');
  const createdAt = timestamp.toISOString();
  return {
    id: normalizeUuid(id),
    revision: 0,
    slug: normalizeSlug(input.slug),
    displayName: normalizeDisplayName(input.displayName),
    status: enumValue(input.status ?? 'draft', JOB_STATUSES, 'status'),
    family: normalizeTrainingFamily(input.family),
    captionReviewMode: enumValue(input.captionReviewMode ?? 'auto', CAPTION_REVIEW_MODES, 'captionReviewMode'),
    triggerWords: normalizeTriggerWords(input.triggerWords),
    assetIds: normalizeAssetIds(input.assetIds),
    config: normalizeConfig(input.config),
    provenance: normalizeProvenance(input.provenance),
    createdAt,
    updatedAt: createdAt,
  };
}

export function normalizeJobPatch(input) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) throw invalid('job patch must be an object');
  const allowed = new Set(['slug', 'displayName', 'status', 'family', 'captionReviewMode', 'triggerWords', 'assetIds', 'config', 'provenance']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw invalid(`job patch field is not editable: ${key}`);
  const patch = {};
  if ('slug' in input) patch.slug = normalizeSlug(input.slug);
  if ('displayName' in input) patch.displayName = normalizeDisplayName(input.displayName);
  if ('status' in input) patch.status = enumValue(input.status, JOB_STATUSES, 'status');
  if ('family' in input) patch.family = normalizeTrainingFamily(input.family);
  if ('captionReviewMode' in input) patch.captionReviewMode = enumValue(input.captionReviewMode, CAPTION_REVIEW_MODES, 'captionReviewMode');
  if ('triggerWords' in input) patch.triggerWords = normalizeTriggerWords(input.triggerWords);
  if ('assetIds' in input) patch.assetIds = normalizeAssetIds(input.assetIds);
  if ('config' in input) patch.config = normalizeConfig(input.config);
  if ('provenance' in input) patch.provenance = normalizeProvenance(input.provenance);
  return patch;
}

export function normalizeJobRecord(input) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) throw invalid('stored job is invalid');
  const createdAt = new Date(input.createdAt);
  const updatedAt = new Date(input.updatedAt);
  if (Number.isNaN(createdAt.valueOf()) || Number.isNaN(updatedAt.valueOf())) throw invalid('stored job timestamps are invalid');
  return {
    id: normalizeUuid(input.id),
    revision: normalizeRevision(input.revision),
    slug: normalizeSlug(input.slug),
    displayName: normalizeDisplayName(input.displayName),
    status: enumValue(input.status, JOB_STATUSES, 'status'),
    family: normalizeTrainingFamily(input.family),
    captionReviewMode: enumValue(input.captionReviewMode, CAPTION_REVIEW_MODES, 'captionReviewMode'),
    triggerWords: normalizeTriggerWords(input.triggerWords),
    assetIds: normalizeAssetIds(input.assetIds),
    config: normalizeConfig(input.config),
    provenance: normalizeProvenance(input.provenance),
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
}

export function toPublicJob(job) {
  const { id, revision, slug, displayName, status, family, captionReviewMode, triggerWords, assetIds, config, provenance, createdAt, updatedAt } = job;
  return structuredClone({ id, revision, slug, displayName, status, family, captionReviewMode, triggerWords, assetIds, config, provenance, createdAt, updatedAt });
}

export function toApiError(error) {
  if (error instanceof LoraTrainingError) {
    return { status: error.status, body: { error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } } };
  }
  return { status: 500, body: { error: { code: API_ERROR_CODES.IO_ERROR, message: 'LoRA training storage operation failed' } } };
}
