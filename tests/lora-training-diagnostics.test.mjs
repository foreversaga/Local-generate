import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import { createLoraTrainingService } from '../server/lora-training/service.mjs';

const JOB_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function pathsFor(root) {
  return { root, runtime: path.join(root, 'runtime'), jobs: path.join(root, 'jobs'), cache: path.join(root, 'cache'), scheduler: path.join(root, 'scheduler.json'), registry: path.join(root, 'registry.json') };
}

function fakePng() { return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]); }

async function createFixture({ createRunner, executeTraining } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'h3-lora-diagnostics-'));
  const paths = pathsFor(root);
  await mkdir(paths.cache, { recursive: true });
  const source = path.join(paths.cache, 'source.png');
  await writeFile(source, fakePng());
  const service = createLoraTrainingService({
    paths,
    jobIdFactory: () => JOB_ID,
    clock: () => new Date('2026-08-11T00:00:00.000Z'),
    now: () => '2026-08-11T00:00:00.000Z',
    comfyLoraDirectory: path.join(root, 'loras'),
    resolveSource: async () => ({ path: source, fileName: 'source.png', mimeType: 'image/png' }),
    fetchImpl: async (url) => String(url).endsWith('/api/tags')
      ? { ok: true, json: async () => ({ models: [{ name: 'gemma4:latest' }] }) }
      : { ok: true, json: async () => ({ response: JSON.stringify({ caption: 'portrait' }) }) },
    preflight: { validateConfig: async () => ({}), run: async () => ({ status: 'pass', token: 'diagnostic-preflight', checks: [] }) },
    resolveBaseModel: async () => ({ path: path.join(root, 'base.safetensors') }),
    resolveCommand: async ({ outputDirectory, outputName, datasetDirectory }) => ({ command: 'fake-trainer', args: ['--train_data_dir', datasetDirectory, '--output_dir', outputDirectory, '--output_name', outputName], cwd: root, shell: false, preset: 'sdxl' }),
    createRunner,
    executeTraining,
  });
  await service.initialize();
  const created = await service.create({ slug: 'diagnostic-job', displayName: 'Diagnostic job', family: 'sdxl', triggerWords: ['subject'], sourceAssetIds: ['input:source.png'], config: { family: 'sdxl', baseProfile: 'sdxl-base-1-0', outputName: 'diagnostic' } });
  await service.start(created.job.id, { expectedRevision: created.job.revision });
  await service.drainQueue();
  return { root, paths, service, jobId: created.job.id };
}

test('trainer failure persists bounded safe diagnostics and UTF-8 environment', async () => {
  let capturedEnv;
  const value = await createFixture({
    createRunner: () => ({ run: async (_resolved, { env }) => {
      capturedEnv = env;
      return { code: 7, logs: Array.from({ length: 500 }, (_, index) => ({ channel: 'stderr', line: `failure-${index} C:\\private\\secret\\model.safetensors` })) };
    } }),
  });
  try {
    assert.equal(capturedEnv.PYTHONUTF8, '1');
    assert.equal(capturedEnv.PYTHONIOENCODING, 'utf-8');
    const details = await value.service.get(value.jobId);
    assert.equal(details.job.status, 'failed');
    assert.equal(details.job.config.orchestration.error.code, 'TRAINER_FAILED');
    assert.equal(details.job.config.orchestration.error.details.exitCode, 7);
    assert.doesNotMatch(details.job.config.orchestration.error.details.stderrTail, /C:\\private/);
    const diagnosticPath = path.join(value.paths.jobs, value.jobId, 'logs', 'trainer-attempt-1.json');
    const diagnostic = JSON.parse(await readFile(diagnosticPath, 'utf8'));
    assert.equal(diagnostic.exitCode, 7);
    assert.equal(diagnostic.stderrTail.length, 40);
    assert.ok(diagnostic.stderrTail.every((line) => !/C:\\private/.test(line)));
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('missing artifact is a distinct terminal error after a zero exit', async () => {
  const value = await createFixture({ executeTraining: async () => ({ code: 0 }) });
  try {
    const details = await value.service.get(value.jobId);
    assert.equal(details.job.status, 'failed');
    assert.equal(details.job.config.orchestration.error.code, 'ARTIFACT_MISSING');
    assert.match(details.job.config.orchestration.error.message, /artifact/i);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
