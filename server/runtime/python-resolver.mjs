import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { access as fsAccess, stat as fsStat } from 'node:fs/promises';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(nodeExecFile);
const DEFAULT_PROBE_TIMEOUT_MS = 1500;
const MAX_PROBE_OUTPUT = 4096;

function pathApiFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
}

function commandCandidates(platform) {
  return platform === 'win32' ? ['python.exe', 'python', 'py'] : ['python3', 'python'];
}

function versionFromOutput(stdout, stderr) {
  const text = `${String(stdout ?? '')}\n${String(stderr ?? '')}`.trim();
  const match = text.match(/\bPython\s+([0-9]+(?:\.[0-9]+){1,3}(?:[-+._][0-9A-Za-z.-]+)?)/i);
  return match?.[1] ?? null;
}

function safeProbeError(error) {
  if (!error || typeof error !== 'object') return 'PROBE_FAILED';
  return typeof error.code === 'string' && error.code ? error.code.slice(0, 48) : 'PROBE_FAILED';
}

function unavailableResult({ code, message, source = 'none', attempts = [] } = {}) {
  return {
    executable: null,
    source,
    version: null,
    available: false,
    error: {
      code: code || 'PYTHON_UNAVAILABLE',
      message: message || 'A usable Python interpreter could not be found.',
      source,
      ...(attempts.length ? { attempts } : {}),
    },
  };
}

function normalizeExecutable(value, pathApi, cwd) {
  const candidate = String(value ?? '').trim();
  if (!candidate || candidate.includes('\0')) return null;
  if (pathApi.isAbsolute(candidate)) return pathApi.normalize(candidate);
  return pathApi.resolve(cwd, candidate);
}

async function checkFile(candidate, { stat, access }) {
  try {
    const value = await stat(candidate);
    if (!value?.isFile?.()) return { ok: false, code: 'NOT_FILE' };
  } catch (error) {
    return { ok: false, code: safeProbeError(error) };
  }
  try {
    await access(candidate, fsConstants.R_OK | fsConstants.X_OK);
    return { ok: true };
  } catch (error) {
    return { ok: false, code: safeProbeError(error) };
  }
}

async function probeExecutable(executable, { exec, timeoutMs }) {
  try {
    const result = await exec(executable, ['--version'], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: MAX_PROBE_OUTPUT,
    });
    return { ok: true, version: versionFromOutput(result?.stdout, result?.stderr) };
  } catch (error) {
    return { ok: false, code: safeProbeError(error) };
  }
}

/**
 * Resolve the local Python executable without assuming a host operating
 * system.  The returned executable is either a validated file path or an
 * unmodified PATH command.  PATH commands are never passed through
 * path.resolve: the successful --version probe is the validation.
 */
