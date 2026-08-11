import path from 'node:path';
import { access, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { API_ERROR_CODES, LoraTrainingError } from './schema.mjs';
import { ensureLoraTrainingLayout, getJobPaths, LORA_PATHS, resolveSafeChild } from './paths.mjs';
import { atomicWriteJson, createJobStore, withStorageLock } from './store.mjs';
import { createRegistryStore } from './registry.mjs';
import { createDatasetService } from './dataset.mjs';
import { createCaptionService } from './captioner.mjs';
import { createPreflightService } from './preflight.mjs';
import { createLoraTrainingController } from './controller.mjs';
import { createTrainingQueue } from './queue.mjs';
import { createTrainingRunner } from './runner.mjs';
import { installTrainingArtifact } from './artifact.mjs';
import { resolveTrainingCommand } from './presets.mjs';
import { inspectRuntimeRevision, preflightLoraTraining } from './health.mjs';

function serviceError(code, message, status = 500, details) {
  return new LoraTrainingError(code, message, { status, details });
}

function normalizeBaseModel(value) {
  if (typeof value === 'string' && value) return { path: path.resolve(value) };
  if (value && typeof value.path === 'string' && value.path) return { ...value, path: path.resolve(value.path) };
  return null;
}

function ensureInside(root, candidate, label) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw serviceError('UNSAFE_RUNTIME_PATH', `${label} is outside its job directory`, 500);
  return resolved;
}

