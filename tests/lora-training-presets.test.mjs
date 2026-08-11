import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeTrainingParameters,
  resolveTrainingCommand,
  resolveTrainingParameters,
} from '../server/lora-training/presets.mjs';
import { createPreflightService } from '../server/lora-training/preflight.mjs';

const COMMAND_REQUEST = {
  preset: 'sdxl-character-balanced',
  family: 'sdxl',
  runtimeRoot: 'data/lora-training/runtime',
  baseCheckpoint: 'data/base.safetensors',
  datasetDirectory: 'data/dataset',
  outputDirectory: 'data/output',
  outputName: 'contract-test',
};

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

test('normalizes UI aliases to canonical trainer parameters', () => {
  assert.deepEqual(normalizeTrainingParameters({ rank: 16, alpha: 8, steps: 42, saveEvery: 2 }), {
    networkDim: 16,
    networkAlpha: 8,
    maxTrainSteps: 42,
    saveEveryEpochs: 2,
  });
});

test('rejects conflicting alias and canonical values', () => {
  assert.throws(
    () => normalizeTrainingParameters({ rank: 16, networkDim: 32 }),
    /training parameter conflict: rank conflicts with networkDim/,
  );
  assert.deepEqual(normalizeTrainingParameters({ rank: 16, networkDim: 16 }), { networkDim: 16 });
});

test('rejects unknown parameters before command construction', async () => {
  assert.throws(() => normalizeTrainingParameters({ optimizer: 'adamw' }), /training parameter is not allowed: optimizer/);
  await assert.rejects(
    resolveTrainingCommand({ ...COMMAND_REQUEST, parameters: { optimizer: 'adamw' } }),
    /training parameter is not allowed: optimizer/,
  );
});

test('maps every UI training override to the sd-scripts CLI', async () => {
  const command = await resolveTrainingCommand({
    ...COMMAND_REQUEST,
    parameters: {
      rank: 16,
      alpha: 8.5,
      learningRate: 0.0002,
      epochs: 3,
      batchSize: 2,
      resolution: 768,
      seed: 7,
      steps: 200,
      saveEvery: 2,
    },
  });
  assert.equal(flagValue(command.args, '--network_dim'), '16');
  assert.equal(flagValue(command.args, '--network_alpha'), '8.5');
  assert.equal(flagValue(command.args, '--learning_rate'), '0.0002');
  assert.equal(flagValue(command.args, '--max_train_epochs'), '3');
  assert.equal(flagValue(command.args, '--train_batch_size'), '2');
  assert.equal(flagValue(command.args, '--resolution'), '768');
  assert.equal(flagValue(command.args, '--max_train_steps'), '200');
  assert.equal(flagValue(command.args, '--save_every_n_epochs'), '2');
  assert.equal(flagValue(command.args, '--seed'), '7');
  // Trainer defaults to .caption, while this project writes .txt sidecars.
  assert.equal(flagValue(command.args, '--caption_extension'), '.txt');
});

test('accepts trainer-supported float alpha and save precision', async () => {
  const resolved = await resolveTrainingParameters({
    preset: 'sdxl-style-balanced',
    family: 'sdxl',
    parameters: { networkAlpha: 0.5, savePrecision: 'float' },
  });
  assert.equal(resolved.values.networkAlpha, 0.5);
  assert.equal(resolved.values.savePrecision, 'float');
  const zeroAlpha = await resolveTrainingParameters({ preset: 'sdxl', family: 'sdxl', parameters: { alpha: 0 } });
  assert.equal(zeroAlpha.values.networkAlpha, 0);
});

test('rejects family/preset mismatch and out-of-range values', async () => {
  await assert.rejects(
    resolveTrainingParameters({ preset: 'illustrious-character-balanced', family: 'sdxl', parameters: {} }),
    /incompatible with family sdxl/,
  );
  await assert.rejects(
    resolveTrainingParameters({ preset: 'sdxl', family: 'sdxl', parameters: { rank: 0 } }),
    /networkDim must be an integer from 1 through 1024/,
  );
});

test('preflight rejects invalid parameters with an actionable 422 before checks', async () => {
  let checksStarted = false;
  const preflight = createPreflightService({
    dataset: { readManifest: async () => { checksStarted = true; return { images: [] }; } },
  });
  const job = {
    id: '11111111-1111-4111-8111-111111111111',
    revision: 4,
    family: 'sdxl',
    config: { family: 'sdxl', presetId: 'sdxl', overrides: { rank: 16, unsupportedOption: true } },
  };
  await assert.rejects(
    preflight.run(job, job.config),
    (error) => error.status === 422 && error.details.field === 'unsupportedOption' && /unsupportedOption/.test(error.message),
  );
  assert.equal(checksStarted, false);
});
