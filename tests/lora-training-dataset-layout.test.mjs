import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';

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

test('generated fixture is non-empty to the pinned sd-scripts DreamBooth parser', async (t) => {
  const python = path.join('data', 'lora-training', 'runtime', 'venv', 'Scripts', 'python.exe');
  try { await access(python); } catch { t.skip('pinned sd-scripts venv is unavailable'); return; }
  const value = await fixture();
  try {
    const materialized = await value.dataset.materializeTrainerDataset(value.job.id, { triggerWords: value.job.triggerWords });
    const script = 'import json,sys; from pathlib import Path; sys.path.insert(0,sys.argv[2]); from library import config_util; p=config_util.generate_dreambooth_subsets_config_by_subdirs(sys.argv[1], None); imgs=[x for s in p for x in Path(s["image_dir"]).iterdir() if x.suffix.lower() != ".txt"]; caps=[x for s in p for x in Path(s["image_dir"]).glob("*.txt")]; print(json.dumps({"subsets":len(p),"images":len(imgs),"captions":len(caps)}))';
    const { stdout } = await execFileAsync(python, ['-c', script, materialized.root, path.resolve('data/lora-training/runtime/sd-scripts')], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
    assert.deepEqual(parsed, { subsets: 1, images: 39, captions: 39 });
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
