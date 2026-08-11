#!/usr/bin/env node
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

const testMode = process.env.LORA_TRAINING_TEST_MODE === '1';
const allowlist = new Set((process.env.LORA_FAKE_RUNNER_ALLOWLIST ?? '').split(',').map((item) => item.trim()).filter(Boolean));
const jobId = process.env.LORA_TRAINING_JOB_ID;
if (!testMode || !jobId || !allowlist.has(jobId)) {
  process.stderr.write('Fake LoRA runner is restricted to explicitly allowlisted test jobs.\n');
  process.exitCode = 64;
} else {
  const outputDirectory = path.resolve(argument('--output_dir', process.cwd()));
  const outputName = argument('--output_name', 'fake-lora');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(outputName)) throw new Error('invalid output name');
  for (let step = 1; step <= 4; step += 1) {
    const loss = (1 / (step + 1)).toFixed(4);
    process.stdout.write(`epoch 1/1 step ${step}/4 loss=${loss} ETA=00:0${4 - step}\n`);
  }
  const headerObject = { weight: { dtype: 'F32', shape: [1], data_offsets: [0, 4] }, __metadata__: { fixture: 'deterministic-test-only' } };
  const rawHeader = Buffer.from(JSON.stringify(headerObject), 'utf8');
  const paddedLength = Math.ceil(rawHeader.length / 8) * 8;
  const header = Buffer.alloc(paddedLength, 0x20);
  rawHeader.copy(header);
  const prefix = Buffer.alloc(8);
  prefix.writeBigUInt64LE(BigInt(paddedLength));
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, `${outputName}.safetensors`), Buffer.concat([prefix, header, Buffer.alloc(4)]), { flag: 'wx' });
}
