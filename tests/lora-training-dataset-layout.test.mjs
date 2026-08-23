import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';

import { atomicWriteJson, createJobStore } from '../server/lora-training/store.mjs';
import { createDatasetService } from '../server/lora-training/dataset.mjs';

const execFileAsync = promisify(execFile);
const JOB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function pathsFor(root) {
  return {
    root,
    runtime: path.join(root, 'runtime'),
    jobs: path.join(root, 'jobs'),
    cache: path.join(root, 'cache'),
    scheduler: path.join(root, 'scheduler.json'),
    registry: path.join(root, 'registry.json'),
  };
}

function fakePng(seed) {
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(`fixture-${seed}`)]);
}

function errno(code, message = code) {
  return Object.assign(new Error(message), { code });
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'h3-lora-layout-'));
  const paths = pathsFor(root);
  await mkdir(paths.cache, { recursive: true });
  const source = path.join(paths.cache, 'source.png');
  await writeFile(source, fakePng('shared'));
  const store = createJobStore({ paths, idFactory: () => JOB_ID, clock: () => new Date('2026-08-11T00:00:00.000Z') });
  const job = await store.createJob({ slug: 'layout-fixture', displayName: 'Layout fixture', family: 'sdxl', triggerWords: ['my_trigger'], assetIds: [], config: { family: 'sdxl' } });
  const dataset = createDatasetService({ paths, resolveSource: async () => ({ path: source, fileName: 'source.png', mimeType: 'image/png' }) });
  const inputs = Array.from({ length: 39 }, (_, index) => ({ assetId: `input:fixture-${index}.png` }));
  await dataset.importImages(job.id, inputs);
  const manifest = await dataset.readManifest(job.id);
  const locations = dataset.getLocations(job.id);
  await mkdir(locations.captions, { recursive: true });
  await atomicWriteJson(path.join(locations.captions, 'manifest.json'), {
    schemaVersion: 1, jobId: job.id, revision: 1, datasetRevision: manifest.revision,
    records: manifest.images.map((image) => ({ imageId: image.id, imageFile: image.fileName, status: 'ready', caption: 'my_trigger, portrait' })),
  });
  await Promise.all(manifest.images.map((image) => writeFile(path.join(locations.captions, `${image.id}.txt`), 'my_trigger, portrait\n')));
  return { root, paths, job, dataset, manifest, locations };
}

