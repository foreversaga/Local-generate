import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LongVideoError } from "./schema.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WINDOWS_RESERVED = new Set([
  "CON", "PRN", "AUX", "NUL",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);

export function dataRoot() {
  return path.resolve(process.env.H3_SEQUENCE_DATA_ROOT || path.join(PROJECT_ROOT, "data"));
}

export function jobsRoot() {
  return path.join(dataRoot(), "jobs");
}

export function outputRoot() {
  const configured = process.env.COMFYUI_OUTPUT_ROOT || process.env.MINIMAX_H3_OUTPUT_ROOT;
  if (configured) return path.resolve(configured);
  const comfy = process.env.COMFYUI_ROOT || path.join(PROJECT_ROOT, "..", "ComfyUI");
  return path.resolve(comfy, "output");
}

export function assertPathContained(root, candidate, code = "PATH_OUTSIDE_ROOT") {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  if (absoluteCandidate !== absoluteRoot && !absoluteCandidate.startsWith(absoluteRoot + path.sep)) {
    throw new LongVideoError(code, "Requested path is outside the allowed root.", 400);
  }
  return absoluteCandidate;
}

export function safeRelativePath(root, relativeName, code = "PATH_TRAVERSAL") {
  const value = String(relativeName ?? "").replaceAll("\\", "/");
  if (!value || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new LongVideoError(code, "A relative path is required.", 400);
  }
  return assertPathContained(root, path.resolve(root, value), code);
}

export function validateOutputFolderName(value) {
  const original = String(value ?? "");
  if (!original || original !== original.trim()) throw new LongVideoError("OUTPUT_FOLDER_INVALID", "Output folder cannot have leading or trailing whitespace.", 400);
  const name = original.normalize("NFKC");
  if (!name) throw new LongVideoError("OUTPUT_FOLDER_INVALID", "Output folder name is required.", 400);
  const hasControl = Array.from(name).some((character) => character.charCodeAt(0) < 32);
  if (name === "." || name === ".." || /[<>:"/\\|?*]/.test(name) || hasControl || /[. ]$/.test(name)) {
    throw new LongVideoError("OUTPUT_FOLDER_INVALID", "Output folder contains invalid Windows characters.", 400);
  }
  const stem = name.split(".")[0].toUpperCase();
  if (WINDOWS_RESERVED.has(stem)) throw new LongVideoError("OUTPUT_FOLDER_INVALID", "Output folder uses a reserved Windows device name.", 400);
  if (name.length > 80) throw new LongVideoError("OUTPUT_FOLDER_INVALID", "Output folder name is too long.", 400);
  return name;
}

export function sequenceJobDir(id) {
  const safeId = String(id || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/.test(safeId)) throw new LongVideoError("JOB_ID_INVALID", "Invalid sequence id.", 400);
  return safeRelativePath(jobsRoot(), safeId, "JOB_PATH_INVALID");
}

export function sequenceJobFile(id) { return path.join(sequenceJobDir(id), "job.json"); }
export function sequenceEventsFile(id) { return path.join(sequenceJobDir(id), "events.jsonl"); }
export function sequenceSegmentsDir(id) { return path.join(sequenceJobDir(id), "segments"); }
export function sequenceSegmentDir(id, index) {
  if (!Number.isInteger(Number(index)) || Number(index) < 0) throw new LongVideoError("SEGMENT_INDEX_INVALID", "Invalid segment index.", 400);
  return path.join(sequenceSegmentsDir(id), String(Number(index) + 1).padStart(3, "0"));
}
export function sequenceSegmentFile(id, index) { return path.join(sequenceSegmentDir(id, index), "segment.json"); }
export function sequenceAttemptsDir(id, index) { return path.join(sequenceSegmentDir(id, index), "attempts"); }
export function sequenceAttemptFile(id, index, attempt) { return path.join(sequenceAttemptsDir(id, index), `${String(Number(attempt)).padStart(3, "0")}.json`); }
export function sequenceAssemblyDir(id) { return path.join(sequenceJobDir(id), "assembly"); }

export async function ensureDataDirs() {
  await fs.mkdir(jobsRoot(), { recursive: true });
}

export async function allocateSequenceOutputPath(folderName, { root = outputRoot() } = {}) {
  const safeName = validateOutputFolderName(folderName);
  const parent = path.resolve(root);
  await fs.mkdir(parent, { recursive: true });
  const candidate = assertPathContained(parent, path.join(parent, safeName), "OUTPUT_PATH_INVALID");
  try {
    await fs.mkdir(candidate, { recursive: false });
  } catch (error) {
    if (error?.code === "EEXIST") throw new LongVideoError("OUTPUT_FOLDER_EXISTS", `Output folder already exists: ${safeName}`, 409, { folderName: safeName });
    throw error;
  }
  return { folderName: safeName, path: candidate };
}

export function sequenceOutputFile(folderPath, fileName) {
  const clean = String(fileName || "").replaceAll("\\", "/");
  if (!clean || clean.includes("/") || clean === "." || clean === "..") throw new LongVideoError("OUTPUT_FILE_INVALID", "Output file name must be a single safe name.", 400);
  return assertPathContained(folderPath, path.join(folderPath, clean), "OUTPUT_PATH_INVALID");
}

export { PROJECT_ROOT, WINDOWS_RESERVED };

export const sanitizeOutputFolderName = validateOutputFolderName;
export const validateFolderName = validateOutputFolderName;
export const isPathContained = (root, candidate) => {
  try { assertPathContained(root, candidate); return true; } catch { return false; }
};
