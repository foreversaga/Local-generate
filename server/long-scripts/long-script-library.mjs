import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const NAME_MAX_LENGTH = 80;
const MAX_SHOTS = 120;
const SHOT_PROMPT_MAX_LENGTH = 7_000;
const SHOT_DESCRIPTION_MAX_LENGTH = 10_000;
const MIN_SHOT_DURATION = 0.5;
const MAX_SHOT_DURATION = 60;

export class LongScriptLibraryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "LongScriptLibraryError";
    this.code = code;
    this.status = status;
  }
}
function text(value, maxLength, field, { required = false } = {}) {
  if (typeof value !== "string") throw new LongScriptLibraryError("LONG_SCRIPT_INVALID", `${field} must be a string.`);
  const normalized = value.trim();
  if (required && !normalized) throw new LongScriptLibraryError("LONG_SCRIPT_INVALID", `${field} is required.`);
  if (normalized.length > maxLength) throw new LongScriptLibraryError("LONG_SCRIPT_INVALID", `${field} exceeds ${maxLength} characters.`);
  return normalized;
}

function duration(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < MIN_SHOT_DURATION || number > MAX_SHOT_DURATION) {
    throw new LongScriptLibraryError("LONG_SCRIPT_INVALID", `${field} must be between ${MIN_SHOT_DURATION} and ${MAX_SHOT_DURATION} seconds.`);
  }
  return Number(number.toFixed(3));
}

function normalizeShot(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LongScriptLibraryError("LONG_SCRIPT_INVALID", `Shot ${index + 1} must be an object.`);
  }
  const promptValue = value.prompt ?? value.content;
  const prompt = text(promptValue, SHOT_PROMPT_MAX_LENGTH, `Shot ${index + 1} prompt`, { required: true });
  const description = text(value.description ?? value.scene ?? "", SHOT_DESCRIPTION_MAX_LENGTH, `Shot ${index + 1} description`, { required: true });
  const id = typeof value.id === "string" && value.id.trim() ? value.id.trim().slice(0, 120) : randomUUID();
  return { id, duration: duration(value.duration, `Shot ${index + 1} duration`), prompt, description };
}

function normalizeShots(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_SHOTS) {
    throw new LongScriptLibraryError("LONG_SCRIPT_INVALID", `shots must contain between 2 and ${MAX_SHOTS} shots.`);
  }
  return value.map(normalizeShot);
}

function normalizeName(value) {
  return text(value, NAME_MAX_LENGTH, "Long script name", { required: true });
}

function canonicalRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.id !== "string" || !value.id.trim()) return null;
  try {
    return {
      id: value.id,
      name: normalizeName(value.name),
      shots: normalizeShots(value.shots),
      createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString(),
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export function createLongScriptLibrary({ filePath, fsApi = fs, clock = () => new Date(), idFactory = randomUUID } = {}) {
  if (!filePath) throw new TypeError("Long script library filePath is required.");
  const resolvedPath = path.resolve(filePath);
  let writeTail = Promise.resolve();

  async function readAll() {
    let parsed;
    try {
      parsed = JSON.parse(await fsApi.readFile(resolvedPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw new LongScriptLibraryError("LONG_SCRIPT_LIBRARY_READ_FAILED", "Unable to read the long-script library.", 500);
    }
    return (Array.isArray(parsed?.scripts) ? parsed.scripts.map(canonicalRecord).filter(Boolean) : [])
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async function writeAll(records) {
    await fsApi.mkdir(path.dirname(resolvedPath), { recursive: true });
    const temporary = `${resolvedPath}.${process.pid}.${randomUUID()}.tmp`;
    const body = `${JSON.stringify({ version: 1, scripts: records }, null, 2)}\n`;
    try {
      await fsApi.writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
      await fsApi.rename(temporary, resolvedPath);
    } catch (error) {
      await fsApi.unlink(temporary).catch(() => {});
      throw error;
    }
  }

  function mutate(operation) {
    const pending = writeTail.then(async () => {
      const records = await readAll();
      const result = await operation(records);
      await writeAll(records);
      return result;
    });
    writeTail = pending.catch(() => {});
    return pending;
  }

  function assertUniqueName(records, name, exceptId = "") {
    if (records.some((record) => record.id !== exceptId && record.name.localeCompare(name, undefined, { sensitivity: "accent" }) === 0)) {
      throw new LongScriptLibraryError("LONG_SCRIPT_NAME_EXISTS", "A long script with this name already exists.", 409);
    }
  }

  return Object.freeze({
    filePath: resolvedPath,
    list: readAll,
    create(input = {}) {
      return mutate((records) => {
        const name = normalizeName(input.name);
        assertUniqueName(records, name);
        const timestamp = clock().toISOString();
        const record = { id: idFactory(), name, shots: normalizeShots(input.shots), createdAt: timestamp, updatedAt: timestamp };
        records.unshift(record);
        return record;
      });
    },
    update(id, input = {}) {
      return mutate((records) => {
        const index = records.findIndex((record) => record.id === id);
        if (index < 0) throw new LongScriptLibraryError("LONG_SCRIPT_NOT_FOUND", "Long script not found.", 404);
        const current = records[index];
        const name = normalizeName(input.name ?? current.name);
        assertUniqueName(records, name, id);
        const record = { ...current, name, shots: normalizeShots(input.shots ?? current.shots), updatedAt: clock().toISOString() };
        records[index] = record;
        return record;
      });
    },
    remove(id) {
      return mutate((records) => {
        const index = records.findIndex((record) => record.id === id);
        if (index < 0) throw new LongScriptLibraryError("LONG_SCRIPT_NOT_FOUND", "Long script not found.", 404);
        return records.splice(index, 1)[0];
      });
    },
  });
}

export async function handleLongScriptLibraryRoute(req, res, { pathname, readJson, sendJson, library }) {
  if (pathname !== "/api/long-scripts" && !pathname.startsWith("/api/long-scripts/")) return false;
  try {
    if (req.method === "GET" && pathname === "/api/long-scripts") {
      sendJson(res, 200, { scripts: await library.list() });
      return true;
    }
    if (req.method === "POST" && pathname === "/api/long-scripts") {
      sendJson(res, 201, { script: await library.create(await readJson(req)) });
      return true;
    }
    const match = pathname.match(/^\/api\/long-scripts\/([^/]+)$/);
    if (match && req.method === "PUT") {
      sendJson(res, 200, { script: await library.update(decodeURIComponent(match[1]), await readJson(req)) });
      return true;
    }
    if (match && req.method === "DELETE") {
      sendJson(res, 200, { script: await library.remove(decodeURIComponent(match[1])) });
      return true;
    }
    sendJson(res, 405, { error: "Long-script endpoint method is not allowed.", code: "METHOD_NOT_ALLOWED" });
  } catch (error) {
    sendJson(res, Number.isInteger(error?.status) ? error.status : 500, {
      error: error instanceof Error ? error.message : "Long-script operation failed.",
      code: error?.code || "LONG_SCRIPT_LIBRARY_FAILED",
    });
  }
  return true;
}
