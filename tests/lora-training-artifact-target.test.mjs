import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';

import { checkArtifactTarget } from '../server/lora-training/artifact-target.mjs';

const JOB = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'training-job',
  triggerWords: ['hero'],
};

test('rejects an existing output file before training', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'h3-lora-target-'));
  try {
    await writeFile(path.join(directory, 'hero.safetensors'), 'existing');
    const result = await checkArtifactTarget({
      job: JOB,
      config: { outputName: 'hero', characterName: 'hero' },
      targetDirectory: directory,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'fail');
    assert.equal(result.details.code, 'ARTIFACT_NAME_CONFLICT');
    assert.equal(result.details.existingFileName, 'hero.safetensors');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('warns about an existing default filename while allowing a distinct output', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'h3-lora-target-'));
  try {
    await writeFile(path.join(directory, 'hero.safetensors'), 'existing default');
    const result = await checkArtifactTarget({
      job: JOB,
      config: { outputName: 'custom-output', characterName: 'hero' },
      targetDirectory: directory,
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'warning');
    assert.equal(result.details.code, 'DEFAULT_ARTIFACT_EXISTS');
    assert.deepEqual(result.details.defaultConflicts, ['hero.safetensors']);
    assert.deepEqual(await readdir(directory), ['hero.safetensors']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('fails when the target write probe reports a Windows permission error', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'h3-lora-target-'));
  try {
    const result = await checkArtifactTarget({
      job: JOB,
      config: { outputName: 'custom-output' },
      targetDirectory: directory,
      platform: 'win32',
      sleep: async () => {},
      openFile: async () => {
        const error = new Error('access denied');
        error.code = 'EPERM';
        throw error;
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.details.code, 'ARTIFACT_TARGET_UNWRITABLE');
    assert.equal(result.details.reason, 'EPERM');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
