import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { recoveryStateForSolH3Job } from "./state-machine.mjs";
import { solH3Error } from "./request.mjs";

function now() {
  return new Date().toISOString();
}

function safeJobId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/u.test(id)) {
    throw solH3Error("SOL_H3_JOB_ID_INVALID", "Sol-H3 job id is invalid.", 400);
  }
  return id;
}

function jobDirectory(root, id) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, safeJobId(id));
  if (!resolved.startsWith(resolvedRoot + path.sep)) {
    throw solH3Error("SOL_H3_JOB_PATH_INVALID", "Sol-H3 job path is invalid.", 400);
  }
  return resolved;
}

async function atomicWriteJson(filePath, value, fsApi) {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fsApi.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  try {
    await fsApi.rename(temporary, filePath);
  } catch (error) {
    await fsApi.unlink(temporary).catch(() => {});
    throw error;
  }
}

function stateRecord(job) {
  const state = { ...job };
  delete state.request;
  delete state.events;
  return state;
}

async function readJson(filePath, fsApi) {
  return await fsApi.readFile(filePath, "utf8").then(JSON.parse).catch(() => null);
}

async function readEvents(filePath, fsApi, limit = 200) {
  const text = await fsApi.readFile(filePath, "utf8").catch(() => "");
  const events = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* keep valid prior events */ }
  }
  return events.slice(-limit);
}

export function createSolH3JobStore({ root, fsApi = fs, clock = now } = {}) {
  if (!root) throw new TypeError("Sol-H3 job store root is required.");
  const saveTails = new Map();

  function directory(id) {
    return jobDirectory(root, id);
  }

  function requestPath(id) {
    return path.join(directory(id), "request.json");
  }

  function statePath(id) {
    return path.join(directory(id), "state.json");
  }

  function eventPath(id) {
    return path.join(directory(id), "events.jsonl");
  }

  async function save(job) {
    job.updatedAt = clock();
    await fsApi.mkdir(directory(job.id), { recursive: true });
    const previous = saveTails.get(job.id) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => atomicWriteJson(statePath(job.id), stateRecord(job), fsApi));
    const tracked = next.finally(() => {
      if (saveTails.get(job.id) === tracked) saveTails.delete(job.id);
    });
    saveTails.set(job.id, tracked);
    await next;
  }

  async function create(job) {
    await fsApi.mkdir(directory(job.id), { recursive: false }).catch((error) => {
      if (error?.code === "EEXIST") {
        throw solH3Error("SOL_H3_JOB_EXISTS", "Sol-H3 job already exists.", 409);
      }
      throw error;
    });
    await Promise.all([
      fsApi.mkdir(path.join(directory(job.id), "inputs"), { recursive: true }),
      fsApi.mkdir(path.join(directory(job.id), "intermediates"), { recursive: true }),
      fsApi.mkdir(path.join(directory(job.id), "outputs"), { recursive: true }),
      fsApi.mkdir(path.join(directory(job.id), "logs"), { recursive: true }),
    ]);
    await fsApi.writeFile(requestPath(job.id), JSON.stringify(job.request, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    await save(job);
  }

  async function appendEvent(job, event) {
    const record = { at: clock(), ...event };
    job.events = [...(Array.isArray(job.events) ? job.events : []), record].slice(-200);
    await fsApi.appendFile(eventPath(job.id), JSON.stringify(record) + "\n", "utf8");
    await save(job);
    return record;
  }

  async function load(id) {
    const cleanId = safeJobId(id);
    const [request, state, events] = await Promise.all([
      readJson(requestPath(cleanId), fsApi),
      readJson(statePath(cleanId), fsApi),
      readEvents(eventPath(cleanId), fsApi),
    ]);
    if (!request || !state?.id) return null;
    return { ...state, request, events };
  }

  async function loadAll() {
    await fsApi.mkdir(root, { recursive: true });
    const entries = await fsApi.readdir(root, { withFileTypes: true }).catch(() => []);
    const jobs = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const job = await load(entry.name).catch(() => null);
      if (job) jobs.push(job);
    }
    return jobs;
  }

  async function recover(job) {
    const recovery = recoveryStateForSolH3Job(job.status);
    if (recovery.action === "reload") {
      job.status = "queued";
      job.stage = "服務重啟後重新排隊";
      job.progress = 0;
      job.startedAt = null;
      job.finishedAt = null;
      job.cancelRequested = false;
      await appendEvent(job, { status: job.status, stage: job.stage, progress: job.progress, recovery: true });
    } else if (recovery.action === "interrupt") {
      job.status = "interrupted";
      job.stage = "服務重啟，工作已中斷";
      job.finishedAt = clock();
      job.cancelRequested = false;
      job.error = "The WebUI restarted before this Sol-H3 job completed.";
      await appendEvent(job, { status: job.status, stage: job.stage, progress: job.progress ?? null, recovery: true });
    }
    return recovery;
  }

  return Object.freeze({
    create,
    save,
    appendEvent,
    load,
    loadAll,
    recover,
    directory,
    requestPath,
    statePath,
    eventPath,
  });
}
