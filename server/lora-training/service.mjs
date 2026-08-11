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
import { createTrainingRunner, sanitizeTrainerText } from './runner.mjs';
import { installTrainingArtifact } from './artifact.mjs';
import { normalizeTrainingParameters, resolveTrainingCommand } from './presets.mjs';
import { inspectRuntimeRevision, preflightLoraTraining } from './health.mjs';
import { createPythonResolver, toPublicPythonResolution } from '../runtime/python-resolver.mjs';

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

const TRAINER_DIAGNOSTIC_TAIL_LINES = 40;
const TRAINER_DIAGNOSTIC_TAIL_BYTES = 8192;
const TRAINER_DIAGNOSTIC_TEXT_LIMIT = 8192;
const WINDOWS_ABSOLUTE_PATH = /(?:[A-Za-z]:[\\/]|\\\\)[^\s"']*/g;

function isoNow(value = new Date()) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? new Date().toISOString() : parsed.toISOString();
}

const DEFAULT_GPU_LEASE_TTL_MS = 30 * 60 * 1000;

function defaultIsProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    // EPERM means the process exists but this process cannot signal it.
    if (error?.code === 'EPERM') return true;
    // Keep an unknown process API result conservative: a lease with an
    // unknown owner must not be deleted merely because probing failed.
    return null;
  }
}

function safeDiagnosticText(value, maximum = TRAINER_DIAGNOSTIC_TEXT_LIMIT) {
  return sanitizeTrainerText(String(value ?? ''), maximum)
    .replace(WINDOWS_ABSOLUTE_PATH, '[PATH]')
    .replace(/\r/g, '')
    .slice(0, maximum);
}

function safeDiagnosticPath(value, jobDirectory) {
  if (typeof value !== 'string' || !value) return value == null ? null : safeDiagnosticText(value, 512);
  const absolute = path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
  if (!absolute) return safeDiagnosticText(value, 512);
  const resolved = path.resolve(value);
  const root = path.resolve(jobDirectory);
  if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
    return path.relative(root, resolved).split(path.sep).join('/');
  }
  return path.basename(resolved);
}

function safeTrainerCommand(resolved, jobDirectory) {
  if (!resolved) return null;
  return {
    command: path.basename(String(resolved.command ?? '')),
    args: Array.isArray(resolved.args) ? resolved.args.map((value) => safeDiagnosticPath(String(value), jobDirectory)) : [],
    cwd: safeDiagnosticPath(resolved.cwd, jobDirectory),
    preset: typeof resolved.preset === 'string' ? safeDiagnosticText(resolved.preset, 128) : undefined,
  };
}

function resultTail(result, channel) {
  const logs = Array.isArray(result?.logs) ? result.logs.filter((entry) => entry?.channel === channel) : [];
  const fallback = channel === 'stderr' ? result?.stderrTail : result?.stdoutTail;
  const values = logs.length ? logs.map((entry) => entry.line) : (Array.isArray(fallback) ? fallback : typeof fallback === 'string' ? fallback.split(/\r?\n/) : []);
  const selected = [];
  let bytes = 0;
  for (const line of values.slice(-TRAINER_DIAGNOSTIC_TAIL_LINES).reverse()) {
    if (bytes >= TRAINER_DIAGNOSTIC_TAIL_BYTES) break;
    const safe = safeDiagnosticText(line, TRAINER_DIAGNOSTIC_TEXT_LIMIT);
    const remaining = TRAINER_DIAGNOSTIC_TAIL_BYTES - bytes;
    selected.unshift(safe.slice(0, remaining));
    bytes += Math.min(safe.length, remaining);
  }
  return selected;
}

