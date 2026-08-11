import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const writes = new Map();
const WINDOWS_RENAME_RETRY_DELAYS_MS = Object.freeze([5, 10, 20, 40, 80]);

function defaultJobsRoot() {
  return path.resolve(process.env.H3_IMG2IMG_DATA_ROOT || path.join(PROJECT_ROOT, "data", "img2img", "jobs"));
}

function jsonText(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

function safeId(value) {
  const id = String(value || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(id)) {
    const error = new Error("Invalid image-to-image job id.");
    error.code = "IMG2IMG_JOB_ID_INVALID";
    error.status = 400;
    throw error;
  }
  return id;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renameWithRetry(source, destination, fsApi) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsApi.rename(source, destination);
      return;
    } catch (error) {
      const retryable = process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(error?.code);
      if (!retryable || attempt >= WINDOWS_RENAME_RETRY_DELAYS_MS.length) throw error;
      await delay(WINDOWS_RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function inside(root, candidate) {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  return absoluteCandidate === absoluteRoot || absoluteCandidate.startsWith(absoluteRoot + path.sep);
}

export async function atomicWriteJson(filePath, value, fsApi = fs) {
  const directory = path.dirname(filePath);
  await fsApi.mkdir(directory, { recursive: true });
  const temp = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await fsApi.open(temp, "wx");
    await handle.writeFile(jsonText(value), "utf8");
    await handle.datasync();
    await handle.close();
    handle = undefined;
    await renameWithRetry(temp, filePath, fsApi);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fsApi.unlink(temp).catch(() => {});
    throw error;
  }
}

export function createImg2ImgStore({ root = defaultJobsRoot(), fsApi = fs } = {}) {
  const jobsRoot = path.resolve(root);

  function jobDir(id) {
    const safe = safeId(id);
    const candidate = path.resolve(jobsRoot, safe);
    if (!inside(jobsRoot, candidate)) {
      const error = new Error("Image-to-image job path is unsafe.");
      error.code = "IMG2IMG_JOB_PATH_INVALID";
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
    if (!job?.id) throw new Error("Image-to-image job id is required.");
    const filePath = jobFile(job.id);
    const previous = writes.get(filePath) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => atomicWriteJson(filePath, job, fsApi));
    writes.set(filePath, next);
    next.finally(() => {
      if (writes.get(filePath) === next) writes.delete(filePath);
    }).catch(() => {});
    return next;
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

  return Object.freeze({
    root: jobsRoot,
    jobDir,
    jobFile,
    read,
    save,
    list,
  });
}

export const IMG2IMG_DATA_ROOT = defaultJobsRoot;