async function readJsonOr(filePath, fallback) {
  try { return JSON.parse(await readFile(filePath, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return structuredClone(fallback);
    throw serviceError(API_ERROR_CODES.IO_ERROR, `unable to read ${path.basename(filePath)}`, 500, { reason: error?.code });
  }
}

export function createLoraTrainingService(options = {}) {
  const paths = options.paths ?? LORA_PATHS;
  const store = options.store ?? createJobStore({ paths, clock: options.clock, idFactory: options.jobIdFactory });
  const registry = options.registry ?? createRegistryStore({ paths, clock: options.clock, idFactory: options.registryIdFactory });
  const dataset = options.dataset ?? createDatasetService({ paths, resolveSource: options.resolveSource, clock: options.clock });
  const captions = options.captions ?? createCaptionService({
    dataset, fetchImpl: options.fetchImpl, ollamaUrl: options.ollamaUrl,
    model: options.ollamaModel, prompt: options.captionPrompt,
    promptVersion: options.captionPromptVersion, clock: options.clock,
    maxAttempts: options.captionMaxAttempts, requestTimeoutMs: options.captionTimeoutMs,
  });
  const schedulerPath = paths.scheduler;
  const leasePath = resolveSafeChild(paths.root, 'gpu-lease.json');
  const pythonPath = options.python ?? path.join(paths.runtime, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const now = options.now ?? (() => new Date().toISOString());
  const resolveBaseModel = async (context) => normalizeBaseModel(await options.resolveBaseModel?.(context));
  const resolveComfyTarget = async (context) => {
    const value = typeof options.comfyLoraDirectory === 'function' ? await options.comfyLoraDirectory(context) : options.comfyLoraDirectory;
    return typeof value === 'string' && value ? path.resolve(value) : null;
  };

  const preflight = options.preflight ?? createPreflightService({
    dataset,
    readCaptions: captions.readCaptions,
    fetchImpl: options.fetchImpl,
    ollamaUrl: options.ollamaUrl,
    ollamaModel: options.ollamaModel,
    paths,
    clock: options.clock,
    resolveBaseModel,
    checkTrainer: options.checkTrainer ?? (async () => {
      const entrypoint = path.join(paths.runtime, 'sd-scripts', 'sdxl_train_network.py');
      const revision = await inspectRuntimeRevision(paths.runtime);
      const checks = [];
      for (const [name, target] of [['python', pythonPath], ['entrypoint', entrypoint]]) {
        try {
          await access(target, constants.R_OK);
          checks.push({ name, ok: true, path: target });
        } catch (error) {
          checks.push({ name, ok: false, path: target, error: error?.code ?? error?.message });
        }
      }
      const ok = revision.ok && checks.every((check) => check.ok);
      return {
        ok,
        message: ok ? 'trainer runtime is ready' : 'trainer runtime is incomplete',
        details: { pythonPath, entrypoint, revision, checks },
      };
    }),
  });

  let controller;
  let initialized;

  async function loadQueueState() {
    const value = await readJsonOr(schedulerPath, { schemaVersion: 1, pending: [], active: null });
    if (!value || !Array.isArray(value.pending) || (value.active !== null && typeof value.active !== 'object')) {
      throw serviceError(API_ERROR_CODES.IO_ERROR, 'scheduler state is invalid');
    }
    return { pending: value.pending, active: value.active };
  }

  async function saveQueueState(value) {
    await atomicWriteJson(schedulerPath, { schemaVersion: 1, updatedAt: now(), pending: value.pending, active: value.active });
  }

  async function acquireGpuLease({ ownerId, jobId }) {
    return withStorageLock(leasePath, async () => {
      const lease = { id: randomUUID(), ownerId, jobId, acquiredAt: now() };
      let handle;
      try {
        handle = await open(leasePath, 'wx', 0o600);
        await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, lease }, null, 2)}\n`, 'utf8');
        await handle.sync(); await handle.close(); handle = undefined;
        return lease;
      } catch (error) {
        if (handle) await handle.close().catch(() => {});
        if (error?.code === 'EEXIST') return null;
        await unlink(leasePath).catch(() => {});
        throw serviceError(API_ERROR_CODES.IO_ERROR, 'unable to acquire GPU lease', 500, { reason: error?.code });
      }
    });
  }

  async function releaseGpuLease({ ownerId, jobId, lease }) {
    return withStorageLock(leasePath, async () => {
      const document = await readJsonOr(leasePath, { schemaVersion: 1, lease: null });
      if (!document.lease) return;
      if (document.lease.id !== lease?.id || document.lease.ownerId !== ownerId || document.lease.jobId !== jobId) {
        throw serviceError('GPU_LEASE_CONFLICT', 'GPU lease ownership changed', 423);
      }
      await unlink(leasePath);
    });
  }

  async function executeTraining(entry, { signal, reportProgress }) {
    const job = await store.readJob(entry.jobId);
    const config = job.config ?? {};
    const baseModel = await resolveBaseModel({ job, family: job.family, baseProfile: config.baseProfile });
    if (!baseModel) throw serviceError('BASE_MODEL_UNAVAILABLE', 'base model could not be resolved', 422);
    const targetDirectory = await resolveComfyTarget({ job });
    if (!targetDirectory) throw serviceError('ARTIFACT_TARGET_UNAVAILABLE', 'ComfyUI LoRA target is not configured', 503);
    const jobDirectory = getJobPaths(job.id, paths).directory;
    const outputDirectory = resolveSafeChild(jobDirectory, 'output/staging');
    await mkdir(outputDirectory, { recursive: true });
    const outputName = config.outputName ?? job.slug;
    const resolved = await (options.resolveCommand ?? resolveTrainingCommand)({
      preset: config.presetId ?? config.preset ?? job.family,
      parameters: config.overrides ?? config.parameters ?? {},
      runtimeRoot: paths.runtime,
      python: pythonPath,
      baseCheckpoint: baseModel.path,
      datasetDirectory: dataset.getLocations(job.id).dataset,
      outputDirectory,
      outputName,
    }, options.presetOptions);
    if (!resolved || resolved.shell !== false) throw serviceError('UNSAFE_TRAINER_COMMAND', 'trainer command must use shell:false', 500);

    let runResult;
    if (typeof options.executeTraining === 'function') {
      runResult = await options.executeTraining({ job, resolved, outputDirectory, signal, reportProgress });
    } else {
      const runner = (options.createRunner ?? createTrainingRunner)({ onProgress: reportProgress, onLog: options.onTrainerLog });
      runResult = await runner.run(resolved, { env: options.runnerEnv ?? {}, signal });
    }
    if (signal.aborted) return { status: 'canceled' };
    if (runResult?.status === 'canceled') return { status: 'canceled' };
    if (runResult?.status === 'failed' || (runResult?.code !== undefined && runResult.code !== 0)) {
      throw serviceError('TRAINER_FAILED', 'trainer process exited unsuccessfully', 500, { exitCode: runResult?.code });
    }
    const source = ensureInside(outputDirectory, runResult?.artifactPath ?? path.join(outputDirectory, `${outputName}.safetensors`), 'training artifact');
    await access(source, constants.R_OK);
    await mkdir(targetDirectory, { recursive: true });
    let registryRecord;
    const installed = await (options.installArtifact ?? installTrainingArtifact)({
      job: { ...job, status: 'succeeded' }, source, targetDirectory,
      fileName: `${outputName}.safetensors`,
      registerArtifact: async (artifact) => {
        registryRecord = await registry.register({
          relativePath: artifact.fileName,
          family: job.family,
          baseProfile: config.baseProfile,
          displayName: job.displayName,
          triggerWords: job.triggerWords,
          hash: artifact.sha256,
          size: artifact.size,
          status: 'available',
          provenance: {
            jobId: job.id, attempt: config.orchestration?.attempt ?? 1,
            presetId: resolved.preset, baseModel: baseModel.path,
            datasetRevision: (await dataset.readManifest(job.id)).revision,
          },
        });
      },
    });
    await controller.onQueueStateChange({
      jobId: job.id, status: 'running',
      progress: { stage: 'installed' },
      artifact: {
        registryId: registryRecord?.id,
        relativePath: registryRecord?.relativePath,
        path: installed.path,
        fileName: installed.fileName,
        sha256: installed.sha256,
        sizeBytes: installed.size,
        comfyLoaded: true,
      },
    });
    return { status: 'succeeded', artifact: installed, registry: registryRecord };
  }

  const queue = options.queue ?? createTrainingQueue({
    loadState: loadQueueState,
    saveState: saveQueueState,
    acquireGpuLease,
    releaseGpuLease,
    execute: executeTraining,
    onStateChange: async (event) => controller?.onQueueStateChange(event),
    now,
    ownerId: options.ownerId,
    progressIntervalMs: options.progressIntervalMs,
  });

  controller = options.controller ?? createLoraTrainingController({
    store, dataset, captions, preflight, queue, resolveSource: options.resolveSource,
    now: options.clock,
  });

  async function recoverInterrupted() {
    const state = await loadQueueState();
    const interrupted = state.active;
    if (interrupted?.jobId) {
      await saveQueueState({ pending: state.pending.filter((item) => item.jobId !== interrupted.jobId), active: null });
      try {
        await controller.onQueueStateChange({ jobId: interrupted.jobId, status: 'failed', error: 'training interrupted during service restart' });
      } catch (error) {
        if (error?.code !== API_ERROR_CODES.NOT_FOUND) throw error;
      }
    }
    const lease = await readJsonOr(leasePath, { schemaVersion: 1, lease: null });
    if (lease.lease) await unlink(leasePath);
    return interrupted ? { recoveredJobId: interrupted.jobId, automaticRetry: false } : { recoveredJobId: null, automaticRetry: false };
  }

  async function initialize() {
    if (!initialized) initialized = (async () => {
      await ensureLoraTrainingLayout(paths);
      const recovery = await recoverInterrupted();
      await queue.initialize?.();
      return recovery;
    })();
    return initialized;
  }

  const call = (method) => async (...args) => { await initialize(); return controller[method](...args); };

  async function health({ family = 'sdxl', baseProfile } = {}) {
    await initialize();
    const base = await resolveBaseModel({ family, baseProfile });
    const targetDirectory = await resolveComfyTarget({ family, baseProfile });
    if (!base || !targetDirectory) return { ok: false, checks: [{ name: !base ? 'baseCheckpoint' : 'targetDirectory', ok: false, error: 'not configured' }] };
    return preflightLoraTraining({
      root: paths.root, runtimeRoot: paths.runtime, python: pythonPath,
      baseCheckpoint: base.path, targetDirectory,
      ollamaProbe: options.ollamaProbe, gpuProbe: options.gpuProbe,
    });
  }

  async function queueSnapshot() { await initialize(); return queue.snapshot(); }
  async function drainQueue() { await initialize(); return queue.drain(); }
  async function listRegistry(filters) { await initialize(); return registry.list(filters); }
  async function getRegistry(id) { await initialize(); return registry.get(id); }

  return Object.freeze({
    initialize, health, queueSnapshot, drainQueue, listRegistry, getRegistry,
    create: call('create'), createAndStart: call('createAndStart'), get: call('get'), list: call('list'),
    start: call('start'), generateCaptions: call('runCaptioning'), editCaption: call('editCaption'),
    retryCaption: call('retryCaption'), confirmCaptions: call('confirmCaptions'),
    preflight: call('runPreflight'), enqueue: call('enqueue'), cancel: call('cancel'), retry: call('retry'),
    components: Object.freeze({ paths, store, registry, dataset, captions, preflight, controller, queue }),
  });
}

let lazySingleton;

export function getLoraTrainingService(options) {
  if (!lazySingleton) lazySingleton = createLoraTrainingService(options);
  else if (options !== undefined) throw new TypeError('LoRA training singleton is already configured');
  return lazySingleton;
}