function diagnosticAttempt(job, config) {
  const raw = Number(config?.orchestration?.attempt ?? job?.provenance?.attempt ?? 1);
  return Number.isSafeInteger(raw) && raw > 0 && raw < 1_000_000 ? raw : 1;
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
  const pythonResolver = options.pythonResolver ?? createPythonResolver({
    platform: options.platform ?? process.platform,
    env: options.env ?? process.env,
    runtimeRoot: paths.runtime,
    explicitExecutable: options.python,
  });
  async function resolveTrainerPython() {
    const result = typeof pythonResolver === 'function'
      ? await pythonResolver({ candidateRoots: [paths.runtime], ...(options.python !== undefined ? { explicitExecutable: options.python } : {}) })
      : await pythonResolver.resolve();
    return result && typeof result === 'object'
      ? result
      : { executable: null, source: 'none', version: null, available: false, error: { code: 'PYTHON_RESOLVER_INVALID', message: 'Python resolver returned an invalid result.', source: 'none' } };
  }
  async function requireTrainerPython() {
    const result = await resolveTrainerPython();
    if (!result.available || !result.executable) {
      throw serviceError(
        result.error?.code ?? 'PYTHON_UNAVAILABLE',
        result.error?.message ?? 'A usable Python interpreter is unavailable.',
        503,
        { python: toPublicPythonResolution(result) },
      );
    }
    return result;
  }
  const now = options.now ?? (() => new Date().toISOString());
  const ownerPidValue = Number(options.ownerPid ?? process.pid);
  const ownerPid = Number.isSafeInteger(ownerPidValue) && ownerPidValue > 0 ? ownerPidValue : process.pid;
  const leaseTtlValue = Number(options.gpuLeaseTtlMs ?? DEFAULT_GPU_LEASE_TTL_MS);
  const leaseTtlMs = Number.isFinite(leaseTtlValue) && leaseTtlValue > 0 ? leaseTtlValue : DEFAULT_GPU_LEASE_TTL_MS;
  const isProcessAlive = typeof options.isProcessAlive === 'function' ? options.isProcessAlive : defaultIsProcessAlive;
  const resolveBaseModel = async (context) => normalizeBaseModel(await options.resolveBaseModel?.(context));
  const resolveComfyTarget = async (context) => {
    const value = typeof options.comfyLoraDirectory === 'function' ? await options.comfyLoraDirectory(context) : options.comfyLoraDirectory;
    return typeof value === 'string' && value ? path.resolve(value) : null;
  };

  async function persistTrainerDiagnostics({ job, config, jobDirectory, resolved, result, error, startedAt, finishedAt, phase = 'trainer' }) {
    try {
      const attempt = diagnosticAttempt(job, config);
      const logsDirectory = resolveSafeChild(jobDirectory, 'logs');
      await mkdir(logsDirectory, { recursive: true });
      const diagnostics = {
        schemaVersion: 1,
        jobId: job.id,
        attempt,
        phase,
        startedAt: result?.startedAt ?? startedAt,
        finishedAt: result?.finishedAt ?? finishedAt,
        durationMs: Number.isFinite(result?.durationMs) ? Math.max(0, result.durationMs) : Math.max(0, new Date(finishedAt).valueOf() - new Date(startedAt).valueOf()),
        command: safeTrainerCommand(resolved, jobDirectory),
        exitCode: Number.isInteger(result?.code) ? result.code : null,
        signal: typeof result?.signal === 'string' ? safeDiagnosticText(result.signal, 64) : null,
        stdoutTail: resultTail(result, 'stdout'),
        stderrTail: resultTail(result, 'stderr'),
        ...(error ? { error: { code: safeDiagnosticText(error.code ?? 'TRAINER_FAILED', 80), message: safeDiagnosticText(error.message, 512) } } : {}),
      };
      const filePath = resolveSafeChild(logsDirectory, `trainer-attempt-${attempt}.json`);
      await atomicWriteJson(filePath, diagnostics);
      return { filePath, diagnostics };
    } catch (diagnosticError) {
      // Diagnostics are best effort.  Never replace the process/artifact
      // failure with an unrelated storage error.
      console.warn('[lora-training] unable to persist trainer diagnostics', diagnosticError?.message || diagnosticError);
      return null;
    }
  }

  const preflight = options.preflight ?? createPreflightService({
    dataset,
    readCaptions: captions.readCaptions,
    fetchImpl: options.fetchImpl,
    ollamaUrl: options.ollamaUrl,
    ollamaModel: options.ollamaModel,
    paths,
    presetOptions: options.presetOptions,
    clock: options.clock,
    resolveBaseModel,
    checkTrainer: options.checkTrainer ?? (async () => {
      const entrypoint = path.join(paths.runtime, 'sd-scripts', 'sdxl_train_network.py');
      const revision = await inspectRuntimeRevision(paths.runtime);
      const checks = [];
      const pythonResolution = await resolveTrainerPython();
      if (!pythonResolution.available || !pythonResolution.executable) {
        checks.push({ name: 'python', ok: false, error: pythonResolution.error?.code ?? 'PYTHON_UNAVAILABLE' });
      } else if (pythonResolution.source === 'PATH') {
        checks.push({ name: 'python', ok: true, source: 'PATH', version: pythonResolution.version ?? null });
      } else {
        try {
          await access(pythonResolution.executable, constants.R_OK);
          checks.push({ name: 'python', ok: true });
        } catch (error) {
          checks.push({ name: 'python', ok: false, error: error?.code ?? error?.message });
        }
      }
      for (const [name, target] of [['entrypoint', entrypoint]]) {
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
        details: { python: toPublicPythonResolution(pythonResolution), entrypoint, revision, checks },
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

  function leaseExpiryMs(lease) {
    const explicit = new Date(lease?.expiresAt).valueOf();
    if (Number.isFinite(explicit)) return explicit;
    const acquired = new Date(lease?.acquiredAt).valueOf();
    return Number.isFinite(acquired) ? acquired + leaseTtlMs : null;
  }

  async function staleLeaseReason(lease) {
    const current = new Date(isoNow(now())).valueOf();
    const expiry = leaseExpiryMs(lease);
    if (Number.isFinite(expiry) && expiry <= current) return 'expired';
    const pid = Number(lease?.ownerPid);
    if (Number.isSafeInteger(pid) && pid > 0) {
      let alive = null;
      try { alive = await isProcessAlive(pid); }
      catch { alive = null; }
      if (alive === false) return 'owner-exited';
    }
    return null;
  }

  async function clearStaleGpuLease() {
    return withStorageLock(leasePath, async () => {
      const document = await readJsonOr(leasePath, { schemaVersion: 1, lease: null });
      if (!document.lease) return { cleared: false, reason: 'missing' };
      const reason = await staleLeaseReason(document.lease);
      if (!reason) return { cleared: false, reason: 'owner-live-or-unknown' };
      await unlink(leasePath);
      return { cleared: true, reason };
    });
  }

  async function acquireGpuLease({ ownerId, jobId }) {
    return withStorageLock(leasePath, async () => {
      const acquiredAt = isoNow(now());
      const lease = {
        id: randomUUID(), ownerId, jobId, ownerPid,
        acquiredAt,
        expiresAt: isoNow(new Date(new Date(acquiredAt).valueOf() + leaseTtlMs)),
      };
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
    const pythonResolution = typeof options.resolveCommand === 'function' ? null : await requireTrainerPython();
    const jobDirectory = getJobPaths(job.id, paths).directory;
    const outputDirectory = resolveSafeChild(jobDirectory, 'output/staging');
    await mkdir(outputDirectory, { recursive: true });
    const outputName = config.outputName ?? job.slug;
    // Keep the canonical Studio split untouched and materialize a fresh
    // DreamBooth tree for every dispatch.  A missing caption therefore fails
    // before a trainer process can be spawned.
    const trainerDataset = typeof dataset.materializeTrainerDataset === 'function'
      ? await dataset.materializeTrainerDataset(job.id, {
        triggerWords: job.triggerWords,
        classTokens: config.classTokens ?? config.classToken,
        repeats: config.trainingRepeats ?? config.repeats,
        captionExtension: '.txt',
      })
      : { root: dataset.getLocations(job.id).dataset };
    const resolved = await (options.resolveCommand ?? resolveTrainingCommand)({
      preset: config.presetId ?? config.preset ?? job.family,
      family: job.family,
      // The process adapter only receives canonical trainer keys.  Public/UI
      // aliases are normalized before dispatch even when a custom resolver is
      // injected for tests or an alternate runtime.
      parameters: normalizeTrainingParameters(config.overrides ?? config.parameters ?? {}),
      runtimeRoot: paths.runtime,
      ...(pythonResolution?.executable ? { python: pythonResolution.executable } : {}),
      baseCheckpoint: baseModel.path,
      datasetDirectory: trainerDataset.root,
      outputDirectory,
      outputName,
    }, options.presetOptions);
    if (!resolved || resolved.shell !== false) throw serviceError('UNSAFE_TRAINER_COMMAND', 'trainer command must use shell:false', 500);

    const startedAt = isoNow(now());
    let runResult;
    let runError;
    try {
      if (typeof options.executeTraining === 'function') {
        runResult = await options.executeTraining({ job, resolved, outputDirectory, signal, reportProgress });
      } else {
        const runner = (options.createRunner ?? createTrainingRunner)({ onProgress: reportProgress, onLog: options.onTrainerLog });
        runResult = await runner.run(resolved, {
          // Python's stdio/argparse must not inherit a legacy Windows code
          // page (cp950 was the first visible failure in the incident log).
          env: { ...(options.runnerEnv ?? {}), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
          signal,
        });
      }
    } catch (error) {
      runError = error;
      runResult = error?.runResult ?? {
        code: Number.isInteger(error?.exitCode) ? error.exitCode : undefined,
        signal: error?.signal,
        stderrTail: error?.stderrTail,
      };
    }
    const finishedAt = isoNow(now());
    await persistTrainerDiagnostics({ job, config, jobDirectory, resolved, result: runResult, error: runError, startedAt, finishedAt });
    if (runError) {
      const stderrTail = resultTail(runResult, 'stderr').join('\n');
      const exitDescription = Number.isInteger(runResult?.code) ? `exit code ${runResult.code}` : (runResult?.signal ? `signal ${runResult.signal}` : 'trainer process error');
      const message = stderrTail ? `trainer process failed (${exitDescription}): ${stderrTail}` : `trainer process failed (${exitDescription})`;
      throw serviceError('TRAINER_FAILED', message, 500, {
        exitCode: Number.isInteger(runResult?.code) ? runResult.code : null,
        ...(runResult?.signal ? { signal: safeDiagnosticText(runResult.signal, 64) } : {}),
        ...(stderrTail ? { stderrTail: safeDiagnosticText(stderrTail) } : {}),
      });
    }
    if (signal.aborted) return { status: 'canceled' };
    if (runResult?.status === 'canceled') return { status: 'canceled' };
    if (runResult?.status === 'failed' || (runResult?.code !== undefined && runResult.code !== 0)) {
      const stderrTail = resultTail(runResult, 'stderr').join('\n');
      const exitDescription = Number.isInteger(runResult?.code) ? `exit code ${runResult.code}` : (runResult?.signal ? `signal ${runResult.signal}` : 'unknown exit');
      const message = stderrTail ? `trainer process failed (${exitDescription}): ${stderrTail}` : `trainer process failed (${exitDescription})`;
      throw serviceError('TRAINER_FAILED', message, 500, {
        exitCode: Number.isInteger(runResult?.code) ? runResult.code : null,
        ...(runResult?.signal ? { signal: safeDiagnosticText(runResult.signal, 64) } : {}),
        ...(stderrTail ? { stderrTail: safeDiagnosticText(stderrTail) } : {}),
      });
    }
    const source = ensureInside(outputDirectory, runResult?.artifactPath ?? path.join(outputDirectory, `${outputName}.safetensors`), 'training artifact');
    try {
      await access(source, constants.R_OK);
    } catch {
      const artifactError = serviceError('ARTIFACT_MISSING', 'trainer completed but the expected artifact was not produced', 500, {
        ...(Number.isInteger(runResult?.code) ? { exitCode: runResult.code } : {}),
      });
      await persistTrainerDiagnostics({ job, config, jobDirectory, resolved, result: runResult, error: artifactError, startedAt, finishedAt, phase: 'artifact' });
      throw artifactError;
    }
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
    onBackgroundError: async ({ error, jobId, phase }) => {
      if (!jobId || !controller) return;
      try {
        const current = await store.readJob(jobId);
        if (['succeeded', 'failed', 'canceled'].includes(current.status)) return;
        const message = `training queue ${phase || 'background'} failed: ${error?.message || 'unknown error'}`;
        await controller.onQueueStateChange({ jobId, status: 'failed', error: message });
      } catch {
        // Queue cleanup has already happened; a status update failure must not
        // turn the original background error into an unhandled rejection.
      }
    },
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
    let recoveryError = null;
    try {
      if (interrupted?.jobId) {
        try {
          const current = await store.readJob(interrupted.jobId);
          if (!['succeeded', 'failed', 'canceled'].includes(current.status)) {
            await controller.onQueueStateChange({
              jobId: interrupted.jobId,
              status: 'failed',
              error: {
                code: 'TRAINING_INTERRUPTED',
                message: 'training was interrupted by service restart; retry is available',
                retryable: true,
                details: { recoverable: true, reason: 'service_restart' },
              },
            });
          }
        } catch (error) {
          if (![API_ERROR_CODES.NOT_FOUND, API_ERROR_CODES.INVALID_IDENTIFIER].includes(error?.code)) throw error;
        }
      }
      if (interrupted) {
        // The service is the only restart recovery authority. Keep pending
        // entries in their persisted order and never requeue the interrupted
        // active entry in the same recovery pass.
        const pending = interrupted.jobId
          ? state.pending.filter((item) => item.jobId !== interrupted.jobId)
          : state.pending;
        await saveQueueState({ pending, active: null });
      }
    } catch (error) {
      recoveryError = error;
    }

    let leaseCleanup;
    try {
      // A lease is removable only when its owner is known to have exited or
      // its explicit/legacy expiry has passed. A live or unknown owner keeps
      // the lease, preventing a second process from stealing the GPU.
      leaseCleanup = await clearStaleGpuLease();
    } catch (error) {
      if (!recoveryError) recoveryError = error;
      else console.warn('[lora-training] unable to clean stale GPU lease', error?.message || error);
    }
    if (recoveryError) throw recoveryError;
    return {
      recoveredJobId: interrupted?.jobId ?? null,
      automaticRetry: false,
      recoverable: Boolean(interrupted?.jobId),
      leaseCleared: Boolean(leaseCleanup?.cleared),
      leaseCleanupReason: leaseCleanup?.reason ?? null,
    };
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
    const pythonResolution = await resolveTrainerPython();
    const base = await resolveBaseModel({ family, baseProfile });
    const targetDirectory = await resolveComfyTarget({ family, baseProfile });
    if (!base || !targetDirectory) {
      return {
        ok: false,
        python: toPublicPythonResolution(pythonResolution),
        checks: [{ name: !base ? 'baseCheckpoint' : 'targetDirectory', ok: false, error: 'not configured' }],
      };
    }
    return preflightLoraTraining({
      root: paths.root, runtimeRoot: paths.runtime, pythonResolution,
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
