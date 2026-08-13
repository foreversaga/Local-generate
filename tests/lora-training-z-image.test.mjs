import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import { createLoraTrainingService } from '../server/lora-training/service.mjs';
import {
  parseZImageTrainingProgress,
  resolveZImageTrainingCommand,
} from '../server/lora-training/backends/z-image-ai-toolkit.mjs';

function fakeSafetensors() {
  const header = Buffer.from(JSON.stringify({
    weight: { dtype: 'F32', shape: [1], data_offsets: [0, 4] },
  }));
  const prefix = Buffer.alloc(8);
  prefix.writeBigUInt64LE(BigInt(header.length));
  return Buffer.concat([prefix, header, Buffer.from([0, 0, 0, 0])]);
}

async function fixtureRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'h3-z-image-'));
  const toolkit = path.join(root, 'ai-toolkit');
  const model = path.join(root, 'z-image-diffusers');
  const dataset = path.join(root, 'training-data');
  const tokenizer = path.join(model, 'tokenizer');
  const output = path.join(root, 'output');
  await Promise.all([
    mkdir(path.join(toolkit), { recursive: true }),
    mkdir(path.join(model, 'transformer'), { recursive: true }),
    mkdir(path.join(model, 'tokenizer'), { recursive: true }),
    mkdir(path.join(dataset), { recursive: true }),
    mkdir(output, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(toolkit, 'run.py'), '# test fixture\n', 'utf8'),
    writeFile(path.join(model, 'model_index.json'), '{}\n', 'utf8'),
    writeFile(path.join(model, 'tokenizer', 'tokenizer_config.json'), '{}\n', 'utf8'),
    writeFile(path.join(dataset, 'portrait.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    writeFile(path.join(dataset, 'portrait.txt'), 'zeta, portrait\n', 'utf8'),
    writeFile(path.join(root, 'source.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    writeFile(path.join(root, 'zimage_turbo_training_adapter_v1.safetensors'), fakeSafetensors()),
  ]);
  return {
    root,
    toolkit,
    model,
    tokenizer,
    dataset,
    output,
    adapter: path.join(root, 'zimage_turbo_training_adapter_v1.safetensors'),
  };
}

test('builds a local AI Toolkit Z-Image config and shell:false argv', async () => {
  const fixture = await fixtureRoot();
  try {
    const resolved = await resolveZImageTrainingCommand({
      family: 'z-image',
      baseProfile: 'z-image-turbo',
      preset: 'z-image',
      python: 'python',
      aiToolkitRoot: fixture.toolkit,
      baseModelPath: fixture.model,
      extrasPath: fixture.model,
      tokenizerPath: fixture.tokenizer,
      assistantLoraPath: fixture.adapter,
      datasetDirectory: fixture.dataset,
      outputDirectory: fixture.output,
      outputName: 'zeta-character',
      triggerWords: ['zeta'],
      parameters: {
        rank: 16, alpha: 8, steps: 120, lowVram: true, quantize: true,
        gradientCheckpointing: false, cacheLatents: false, aspectRatioBuckets: false,
      },
    });
    assert.equal(resolved.shell, false);
    assert.equal(resolved.command, 'python');
    assert.equal(resolved.args.length, 2);
    assert.equal(path.basename(resolved.args[0]), 'run.py');
    assert.equal(resolved.args[1], resolved.configPath);
    assert.equal(resolved.backend, 'ai-toolkit');
    assert.deepEqual(resolved.env.HF_HUB_OFFLINE, '1');

    const config = JSON.parse(await readFile(resolved.configPath, 'utf8'));
    assert.equal(config.model.arch, 'zimage');
    assert.equal(config.model.name_or_path, fixture.model);
    assert.equal(config.model.assistant_lora_path, fixture.adapter);
    assert.equal(config.network.type, 'lora');
    assert.equal(config.network.linear, 16);
    assert.equal(config.network.linear_alpha, 8);
    assert.equal(config.datasets[0].folder_path, fixture.dataset);
    assert.equal(config.datasets[0].dataset_path, undefined);
    assert.equal(config.datasets[0].caption_ext, '.txt');
    assert.equal(config.datasets[0].buckets, false);
    assert.equal(config.datasets[0].cache_latents, false);
    assert.equal(config.datasets[0].trigger_word, 'zeta');
    assert.equal(config.train.steps, 120);
    assert.equal(config.train.dtype, 'bf16');
    assert.equal(config.train.epochs, undefined);
    assert.equal(config.train.gradient_checkpointing, false);
    assert.equal(config.model.low_vram, true);
    assert.equal(config.model.quantize, true);
    assert.deepEqual(config.model.model_kwargs, {});
    assert.equal(config.model.training_adapter, undefined);
    const adapterDocument = JSON.parse(await readFile(path.join(fixture.output, 'zeta-character.ai-toolkit.dataset.json'), 'utf8').catch(() => '{}'));
    assert.deepEqual(adapterDocument, {});
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('prepends the configured AI Toolkit FFmpeg directory without replacing PATH', async () => {
  const fixture = await fixtureRoot();
  const inheritedPath = ['C:\\Windows\\System32', 'C:\\Windows'].join(path.delimiter);
  const ffmpegBin = 'C:\\ai-toolkit\\runtime\\ffmpeg\\bin';
  try {
    const resolved = await resolveZImageTrainingCommand({
      family: 'z-image', baseProfile: 'z-image-turbo', preset: 'z-image', python: 'python',
      aiToolkitRoot: fixture.toolkit, baseModelPath: fixture.model, extrasPath: fixture.model,
      tokenizerPath: fixture.tokenizer, assistantLoraPath: fixture.adapter,
      datasetDirectory: fixture.dataset, outputDirectory: fixture.output, outputName: 'ffmpeg-path',
      triggerWords: ['zeta'],
    }, { env: { MINIMAX_H3_AI_TOOLKIT_FFMPEG_BIN: ffmpegBin, PATH: inheritedPath, Path: inheritedPath } });
    const expected = `${ffmpegBin}${path.delimiter}${inheritedPath}`;
    assert.equal(resolved.env.PATH, expected);
    assert.equal(resolved.env.Path, expected);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects remote or unknown ComfyUI model formats before command creation', async () => {
  const fixture = await fixtureRoot();
  const common = {
    family: 'z-image', baseProfile: 'z-image-turbo', preset: 'z-image',
    aiToolkitRoot: fixture.toolkit, extrasPath: fixture.model,
    tokenizerPath: fixture.tokenizer,
    assistantLoraPath: fixture.adapter, datasetDirectory: fixture.dataset,
    outputDirectory: fixture.output, outputName: 'unsafe', triggerWords: ['zeta'],
  };
  try {
    await assert.rejects(
      resolveZImageTrainingCommand({ ...common, baseModelPath: 'Tongyi-MAI/Z-Image-Turbo' }),
      (error) => error.code === 'Z_IMAGE_PATH_UNTRUSTED',
    );
    const comfyCheckpoint = path.join(fixture.root, 'z_image_turbo_bf16.safetensors');
    await writeFile(comfyCheckpoint, fakeSafetensors());
    await assert.rejects(
      resolveZImageTrainingCommand({ ...common, baseModelPath: comfyCheckpoint }),
      (error) => error.code === 'Z_IMAGE_MODEL_FORMAT_UNSUPPORTED',
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('maps the Studio images/captions layout through AI Toolkit dataset_path JSON without copying data', async () => {
  const fixture = await fixtureRoot();
  const studioDataset = path.join(fixture.root, 'studio-dataset');
  const images = path.join(studioDataset, 'images');
  const captions = path.join(studioDataset, 'captions');
  await Promise.all([
    mkdir(images, { recursive: true }),
    mkdir(captions, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(images, 'image-1.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    writeFile(path.join(captions, 'image-1.txt'), 'zeta, studio layout\n', 'utf8'),
  ]);
  try {
    const resolved = await resolveZImageTrainingCommand({
      family: 'z-image', baseProfile: 'z-image-turbo', preset: 'z-image', python: 'python',
      aiToolkitRoot: fixture.toolkit, baseModelPath: fixture.model, extrasPath: fixture.model,
      tokenizerPath: fixture.tokenizer, assistantLoraPath: fixture.adapter,
      datasetDirectory: studioDataset,
      datasetLocations: { dataset: studioDataset, images, captions },
      outputDirectory: fixture.output, outputName: 'studio-zeta', triggerWords: ['zeta'],
      parameters: { steps: 10 },
    });
    const config = JSON.parse(await readFile(resolved.configPath, 'utf8'));
    assert.equal(config.datasets[0].folder_path, undefined);
    assert.match(config.datasets[0].dataset_path, /studio-zeta\.ai-toolkit\.dataset\.json$/);
    assert.equal(resolved.provenance.datasetContract, 'ai-toolkit-json-v1');
    const adapter = JSON.parse(await readFile(config.datasets[0].dataset_path, 'utf8'));
    assert.deepEqual(adapter, { [path.join(images, 'image-1.png')]: { caption: 'zeta, studio layout\n' } });
    assert.deepEqual(await readFile(path.join(images, 'image-1.png')), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(await readFile(path.join(captions, 'image-1.txt'), 'utf8'), 'zeta, studio layout\n');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects epochs in the Z-Image user parameter contract', async () => {
  const fixture = await fixtureRoot();
  try {
    await assert.rejects(
      resolveZImageTrainingCommand({
        family: 'z-image', baseProfile: 'z-image-turbo', preset: 'z-image', python: 'python',
        aiToolkitRoot: fixture.toolkit, baseModelPath: fixture.model, extrasPath: fixture.model,
        tokenizerPath: fixture.tokenizer, assistantLoraPath: fixture.adapter,
        datasetDirectory: fixture.dataset, outputDirectory: fixture.output, outputName: 'epochs',
        triggerWords: ['zeta'], parameters: { epochs: 2 },
      }),
      (error) => error.code === 'Z_IMAGE_CONFIG_INVALID' && /epochs/.test(error.message),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('Z-Image health uses AI Toolkit prerequisites and never the SDXL entrypoint', async () => {
  const fixture = await fixtureRoot();
  const paths = {
    root: path.join(fixture.root, 'health-training'),
    runtime: path.join(fixture.root, 'runtime'),
    jobs: path.join(fixture.root, 'health-training', 'jobs'),
    cache: path.join(fixture.root, 'health-training', 'cache'),
    scheduler: path.join(fixture.root, 'health-training', 'scheduler.json'),
    registry: path.join(fixture.root, 'health-training', 'registry.json'),
  };
  try {
    const service = createLoraTrainingService({
      paths,
      env: {
        MINIMAX_H3_AI_TOOLKIT_ROOT: fixture.toolkit,
        MINIMAX_H3_Z_IMAGE_MODEL_PATH: fixture.model,
        MINIMAX_H3_Z_IMAGE_EXTRAS_PATH: fixture.model,
        MINIMAX_H3_Z_IMAGE_ASSISTANT_LORA_PATH: fixture.adapter,
        MINIMAX_H3_Z_IMAGE_TOKENIZER_PATH: fixture.tokenizer,
        MINIMAX_H3_AI_TOOLKIT_PYTHON: 'python',
      },
      fetchImpl: async () => ({ ok: true, json: async () => ({ models: [] }) }),
      ollamaProbe: async () => ({ ok: true }),
      resolveBaseModel: async () => null,
      comfyLoraDirectory: path.join(fixture.root, 'comfy', 'loras'),
    });
    const health = await service.health({ family: 'z-image', baseProfile: 'z-image-turbo' });
    assert.equal(health.backend, 'ai-toolkit');
    assert.equal(health.checks.some((check) => check.name === 'sdxl_train_network.py'), false);
    assert.equal(health.checks.every((check) => check.ok), true, JSON.stringify(health));
    const malformedProfileHealth = await service.health({ family: 'z-image', baseProfile: 'sdxl-base-1.0' });
    assert.equal(malformedProfileHealth.backend, 'ai-toolkit');
    assert.equal(malformedProfileHealth.checks.some((check) => check.name === 'sdxl_train_network.py'), false);
    const missingAssets = createLoraTrainingService({
      paths: { ...paths, root: path.join(fixture.root, 'missing-health'), jobs: path.join(fixture.root, 'missing-health', 'jobs'), cache: path.join(fixture.root, 'missing-health', 'cache'), scheduler: path.join(fixture.root, 'missing-health', 'scheduler.json'), registry: path.join(fixture.root, 'missing-health', 'registry.json') },
      env: { MINIMAX_H3_AI_TOOLKIT_ROOT: fixture.toolkit, MINIMAX_H3_AI_TOOLKIT_PYTHON: 'python' },
      resolveBaseModel: async () => null,
      comfyLoraDirectory: path.join(fixture.root, 'comfy', 'loras'),
    });
    const failedHealth = await missingAssets.health({ family: 'z-image', baseProfile: 'z-image-turbo' });
    assert.equal(failedHealth.ok, false);
    assert.match(failedHealth.checks.find((check) => check.name === 'model')?.message || '', /MINIMAX_H3_Z_IMAGE_MODEL_PATH/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('parses AI Toolkit step, epoch, loss, ETA, and preserves unknown output', () => {
  assert.deepEqual(
    parseZImageTrainingProgress('step=12/120 epoch: 2/10 loss: 1.25e-3 ETA: 00:42'),
    { step: 12, totalSteps: 120, epoch: 2, totalEpochs: 10, loss: 0.00125, eta: '00:42', etaSeconds: 42 },
  );
  assert.deepEqual(
    parseZImageTrainingProgress('unrecognized trainer status: warming up'),
    { raw: 'unrecognized trainer status: warming up' },
  );
});

test('routes Z-Image through the shared queue without DreamBooth materialization', async () => {
  const fixture = await fixtureRoot();
  const trainingRoot = path.join(fixture.root, 'studio-training');
  const directData = path.join(fixture.root, 'workflow-training-data');
  const directImages = path.join(directData, 'images');
  const directCaptions = path.join(directData, 'captions');
  const comfyLoras = path.join(fixture.root, 'comfy', 'models', 'loras', 'trained');
  const paths = {
    root: trainingRoot,
    runtime: path.join(trainingRoot, 'runtime'),
    jobs: path.join(trainingRoot, 'jobs'),
    cache: path.join(trainingRoot, 'cache'),
    scheduler: path.join(trainingRoot, 'scheduler.json'),
    registry: path.join(trainingRoot, 'registry.json'),
  };
  await Promise.all([mkdir(directImages, { recursive: true }), mkdir(directCaptions, { recursive: true })]);
  await Promise.all([
    writeFile(path.join(directImages, 'subject.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    writeFile(path.join(directCaptions, 'subject.txt'), 'zeta, portrait\n', 'utf8'),
  ]);
  try {
    const service = createLoraTrainingService({
      paths,
      now: () => '2026-08-12T00:00:00.000Z',
      clock: () => new Date('2026-08-12T00:00:00.000Z'),
      comfyLoraDirectory: comfyLoras,
      resolveSource: async () => ({ path: path.join(fixture.root, 'source.png'), fileName: 'source.png', mimeType: 'image/png', assetId: 'input:source.png' }),
      fetchImpl: async (url) => String(url).endsWith('/api/tags')
        ? { ok: true, json: async () => ({ models: [{ name: 'gemma4:latest' }] }) }
        : { ok: true, json: async () => ({ response: JSON.stringify({ caption: 'portrait' }) }) },
      checkTrainer: async () => ({ ok: true, message: 'test trainer ready' }),
      resolveBaseModel: async () => ({ path: fixture.model, format: 'diffusers' }),
      resolveCommand: async (request) => {
        assert.equal(request.family, 'z-image');
        assert.equal(request.parameters.steps, 4);
        assert.equal(request.datasetDirectory, directData);
        return {
          command: 'fake-ai-toolkit', args: ['run.py', 'config.json'], cwd: fixture.toolkit, shell: false,
          backend: 'ai-toolkit', aiToolkitVersion: '0.12.13', configPath: path.join(fixture.root, 'config.json'),
          datasetContract: 'ai-toolkit-json-v1',
          provenance: {
            modelArch: 'zimage', assistantAdapter: 'local-v1-full-precision-merge',
            offline: true,
            datasetContract: 'ai-toolkit-json-v1', datasetFingerprint: 'a'.repeat(64),
            configFingerprint: 'b'.repeat(64), dependencyFingerprint: 'c'.repeat(64),
            pathSources: { baseModel: 'test', extras: 'test', assistantLora: 'test', tokenizer: 'test', aiToolkit: 'test', python: 'test' },
          },
        };
      },
      progressIntervalMs: 0,
      executeTraining: async ({ outputDirectory, reportProgress }) => {
        await reportProgress({ step: 1, totalSteps: 4, loss: 0.2, etaSeconds: 2 });
        const artifactPath = path.join(outputDirectory, 'zeta.safetensors');
        await writeFile(artifactPath, fakeSafetensors());
        return { code: 0, artifactPath };
      },
    });
    const created = await service.createAndStart({
      slug: 'zeta',
      displayName: 'Zeta character',
      family: 'z-image',
      triggerWords: ['zeta'],
      sourceAssetIds: ['input:source.png'],
      config: {
        family: 'z-image',
        baseProfile: 'z-image-turbo',
        presetId: 'z-image',
        trainingDataDirectory: directData,
        outputName: 'zeta',
        overrides: { steps: 4 },
      },
    });
    await service.drainQueue();
    const completed = await service.get(created.job.id);
    assert.equal(completed.job.status, 'succeeded', JSON.stringify(completed.job.config.orchestration));
    assert.equal(completed.job.config.orchestration.progress.loss, 0.2);
    assert.equal(completed.job.config.orchestration.artifact.family, 'z-image');
    assert.equal(completed.job.config.orchestration.artifact.characterName, 'Zeta character');
    assert.equal(completed.job.config.orchestration.artifact.triggerWords[0], 'zeta');
    assert.equal(await readFile(path.join(directCaptions, 'subject.txt'), 'utf8'), 'zeta, portrait\n');
    const registry = await service.listRegistry({ family: 'z-image' });
    assert.equal(registry.length, 1);
    assert.match(registry[0].hash, /^[0-9a-f]{64}$/);
    assert.equal(Number.isSafeInteger(registry[0].size), true);
    assert.equal(registry[0].provenance.datasetContract, 'ai-toolkit-json-v1');
    assert.match(registry[0].provenance.datasetFingerprint, /^[0-9a-f]{64}$/);
    assert.match(registry[0].provenance.configFingerprint, /^[0-9a-f]{64}$/);
    assert.match(registry[0].provenance.dependencyFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(registry[0]).includes('undefined'), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
