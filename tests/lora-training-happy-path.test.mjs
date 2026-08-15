import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";

import { createLoraTrainingService } from "../server/lora-training/service.mjs";

const JOB_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];
const REGISTRY_IDS = [
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];

function pathsFor(root) {
  return {
    root,
    runtime: path.join(root, "runtime"),
    jobs: path.join(root, "jobs"),
    cache: path.join(root, "cache"),
    scheduler: path.join(root, "scheduler.json"),
    registry: path.join(root, "registry.json"),
  };
}

function fakePng(seed) {
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.from(`deterministic-image-${seed}`),
  ]);
}

function fakeSafetensors() {
  const header = Buffer.from(JSON.stringify({
    weight: { dtype: "F32", shape: [1], data_offsets: [0, 4] },
  }));
  const prefix = Buffer.alloc(8);
  prefix.writeBigUInt64LE(BigInt(header.length));
  return Buffer.concat([prefix, header, Buffer.from([0, 0, 0, 0])]);
}

async function allFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else files.push(absolute);
    }
  }
  await visit(root);
  return files;
}

test("create/start captions multiple images, preflights, runs FIFO, and installs discoverable LoRAs", async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "h3-lora-happy-"));
  const trainingRoot = path.join(sandbox, "training-root");
  const comfyLoras = path.join(sandbox, "mock-comfy", "models", "loras", "trained");
  const paths = pathsFor(trainingRoot);

  try {
    await mkdir(paths.cache, { recursive: true });
    const sourceAssets = new Map();
    for (let jobIndex = 0; jobIndex < JOB_IDS.length; jobIndex += 1) {
      for (let imageIndex = 0; imageIndex < 2; imageIndex += 1) {
        const assetId = `input:fixtures/job-${jobIndex + 1}-${imageIndex + 1}.png`;
        const source = path.join(paths.cache, `source-${jobIndex}-${imageIndex}.png`);
        await writeFile(source, fakePng(`${jobIndex}-${imageIndex}`));
        sourceAssets.set(assetId, source);
      }
    }

    let jobIdIndex = 0;
    let registryIdIndex = 0;
    const executionOrder = [];
    const ollamaRequests = [];
    const ollamaUnloadRequests = [];
    const explicitStops = [];
    const clock = () => new Date("2026-08-11T00:00:00.000Z");

    const service = createLoraTrainingService({
      paths,
      clock,
      now: () => "2026-08-11T00:00:00.000Z",
      ownerId: "happy-path-test-owner",
      ollamaModel: "gemma4",
      jobIdFactory: () => JOB_IDS[jobIdIndex++],
      registryIdFactory: () => REGISTRY_IDS[registryIdIndex++],
      comfyLoraDirectory: comfyLoras,
      resolveSource: async ({ assetId }) => ({
        path: sourceAssets.get(assetId),
        fileName: assetId.slice(assetId.lastIndexOf("/") + 1),
        mimeType: "image/png",
        assetId,
      }),
      fetchImpl: async (url, init = {}) => {
        if (String(url).endsWith("/api/tags")) {
          return { ok: true, json: async () => ({ models: [{ name: "gemma4:latest" }] }) };
        }
        const body = JSON.parse(init.body);
        (body.prompt === "" ? ollamaUnloadRequests : ollamaRequests).push(body);
        return {
          ok: true,
          json: async () => ({ response: JSON.stringify({ caption: "portrait, studio lighting" }) }),
        };
      },
      ollamaCommandRunner: async (executable, args, options) => {
        explicitStops.push({ executable, args, options });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      checkTrainer: async () => ({ ok: true, message: "fake trainer ready" }),
      resolveBaseModel: async () => ({ path: path.join(paths.cache, "fake-base-model.safetensors") }),
      resolveCommand: async ({ preset, outputDirectory, outputName }) => ({
        command: "fake-trainer",
        args: [],
        cwd: paths.runtime,
        shell: false,
        preset: preset.startsWith("illustrious") ? "illustrious" : "sdxl",
        outputDirectory,
        outputName,
      }),
      progressIntervalMs: 0,
      executeTraining: async ({ job, outputDirectory, reportProgress }) => {
        executionOrder.push(job.id);
        await reportProgress({ step: 1, totalSteps: 1, epoch: 1, loss: 0.1, etaSeconds: 0 });
        const artifactPath = path.join(outputDirectory, `${job.config.outputName}.safetensors`);
        await writeFile(artifactPath, fakeSafetensors());
        return { code: 0, artifactPath };
      },
    });

    await service.initialize();
    const heldLease = path.join(trainingRoot, "gpu-lease.json");
    await writeFile(heldLease, JSON.stringify({ schemaVersion: 1, lease: { id: "held-by-test" } }));

    const requests = JOB_IDS.map((_, index) => {
      const sourceAssetIds = [...sourceAssets.keys()].slice(index * 2, index * 2 + 2);
      return {
        slug: `happy-job-${index + 1}`,
        displayName: `Happy job ${index + 1}`,
        family: "sdxl",
        captionReviewMode: "auto",
        triggerWords: [`subject_${index + 1}`],
        sourceAssetIds,
        config: {
          family: "sdxl",
          baseProfile: "sdxl-base-1-0",
          presetId: "sdxl-character-balanced",
          outputName: `happy-${index + 1}`,
        },
      };
    });

    const first = await service.createAndStart(requests[0]);
    assert.equal(first.dataset.images.length, 2);

    const secondCreated = await service.create(requests[1]);
    const second = await service.start(secondCreated.job.id, { expectedRevision: secondCreated.job.revision });
    assert.equal(second.dataset.images.length, 2);
    const queued = await service.queueSnapshot();
    assert.equal(queued.active, null);
    assert.deepEqual(queued.pending.map(({ jobId }) => jobId), JOB_IDS);

    await unlink(heldLease);
    await service.drainQueue();

    assert.deepEqual(executionOrder, JOB_IDS);
    assert.equal(ollamaRequests.length, 4);
    assert.equal(ollamaUnloadRequests.length, 2, "each caption batch unloads its shared model session once");
    assert.ok(ollamaRequests.every((request) => request.format === "json" && request.stream === false && request.keep_alive === -1));
    assert.ok(ollamaUnloadRequests.every((request) => request.keep_alive === 0 && request.stream === false));
    assert.deepEqual(explicitStops.map(({ args }) => args), Array.from({ length: 2 }, () => ["stop", "gemma4"]));
    for (let index = 0; index < JOB_IDS.length; index += 1) {
      const details = await service.get(JOB_IDS[index]);
      assert.equal(details.job.status, "succeeded");
      assert.equal(details.captions.confirmed, 2);
      assert.equal(details.job.config.orchestration.phase, "succeeded");
      assert.equal(details.job.config.orchestration.progress.stage, "succeeded");
      const captionManifest = await service.components.captions.readCaptions(JOB_IDS[index]);
      for (const record of captionManifest.records) {
        const sidecar = await readFile(path.join(service.components.dataset.getLocations(JOB_IDS[index]).captions, `${record.imageId}.txt`), "utf8");
        assert.match(sidecar, new RegExp(`^subject_${index + 1}, portrait, studio lighting\\n$`));
      }
      const preflight = details.job.config.orchestration.preflight;
      assert.equal(preflight.status, "pass");
      assert.ok(preflight.checks.every(({ status }) => status === "pass"));
      assert.equal(preflight.checks.find(({ id }) => id === "artifactTarget")?.status, "pass");
    }

    const listed = await service.list({ status: "succeeded" });
    assert.equal(listed.length, 2);
    const available = await service.listRegistry({ family: "sdxl", status: "available" });
    assert.deepEqual(new Set(available.map(({ id }) => id)), new Set(REGISTRY_IDS));
    assert.ok(available.every(({ relativePath }) => !path.isAbsolute(relativePath)));

    const externalFiles = await allFiles(path.join(sandbox, "mock-comfy"));
    assert.equal(externalFiles.length, 2, "only installed LoRA copies may live outside LORA_TRAINING_ROOT");
    assert.ok(externalFiles.every((file) => file.startsWith(comfyLoras + path.sep) && file.endsWith(".safetensors")));
    assert.ok((await allFiles(trainingRoot)).length > 0, "all job, dataset, caption, scheduler, output, and registry files stay under the training root");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
