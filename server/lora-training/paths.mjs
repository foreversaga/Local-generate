import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { invalid, normalizeUuid } from './schema.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(MODULE_DIR, '..', '..');
const DEFAULT_ROOT = path.join(REPO_ROOT, 'data', 'lora-training');
const WINDOWS_RESERVED_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function hasControlCharacters(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function resolveConfiguredRoot(value) {
  if (value !== undefined && (typeof value !== 'string' || !value.trim())) throw invalid('LORA_TRAINING_ROOT is invalid');
  if (value && hasControlCharacters(value)) throw invalid('LORA_TRAINING_ROOT is invalid');
  const resolved = path.resolve(REPO_ROOT, value?.trim() || DEFAULT_ROOT);
  const parsed = path.parse(resolved);
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  if (resolved === parsed.root || resolved.length > 240 || segments.some((segment) =>
    segment.endsWith('.') || segment.endsWith(' ') || WINDOWS_RESERVED_PATTERN.test(segment))) {
    throw invalid('LORA_TRAINING_ROOT is unsafe');
  }
  return resolved;
}

export const LORA_TRAINING_ROOT = resolveConfiguredRoot(process.env.LORA_TRAINING_ROOT);
export const LORA_PATHS = Object.freeze({
  root: LORA_TRAINING_ROOT,
  runtime: path.join(LORA_TRAINING_ROOT, 'runtime'),
  jobs: path.join(LORA_TRAINING_ROOT, 'jobs'),
  cache: path.join(LORA_TRAINING_ROOT, 'cache'),
  scheduler: path.join(LORA_TRAINING_ROOT, 'scheduler.json'),
  registry: path.join(LORA_TRAINING_ROOT, 'registry.json'),
});

export function assertSafeRelativePath(value, field = 'relativePath') {
  if (typeof value !== 'string' || !value || value.length > 220 || path.isAbsolute(value) || /^[a-z]:/i.test(value)) {
    throw invalid(`${field} is unsafe`);
  }
  const normalizedSeparators = value.replaceAll('\\', '/');
  const segments = normalizedSeparators.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes(':') ||
      segment.endsWith('.') || segment.endsWith(' ') || WINDOWS_RESERVED_PATTERN.test(segment))) {
    throw invalid(`${field} is unsafe`);
  }
  return segments.join('/');
}

export function resolveSafeChild(root, relativePath) {
  const safeRelative = assertSafeRelativePath(relativePath);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...safeRelative.split('/'));
  if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw invalid('relativePath is unsafe');
  return resolved;
}

export function getJobPaths(jobId, paths = LORA_PATHS) {
  const id = normalizeUuid(jobId, 'jobId');
  const directory = resolveSafeChild(paths.jobs, id);
  return Object.freeze({ directory, state: path.join(directory, 'job.json') });
}

export async function ensureLoraTrainingLayout(paths = LORA_PATHS) {
  await Promise.all([
    mkdir(paths.runtime, { recursive: true }),
    mkdir(paths.jobs, { recursive: true }),
    mkdir(paths.cache, { recursive: true }),
  ]);
  return paths;
}
