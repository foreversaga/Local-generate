import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const PRESET_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'presets');
export const PRESET_ALIASES = Object.freeze({
  sdxl: 'sdxl',
  'sdxl-character-balanced': 'sdxl',
  'sdxl-style-balanced': 'sdxl',
  illustrious: 'illustrious',
  'illustrious-character-balanced': 'illustrious',
  'illustrious-style-balanced': 'illustrious',
});
export const PRESET_IDS = Object.freeze(Object.keys(PRESET_ALIASES));
const MIXED_PRECISIONS = new Set(['no', 'fp16', 'bf16']);
const SAVE_PRECISIONS = new Set(['float', 'fp16', 'bf16']);
const SECRET_NAME = /(?:token|secret|password|credential|api[_-]?key)/i;
const SECRET_VALUE = /(?:bearer\s+|hf_[a-z0-9]{8,}|(?:token|password|api[_-]?key)=)/i;
const SAFE_PATH_REQUEST_KEYS = new Set(['tokenizerCacheDirectory']);

export const TRAINING_PARAMETER_ALIASES = Object.freeze({
  // The UI and the public job shape use the terminology users expect.  The
  // pinned sd-scripts adapter exposes these as network_dim/network_alpha.
  rank: 'networkDim',
  alpha: 'networkAlpha',
  // Keep the older API spelling usable while the command contract remains
  // maxTrainSteps/saveEveryEpochs.
  steps: 'maxTrainSteps',
  saveEvery: 'saveEveryEpochs',
});

export const TRAINING_PARAMETER_KEYS = Object.freeze([
  'resolution', 'batchSize', 'epochs', 'maxTrainSteps', 'learningRate',
  'networkDim', 'networkAlpha', 'saveEveryEpochs', 'mixedPrecision',
  'savePrecision', 'seed', 'captionExtension',
]);

const TRAINING_PARAMETER_SET = new Set(TRAINING_PARAMETER_KEYS);

function parameterObject(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('training parameters must be an object');
  }
  return value;
}

function assertEnum(value, allowed, name) {
  if (!allowed.has(value)) throw new TypeError(`${name} is unsupported`);
  return value;
}

