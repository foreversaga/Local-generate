import assert from 'node:assert/strict';
import test from 'node:test';

import { resolvePythonExecutable, toPublicPythonResolution } from '../server/runtime/python-resolver.mjs';

function fakeRuntime({ files = [], versions = new Map(), executableFailures = new Map() } = {}) {
  const fileSet = new Set(files);
  const statCalls = [];
  const accessCalls = [];
  const execCalls = [];
  const missing = (code = 'ENOENT') => Object.assign(new Error(code), { code });
  return {
    stat: async (target) => {
      statCalls.push(target);
      if (!fileSet.has(target)) throw missing();
      return { isFile: () => true };
    },
    access: async (target) => {
      accessCalls.push(target);
      if (!fileSet.has(target)) throw missing();
    },
    exec: async (command, args) => {
      execCalls.push({ command, args });
      if (executableFailures.has(command)) throw missing(executableFailures.get(command));
      if (!versions.has(command)) throw missing();
      return { stdout: `Python ${versions.get(command)}\n`, stderr: '' };
    },
    statCalls,
    accessCalls,
    execCalls,
  };
}

test('resolves the Windows venv interpreter and probes its version', async () => {
  const root = 'C:\\workspace\\ComfyUI';
  const python = `${root}\\venv\\Scripts\\python.exe`;
  const fake = fakeRuntime({ files: [python], versions: new Map([[python, '3.12.4']]) });
  const result = await resolvePythonExecutable({
    platform: 'win32',
    cwd: 'C:\\workspace',
    candidateRoots: [root],
    env: {},
    ...fake,
  });
  assert.deepEqual(result, { executable: python, source: 'venv', version: '3.12.4', available: true, error: null });
  assert.deepEqual(fake.execCalls, [{ command: python, args: ['--version'] }]);
});

test('uses the Linux venv/bin/python candidate', async () => {
  const root = '/workspace/ComfyUI';
  const python = `${root}/venv/bin/python`;
  const fake = fakeRuntime({ files: [python], versions: new Map([[python, '3.11.9']]) });
  const result = await resolvePythonExecutable({
    platform: 'linux',
    candidateRoots: [root],
    env: {},
    ...fake,
  });
  assert.equal(result.executable, python);
  assert.equal(result.source, 'venv');
  assert.equal(result.version, '3.11.9');
});

test('uses the macOS venv/bin/python candidate', async () => {
  const root = '/Users/test/ComfyUI';
  const python = `${root}/venv/bin/python`;
  const fake = fakeRuntime({ files: [python], versions: new Map([[python, '3.12.1']]) });
  const result = await resolvePythonExecutable({
    platform: 'darwin',
    candidateRoots: [root],
    env: {},
    ...fake,
  });
  assert.equal(result.executable, python);
  assert.equal(result.source, 'venv');
  assert.equal(result.version, '3.12.1');
});

test('MINIMAX_H3_PYTHON has priority and an invalid path fails fast', async () => {
  const fake = fakeRuntime({ versions: new Map([['python3', '3.12.0']]) });
  const result = await resolvePythonExecutable({
    platform: 'linux',
    cwd: '/workspace',
    candidateRoots: ['/workspace/ComfyUI'],
    env: { MINIMAX_H3_PYTHON: '/private/secret/python' },
    ...fake,
  });
  assert.equal(result.available, false);
  assert.equal(result.source, 'MINIMAX_H3_PYTHON');
  assert.equal(result.error.code, 'PYTHON_ENV_INVALID');
  assert.equal(fake.execCalls.length, 0, 'an invalid explicit env path must not fall back to PATH');
  assert.doesNotMatch(JSON.stringify(result.error), /private|secret/);
});

test('a valid explicit env interpreter is probed before any venv or PATH candidate', async () => {
  const explicit = '/opt/custom/python';
  const fallback = '/workspace/ComfyUI/venv/bin/python';
  const fake = fakeRuntime({ files: [explicit, fallback], versions: new Map([[explicit, '3.10.14'], [fallback, '3.11.0']]) });
  const result = await resolvePythonExecutable({
    platform: 'linux',
    candidateRoots: ['/workspace/ComfyUI'],
    env: { MINIMAX_H3_PYTHON: explicit },
    ...fake,
  });
  assert.equal(result.executable, explicit);
  assert.equal(result.source, 'MINIMAX_H3_PYTHON');
  assert.equal(result.version, '3.10.14');
  assert.deepEqual(fake.execCalls.map(({ command }) => command), [explicit]);
});

test('PATH fallback is accepted only after a bounded --version probe and keeps the command string', async () => {
  const fake = fakeRuntime({ versions: new Map([['python3', '3.12.5']]) });
  const result = await resolvePythonExecutable({ platform: 'linux', env: {}, ...fake });
  assert.deepEqual(result, { executable: 'python3', source: 'PATH', version: '3.12.5', available: true, error: null });
  assert.deepEqual(fake.execCalls, [{ command: 'python3', args: ['--version'] }]);
  assert.equal(result.executable, 'python3');
});

test('failed venv probes can continue to a successful PATH fallback', async () => {
  const root = '/workspace/ComfyUI';
  const python = `${root}/venv/bin/python`;
  const fake = fakeRuntime({
    files: [python],
    versions: new Map([['python', '3.9.18']]),
    executableFailures: new Map([[python, 'ETIMEDOUT']]),
  });
  const result = await resolvePythonExecutable({ platform: 'linux', candidateRoots: [root], env: {}, ...fake });
  assert.equal(result.executable, 'python');
  assert.equal(result.source, 'PATH');
  assert.equal(result.version, '3.9.18');
});

test('public diagnostics redact executable directories while preserving resolver metadata', () => {
  const result = toPublicPythonResolution({
    executable: 'C:\\private\\venv\\Scripts\\python.exe',
    source: 'venv',
    version: '3.12.4',
    available: true,
    error: null,
  });
  assert.deepEqual(result, { executable: 'python.exe', source: 'venv', version: '3.12.4', available: true, error: null });
});
