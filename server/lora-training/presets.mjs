import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const PRESET_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'presets');
export const PRESET_ALIASES = Object.freeze({
  sdxl: 'sdxl',
  'sdxl-character-balanced': 'sdxl',
  illustrious: 'illustrious',
  'illustrious-character-balanced': 'illustrious',
});
export const PRESET_IDS = Object.freeze(Object.keys(PRESET_ALIASES));
const PRECISIONS = new Set(['no', 'fp16', 'bf16']);
const SECRET_NAME = /(?:token|secret|password|credential|api[_-]?key)/i;
const SECRET_VALUE = /(?:bearer\s+|hf_[a-z0-9]{8,}|(?:token|password|api[_-]?key)=)/i;

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
  for (const key of Object.keys(request)) if (SECRET_NAME.test(key)) throw new TypeError('secrets must be supplied through the runner environment');
  const preset = await loadPreset(request.preset, options);
  const values = { ...preset.defaults, ...(request.parameters ?? {}) };
  const allowed = new Set(['resolution', 'batchSize', 'epochs', 'maxTrainSteps', 'learningRate', 'networkDim', 'networkAlpha', 'saveEveryEpochs', 'mixedPrecision', 'savePrecision', 'seed', 'captionExtension']);
  for (const key of Object.keys(request.parameters ?? {})) {
    if (!allowed.has(key)) throw new TypeError(`training parameter is not allowed: ${key}`);
  }
  const runtimeRoot = requiredPath(request.runtimeRoot, 'runtimeRoot');
  const python = requiredPath(request.python ?? path.join(runtimeRoot, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), 'python');
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
    '--network_alpha', String(integer(values.networkAlpha, 'networkAlpha', 1, 1024)),
    '--save_every_n_epochs', String(integer(values.saveEveryEpochs, 'saveEveryEpochs', 1, 1000)),
    '--mixed_precision', assertEnum(values.mixedPrecision, PRECISIONS, 'mixedPrecision'),
    '--save_precision', assertEnum(values.savePrecision, PRECISIONS, 'savePrecision'),
  ];
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