function integer(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function number(value, name, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be a number from ${minimum} through ${maximum}`);
  }
  return value;
}

function requiredPath(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new TypeError(`${name} is required`);
  return path.resolve(value.trim());
}

function requiredExecutable(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new TypeError(`${name} is required`);
  const executable = value.trim();
  // Keep PATH commands (for example `python3`) as commands.  The runtime
  // resolver has already admitted them with a bounded --version probe.
  if (!executable.includes('/') && !executable.includes('\\') && !path.win32.isAbsolute(executable)) return executable;
  return path.isAbsolute(executable) || path.win32.isAbsolute(executable) ? executable : path.resolve(executable);
}

/**
 * Convert public/UI parameter names into the pinned trainer's canonical names.
 * If an alias and its canonical key are both supplied, equal values are
 * accepted; differing values are rejected instead of silently choosing one.
 */
export function normalizeTrainingParameters(value = {}) {
  const input = parameterObject(value);
  const result = {};
  const sourceKeys = {};
  for (const [key, rawValue] of Object.entries(input)) {
    // JSON requests omit undefined values, but direct callers/tests may still
    // provide them.  Treat those as an unset optional field.
    if (rawValue === undefined) continue;
    const canonical = TRAINING_PARAMETER_ALIASES[key] ?? key;
    if (!TRAINING_PARAMETER_SET.has(canonical)) {
      throw new TypeError(`training parameter is not allowed: ${key}`);
    }
    if (Object.hasOwn(result, canonical)) {
      if (!Object.is(result[canonical], rawValue)) {
        throw new TypeError(`training parameter conflict: ${sourceKeys[canonical]} conflicts with ${key}`);
      }
      continue;
    }
    result[canonical] = rawValue;
    sourceKeys[canonical] = key;
  }
  return result;
}

function validateTrainingValues(values) {
  if (values.resolution !== undefined) integer(values.resolution, 'resolution', 256, 2048);
  if (values.batchSize !== undefined) integer(values.batchSize, 'batchSize', 1, 16);
  if (values.epochs !== undefined) integer(values.epochs, 'epochs', 1, 1000);
  if (values.maxTrainSteps !== undefined) integer(values.maxTrainSteps, 'maxTrainSteps', 1, 10000000);
  if (values.learningRate !== undefined) number(values.learningRate, 'learningRate', 1e-7, 0.1);
  if (values.networkDim !== undefined) integer(values.networkDim, 'networkDim', 1, 1024);
  // sd-scripts parses --network_alpha as a float; its LoRA adapter explicitly
  // treats zero as "use rank" (no scaling), so preserve that supported value.
  if (values.networkAlpha !== undefined) number(values.networkAlpha, 'networkAlpha', 0, 1024);
  if (values.saveEveryEpochs !== undefined) integer(values.saveEveryEpochs, 'saveEveryEpochs', 1, 1000);
  if (values.mixedPrecision !== undefined) assertEnum(values.mixedPrecision, MIXED_PRECISIONS, 'mixedPrecision');
  if (values.savePrecision !== undefined) assertEnum(values.savePrecision, SAVE_PRECISIONS, 'savePrecision');
  if (values.seed !== undefined) integer(values.seed, 'seed', 0, 2147483647);
  if (values.captionExtension !== undefined && (typeof values.captionExtension !== 'string' || !/^\.[a-z0-9]{1,8}$/i.test(values.captionExtension))) {
    throw new TypeError('captionExtension is invalid');
  }
  return values;
}

function presetFamily(preset) {
  return preset?.canonicalId;
}

/**
 * Validate a preset/parameter pair without constructing a command.  This is
 * used by preflight and enqueue so invalid requests cannot reach the trainer.
 */
export async function resolveTrainingParameters({ preset, family, parameters = {} } = {}, options = {}) {
  const loaded = await loadPreset(preset, options);
  return resolveLoadedTrainingParameters(loaded, { family, parameters });
}

function resolveLoadedTrainingParameters(loaded, { family, parameters = {} } = {}) {
  if (family !== undefined && family !== presetFamily(loaded)) {
    throw new TypeError(`preset ${loaded.selectedId} is incompatible with family ${family}`);
  }
  const normalized = normalizeTrainingParameters(parameters);
  const values = { ...loaded.defaults, ...normalized };
  validateTrainingValues(values);
  return Object.freeze({
    preset: loaded.canonicalId,
    selectedPreset: loaded.selectedId,
    parameters: Object.freeze(structuredClone(normalized)),
    values: Object.freeze(structuredClone(values)),
  });
}

export async function loadPreset(id, { read = readFile, presetDirectory = PRESET_DIR } = {}) {
  if (typeof id !== 'string' || !Object.hasOwn(PRESET_ALIASES, id)) {
    throw new TypeError(`preset must be one of: ${PRESET_IDS.join(', ')}`);
  }
  const canonicalId = PRESET_ALIASES[id];
  const preset = JSON.parse(await read(path.join(presetDirectory, `${canonicalId}.json`), 'utf8'));
  if (preset.id !== canonicalId || typeof preset.entrypoint !== 'string') throw new TypeError(`preset ${id} is invalid`);
  return Object.freeze({ ...structuredClone(preset), canonicalId, selectedId: id });
}

export async function resolveTrainingCommand(request, options = {}) {
  if (!request || Object.getPrototypeOf(request) !== Object.prototype) throw new TypeError('training request must be an object');
  for (const key of Object.keys(request)) {
    if (!SAFE_PATH_REQUEST_KEYS.has(key) && SECRET_NAME.test(key)) throw new TypeError('secrets must be supplied through the runner environment');
  }
  const preset = await loadPreset(request.preset, options);
  const parameterResolution = resolveLoadedTrainingParameters(preset, {
    family: request.family,
    parameters: request.parameters ?? {},
  });
  const values = parameterResolution.values;
  const runtimeRoot = requiredPath(request.runtimeRoot, 'runtimeRoot');
  const tokenizerCacheDirectory = request.tokenizerCacheDirectory === undefined
    ? null
    : requiredPath(request.tokenizerCacheDirectory, 'tokenizerCacheDirectory');
  const python = requiredExecutable(request.python ?? 'python', 'python');
  const entrypoint = path.join(runtimeRoot, 'sd-scripts', preset.entrypoint);
  const args = [entrypoint,
    '--pretrained_model_name_or_path', requiredPath(request.baseCheckpoint, 'baseCheckpoint'),
    '--train_data_dir', requiredPath(request.datasetDirectory, 'datasetDirectory'),
    '--output_dir', requiredPath(request.outputDirectory, 'outputDirectory'),
    '--output_name', String(request.outputName ?? 'lora'),
    '--network_module', preset.networkModule,
    '--resolution', String(integer(values.resolution, 'resolution', 256, 2048)),
    '--train_batch_size', String(integer(values.batchSize, 'batchSize', 1, 16)),
    '--max_train_epochs', String(integer(values.epochs, 'epochs', 1, 1000)),
    '--learning_rate', String(number(values.learningRate, 'learningRate', 1e-7, 0.1)),
    '--network_dim', String(integer(values.networkDim, 'networkDim', 1, 1024)),
    '--network_alpha', String(number(values.networkAlpha, 'networkAlpha', 0, 1024)),
    '--save_every_n_epochs', String(integer(values.saveEveryEpochs, 'saveEveryEpochs', 1, 1000)),
    '--mixed_precision', assertEnum(values.mixedPrecision, MIXED_PRECISIONS, 'mixedPrecision'),
    '--save_precision', assertEnum(values.savePrecision, SAVE_PRECISIONS, 'savePrecision'),
    // Training images can have different aspect ratios and dimensions larger
    // than the target resolution.  Buckets resize them safely without forcing
    // callers to crop character datasets before training.
    '--enable_bucket',
  ];
  if (tokenizerCacheDirectory) args.push('--tokenizer_cache_dir', tokenizerCacheDirectory);
  if (values.maxTrainSteps !== undefined) args.push('--max_train_steps', String(integer(values.maxTrainSteps, 'maxTrainSteps', 1, 10000000)));
  if (values.seed !== undefined) args.push('--seed', String(integer(values.seed, 'seed', 0, 2147483647)));
  if (values.captionExtension !== undefined) {
    if (!/^\.[a-z0-9]{1,8}$/i.test(values.captionExtension)) throw new TypeError('captionExtension is invalid');
    args.push('--caption_extension', values.captionExtension);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(args[8])) throw new TypeError('outputName is invalid');
  if ([python, ...args].some((value) => SECRET_VALUE.test(value))) throw new TypeError('resolved command must not contain secrets');
  return Object.freeze({
    command: python,
    args: Object.freeze(args),
    cwd: path.dirname(entrypoint),
    shell: false,
    preset: preset.canonicalId,
    selectedPreset: preset.selectedId,
    provenance: Object.freeze({ canonicalPreset: preset.canonicalId, selectedPreset: preset.selectedId }),
  });
}
