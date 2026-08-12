import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

import { normalizeTriggerWords } from '../schema.mjs';
import { validateSafetensors } from '../artifact.mjs';
import { createTrainingRunner } from '../runner.mjs';

export const Z_IMAGE_FAMILY = 'z-image';
export const Z_IMAGE_BASE_PROFILE = 'z-image-turbo';
export const Z_IMAGE_PRESET = 'z-image';
export const AI_TOOLKIT_VERSION = '0.12.13';
export const Z_IMAGE_DATASET_ADAPTER = 'ai-toolkit-json-v1';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const CAPTION_EXTENSION = '.txt';
const Z_IMAGE_DTYPES = new Set(['bf16', 'fp16', 'float16', 'float32', 'fp32']);
const SAVE_DTYPES = new Set(['bf16', 'fp16', 'float16', 'float32', 'fp32', 'float']);
const Q_TYPES = new Set(['qfloat8', 'float8', 'int8', 'uint8', 'uint4']);
const SAFE_OUTPUT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');

const PARAMETER_ALIASES = Object.freeze({
  rank: 'linear',
  networkDim: 'linear',
  alpha: 'linearAlpha',
  networkAlpha: 'linearAlpha',
  networkLinear: 'linear',
  networkLinearAlpha: 'linearAlpha',
  maxTrainSteps: 'steps',
  learningRate: 'lr',
  mixedPrecision: 'dtype',
  savePrecision: 'saveDtype',
  saveEveryEpochs: 'saveEvery',
  save_every: 'saveEvery',
  low_vram: 'lowVram',
  quantize_te: 'quantizeTextEncoder',
  qtype_te: 'qtypeTextEncoder',
  layer_offloading: 'layerOffloading',
  layer_offloading_text_encoder_percent: 'layerOffloadingTextEncoderPercent',
  layer_offloading_transformer_percent: 'layerOffloadingTransformerPercent',
  sample_every: 'sampleEvery',
  sample_steps: 'sampleSteps',
  gradient_checkpointing: 'gradientCheckpointing',
  cache_latents: 'cacheLatents',
  cache_latents_to_disk: 'cacheLatentsToDisk',
  aspect_ratio_buckets: 'aspectRatioBuckets',
  aspectRatioBucket: 'aspectRatioBuckets',
  buckets: 'aspectRatioBuckets',
});
export const Z_IMAGE_PARAMETER_ALIASES = Object.freeze({ ...PARAMETER_ALIASES });

const PARAMETER_KEYS = new Set([
  'resolution', 'width', 'height', 'batchSize', 'steps', 'lr', 'linear', 'linearAlpha',
  'saveEvery', 'dtype', 'saveDtype', 'seed', 'sampleEvery', 'sampleSteps',
  'lowVram', 'quantize', 'qtype', 'quantizeTextEncoder', 'qtypeTextEncoder',
  'layerOffloading', 'layerOffloadingTextEncoderPercent', 'layerOffloadingTransformerPercent',
  'gradientAccumulation', 'gradientCheckpointing', 'cacheLatents', 'cacheLatentsToDisk',
  'aspectRatioBuckets', 'disableSampling', 'samplePrompts', 'captionExtension',
]);
export const Z_IMAGE_PARAMETER_KEYS = Object.freeze([...PARAMETER_KEYS]);

const DEFAULT_PARAMETERS = Object.freeze({
  resolution: 1024,
  width: 1024,
  height: 1024,
  batchSize: 1,
  steps: 3000,
  lr: 0.0001,
  linear: 8,
  linearAlpha: 8,
  saveEvery: 250,
  dtype: 'bf16',
  saveDtype: 'bf16',
  seed: 42,
  sampleEvery: 250,
  sampleSteps: 8,
  lowVram: false,
  quantize: false,
  qtype: 'qfloat8',
  quantizeTextEncoder: false,
  qtypeTextEncoder: 'qfloat8',
  layerOffloading: false,
  layerOffloadingTextEncoderPercent: 1,
  layerOffloadingTransformerPercent: 1,
  gradientAccumulation: 1,
  gradientCheckpointing: true,
  cacheLatents: true,
  cacheLatentsToDisk: false,
  aspectRatioBuckets: true,
  disableSampling: false,
  captionExtension: CAPTION_EXTENSION,
});

export class ZImageBackendError extends Error {
  constructor(code, message, { status = 422, details, retryable = true } = {}) {
    super(message);
    this.name = 'ZImageBackendError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    if (details !== undefined) this.details = details;
  }
}

function backendError(code, message, details) {
  return new ZImageBackendError(code, message, { details });
}

function annotatePrerequisiteError(error, source, candidate) {
  if (!(error instanceof ZImageBackendError) || typeof candidate !== 'string' || !candidate.trim()) return error;
  return new ZImageBackendError(
    error.code,
    `${error.message} (source: ${source}; path: ${candidate.trim()})`,
    {
      status: error.status,
      retryable: error.retryable,
      details: { ...(error.details ?? {}), source, path: candidate.trim() },
    },
  );
}

function plainObject(value, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) {
    throw backendError('Z_IMAGE_CONFIG_INVALID', `${label} must be an object`);
  }
  return value;
}

function finiteNumber(value, label, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw backendError('Z_IMAGE_CONFIG_INVALID', `${label} must be a number from ${minimum} through ${maximum}`);
  }
  return value;
}

