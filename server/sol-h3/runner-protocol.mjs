import { solH3Error } from "./request.mjs";

const EVENT_TYPES = new Set(["hello", "ready", "progress", "result", "heartbeat", "error"]);

function protocolError(code, message, details) {
  return solH3Error(code, message, 502, details);
}

export function validateSolH3WorkerEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw protocolError("SOL_H3_WORKER_PROTOCOL_INVALID", "Sol-H3 worker event must be a JSON object.");
  }
  if (value.v !== 1) throw protocolError("SOL_H3_WORKER_PROTOCOL_VERSION", "Unsupported Sol-H3 worker protocol version.");
  const type = String(value.type || "");
  if (!EVENT_TYPES.has(type)) throw protocolError("SOL_H3_WORKER_EVENT_INVALID", "Unknown Sol-H3 worker event type.", { type });

  if (type === "hello") {
    if (!String(value.worker || "").trim() || !Number.isInteger(Number(value.pid)) || Number(value.pid) <= 0) {
      throw protocolError("SOL_H3_WORKER_HELLO_INVALID", "Sol-H3 worker hello event is invalid.");
    }
  }
  if (type === "ready" && !String(value.sessionId || "").trim()) {
    throw protocolError("SOL_H3_WORKER_READY_INVALID", "Sol-H3 worker ready event requires sessionId.");
  }
  if (["progress", "result", "error"].includes(type) && !String(value.requestId || "").trim()) {
    throw protocolError("SOL_H3_WORKER_REQUEST_ID_REQUIRED", "Sol-H3 worker event requires requestId.");
  }
  if (type === "progress") {
    const current = Number(value.current);
    const total = Number(value.total);
    if (!Number.isInteger(current) || !Number.isInteger(total) || current < 0 || total <= 0 || current > total || !String(value.stage || "").trim()) {
      throw protocolError("SOL_H3_WORKER_PROGRESS_INVALID", "Sol-H3 worker progress event is invalid.");
    }
  }
  if (type === "result" && !["ok", "cancelled"].includes(String(value.status || ""))) {
    throw protocolError("SOL_H3_WORKER_RESULT_INVALID", "Sol-H3 worker result status is invalid.");
  }
  return value;
}

export function createSolH3JsonlParser({ onEvent } = {}) {
  if (typeof onEvent !== "function") throw new TypeError("Sol-H3 JSONL parser requires onEvent.");
  let buffer = "";
  let ended = false;

  function parseLine(line) {
    if (!line.trim()) return;
    let value;
    try { value = JSON.parse(line); }
    catch {
      throw protocolError("SOL_H3_WORKER_STDOUT_INVALID", "Sol-H3 worker stdout must contain JSONL events only.", { line: line.slice(0, 200) });
    }
    onEvent(validateSolH3WorkerEvent(value));
  }

  function push(chunk) {
    if (ended) throw protocolError("SOL_H3_WORKER_PROTOCOL_ENDED", "Cannot write to an ended Sol-H3 JSONL parser.");
    buffer += String(chunk || "");
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/u, "");
      buffer = buffer.slice(newline + 1);
      parseLine(line);
    }
  }

  function end(chunk = "") {
    if (ended) return;
    if (chunk) push(chunk);
    ended = true;
    if (buffer.trim()) parseLine(buffer.replace(/\r$/u, ""));
    buffer = "";
  }

  return Object.freeze({ push, end });
}
