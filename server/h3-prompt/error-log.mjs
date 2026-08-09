import { promises as fs } from "node:fs";
import path from "node:path";

const OMITTED_DETAIL_KEYS = new Set([
  "candidatePrompt",
  "repairPrompt",
  "repairPrompts",
  "images",
  "data",
  "base64",
]);
const MAX_DETAIL_DEPTH = 8;
const MAX_DETAIL_STRING_CHARS = 20_000;
let appendQueue = Promise.resolve();

function textOrNull(value) {
  return typeof value === "string" && value.length ? value : null;
}

function sanitizeDetail(value, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return value.length <= MAX_DETAIL_STRING_CHARS
      ? value
      : `${value.slice(0, MAX_DETAIL_STRING_CHARS)}\n[truncated ${value.length - MAX_DETAIL_STRING_CHARS} characters]`;
  }
  if (typeof value !== "object") return String(value);
  if (depth >= MAX_DETAIL_DEPTH) return "[maximum detail depth reached]";
  if (seen.has(value)) return "[circular reference]";
  seen.add(value);
  const result = Array.isArray(value)
    ? value.map((item) => sanitizeDetail(item, depth + 1, seen))
    : Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !OMITTED_DETAIL_KEYS.has(key))
        .map(([key, item]) => [key, sanitizeDetail(item, depth + 1, seen)]),
    );
  seen.delete(value);
  return result;
}

function visualInputSummary(payload) {
  const images = Array.isArray(payload?.images) ? payload.images : [];
  return {
    count: images.length,
    roles: images.map((item) => String(item?.role || "reference_image")),
  };
}

export function buildPromptErrorRecord({
  timestamp = new Date().toISOString(),
  stage,
  endpoint,
  payload = null,
  error,
  runtime = null,
} = {}) {
  const request = payload && typeof payload === "object" ? payload : {};
  const details = error?.details && typeof error.details === "object" ? error.details : null;
  return {
    timestamp,
    stage: String(stage || "prompt_error"),
    endpoint: String(endpoint || ""),
    runtime: runtime && typeof runtime === "object" ? sanitizeDetail(runtime) : null,
    request: {
      provider: textOrNull(request.provider),
      model: textOrNull(request.model || request.ollamaModel || request.codexModel),
      mode: textOrNull(request.mode),
      duration: Number.isFinite(Number(request.duration)) ? Number(request.duration) : null,
      outputName: textOrNull(request.outputName),
      referenceImageName: textOrNull(request.referenceImageName || request.inputImageName),
      referenceImageNames: Array.isArray(request.referenceImageNames)
        ? request.referenceImageNames.map(String)
        : [],
      firstFrameName: textOrNull(request.firstFrameName || request.inputImageName),
      lastFrameName: textOrNull(request.lastFrameName || request.lastImageName),
      sourceVideoName: textOrNull(request.sourceVideoName || request.inputVideoName),
      visualInputs: visualInputSummary(request),
    },
    prompts: {
      submitted: textOrNull(request.prompt),
      candidate: textOrNull(details?.candidatePrompt),
      sourceBrief: textOrNull(request.brief),
      negative: textOrNull(request.negativePrompt),
    },
    error: {
      name: textOrNull(error?.name) || "Error",
      code: textOrNull(error?.code),
      status: Number.isInteger(error?.status) ? error.status : null,
      message: error instanceof Error ? error.message : String(error || "Prompt error"),
      details: details ? sanitizeDetail(details) : null,
    },
  };
}

export function promptErrorLogPath(logRoot, timestamp = new Date().toISOString()) {
  const date = String(timestamp).slice(0, 10).replaceAll("-", "");
  return path.join(path.resolve(logRoot), `prompt-errors-${date}.jsonl`);
}

export async function appendPromptError({ logRoot, ...input } = {}) {
  if (!logRoot) throw new TypeError("Prompt error log root is required.");
  const record = buildPromptErrorRecord(input);
  const filePath = promptErrorLogPath(logRoot, record.timestamp);
  const operation = appendQueue.then(async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
  });
  appendQueue = operation.catch(() => {});
  await operation;
  return { filePath, record };
}
