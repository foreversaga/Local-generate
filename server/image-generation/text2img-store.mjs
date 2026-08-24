import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteJson } from "./img2img-store.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const writes = new Map();

function defaultJobsRoot() {
  return path.resolve(process.env.H3_TEXT2IMG_DATA_ROOT || path.join(PROJECT_ROOT, "data", "text2img", "jobs"));
}

function safeId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(id)) {
    const error = new Error("Invalid text-to-image job id.");
    error.code = "TEXT2IMG_JOB_ID_INVALID";
    error.status = 400;
    throw error;
  }
  return id;
}

function inside(root, candidate) {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  return absoluteCandidate === absoluteRoot || absoluteCandidate.startsWith(absoluteRoot + path.sep);
}

export function createText2ImgStore({ root = defaultJobsRoot(), fsApi = fs } = {}) {
  const jobsRoot = path.resolve(root);

  function jobDir(id) {
    const candidate = path.resolve(jobsRoot, safeId(id));
    if (!inside(jobsRoot, candidate)) {
      const error = new Error("Text-to-image job path is unsafe.");
      error.code = "TEXT2IMG_JOB_PATH_INVALID";
      error.status = 400;
      throw error;
    }
    return candidate;
  }

  function jobFile(id) {
    return path.join(jobDir(id), "job.json");
  }

  async function read(id) {
    const filePath = jobFile(id);
    const pendingWrite = writes.get(filePath);
    if (pendingWrite) await pendingWrite;
    try {
      return JSON.parse(await fsApi.readFile(filePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async function save(job) {
    if (!job?.id) throw new Error("Text-to-image job id is required.");
    const filePath = jobFile(job.id);
    const previous = writes.get(filePath) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => atomicWriteJson(filePath, job, fsApi));
    writes.set(filePath, next);
    next.finally(() => {
      if (writes.get(filePath) === next) writes.delete(filePath);
    }).catch(() => {});
    await next;
    return structuredClone(job);
  }

  async function list() {
    const entries = await fsApi.readdir(jobsRoot, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    const jobs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const job = await read(entry.name);
      if (job && typeof job === "object" && job.id) jobs.push(job);
    }
    return jobs.sort((left, right) => String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")));
  }

  return Object.freeze({ root: jobsRoot, jobDir, jobFile, read, save, list });
}

export const TEXT2IMG_DATA_ROOT = defaultJobsRoot;
