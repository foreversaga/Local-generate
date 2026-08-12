import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { installTrainingArtifact } from '../server/lora-training/artifact.mjs';

function errno(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function fakeSafetensors() {
  const header = Buffer.from(JSON.stringify({
    weight: { dtype: 'F32', shape: [1], data_offsets: [0, 4] },
  }));
  const prefix = Buffer.alloc(8);
  prefix.writeBigUInt64LE(BigInt(header.length));
  return Buffer.concat([prefix, header, Buffer.from([0, 0, 0, 0])]);
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'h3-lora-artifact-'));
  const source = path.join(root, 'source.safetensors');
  const targetDirectory = path.join(root, 'trained');
  await mkdir(targetDirectory);
  await writeFile(source, fakeSafetensors());
  return { root, source, targetDirectory };
}

test('Windows artifact staging retries transient EPERM and keeps atomic publish', async () => {
  const value = await fixture();
  try {
    let copyCalls = 0;
    const waits = [];
    const record = await installTrainingArtifact({
      job: { id: 'artifact-job', status: 'succeeded' },
      source: value.source,
      targetDirectory: value.targetDirectory,
      fileName: 'trained.safetensors',
      platform: 'win32',
      sleep: async (milliseconds) => waits.push(milliseconds),
      copy: async (source, target, mode) => {
        copyCalls += 1;
        assert.equal(mode, constants.COPYFILE_EXCL);
        if (copyCalls < 3) {
          await copyFile(source, target, mode);
          throw errno('EPERM', 'sharing violation');
        }
        return copyFile(source, target, mode);
      },
      registerArtifact: async () => {},
    });

    assert.equal(copyCalls, 3);
    assert.deepEqual(waits, [25, 75]);
    assert.equal(record.fileName, 'trained.safetensors');
    assert.equal((await readdir(value.targetDirectory)).join(''), 'trained.safetensors');
    assert.deepEqual(await readFile(path.join(value.targetDirectory, record.fileName)), fakeSafetensors());
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('artifact install never overwrites an existing same-name target', async () => {
  const value = await fixture();
  const target = path.join(value.targetDirectory, 'trained.safetensors');
  const existing = Buffer.from('existing-target');
  try {
    await writeFile(target, existing);
    await assert.rejects(
      installTrainingArtifact({
        job: { id: 'artifact-job', status: 'succeeded' },
        source: value.source,
        targetDirectory: value.targetDirectory,
        fileName: 'trained.safetensors',
        publish: async () => { throw errno('EEXIST', 'target already exists'); },
        registerArtifact: async () => {},
      }),
      (error) => error?.code === 'EEXIST',
    );
    assert.deepEqual(await readFile(target), existing);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('artifact staging reports bounded copy diagnostics after retries are exhausted', async () => {
  const value = await fixture();
  try {
    let copyCalls = 0;
    const waits = [];
    await assert.rejects(
      installTrainingArtifact({
        job: { id: 'artifact-job', status: 'succeeded' },
        source: value.source,
        targetDirectory: value.targetDirectory,
        fileName: 'trained.safetensors',
        platform: 'win32',
        sleep: async (milliseconds) => waits.push(milliseconds),
        copy: async () => {
          copyCalls += 1;
          throw errno('EPERM', 'sharing violation');
        },
        registerArtifact: async () => {},
      }),
      (error) => error?.code === 'EPERM'
        && error?.details?.operation === 'copy'
        && error?.details?.phase === 'artifact-staging'
        && error?.details?.attempts === 5
        && error?.details?.retryable === true,
    );
    assert.equal(copyCalls, 5);
    assert.deepEqual(waits, [25, 75, 200, 500]);
    assert.deepEqual(await readdir(value.targetDirectory), []);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
