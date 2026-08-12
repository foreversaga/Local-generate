import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { access as fsAccess, mkdir as fsMkdir, open as fsOpen, readdir as fsReaddir, unlink as fsUnlink } from 'node:fs/promises';
import { constants } from 'node:fs';

export const DEFAULT_LORA_OUTPUT_NAME = 'my-character';

const LEGACY_DEFAULT_LORA_OUTPUT_NAME = 'my-character-lora';
const SAFE_OUTPUT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const TRANSIENT_TARGET_ERRORS = new Set(['EACCES', 'EBUSY', 'EPERM']);
const PROBE_RETRY_DELAYS_MS = Object.freeze([25, 75, 200]);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function errorCode(error) {
  return error?.code ?? 'UNKNOWN';
}
function outputNameFrom(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function fallbackOutputName(value) {
  const cleaned = outputNameFrom(value)
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[^A-Za-z0-9]+/g, '')
    .replace(/[^A-Za-z0-9]+$/g, '')
    .slice(0, 128);
  return cleaned && SAFE_OUTPUT_NAME.test(cleaned) ? cleaned : DEFAULT_LORA_OUTPUT_NAME;
}

function fileNameForOutputName(value) {
  const outputName = outputNameFrom(value);
  return SAFE_OUTPUT_NAME.test(outputName) ? `${outputName}.safetensors` : null;
}

function compareName(value) {
  return String(value).normalize('NFKC').toLocaleLowerCase('en-US');
}

function unique(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = compareName(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function resolveArtifactTargetNames({ job, config } = {}) {
  const requestedOutputName = config?.outputName === undefined
    ? outputNameFrom(job?.slug) || DEFAULT_LORA_OUTPUT_NAME
    : outputNameFrom(config.outputName);
  const requestedFileName = fileNameForOutputName(requestedOutputName);
  const triggerSource = Array.isArray(job?.triggerWords)
    ? job.triggerWords.find((value) => outputNameFrom(value))
    : undefined;
  const derivedDefault = fallbackOutputName(config?.characterName || triggerSource || DEFAULT_LORA_OUTPUT_NAME);
  const defaultFileNames = unique([
    fileNameForOutputName(derivedDefault),
    fileNameForOutputName(DEFAULT_LORA_OUTPUT_NAME),
    fileNameForOutputName(LEGACY_DEFAULT_LORA_OUTPUT_NAME),
  ].filter(Boolean));
  return { requestedOutputName, requestedFileName, defaultFileNames };
}

async function probeWritableTarget(directory, {
  openFile = fsOpen,
  removeFile = fsUnlink,
  platform = process.platform,
  sleep = delay,
} = {}) {
  let lastError;
  for (let attempt = 0; attempt <= PROBE_RETRY_DELAYS_MS.length; attempt += 1) {
    const probePath = path.join(directory, `.h3-lora-preflight-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await openFile(probePath, 'wx', 0o600);
      await handle.close();
      handle = undefined;
      await removeFile(probePath);
      return null;
    } catch (error) {
      lastError = error;
      if (handle) await handle.close().catch(() => {});
      await removeFile(probePath).catch(() => {});
      const canRetry = platform === 'win32'
        && TRANSIENT_TARGET_ERRORS.has(errorCode(error))
        && attempt < PROBE_RETRY_DELAYS_MS.length;
      if (!canRetry) break;
      await sleep(PROBE_RETRY_DELAYS_MS[attempt]);
    }
  }
  return lastError;
}

function failure(message, code, details = {}) {
  return { ok: false, status: 'fail', message, details: { code, ...details } };
}

export async function checkArtifactTarget({
  job,
  config,
  targetDirectory,
  makeDirectory = fsMkdir,
  checkAccess = fsAccess,
  readDirectory = fsReaddir,
  openFile = fsOpen,
  removeFile = fsUnlink,
  platform = process.platform,
  sleep = delay,
} = {}) {
  if (typeof targetDirectory !== 'string' || !targetDirectory) {
    return failure('ComfyUI LoRA target directory is not configured', 'ARTIFACT_TARGET_UNAVAILABLE');
  }

  const names = resolveArtifactTargetNames({ job, config });
  if (!names.requestedFileName) {
    return failure('LoRA output filename is invalid', 'ARTIFACT_NAME_INVALID', {
      outputName: names.requestedOutputName,
    });
  }

  const directory = path.resolve(targetDirectory);
  try {
    await makeDirectory(directory, { recursive: true });
    await checkAccess(directory, constants.R_OK | constants.W_OK);
  } catch (error) {
    return failure('ComfyUI LoRA target directory is not writable', 'ARTIFACT_TARGET_UNWRITABLE', {
      reason: errorCode(error),
    });
  }

  let entries;
  try {
    entries = await readDirectory(directory, { withFileTypes: true });
  } catch (error) {
    return failure('ComfyUI LoRA target directory cannot be inspected', 'ARTIFACT_TARGET_UNREADABLE', {
      reason: errorCode(error),
    });
  }

  const existing = new Map(entries.map((entry) => [compareName(entry.name), entry.name]));
  const requestedExisting = existing.get(compareName(names.requestedFileName));
  if (requestedExisting) {
    return failure(
      `LoRA output ${names.requestedFileName} already exists; choose a different filename before training`,
      'ARTIFACT_NAME_CONFLICT',
      {
        fileName: names.requestedFileName,
        existingFileName: requestedExisting,
        defaultFileNames: names.defaultFileNames,
      },
    );
  }

  const defaultConflicts = names.defaultFileNames
    .map((fileName) => existing.get(compareName(fileName)))
    .filter(Boolean);
  const probeError = await probeWritableTarget(directory, { openFile, removeFile, platform, sleep });
  if (probeError) {
    return failure('ComfyUI LoRA target directory failed the write check', 'ARTIFACT_TARGET_UNWRITABLE', {
      reason: errorCode(probeError),
    });
  }

  if (defaultConflicts.length) {
    return {
      ok: true,
      status: 'warning',
      message: `Existing default LoRA file(s) detected: ${defaultConflicts.join(', ')}; current output will use ${names.requestedFileName}`,
      details: {
        code: 'DEFAULT_ARTIFACT_EXISTS',
        fileName: names.requestedFileName,
        defaultConflicts: unique(defaultConflicts),
      },
    };
  }

  return {
    ok: true,
    status: 'pass',
    message: `LoRA output ${names.requestedFileName} is available and the target directory is writable`,
    details: { fileName: names.requestedFileName },
  };
}