function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw backendError('Z_IMAGE_CONFIG_INVALID', `${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function boolean(value, label) {
  if (typeof value !== 'boolean') throw backendError('Z_IMAGE_CONFIG_INVALID', `${label} must be a boolean`);
  return value;
}

function normalizeDtype(value, label, allowed = Z_IMAGE_DTYPES) {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw backendError('Z_IMAGE_CONFIG_INVALID', `${label} is unsupported`, { allowed: [...allowed] });
  }
  if (value === 'float16') return 'fp16';
  if (value === 'fp32') return 'float32';
  return value;
}

function normalizeQType(value, label) {
  if (typeof value !== 'string' || !Q_TYPES.has(value) || value.includes('/') || value.includes('\\') || value.includes('|')) {
    throw backendError('Z_IMAGE_REMOTE_RESOURCE', `${label} must be a local, non-downloading quantization type`, { allowed: [...Q_TYPES] });
  }
  return value;
}

function isAbsoluteLocalPath(value) {
  return typeof value === 'string' && ABSOLUTE_PATH.test(value.trim()) && !value.includes('\0');
}

function localPath(value, label) {
  if (!isAbsoluteLocalPath(value)) {
    throw backendError('Z_IMAGE_PATH_UNTRUSTED', `${label} must be an absolute local path`);
  }
  return path.normalize(value.trim());
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertTrusted(candidate, label, trustedRoots = []) {
  if (!trustedRoots.length) return;
  const roots = trustedRoots.map((root) => localPath(root, 'trusted root'));
  if (!roots.some((root) => isWithin(root, candidate))) {
    throw backendError('Z_IMAGE_PATH_UNTRUSTED', `${label} is outside the configured trusted roots`);
  }
}

async function inspectLocal(filePath, label, { kind = 'any', trustedRoots = [], lstatImpl = lstat } = {}) {
  const candidate = localPath(filePath, label);
  assertTrusted(candidate, label, trustedRoots);
  let details;
  try {
    details = await lstatImpl(candidate);
  } catch (error) {
    throw backendError('Z_IMAGE_PATH_MISSING', `${label} does not exist: ${candidate}`, { path: candidate, reason: error?.code ?? 'ENOENT' });
  }
  if (details.isSymbolicLink?.()) throw backendError('Z_IMAGE_PATH_UNTRUSTED', `${label} must not be a symbolic link`, { path: candidate });
  if (kind === 'file' && !details.isFile?.()) throw backendError('Z_IMAGE_PATH_INVALID', `${label} must be a regular file: ${candidate}`, { path: candidate });
  if (kind === 'directory' && !details.isDirectory?.()) throw backendError('Z_IMAGE_PATH_INVALID', `${label} must be a regular directory: ${candidate}`, { path: candidate });
  return { path: candidate, stat: details };
}

async function optionalDirectoryEntry(root, name, lstatImpl) {
  try {
    const details = await lstatImpl(path.join(root, name));
    return details.isDirectory?.() && !details.isSymbolicLink?.();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function validateDiffusersDirectory(root, label, { lstatImpl = lstat } = {}) {
  const marker = await inspectLocal(path.join(root, 'model_index.json'), `${label} model_index.json`, { kind: 'file', lstatImpl });
  const components = ['transformer', 'text_encoder', 'tokenizer', 'vae'];
  const present = [];
  for (const component of components) {
    if (await optionalDirectoryEntry(root, component, lstatImpl)) present.push(component);
  }
  if (!present.length) {
    throw backendError('Z_IMAGE_MODEL_FORMAT_UNSUPPORTED', `${label} is not a Diffusers directory`, { requiredMarker: 'model_index.json' });
  }
  return { format: 'diffusers-directory', marker: marker.path, components: present };
}

async function validateModelPath(value, label, { modelFormat, extrasPath, trustedRoots = [], lstatImpl = lstat } = {}) {
  const inspected = await inspectLocal(value, label, { trustedRoots, lstatImpl });
  if (inspected.stat.isDirectory?.()) return validateDiffusersDirectory(inspected.path, label, { lstatImpl });
  if (path.basename(inspected.path).toLowerCase() === 'z_image_turbo_bf16.safetensors') {
    throw backendError('Z_IMAGE_MODEL_FORMAT_UNSUPPORTED', `${label} is a ComfyUI inference checkpoint, not an AI Toolkit Diffusers model`, { path: inspected.path, forbiddenAsset: 'z_image_turbo_bf16.safetensors' });
  }
  if (inspected.stat.isFile?.() && path.extname(inspected.path).toLowerCase() === '.safetensors' && modelFormat === 'diffusers-single-file') {
    if (!extrasPath) throw backendError('Z_IMAGE_EXTRAS_MISSING', 'a Diffusers extras path is required for a single-file Z-Image model');
    return { format: 'diffusers-single-file', path: inspected.path };
  }
  throw backendError('Z_IMAGE_MODEL_FORMAT_UNSUPPORTED', `${label} is not a trusted Diffusers model`);
}

async function validateAssistantPath(value, { trustedRoots = [], lstatImpl = lstat, validateAdapter = validateSafetensors } = {}) {
  const inspected = await inspectLocal(value, 'training adapter', { kind: 'file', trustedRoots, lstatImpl });
  if (path.extname(inspected.path).toLowerCase() !== '.safetensors' || !/_v1\.safetensors$/i.test(path.basename(inspected.path))) {
    throw backendError('Z_IMAGE_ADAPTER_INVALID', 'training adapter must be the local v1 .safetensors adapter');
  }
  if (typeof validateAdapter === 'function') {
    try { await validateAdapter(inspected.path); }
    catch (error) { throw backendError('Z_IMAGE_ADAPTER_INVALID', 'training adapter is not a valid safetensors artifact', { reason: error?.code ?? error?.message }); }
  }
  return inspected.path;
}

async function validateTokenizerPath(value, { trustedRoots = [], lstatImpl = lstat } = {}) {
  const inspected = await inspectLocal(value, 'tokenizer path', { kind: 'directory', trustedRoots, lstatImpl });
  const entries = await readdir(inspected.path, { withFileTypes: true });
  if (!entries.some((entry) => entry.isFile() && ['tokenizer.json', 'tokenizer_config.json', 'spiece.model'].includes(entry.name))) {
    throw backendError('Z_IMAGE_TOKENIZER_INVALID', 'tokenizer path does not contain a tokenizer configuration');
  }
  return inspected.path;
}

async function validateTokenizerSource(value, extrasPath, { trustedRoots = [], lstatImpl = lstat } = {}) {
  const tokenizerPath = await validateTokenizerPath(value, { trustedRoots, lstatImpl });
  const expectedPath = path.join(extrasPath, 'tokenizer');
  if (!samePath(tokenizerPath, expectedPath)) {
    throw backendError(
      'Z_IMAGE_TOKENIZER_INVALID',
      'tokenizer path must be the tokenizer subdirectory of extras_name_or_path because AI Toolkit Z-Image loads extras_name_or_path/tokenizer',
      { tokenizerPath, extrasPath, expectedPath },
    );
  }
  return tokenizerPath;
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function dependencyFingerprint(paths, { lstatImpl = lstat } = {}) {
  const entries = [];
  for (const value of paths) {
    const inspected = await inspectLocal(value, 'Z-Image dependency', { lstatImpl });
    entries.push({
      path: inspected.path,
      kind: inspected.stat.isDirectory?.() ? 'directory' : 'file',
      size: inspected.stat.size,
      mtimeMs: inspected.stat.mtimeMs,
      ...(inspected.stat.isFile?.() ? { sha256: await sha256File(inspected.path) } : {}),
    });
  }
  return sha256Json(entries);
}

export function isZImageFamily({ family, baseProfile, preset } = {}) {
  return family === Z_IMAGE_FAMILY
    && (baseProfile === undefined || baseProfile === Z_IMAGE_BASE_PROFILE)
    && (preset === undefined || preset === Z_IMAGE_PRESET || preset === Z_IMAGE_BASE_PROFILE);
}

export function normalizeZImageParameters(input = {}, defaults = DEFAULT_PARAMETERS) {
  const source = plainObject(input, 'Z-Image training parameters');
  const normalized = {};
  const sourceKeys = {};
  for (const [key, rawValue] of Object.entries(source)) {
    if (rawValue === undefined) continue;
    const canonical = PARAMETER_ALIASES[key] ?? key;
    if (!PARAMETER_KEYS.has(canonical)) throw backendError('Z_IMAGE_CONFIG_INVALID', `training parameter is not allowed: ${key}`, { field: key });
    if (Object.hasOwn(normalized, canonical)) {
      if (!Object.is(normalized[canonical], rawValue)) throw backendError('Z_IMAGE_CONFIG_INVALID', `training parameter conflict: ${sourceKeys[canonical]} conflicts with ${key}`, { field: key });
      continue;
    }
    normalized[canonical] = rawValue;
    sourceKeys[canonical] = key;
  }
  const values = { ...defaults, ...normalized };
  values.resolution = integer(values.resolution, 'resolution', 256, 2048);
  if (!Object.hasOwn(normalized, 'width')) values.width = values.resolution;
  if (!Object.hasOwn(normalized, 'height')) values.height = values.resolution;
  values.width = integer(values.width ?? values.resolution, 'width', 256, 4096);
  values.height = integer(values.height ?? values.resolution, 'height', 256, 4096);
  values.batchSize = integer(values.batchSize, 'batchSize', 1, 16);
  values.steps = integer(values.steps, 'steps', 1, 10_000_000);
  values.lr = finiteNumber(values.lr, 'lr', 1e-7, 0.1);
  values.linear = integer(values.linear, 'linear', 1, 1024);
  values.linearAlpha = finiteNumber(values.linearAlpha, 'linearAlpha', 0, 1024);
  values.saveEvery = integer(values.saveEvery, 'saveEvery', 1, 10_000_000);
  values.dtype = normalizeDtype(values.dtype, 'dtype');
  values.saveDtype = normalizeDtype(values.saveDtype, 'saveDtype', SAVE_DTYPES);
  values.seed = integer(values.seed, 'seed', 0, 2_147_483_647);
  values.sampleEvery = integer(values.sampleEvery, 'sampleEvery', 1, 10_000_000);
  values.sampleSteps = integer(values.sampleSteps, 'sampleSteps', 1, 256);
  values.lowVram = boolean(values.lowVram, 'lowVram');
  values.quantize = boolean(values.quantize, 'quantize');
  values.qtype = normalizeQType(values.qtype, 'qtype');
  values.quantizeTextEncoder = boolean(values.quantizeTextEncoder, 'quantizeTextEncoder');
  values.qtypeTextEncoder = normalizeQType(values.qtypeTextEncoder, 'qtypeTextEncoder');
  values.layerOffloading = boolean(values.layerOffloading, 'layerOffloading');
  values.layerOffloadingTextEncoderPercent = finiteNumber(values.layerOffloadingTextEncoderPercent, 'layerOffloadingTextEncoderPercent', 0, 1);
  values.layerOffloadingTransformerPercent = finiteNumber(values.layerOffloadingTransformerPercent, 'layerOffloadingTransformerPercent', 0, 1);
  values.gradientAccumulation = integer(values.gradientAccumulation, 'gradientAccumulation', 1, 1024);
  values.gradientCheckpointing = boolean(values.gradientCheckpointing, 'gradientCheckpointing');
  values.cacheLatents = boolean(values.cacheLatents, 'cacheLatents');
  values.cacheLatentsToDisk = boolean(values.cacheLatentsToDisk, 'cacheLatentsToDisk');
  values.aspectRatioBuckets = boolean(values.aspectRatioBuckets, 'aspectRatioBuckets');
  values.disableSampling = boolean(values.disableSampling, 'disableSampling');
  if (values.captionExtension !== CAPTION_EXTENSION) throw backendError('Z_IMAGE_CONFIG_INVALID', 'captionExtension must be .txt', { field: 'captionExtension' });
  if (values.samplePrompts !== undefined && (!Array.isArray(values.samplePrompts) || values.samplePrompts.some((item) => typeof item !== 'string' || !item.trim() || item.length > 4096))) {
    throw backendError('Z_IMAGE_CONFIG_INVALID', 'samplePrompts must contain non-empty strings');
  }
  return Object.freeze(structuredClone(values));
}

export function resolveZImageTrainingParameters({ family, preset = Z_IMAGE_PRESET, parameters = {} } = {}) {
  if (family !== undefined && family !== Z_IMAGE_FAMILY) {
    throw backendError('Z_IMAGE_SELECTION_INVALID', `preset ${preset} is incompatible with family ${family}`);
  }
  return Object.freeze({
    preset: Z_IMAGE_PRESET,
    selectedPreset: preset,
    parameters: Object.freeze(structuredClone(plainObject(parameters, 'Z-Image training parameters'))),
    values: normalizeZImageParameters(parameters),
  });
}

function firstConfigured(candidates, label) {
  for (const [source, value] of candidates) {
    if (typeof value === 'string' && value.trim()) return { value: value.trim(), source };
  }
  throw backendError('Z_IMAGE_CONFIG_MISSING', `${label} is required; configure one of the local sources`, {
    field: label,
    sources: candidates.map(([source]) => source),
  });
}

function envValue(env, names) {
  for (const name of names) if (typeof env?.[name] === 'string' && env[name].trim()) return [env[name].trim(), name];
  return [undefined, undefined];
}

function configSection(request) {
  const section = request.zImageConfig ?? request.zImage ?? request.aiToolkit ?? {};
  return plainObject(section, 'zImageConfig');
}

function directParameters(section) {
  const direct = {};
  for (const key of PARAMETER_KEYS) if (Object.hasOwn(section, key)) direct[key] = section[key];
  for (const alias of Object.keys(PARAMETER_ALIASES)) if (Object.hasOwn(section, alias)) direct[alias] = section[alias];
  return direct;
}

function safePrompts(section, values, triggerWords) {
  const configured = section.samplePrompts ?? values.samplePrompts;
  if (configured !== undefined) return configured.map((prompt) => prompt.replaceAll('[trigger]', triggerWords[0]));
  return [`${triggerWords[0]}, training sample`];
}

export function resolveZImageTrainingDataDirectory({ datasetDirectory, config = {}, locations } = {}) {
  const section = config.zImageConfig ?? config.zImage ?? config.aiToolkit ?? config;
  const candidates = [
    datasetDirectory,
    section?.trainingDataDirectory,
    section?.datasetDirectory,
    config.trainingDataDirectory,
    config.datasetDirectory,
    locations?.dataset,
  ];
  const selected = candidates.find((candidate) => typeof candidate === 'string' && candidate.trim());
  if (!selected) throw backendError('Z_IMAGE_DATASET_MISSING', 'a direct AI Toolkit training data directory is required', { field: 'datasetDirectory' });
  return localPath(selected, 'datasetDirectory');
}

function samePath(left, right) {
  if (!left || !right) return false;
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

async function inspectDatasetFolder(root, { captionExtension, lstatImpl, readDirectory, readFileImpl }) {
  const entries = await readDirectory(root, { withFileTypes: true });
  const images = entries.filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()));
  if (!images.length) throw backendError('Z_IMAGE_DATASET_EMPTY', 'AI Toolkit training data directory contains no supported images', { path: root });
  const adapterEntries = [];
  for (const image of images) {
    const imagePath = path.join(root, image.name);
    const captionPath = path.join(root, `${path.basename(image.name, path.extname(image.name))}${captionExtension}`);
    const details = await lstatImpl(captionPath).catch((error) => {
      throw backendError('Z_IMAGE_CAPTIONS_INCOMPLETE', `${image.name} is missing its .txt caption`, { imagePath, captionPath, reason: error?.code ?? 'ENOENT' });
    });
    if (!details.isFile?.() || details.isSymbolicLink?.()) {
      throw backendError('Z_IMAGE_CAPTIONS_INCOMPLETE', `${image.name} caption must be a regular file`, { imagePath, captionPath });
    }
    const caption = await readFileImpl(captionPath, 'utf8');
    if (typeof caption !== 'string' || !caption.trim()) {
      throw backendError('Z_IMAGE_CAPTIONS_INCOMPLETE', `${image.name} caption must not be empty`, { imagePath, captionPath });
    }
    adapterEntries.push({
      imagePath,
      captionPath,
      caption,
      imageSha256: await sha256File(imagePath),
      captionSha256: await sha256File(captionPath),
    });
  }
  return { imageDirectory: root, captionDirectory: root, adapterEntries };
}

async function inspectStudioSplit(root, { captionExtension, lstatImpl, readDirectory, readFileImpl }) {
  const imageDirectory = path.join(root, 'images');
  const captionDirectory = path.join(root, 'captions');
  await inspectLocal(imageDirectory, 'dataset images directory', { kind: 'directory', lstatImpl });
  await inspectLocal(captionDirectory, 'dataset captions directory', { kind: 'directory', lstatImpl });
  const entries = await readDirectory(imageDirectory, { withFileTypes: true });
  const images = entries.filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()));
  if (!images.length) throw backendError('Z_IMAGE_DATASET_EMPTY', 'Studio dataset images directory contains no supported images', { path: imageDirectory });
  const adapterEntries = [];
  for (const image of images) {
    const imagePath = path.join(imageDirectory, image.name);
    const captionPath = path.join(captionDirectory, `${path.basename(image.name, path.extname(image.name))}${captionExtension}`);
    const details = await lstatImpl(captionPath).catch((error) => {
      throw backendError('Z_IMAGE_CAPTIONS_INCOMPLETE', `${image.name} is missing its Studio caption`, { imagePath, captionPath, reason: error?.code ?? 'ENOENT' });
    });
    if (!details.isFile?.() || details.isSymbolicLink?.()) {
      throw backendError('Z_IMAGE_CAPTIONS_INCOMPLETE', `${image.name} Studio caption must be a regular file`, { imagePath, captionPath });
    }
    const caption = await readFileImpl(captionPath, 'utf8');
    if (typeof caption !== 'string' || !caption.trim()) {
      throw backendError('Z_IMAGE_CAPTIONS_INCOMPLETE', `${image.name} Studio caption must not be empty`, { imagePath, captionPath });
    }
    adapterEntries.push({
      imagePath,
      captionPath,
      caption,
      imageSha256: await sha256File(imagePath),
      captionSha256: await sha256File(captionPath),
    });
  }
  return { imageDirectory, captionDirectory, adapterEntries };
}

export async function inspectZImageDatasetDirectory(datasetDirectory, { locations, captionExtension = CAPTION_EXTENSION, lstatImpl = lstat, readDirectory = readdir, readFileImpl = readFile } = {}) {
  try {
    const root = await inspectLocal(datasetDirectory, 'datasetDirectory', { kind: 'directory', lstatImpl });
    if (captionExtension !== CAPTION_EXTENSION) throw backendError('Z_IMAGE_CONFIG_INVALID', 'caption extension must be .txt');
    const splitLayout = samePath(locations?.dataset, root.path)
      ? Boolean(locations?.images && locations?.captions)
      : await optionalDirectoryEntry(root.path, 'images', lstatImpl) && await optionalDirectoryEntry(root.path, 'captions', lstatImpl);
    const layout = splitLayout
      ? await inspectStudioSplit(root.path, { captionExtension, lstatImpl, readDirectory, readFileImpl })
      : await inspectDatasetFolder(root.path, { captionExtension, lstatImpl, readDirectory, readFileImpl });
    const datasetContract = splitLayout ? Z_IMAGE_DATASET_ADAPTER : 'ai-toolkit-folder-v1';
    return {
      ok: true,
      layout: splitLayout ? 'studio-split' : 'folder',
      imageCount: layout.adapterEntries.length,
      captionCount: layout.adapterEntries.length,
      folderPath: layout.imageDirectory,
      datasetDirectory: root.path,
      imageDirectory: layout.imageDirectory,
      captionDirectory: layout.captionDirectory,
      captionExtension: CAPTION_EXTENSION,
      datasetContract,
      adapterEntries: layout.adapterEntries,
      datasetFingerprint: sha256Json(layout.adapterEntries.map(({ imagePath, captionPath, caption, imageSha256, captionSha256 }) => ({ imagePath, captionPath, caption, imageSha256, captionSha256 }))),
    };
  } catch (error) {
    if (error instanceof ZImageBackendError) return { ok: false, code: error.code, message: error.message, details: error.details };
    return { ok: false, code: 'Z_IMAGE_DATASET_INVALID', message: 'unable to inspect AI Toolkit training data directory' };
  }
}

export function validateZImageTrainingConfig(config) {
  const value = plainObject(config, 'AI Toolkit config');
  if (value.model?.arch !== 'zimage') throw backendError('Z_IMAGE_CONFIG_INVALID', 'model.arch must be zimage');
  if (!isAbsoluteLocalPath(value.model?.name_or_path)) throw backendError('Z_IMAGE_PATH_UNTRUSTED', 'model.name_or_path must be a local path');
  if (!isAbsoluteLocalPath(value.model?.extras_name_or_path)) throw backendError('Z_IMAGE_PATH_UNTRUSTED', 'model.extras_name_or_path must be a local path');
  if (!isAbsoluteLocalPath(value.model?.assistant_lora_path)) throw backendError('Z_IMAGE_PATH_UNTRUSTED', 'model.assistant_lora_path must be a local path');
  if (!/_v1\.safetensors$/i.test(path.basename(value.model.assistant_lora_path))) throw backendError('Z_IMAGE_ADAPTER_INVALID', 'model.assistant_lora_path must reference the local v1 adapter');
  if (value.model?.model_kwargs?.tokenizer_path !== undefined) {
    throw backendError('Z_IMAGE_CONFIG_INVALID', 'model.model_kwargs.tokenizer_path is not an AI Toolkit Z-Image setting; tokenizer is loaded from extras_name_or_path/tokenizer');
  }
  if (value.network?.type !== 'lora' || !Number.isSafeInteger(value.network?.linear) || !Number.isFinite(value.network?.linear_alpha)) {
    throw backendError('Z_IMAGE_CONFIG_INVALID', 'network.type, network.linear, and network.linear_alpha are required');
  }
  const dataset = value.datasets?.[0];
  const hasFolderDataset = isAbsoluteLocalPath(dataset?.folder_path);
  const hasJsonDataset = isAbsoluteLocalPath(dataset?.dataset_path);
  if (!dataset || (hasFolderDataset === hasJsonDataset) || dataset.caption_ext !== CAPTION_EXTENSION) {
    throw backendError('Z_IMAGE_CONFIG_INVALID', 'datasets must use exactly one local folder_path or official dataset_path JSON adapter, with .txt captions');
  }
  if (!Number.isSafeInteger(value.train?.steps) || typeof value.train?.dtype !== 'string' || value.train?.epochs !== undefined) {
    throw backendError('Z_IMAGE_CONFIG_INVALID', 'train.steps and train.dtype are required; epochs is not supported by AI Toolkit Z-Image');
  }
  if (typeof dataset.buckets !== 'boolean' || typeof dataset.cache_latents !== 'boolean' || typeof dataset.cache_latents_to_disk !== 'boolean') {
    throw backendError('Z_IMAGE_CONFIG_INVALID', 'dataset buckets and latent-cache settings are required');
  }
  if (typeof value.train.gradient_checkpointing !== 'boolean') throw backendError('Z_IMAGE_CONFIG_INVALID', 'train.gradient_checkpointing is required');
  if (!value.save || !value.sample) throw backendError('Z_IMAGE_CONFIG_INVALID', 'save and sample configuration are required');
  if (value.model?.training_adapter !== undefined) throw backendError('Z_IMAGE_CONFIG_INVALID', 'training_adapter is not a supported AI Toolkit setting');
  return structuredClone(value);
}

export async function writeZImageDatasetAdapter(entries, adapterPath, { mkdirImpl = mkdir, writeFileImpl = writeFile } = {}) {
  if (!Array.isArray(entries) || !entries.length) throw backendError('Z_IMAGE_DATASET_EMPTY', 'AI Toolkit JSON dataset adapter requires image/caption entries');
  const target = localPath(adapterPath, 'datasetAdapterPath');
  const mapping = {};
  for (const entry of entries) {
    const imagePath = localPath(entry?.imagePath, 'dataset image path');
    if (typeof entry?.caption !== 'string' || !entry.caption.trim()) throw backendError('Z_IMAGE_CAPTIONS_INCOMPLETE', 'dataset adapter caption must be a non-empty string', { imagePath });
    mapping[imagePath] = { caption: entry.caption };
  }
  const serialized = `${JSON.stringify(mapping, null, 2)}\n`;
  await mkdirImpl(path.dirname(target), { recursive: true });
  await writeFileImpl(target, serialized, { encoding: 'utf8', mode: 0o600 });
  return { path: target, bytes: Buffer.byteLength(serialized, 'utf8'), sha256: sha256Json(mapping) };
}

function datasetCheckPath(outputDirectory, outputName, request, section) {
  const target = localPath(
    request.datasetAdapterPath ?? section.datasetAdapterPath ?? path.join(outputDirectory, `${outputName}.ai-toolkit.dataset.json`),
    'datasetAdapterPath',
  );
  if (!isWithin(outputDirectory, target)) throw backendError('Z_IMAGE_PATH_UNTRUSTED', 'datasetAdapterPath must be inside outputDirectory');
  return target;
}

export async function buildZImageTrainingConfig(request = {}, options = {}) {
  plainObject(request, 'Z-Image training request');
  const section = configSection(request);
  const family = request.family ?? section.family;
  const baseProfile = request.baseProfile ?? section.baseProfile;
  const preset = request.preset ?? section.preset ?? Z_IMAGE_PRESET;
  if (family !== Z_IMAGE_FAMILY || baseProfile !== Z_IMAGE_BASE_PROFILE
      || (preset !== Z_IMAGE_PRESET && preset !== Z_IMAGE_BASE_PROFILE)) {
    throw backendError('Z_IMAGE_SELECTION_INVALID', 'Z-Image training requires family=z-image, baseProfile=z-image-turbo, and the z-image preset');
  }
  const env = options.env ?? process.env;
  const trustedRoots = options.trustedRoots ?? section.trustedRoots ?? [];
  const modelCandidate = firstConfigured([
    ['request', request.baseModelPath],
    ['request', request.baseCheckpoint],
    ['config', section.modelPath ?? section.nameOrPath],
    ...(() => { const [value, source] = envValue(env, ['MINIMAX_H3_Z_IMAGE_MODEL_PATH', 'AI_TOOLKIT_Z_IMAGE_MODEL_PATH']); return [[source ?? 'environment', value]]; })(),
  ], 'baseModelPath');
  const extrasCandidate = firstConfigured([
    ['request', request.extrasPath],
    ['request', request.extrasNameOrPath],
    ['config', section.extrasPath ?? section.extrasNameOrPath],
    ...(() => { const [value, source] = envValue(env, ['MINIMAX_H3_Z_IMAGE_EXTRAS_PATH', 'AI_TOOLKIT_Z_IMAGE_EXTRAS_PATH']); return [[source ?? 'environment', value]]; })(),
  ], 'extrasPath');
  const adapterCandidate = firstConfigured([
    ['request', request.assistantLoraPath],
    ['config', section.assistantLoraPath],
    ...(() => { const [value, source] = envValue(env, ['MINIMAX_H3_Z_IMAGE_ASSISTANT_LORA_PATH', 'AI_TOOLKIT_Z_IMAGE_ASSISTANT_LORA_PATH']); return [[source ?? 'environment', value]]; })(),
  ], 'assistantLoraPath');
  const tokenizerEnv = envValue(env, ['MINIMAX_H3_Z_IMAGE_TOKENIZER_PATH', 'AI_TOOLKIT_Z_IMAGE_TOKENIZER_PATH']);
  const tokenizerCandidate = firstConfigured([
    ['request', request.tokenizerPath],
    ['config', section.tokenizerPath],
    [tokenizerEnv[1] ?? 'environment', tokenizerEnv[0]],
  ], 'tokenizerPath');
  const toolkitCandidate = firstConfigured([
    ['request', request.aiToolkitRoot],
    ['config', section.aiToolkitRoot],
    ...(() => { const [value, source] = envValue(env, ['MINIMAX_H3_AI_TOOLKIT_ROOT', 'AI_TOOLKIT_ROOT']); return [[source ?? 'environment', value]]; })(),
  ], 'aiToolkitRoot');
  const datasetDirectory = resolveZImageTrainingDataDirectory({ datasetDirectory: request.datasetDirectory, config: section, locations: request.datasetLocations });
  const outputDirectory = localPath(request.outputDirectory ?? section.outputDirectory, 'outputDirectory');
  assertTrusted(outputDirectory, 'outputDirectory', trustedRoots);
  const outputName = String(request.outputName ?? section.outputName ?? 'lora');
  if (!SAFE_OUTPUT_NAME.test(outputName)) throw backendError('Z_IMAGE_CONFIG_INVALID', 'outputName is invalid');
  const configPath = localPath(request.configPath ?? section.configPath ?? path.join(outputDirectory, `${outputName}.ai-toolkit.json`), 'configPath');
  if (!isWithin(outputDirectory, configPath)) throw backendError('Z_IMAGE_PATH_UNTRUSTED', 'configPath must be inside outputDirectory');
  const modelPath = localPath(modelCandidate.value, 'baseModelPath');
  const extrasPath = localPath(extrasCandidate.value, 'extrasPath');
  const toolkitRoot = localPath(toolkitCandidate.value, 'aiToolkitRoot');
  assertTrusted(datasetDirectory, 'datasetDirectory', trustedRoots);
  await inspectLocal(toolkitRoot, 'aiToolkitRoot', { kind: 'directory', trustedRoots, lstatImpl: options.lstatImpl });
  await inspectLocal(path.join(toolkitRoot, 'run.py'), 'AI Toolkit run.py', { kind: 'file', trustedRoots, lstatImpl: options.lstatImpl });
  const modelFormat = request.modelFormat ?? section.modelFormat ?? request.baseModel?.format;
  await validateModelPath(modelPath, 'baseModelPath', { modelFormat, extrasPath, trustedRoots, lstatImpl: options.lstatImpl });
  await validateDiffusersDirectory(extrasPath, 'extrasPath', { lstatImpl: options.lstatImpl });
  const assistantLoraPath = await validateAssistantPath(adapterCandidate.value, { trustedRoots, lstatImpl: options.lstatImpl, validateAdapter: options.validateAdapter ?? validateSafetensors });
  const tokenizerPath = await validateTokenizerSource(tokenizerCandidate.value, extrasPath, { trustedRoots, lstatImpl: options.lstatImpl });
  const datasetCheck = await inspectZImageDatasetDirectory(datasetDirectory, {
    locations: request.datasetLocations,
    lstatImpl: options.lstatImpl,
    readDirectory: options.readDirectory,
    readFileImpl: options.readFileImpl,
  });
  if (!datasetCheck.ok) throw backendError(datasetCheck.code, datasetCheck.message, datasetCheck.details);
  const datasetAdapterPath = datasetCheckPath(outputDirectory, outputName, request, section);
  const triggerWords = normalizeTriggerWords(request.triggerWords ?? section.triggerWords);
  const parameterInput = { ...section.parameters, ...section.overrides, ...directParameters(section), ...request.parameters };
  const values = normalizeZImageParameters(parameterInput);
  const samplePrompts = safePrompts(section, values, triggerWords);
  const config = {
    job: 'extension',
    name: outputName,
    training_folder: outputDirectory,
    trigger_word: triggerWords[0],
    performance_log_every: Number.isSafeInteger(section.performanceLogEvery) ? section.performanceLogEvery : 10,
    network: {
      type: 'lora',
      linear: values.linear,
      linear_alpha: values.linearAlpha,
      transformer_only: true,
    },
    datasets: [{
      ...(datasetCheck.layout === 'studio-split' ? { dataset_path: datasetAdapterPath } : { folder_path: datasetDirectory }),
      caption_ext: CAPTION_EXTENSION,
      trigger_word: triggerWords[0],
      resolution: [values.resolution],
      buckets: values.aspectRatioBuckets,
      cache_latents: values.cacheLatents,
      cache_latents_to_disk: values.cacheLatentsToDisk,
      num_frames: 1,
    }],
    train: {
      batch_size: values.batchSize,
      steps: values.steps,
      gradient_accumulation: values.gradientAccumulation,
      train_unet: true,
      train_text_encoder: false,
      gradient_checkpointing: values.gradientCheckpointing,
      noise_scheduler: 'flowmatch',
      optimizer: 'adamw8bit',
      timestep_type: 'weighted',
      content_or_style: 'balanced',
      lr: values.lr,
      dtype: values.dtype,
      disable_sampling: values.disableSampling,
      seed: values.seed,
    },
    model: {
      arch: 'zimage',
      name_or_path: modelPath,
      extras_name_or_path: extrasPath,
      assistant_lora_path: assistantLoraPath,
      low_vram: values.lowVram,
      quantize: values.quantize,
      qtype: values.qtype,
      quantize_te: values.quantizeTextEncoder,
      qtype_te: values.qtypeTextEncoder,
      layer_offloading: values.layerOffloading,
      layer_offloading_text_encoder_percent: values.layerOffloadingTextEncoderPercent,
      layer_offloading_transformer_percent: values.layerOffloadingTransformerPercent,
      model_kwargs: {},
    },
    save: {
      dtype: values.saveDtype,
      save_every: values.saveEvery,
      max_step_saves_to_keep: 1,
      save_format: 'diffusers',
      push_to_hub: false,
    },
    sample: {
      sampler: 'flowmatch',
      sample_every: values.sampleEvery,
      width: values.width,
      height: values.height,
      samples: samplePrompts.map((prompt) => ({ prompt })),
      neg: '',
      seed: values.seed,
      walk_seed: true,
      guidance_scale: 1,
      sample_steps: values.sampleSteps,
      num_frames: 1,
      fps: 1,
    },
  };
  const validated = validateZImageTrainingConfig(config);
  const pythonEnv = envValue(env, ['MINIMAX_H3_AI_TOOLKIT_PYTHON', 'AI_TOOLKIT_PYTHON']);
  const defaultPython = path.join(toolkitRoot, ...(process.platform === 'win32' ? ['venv', 'Scripts', 'python.exe'] : ['venv', 'bin', 'python']));
  const pythonCandidate = firstConfigured([
    ['request', request.python],
    ['config', section.python],
    [pythonEnv[1] ?? 'environment', pythonEnv[0]],
    ['ai-toolkit-venv', defaultPython],
  ], 'python');
  const python = pythonCandidate.value;
  const pythonSource = pythonCandidate.source;
  if (isAbsoluteLocalPath(python)) await inspectLocal(python, 'AI Toolkit Python', { kind: 'file', trustedRoots, lstatImpl: options.lstatImpl });
  const dependencyFingerprintValue = await dependencyFingerprint(
    [modelPath, extrasPath, assistantLoraPath, tokenizerPath],
    { lstatImpl: options.lstatImpl },
  );
  return {
    config: validated,
    configPath,
    datasetDirectory,
    outputDirectory,
    outputName,
    python,
    pythonSource,
    toolkitRoot,
    modelPath,
    extrasPath,
    tokenizerPath,
    assistantLoraPath,
    values,
    triggerWords,
    datasetContract: datasetCheck.datasetContract,
    datasetFingerprint: datasetCheck.datasetFingerprint,
    dependencyFingerprint: dependencyFingerprintValue,
    ...(datasetCheck.layout === 'studio-split' ? {
      datasetAdapterPath,
      datasetAdapterEntries: datasetCheck.adapterEntries,
    } : {}),
    configFingerprint: sha256Json(validated),
    pathSources: {
      baseModel: modelCandidate.source,
      extras: extrasCandidate.source,
      assistantLora: adapterCandidate.source,
      tokenizer: tokenizerCandidate.source,
      aiToolkit: toolkitCandidate.source,
      python: pythonSource,
    },
  };
}

export async function writeZImageTrainingConfig(config, configPath, { mkdirImpl = mkdir, writeFileImpl = writeFile } = {}) {
  const validated = validateZImageTrainingConfig(config);
  const target = localPath(configPath, 'configPath');
  await mkdirImpl(path.dirname(target), { recursive: true });
  const serialized = `${JSON.stringify(validated, null, 2)}\n`;
  await writeFileImpl(target, serialized, { encoding: 'utf8', mode: 0o600 });
  return { path: target, bytes: Buffer.byteLength(serialized, 'utf8'), config: validated };
}

export async function resolveZImageTrainingCommand(request = {}, options = {}) {
  const built = await buildZImageTrainingConfig(request, options);
  if (built.datasetAdapterEntries) {
    await writeZImageDatasetAdapter(built.datasetAdapterEntries, built.datasetAdapterPath, options);
  }
  const written = await writeZImageTrainingConfig(built.config, built.configPath, options);
  const runEntrypoint = path.join(built.toolkitRoot, 'run.py');
  const artifactPath = path.join(built.outputDirectory, `${built.outputName}.safetensors`);
  const command = built.python;
  const args = [runEntrypoint, written.path];
  if ([command, ...args].some((value) => /(?:bearer\s+|hf_[a-z0-9]{8,}|token=|password=|api[_-]?key=)/i.test(String(value)))) {
    throw backendError('Z_IMAGE_CONFIG_INVALID', 'resolved AI Toolkit command contains a secret');
  }
  return Object.freeze({
    command,
    args: Object.freeze(args),
    cwd: built.toolkitRoot,
    shell: false,
    preset: Z_IMAGE_PRESET,
    selectedPreset: request.preset ?? Z_IMAGE_PRESET,
    backend: 'ai-toolkit',
    aiToolkitVersion: AI_TOOLKIT_VERSION,
    configPath: written.path,
    artifactPath,
    env: Object.freeze({
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      HF_DATASETS_OFFLINE: '1',
      HF_HUB_DISABLE_TELEMETRY: '1',
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    }),
    provenance: Object.freeze({
      backend: 'ai-toolkit',
      aiToolkitVersion: AI_TOOLKIT_VERSION,
      modelArch: 'zimage',
      assistantAdapter: 'local-v1-full-precision-merge',
      offline: true,
      configPath: written.path,
      datasetContract: built.datasetContract,
      ...(built.datasetAdapterPath === undefined ? {} : { datasetAdapterPath: built.datasetAdapterPath }),
      datasetFingerprint: built.datasetFingerprint,
      configFingerprint: built.configFingerprint,
      dependencyFingerprint: built.dependencyFingerprint,
      pathSources: built.pathSources,
    }),
  });
}

function parseClock(value) {
  if (!value) return null;
  const colon = value.match(/^(\d{1,3}):(\d{2})(?::(\d{2}))?$/);
  if (colon) return Number(colon[1]) * (colon[3] ? 3600 : 60) + Number(colon[2]) * (colon[3] ? 60 : 1) + Number(colon[3] ?? 0);
  const units = value.match(/(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s)?/i);
  if (units && units[0].trim()) return Math.round(Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0));
  return null;
}

export function parseZImageTrainingProgress(line) {
  const text = String(line ?? '').replace(ANSI, '').trim();
  if (!text) return null;
  const progress = {};
  const tqdm = text.match(/\b(\d+(?:\.\d+)?)%\s*\|[^|]*\|\s*(\d+)\s*\/\s*(\d+)\s*\[[^<\]]*<([^,\]]+)/i);
  const step = text.match(/(?:global[_ ]?step|training[_ ]step|steps?|step)\s*[:=# ]\s*(\d+)(?:\s*\/\s*(\d+))?/i) ?? text.match(/\b(\d+)\s*\/\s*(\d+)\s*\[/);
  if (tqdm || step) {
    progress.step = Number(tqdm?.[2] ?? step?.[1]);
    const total = Number(tqdm?.[3] ?? step?.[2]);
    if (Number.isFinite(total) && total > 0) progress.totalSteps = total;
    const etaRaw = tqdm?.[4]?.trim();
    if (etaRaw) { progress.eta = etaRaw; const etaSeconds = parseClock(etaRaw); if (etaSeconds !== null) progress.etaSeconds = etaSeconds; }
  }
  const epoch = text.match(/epoch\s*[:=# ]\s*(\d+)(?:\s*\/\s*(\d+))?/i);
  if (epoch) { progress.epoch = Number(epoch[1]); if (epoch[2]) progress.totalEpochs = Number(epoch[2]); }
  const loss = text.match(/(?:train[_ ]?loss|loss)\s*[:= ]\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|nan|inf(?:inity)?)/i);
  if (loss) {
    const numeric = Number(loss[1]);
    if (Number.isFinite(numeric)) progress.loss = numeric;
    else progress.lossRaw = loss[1];
  }
  const eta = text.match(/(?:eta|remaining|time\s+left)\s*[:= ]\s*(\d{1,3}:\d{2}(?::\d{2})?|\d+(?:\.\d+)?\s*[hms](?:\s*\d+(?:\.\d+)?\s*[ms])*)/i);
  if (eta && progress.eta === undefined) {
    progress.eta = eta[1];
    const etaSeconds = parseClock(eta[1]);
    if (etaSeconds !== null) progress.etaSeconds = etaSeconds;
  }
  if (Object.keys(progress).length) return progress;
  return { raw: text };
}

export function createZImageTrainingRunner(options = {}) {
  return createTrainingRunner({ ...options, progressParser: parseZImageTrainingProgress });
}

export async function checkZImageToolkitRuntime({
  aiToolkitRoot,
  modelPath,
  extrasPath,
  assistantLoraPath,
  tokenizerPath,
  modelFormat,
  python,
  env = process.env,
  lstatImpl = lstat,
  validateAdapter = validateSafetensors,
} = {}) {
  const checks = [];
  const check = async (name, callback) => {
    try {
      const details = await callback();
      checks.push({ name, ok: true, ...(details ?? {}) });
    } catch (error) {
      checks.push({ name, ok: false, error: error?.code ?? 'Z_IMAGE_PREREQUISITE_MISSING', message: error?.message ?? 'prerequisite is unavailable', details: error?.details });
    }
  };
  const toolkitCandidate = aiToolkitRoot ?? envValue(env, ['MINIMAX_H3_AI_TOOLKIT_ROOT', 'AI_TOOLKIT_ROOT'])[0];
  await check('aiToolkitRoot', async () => {
    if (!toolkitCandidate) throw backendError('Z_IMAGE_CONFIG_MISSING', 'AI Toolkit root is not configured; set MINIMAX_H3_AI_TOOLKIT_ROOT or AI_TOOLKIT_ROOT', { sources: ['MINIMAX_H3_AI_TOOLKIT_ROOT', 'AI_TOOLKIT_ROOT'] });
    const root = await inspectLocal(toolkitCandidate, 'aiToolkitRoot', { kind: 'directory', lstatImpl });
    const entrypoint = await inspectLocal(path.join(root.path, 'run.py'), 'AI Toolkit run.py', { kind: 'file', lstatImpl });
    return { path: root.path, entrypoint: entrypoint.path, version: AI_TOOLKIT_VERSION };
  });
  await check('python', async () => {
    const root = isAbsoluteLocalPath(toolkitCandidate) ? path.normalize(toolkitCandidate) : undefined;
    const envPython = envValue(env, ['MINIMAX_H3_AI_TOOLKIT_PYTHON', 'AI_TOOLKIT_PYTHON'])[0];
    const defaultPython = root
      ? path.join(root, ...(process.platform === 'win32' ? ['venv', 'Scripts', 'python.exe'] : ['venv', 'bin', 'python']))
      : undefined;
    const candidate = python ?? envPython ?? defaultPython;
    if (!candidate) throw backendError('Z_IMAGE_PYTHON_MISSING', 'AI Toolkit Python is not configured; set MINIMAX_H3_AI_TOOLKIT_PYTHON or AI_TOOLKIT_PYTHON');
    if (isAbsoluteLocalPath(candidate)) {
      const inspected = await inspectLocal(candidate, 'AI Toolkit Python', { kind: 'file', lstatImpl });
      return { path: inspected.path, source: python ? 'request' : envPython ? 'environment' : 'ai-toolkit-venv' };
    }
    if (candidate !== 'python' && candidate !== 'python3') throw backendError('Z_IMAGE_PYTHON_INVALID', 'AI Toolkit Python must be a local executable path or python command', { value: candidate });
    return { command: candidate, source: python ? 'request' : 'environment' };
  });
  const modelEnv = envValue(env, ['MINIMAX_H3_Z_IMAGE_MODEL_PATH', 'AI_TOOLKIT_Z_IMAGE_MODEL_PATH']);
  const modelCandidate = modelPath ?? modelEnv[0];
  const modelSource = modelPath !== undefined && modelPath !== null ? 'request' : modelEnv[1] ?? 'environment';
  const extrasEnv = envValue(env, ['MINIMAX_H3_Z_IMAGE_EXTRAS_PATH', 'AI_TOOLKIT_Z_IMAGE_EXTRAS_PATH']);
  const extrasCandidate = extrasPath ?? extrasEnv[0];
  const extrasSource = extrasPath !== undefined && extrasPath !== null ? 'request' : extrasEnv[1] ?? 'environment';
  await check('model', async () => {
    if (!modelCandidate) throw backendError('Z_IMAGE_CONFIG_MISSING', 'AI Toolkit Diffusers model path is not configured; set MINIMAX_H3_Z_IMAGE_MODEL_PATH or AI_TOOLKIT_Z_IMAGE_MODEL_PATH', { sources: ['MINIMAX_H3_Z_IMAGE_MODEL_PATH', 'AI_TOOLKIT_Z_IMAGE_MODEL_PATH'] });
    try {
      const inspected = await validateModelPath(modelCandidate, 'AI Toolkit Diffusers model', { modelFormat, extrasPath: extrasCandidate, lstatImpl });
      return { path: localPath(modelCandidate, 'AI Toolkit Diffusers model'), format: inspected.format, source: modelSource };
    } catch (error) { throw annotatePrerequisiteError(error, modelSource, modelCandidate); }
  });
  await check('extras', async () => {
    if (!extrasCandidate) throw backendError('Z_IMAGE_CONFIG_MISSING', 'AI Toolkit extras path is not configured; set MINIMAX_H3_Z_IMAGE_EXTRAS_PATH or AI_TOOLKIT_Z_IMAGE_EXTRAS_PATH', { sources: ['MINIMAX_H3_Z_IMAGE_EXTRAS_PATH', 'AI_TOOLKIT_Z_IMAGE_EXTRAS_PATH'] });
    try {
      return { path: (await validateDiffusersDirectory(localPath(extrasCandidate, 'AI Toolkit extras'), 'AI Toolkit extras', { lstatImpl })).marker, source: extrasSource };
    } catch (error) { throw annotatePrerequisiteError(error, extrasSource, extrasCandidate); }
  });
  const adapterEnv = envValue(env, ['MINIMAX_H3_Z_IMAGE_ASSISTANT_LORA_PATH', 'AI_TOOLKIT_Z_IMAGE_ASSISTANT_LORA_PATH']);
  const adapterCandidate = assistantLoraPath ?? adapterEnv[0];
  const adapterSource = assistantLoraPath !== undefined && assistantLoraPath !== null ? 'request' : adapterEnv[1] ?? 'environment';
  await check('assistantAdapter', async () => {
    if (!adapterCandidate) throw backendError('Z_IMAGE_CONFIG_MISSING', 'AI Toolkit assistant adapter path is not configured; set MINIMAX_H3_Z_IMAGE_ASSISTANT_LORA_PATH or AI_TOOLKIT_Z_IMAGE_ASSISTANT_LORA_PATH', { sources: ['MINIMAX_H3_Z_IMAGE_ASSISTANT_LORA_PATH', 'AI_TOOLKIT_Z_IMAGE_ASSISTANT_LORA_PATH'] });
    try { return { path: await validateAssistantPath(adapterCandidate, { lstatImpl, validateAdapter }), source: adapterSource }; }
    catch (error) { throw annotatePrerequisiteError(error, adapterSource, adapterCandidate); }
  });
  const tokenizerEnv = envValue(env, ['MINIMAX_H3_Z_IMAGE_TOKENIZER_PATH', 'AI_TOOLKIT_Z_IMAGE_TOKENIZER_PATH']);
  const tokenizerCandidate = tokenizerPath ?? tokenizerEnv[0];
  const tokenizerSource = tokenizerPath !== undefined && tokenizerPath !== null ? 'request' : tokenizerEnv[1] ?? 'environment';
  await check('tokenizer', async () => {
    if (!tokenizerCandidate) throw backendError('Z_IMAGE_CONFIG_MISSING', 'AI Toolkit tokenizer path is not configured; set MINIMAX_H3_Z_IMAGE_TOKENIZER_PATH or AI_TOOLKIT_Z_IMAGE_TOKENIZER_PATH', { sources: ['MINIMAX_H3_Z_IMAGE_TOKENIZER_PATH', 'AI_TOOLKIT_Z_IMAGE_TOKENIZER_PATH'] });
    try {
      const extrasRoot = await inspectLocal(extrasCandidate, 'AI Toolkit extras', { kind: 'directory', lstatImpl });
      return { path: await validateTokenizerSource(tokenizerCandidate, extrasRoot.path, { lstatImpl }), source: tokenizerSource };
    } catch (error) { throw annotatePrerequisiteError(error, tokenizerSource, tokenizerCandidate); }
  });
  const ok = checks.every((item) => item.ok);
  return {
    ok,
    message: ok ? 'AI Toolkit Z-Image prerequisites are ready' : 'AI Toolkit Z-Image prerequisites are incomplete; no network download is permitted',
    details: { backend: 'ai-toolkit', version: AI_TOOLKIT_VERSION, offline: true, checks },
  };
}