test('materializes 39 split pairs into DreamBooth layout and refreshes stale files', async () => {
  const value = await fixture();
  try {
    const first = await value.dataset.materializeTrainerDataset(value.job.id, { classTokens: '../Unsafe/..', repeats: 2 });
    assert.equal(first.imageCount, 39);
    assert.equal(first.captionCount, 39);
    assert.equal(first.subset, '2_unsafe');
    const subsetPath = path.join(first.root, first.subset);
    assert.equal((await readdir(subsetPath)).length, 78);
    const stale = path.join(subsetPath, 'stale.png');
    await writeFile(stale, fakePng('stale'));
    const second = await value.dataset.materializeTrainerDataset(value.job.id, { classTokens: '../Unsafe/..', repeats: 2 });
    assert.equal(second.subset, first.subset);
    await assert.rejects(access(stale), { code: 'ENOENT' });
    const layout = await value.dataset.inspectTrainerLayout(value.job.id, { classTokens: '../Unsafe/..', repeats: 2 });
    assert.equal(layout.ok, true);
    assert.equal(layout.imageCount, 39);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('retries transient Windows directory swaps and removes the replaced tree', async () => {
  const value = await fixture();
  try {
    const oldFile = path.join(value.locations.trainer, 'legacy', 'old.txt');
    await mkdir(path.dirname(oldFile), { recursive: true });
    await writeFile(oldFile, 'keep only until the swap succeeds\n');
    let renameCalls = 0;
    const waits = [];
    const materialized = await value.dataset.materializeTrainerDataset(value.job.id, {
      classTokens: 'retry',
      platform: 'win32',
      renameImpl: async (source, target) => {
        renameCalls += 1;
        if (renameCalls <= 2) throw errno('EPERM', 'directory handle is temporarily locked');
        return rename(source, target);
      },
      sleep: async (milliseconds) => waits.push(milliseconds),
    });
    assert.equal(materialized.subset, '1_retry');
    assert.equal(renameCalls, 4);
    assert.deepEqual(waits, [25, 75]);
    await assert.rejects(access(oldFile), { code: 'ENOENT' });
    const jobEntries = await readdir(path.join(value.paths.jobs, value.job.id));
    assert.equal(jobEntries.some((entry) => entry.startsWith('.trainer-data-')), false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('uses an isolated trainer root when Windows keeps the existing tree locked', async () => {
  const value = await fixture();
  try {
    const first = await value.dataset.materializeTrainerDataset(value.job.id, { classTokens: 'locked' });
    const waits = [];
    const second = await value.dataset.materializeTrainerDataset(value.job.id, {
      classTokens: 'fresh',
      platform: 'win32',
      renameImpl: async (source, target) => {
        if (path.basename(source) === 'trainer-data') throw errno('EPERM', 'existing trainer directory is locked');
        return rename(source, target);
      },
      sleep: async (milliseconds) => waits.push(milliseconds),
    });
    assert.notEqual(second.root, first.root);
    assert.match(second.root, /trainer-data-[0-9a-f-]+$/i);
    assert.equal(second.subset, '1_fresh');
    assert.equal(second.imageCount, 39);
    assert.equal(second.captionCount, 39);
    assert.deepEqual(waits, [25, 75, 200, 500]);
    await access(path.join(first.root, '1_locked'));
    await access(path.join(second.root, '1_fresh'));
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('uses an isolated trainer root when Windows cannot install a fresh tree', async () => {
  const value = await fixture();
  try {
    const waits = [];
    const materialized = await value.dataset.materializeTrainerDataset(value.job.id, {
      classTokens: 'fresh-install',
      platform: 'win32',
      renameImpl: async (source, target) => {
        if (path.basename(target) === 'trainer-data') throw errno('EPERM', 'directory install is locked');
        return rename(source, target);
      },
      sleep: async (milliseconds) => waits.push(milliseconds),
    });
    assert.match(materialized.root, /trainer-data-[0-9a-f-]+$/i);
    assert.equal(materialized.subset, '1_fresh-install');
    assert.equal(materialized.imageCount, 39);
    assert.equal(materialized.captionCount, 39);
    assert.deepEqual(waits, [25, 75, 200, 500]);
    await access(path.join(materialized.root, '1_fresh-install'));
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('restores the old trainer directory and exposes bounded rename diagnostics', async () => {
  const value = await fixture();
  try {
    const oldFile = path.join(value.locations.trainer, 'legacy', 'old.txt');
    await mkdir(path.dirname(oldFile), { recursive: true });
    await writeFile(oldFile, 'must be restored\n');
    const waits = [];
    const failure = await value.dataset.materializeTrainerDataset(value.job.id, {
      platform: 'win32',
      renameImpl: async (source, target) => {
        if (path.basename(source).startsWith('.trainer-data-stage-')) throw errno('EACCES', 'stage install is denied');
        return rename(source, target);
      },
      sleep: async (milliseconds) => waits.push(milliseconds),
    }).then(() => null, (error) => error);
    assert.equal(failure?.code, 'TRAINER_DATASET_MATERIALIZE_FAILED');
    assert.equal(failure?.details?.operation, 'rename');
    assert.equal(failure?.details?.phase, 'install-stage');
    assert.equal(failure?.details?.attempt, 1);
    assert.equal(failure?.details?.attempts, 1);
    assert.equal(failure?.details?.errno, 'EACCES');
    assert.equal(failure?.details?.relativePath, 'trainer-data');
    assert.equal(failure?.details?.sourceExists, true);
    assert.equal(failure?.details?.targetExists, false);
    assert.deepEqual(waits, []);
    assert.equal(await readFile(oldFile, 'utf8'), 'must be restored\n');
    const jobEntries = await readdir(path.join(value.paths.jobs, value.job.id));
    assert.equal(jobEntries.some((entry) => entry.startsWith('.trainer-data-')), false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('keeps the old trainer backup when rollback is also blocked', async () => {
  const value = await fixture();
  try {
    const oldFile = path.join(value.locations.trainer, 'legacy', 'old.txt');
    await mkdir(path.dirname(oldFile), { recursive: true });
    await writeFile(oldFile, 'recoverable old tree\n');
    const failure = await value.dataset.materializeTrainerDataset(value.job.id, {
      platform: 'win32',
      renameImpl: async (source, target) => {
        const sourceName = path.basename(source);
        if (sourceName.startsWith('.trainer-data-stage-')) throw errno('EACCES', 'stage install is denied');
        if (sourceName.startsWith('.trainer-data-backup-')) throw errno('ENOTEMPTY', 'directory is still in use');
        return rename(source, target);
      },
      sleep: async () => {},
    }).then(() => null, (error) => error);
    assert.equal(failure?.code, 'TRAINER_DATASET_MATERIALIZE_FAILED');
    assert.equal(failure?.details?.phase, 'install-stage');
    assert.equal(failure?.details?.rollback?.phase, 'restore-existing');
    assert.equal(failure?.details?.rollback?.attempts, 5);
    await assert.rejects(access(value.locations.trainer), { code: 'ENOENT' });
    const jobEntries = await readdir(path.join(value.paths.jobs, value.job.id));
    const backupEntry = jobEntries.find((entry) => entry.startsWith('.trainer-data-backup-'));
    assert.ok(backupEntry, 'blocked rollback must leave a recoverable backup');
    assert.equal(await readFile(path.join(value.paths.jobs, value.job.id, backupEntry, 'legacy', 'old.txt'), 'utf8'), 'recoverable old tree\n');
    assert.equal(jobEntries.some((entry) => entry.startsWith('.trainer-data-stage-')), false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('cleanup rejection does not replace the primary materialization error', async () => {
  const value = await fixture();
  try {
    const failure = await value.dataset.materializeTrainerDataset(value.job.id, {
      platform: 'linux',
      renameImpl: async () => { throw errno('EACCES', 'rename denied'); },
      removeImpl: () => { throw errno('EPERM', 'cleanup denied'); },
    }).then(() => null, (error) => error);
    assert.equal(failure?.code, 'TRAINER_DATASET_MATERIALIZE_FAILED');
    assert.equal(failure?.details?.operation, 'rename');
    assert.equal(failure?.details?.errno, 'EACCES');
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('does not retry transient rename errors outside Windows', async () => {
  const value = await fixture();
  try {
    let renameCalls = 0;
    const waits = [];
    const failure = await value.dataset.materializeTrainerDataset(value.job.id, {
      platform: 'linux',
      renameImpl: async () => {
        renameCalls += 1;
        throw errno('EPERM', 'permanent on this platform');
      },
      sleep: async () => waits.push(true),
    }).then(() => null, (error) => error);
    assert.equal(failure?.code, 'TRAINER_DATASET_MATERIALIZE_FAILED');
    assert.equal(failure?.details?.attempts, 1);
    assert.equal(failure?.details?.errno, 'EPERM');
    assert.equal(failure?.details?.retryable, false);
    assert.equal(renameCalls, 1);
    assert.deepEqual(waits, []);
    await assert.rejects(access(value.locations.trainer), { code: 'ENOENT' });
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('materialization failure has no unhandled rejection under strict mode', async () => {
  const value = await fixture();
  try {
    const moduleUrl = new URL('../server/lora-training/dataset.mjs', import.meta.url).href;
    const script = `
      import { createDatasetService } from ${JSON.stringify(moduleUrl)};
      const dataset = createDatasetService({ paths: ${JSON.stringify(value.paths)} });
      const failure = await dataset.materializeTrainerDataset(${JSON.stringify(value.job.id)}, {
        platform: 'win32',
        renameImpl: async () => { const error = new Error('strict-mode denial'); error.code = 'EACCES'; throw error; },
        sleep: async () => {},
      }).then(() => null, (error) => error);
      if (!failure || failure.code !== 'TRAINER_DATASET_MATERIALIZE_FAILED' || failure.details?.attempts !== 1) {
        throw new Error('materialization failure did not preserve bounded diagnostics');
      }
      await new Promise((resolve) => setImmediate(resolve));
    `;
    await execFileAsync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', script], {
      cwd: path.resolve('.'), windowsHide: true, maxBuffer: 1024 * 1024,
    });
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('rejects unsafe repeats and missing captions before materialization', async () => {
  const value = await fixture();
  try {
    await assert.rejects(value.dataset.materializeTrainerDataset(value.job.id, { repeats: 0 }), (error) => error.code === 'INVALID_TRAINING_REPEATS');
    const locations = value.dataset.getLocations(value.job.id);
    const captions = JSON.parse(await readFile(path.join(locations.captions, 'manifest.json'), 'utf8'));
    captions.records.pop();
    await atomicWriteJson(path.join(locations.captions, 'manifest.json'), captions);
    await assert.rejects(value.dataset.materializeTrainerDataset(value.job.id), (error) => error.code === 'CAPTIONS_INCOMPLETE');
    await assert.rejects(access(value.locations.trainer), { code: 'ENOENT' });
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
