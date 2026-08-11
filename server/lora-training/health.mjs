import path from 'node:path';
import { access, constants, stat } from 'node:fs/promises';
import { resolvePythonExecutable, toPublicPythonResolution } from '../runtime/python-resolver.mjs';

async function pathCheck(name, target, mode, checks, { includePath = true } = {}) {
  const details = { name };
  if (includePath) details.path = target;
  try {
    await access(target, mode);
    checks.push({ ...details, ok: true });
  } catch (error) {
    checks.push({ ...details, ok: false, error: error.code ?? error.message });
  }
}

export async function preflightLoraTraining({
  root,
  runtimeRoot = path.join(root ?? '', 'runtime'),
  python,
  pythonResolution,
  resolvePython = resolvePythonExecutable,
  entrypoint = path.join(runtimeRoot, 'sd-scripts', 'sdxl_train_network.py'),
  baseCheckpoint,
  targetDirectory,
  ollamaProbe = async () => ({ ok: true, skipped: true }),
  gpuProbe = async () => ({ ok: true, skipped: true }),
} = {}) {
  const checks = [];
  if (!root || !baseCheckpoint || !targetDirectory) throw new TypeError('root, baseCheckpoint, and targetDirectory are required');
  const resolvedPython = pythonResolution ?? await resolvePython({
    candidateRoots: [runtimeRoot],
    ...(python !== undefined ? { explicitExecutable: python } : {}),
  });
  await pathCheck('root', path.resolve(root), constants.R_OK | constants.W_OK, checks);
  await pathCheck('runtime', path.resolve(runtimeRoot), constants.R_OK, checks);
  if (resolvedPython?.available && resolvedPython.source === 'PATH') {
    checks.push({ name: 'python', ok: true, source: 'PATH', version: resolvedPython.version ?? null });
  } else if (resolvedPython?.available && resolvedPython.executable) {
    await pathCheck('python', path.resolve(resolvedPython.executable), constants.R_OK, checks, { includePath: false });
  } else {
    checks.push({ name: 'python', ok: false, error: resolvedPython?.error?.code ?? 'PYTHON_UNAVAILABLE' });
  }
  await pathCheck('entrypoint', path.resolve(entrypoint), constants.R_OK, checks);
  await pathCheck('baseCheckpoint', path.resolve(baseCheckpoint), constants.R_OK, checks);
  await pathCheck('targetDirectory', path.resolve(targetDirectory), constants.R_OK | constants.W_OK, checks);
  for (const [name, probe] of [['ollama', ollamaProbe], ['gpu', gpuProbe]]) {
    try {
      const result = await probe();
      checks.push({ name, ok: result?.ok !== false, ...(result ?? {}) });
    } catch (error) {
      checks.push({ name, ok: false, error: error.message });
    }
  }
  return { ok: checks.every((check) => check.ok), checks, python: toPublicPythonResolution(resolvedPython) };
}

export async function inspectRuntimeRevision(runtimeRoot, { fileStat = stat } = {}) {
  const gitHead = path.join(runtimeRoot, 'sd-scripts', '.git', 'HEAD');
  try { return { ok: (await fileStat(gitHead)).isFile(), gitHead }; }
  catch (error) { return { ok: false, gitHead, error: error.code ?? error.message }; }
}
