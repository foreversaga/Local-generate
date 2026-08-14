function normalizedPromptId(value) {
  return String(value || "").trim();
}

function queuePromptId(entry) {
  return Array.isArray(entry) ? normalizedPromptId(entry[1]) : "";
}

function historyRecord(payload, promptId) {
  if (!payload || typeof payload !== "object") return null;
  const record = payload[promptId];
  return record && typeof record === "object" ? record : null;
}

export function videoArtifactFromHistory(record) {
  const outputs = record?.outputs;
  if (!outputs || typeof outputs !== "object") return null;
  for (const nodeOutput of Object.values(outputs)) {
    if (!nodeOutput || typeof nodeOutput !== "object") continue;
    for (const key of ["videos", "gifs", "files", "images"]) {
      const entries = nodeOutput[key];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (entry && typeof entry === "object" && entry.filename) return entry;
      }
    }
  }
  return null;
}

export function inspectComfyPromptPayloads({ queuePayload, historyPayload, promptId = "" } = {}) {
  const id = normalizedPromptId(promptId);
  const running = Array.isArray(queuePayload?.queue_running) ? queuePayload.queue_running : [];
  const pending = Array.isArray(queuePayload?.queue_pending) ? queuePayload.queue_pending : [];
  const queue = {
    running: running.length,
    pending: pending.length,
    busy: running.length > 0 || pending.length > 0,
  };

  if (!id) return { state: queue.busy ? "uncorrelated_busy" : "idle", promptId: "", queue };

  const record = historyRecord(historyPayload, id);
  if (record) {
    const status = record.status && typeof record.status === "object" ? record.status : {};
    if (status.status_str === "error" || status.completed === false) {
      return { state: "error", promptId: id, queue, record };
    }
    if (status.completed === true || (record.outputs && Object.keys(record.outputs).length > 0)) {
      return {
        state: "completed",
        promptId: id,
        queue,
        record,
        artifact: videoArtifactFromHistory(record),
      };
    }
  }

  if (running.some((entry) => queuePromptId(entry) === id)) {
    return { state: "running", promptId: id, queue };
  }
  if (pending.some((entry) => queuePromptId(entry) === id)) {
    return { state: "pending", promptId: id, queue };
  }
  return { state: "missing", promptId: id, queue };
}

export async function inspectComfyPrompt({ comfyUrl, promptId = "", fetchJson, timeoutMs = 5000 } = {}) {
  if (typeof fetchJson !== "function") throw new TypeError("fetchJson is required.");
  const baseUrl = String(comfyUrl || "").replace(/\/$/, "");
  if (!baseUrl) throw new TypeError("comfyUrl is required.");
  const id = normalizedPromptId(promptId);
  const queueRequest = fetchJson(`${baseUrl}/queue`, {}, timeoutMs);
  const historyRequest = id
    ? fetchJson(`${baseUrl}/history/${encodeURIComponent(id)}`, {}, timeoutMs)
    : Promise.resolve(null);
  const [queueResult, historyResult] = await Promise.allSettled([queueRequest, historyRequest]);

  if (queueResult.status === "rejected" || historyResult.status === "rejected") {
    return {
      state: "unavailable",
      promptId: id,
      queue: { running: 0, pending: 0, busy: false },
      error: queueResult.status === "rejected" ? queueResult.reason : historyResult.reason,
    };
  }

  return inspectComfyPromptPayloads({
    queuePayload: queueResult.value,
    historyPayload: historyResult.value,
    promptId: id,
  });
}