export async function resolvePythonExecutable(options = {}) {
  const platform = options.platform ?? process.platform;
  const pathApi = pathApiFor(platform);
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const stat = options.stat ?? fsStat;
  const access = options.access ?? fsAccess;
  const exec = options.exec ?? execFileAsync;
  const timeoutValue = Number(options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(timeoutValue) && timeoutValue > 0 ? timeoutValue : DEFAULT_PROBE_TIMEOUT_MS;
  const attempts = [];

  const envConfigured = env && Object.hasOwn(env, 'MINIMAX_H3_PYTHON');
  const envValue = typeof env?.MINIMAX_H3_PYTHON === 'string' ? env.MINIMAX_H3_PYTHON.trim() : '';
  if (envConfigured) {
    if (!envValue) {
      return unavailableResult({
        code: 'PYTHON_ENV_INVALID',
        message: 'MINIMAX_H3_PYTHON is set but empty; configure a valid Python executable path.',
        source: 'MINIMAX_H3_PYTHON',
      });
    }
    const executable = normalizeExecutable(envValue, pathApi, cwd);
    const file = executable ? await checkFile(executable, { stat, access }) : { ok: false, code: 'INVALID_PATH' };
    if (!file.ok) {
      return unavailableResult({
        code: 'PYTHON_ENV_INVALID',
        message: 'MINIMAX_H3_PYTHON does not point to an executable Python interpreter.',
        source: 'MINIMAX_H3_PYTHON',
        attempts: [{ source: 'MINIMAX_H3_PYTHON', error: file.code }],
      });
    }
    const probe = await probeExecutable(executable, { exec, timeoutMs });
    if (!probe.ok) {
      return unavailableResult({
        code: 'PYTHON_ENV_PROBE_FAILED',
        message: 'MINIMAX_H3_PYTHON points to a file that failed the Python --version probe.',
        source: 'MINIMAX_H3_PYTHON',
        attempts: [{ source: 'MINIMAX_H3_PYTHON', error: probe.code }],
      });
    }
    return { executable, source: 'MINIMAX_H3_PYTHON', version: probe.version, available: true, error: null };
  }

  const explicitExecutable = options.explicitExecutable;
  if (explicitExecutable !== undefined && explicitExecutable !== null) {
    const executable = normalizeExecutable(explicitExecutable, pathApi, cwd);
    const file = executable ? await checkFile(executable, { stat, access }) : { ok: false, code: 'INVALID_PATH' };
    if (!file.ok) {
      return unavailableResult({
        code: 'PYTHON_CONFIG_INVALID',
        message: 'The configured Python executable is not an executable file.',
        source: 'configured',
        attempts: [{ source: 'configured', error: file.code }],
      });
    }
    const probe = await probeExecutable(executable, { exec, timeoutMs });
    if (!probe.ok) {
      return unavailableResult({
        code: 'PYTHON_CONFIG_PROBE_FAILED',
        message: 'The configured Python executable failed the Python --version probe.',
        source: 'configured',
        attempts: [{ source: 'configured', error: probe.code }],
      });
    }
    return { executable, source: 'configured', version: probe.version, available: true, error: null };
  }

  const roots = uniqueStrings([
    ...(Array.isArray(options.candidateRoots) ? options.candidateRoots : []),
    options.comfyRoot,
    options.h3Root,
    options.runtimeRoot,
    options.projectRoot,
  ]);
  const venvParts = platform === 'win32' ? ['venv', 'Scripts', 'python.exe'] : ['venv', 'bin', 'python'];
  for (const root of roots) {
    const executable = pathApi.join(root, ...venvParts);
    const file = await checkFile(executable, { stat, access });
    if (!file.ok) {
      attempts.push({ source: 'venv', error: file.code });
      continue;
    }
    const probe = await probeExecutable(executable, { exec, timeoutMs });
    if (!probe.ok) {
      attempts.push({ source: 'venv', error: probe.code });
      continue;
    }
    return { executable, source: 'venv', version: probe.version, available: true, error: null };
  }

  // A PATH command is intentionally left untouched.  A successful, bounded
  // --version probe is the only admission criterion for this fallback.
  for (const executable of commandCandidates(platform)) {
    const probe = await probeExecutable(executable, { exec, timeoutMs });
    if (probe.ok) return { executable, source: 'PATH', version: probe.version, available: true, error: null };
    attempts.push({ source: 'PATH', error: probe.code });
  }

  return unavailableResult({
    code: 'PYTHON_NOT_FOUND',
    message: 'No usable Python interpreter was found in the configured virtual environments or PATH.',
    source: 'none',
    attempts,
  });
}

export function createPythonResolver(options = {}) {
  return Object.freeze({
    resolve: (overrides = {}) => resolvePythonExecutable({ ...options, ...overrides }),
  });
}

/**
 * Health/status consumers receive only a basename and resolver metadata; the
 * actual executable path remains available to the process adapter internally.
 */
export function toPublicPythonResolution(result) {
  const executable = result?.available && typeof result.executable === 'string'
    ? path.win32.basename(path.posix.basename(result.executable))
    : null;
  return {
    executable,
    source: typeof result?.source === 'string' ? result.source : 'none',
    version: typeof result?.version === 'string' ? result.version : null,
    available: result?.available === true,
    error: result?.error && typeof result.error === 'object'
      ? {
          code: typeof result.error.code === 'string' ? result.error.code : 'PYTHON_UNAVAILABLE',
          message: typeof result.error.message === 'string' ? result.error.message : 'Python interpreter unavailable.',
          source: typeof result.error.source === 'string' ? result.error.source : 'none',
          ...(Array.isArray(result.error.attempts)
            ? { attempts: result.error.attempts.map((attempt) => ({
                source: typeof attempt?.source === 'string' ? attempt.source : 'unknown',
                ...(attempt?.error ? { error: String(attempt.error).slice(0, 48) } : {}),
              })) }
            : {}),
        }
      : null,
  };
}
