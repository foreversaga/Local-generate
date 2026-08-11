import path from 'node:path';
import { access, constants, stat } from 'node:fs/promises';

async function pathCheck(name, target, mode, checks) {
  try {
    await access(target, mode);
    checks.push({ name, ok: true, path: target });
  } catch (error) {
    checks.push({ name, ok: false, path: target, error: error.code ?? error.message });
  }
}

export async function preflightLoraTraining({
  root,
  runtimeRoot = path.join(root ?? '', 'runtime'),
  python = path.join(runtimeRoot, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
  entrypoint = path.join(runtimeRoot, 'sd-scripts', 'sdxl_train_network.py'),
  baseCheckpoint,
  targetDirectory,
  ollamaProbe = async () => ({ ok: true, skipped: true }),
  gpuProbe = async () => ({ ok: true, skipped: true }),
} = {}) {
  const checks = [];
  if (!root || !baseCheckpoint || !targetDirectory) throw new TypeError('root, baseCheckpoint, and targetDirectory are required');
  await pathCheck('root', path.resolve(root), constants.R_OK | constants.W_OK, checks);
  await pathCheck('runtime', path.resolve(runtimeRoot), constants.R_OK, checks);
  await pathCheck('python', path.resolve(python), constants.R_OK, checks);
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
  return { ok: checks.every((check) => check.ok), checks };
}

export async function inspectRuntimeRevision(runtimeRoot, { fileStat = stat } = {}) {
  const gitHead = path.join(runtimeRoot, 'sd-scripts', '.git', 'HEAD');
  try { return { ok: (await fileStat(gitHead)).isFile(), gitHead }; }
  catch (error) { return { ok: false, gitHead, error: error.code ?? error.message }; }
}
