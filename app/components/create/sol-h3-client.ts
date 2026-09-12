export type SolH3Mode = "t2va" | "fl2va" | "ref2va";
export type SolH3MediaKind = "image" | "video" | "audio";
export type SolH3Locator = {
  root: "comfyui-input" | "comfyui-output";
  relativePath: string;
  kind?: SolH3MediaKind;
  fingerprint?: { size?: number; mtimeMs?: number };
};

export type SolH3Job = {
  id: string;
  mode: SolH3Mode;
  prompt: string;
  seed: number | null;
  status: string;
  stage: string;
  progress: number | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cancelRequested?: boolean;
  output: { id: string; name: string; url: string; kind: "video" } | null;
  outputSpec: { width: number; height: number; frames: number; fps: number; container: string; audioCodec: string };
  error: string;
  events: Array<{ at: string; status?: string; stage?: string; progress?: number | null }>;
};

export type SolH3Readiness = {
  enabled: boolean;
  ready: boolean;
  code?: { source?: boolean; sanaCommit?: string | null };
  paths?: { source?: string; h3Revision?: string; hasPreparedRuntimePaths?: boolean };
  runtimes?: Record<string, { configured: boolean; executable: boolean; probe: string; ready: boolean }>;
  modes: Record<SolH3Mode, { ready: boolean; missing: string[]; inputs?: string; output?: SolH3Job["outputSpec"] }>;
  checkpoints?: { installed: boolean; verified: boolean; promptCache: boolean };
  gpu?: { active: unknown; queue: unknown[]; activeCount: number; queuedCount: number; totalCount: number };
  conflicts?: string[];
  hostLock?: { held: boolean; owner?: string };
  conflictPolicy?: string;
  output?: SolH3Job["outputSpec"];
};

const BRIDGE_URL = "/app";

async function json<T>(endpoint: string, init?: RequestInit): Promise<T> {
  const response = await fetch(BRIDGE_URL + endpoint, { ...init, cache: "no-store" });
  const payload = await response.json().catch(() => ({})) as { error?: string | { message?: string }; code?: string; details?: { missing?: string[] } };
  if (!response.ok) {
    const message = typeof payload.error === "string" ? payload.error : payload.error?.message;
    const detail = payload.details?.missing?.length ? " (" + payload.details.missing.join(", ") + ")" : "";
    throw new Error((payload.code ? payload.code + ": " : "") + (message || "Sol-H3 request failed.") + detail);
  }
  return payload as T;
}

function toSolH3Root(root: "input" | "output" | "training"): SolH3Locator["root"] {
  if (root === "training") throw new Error("Sol-H3 does not accept training assets.");
  return root === "input" ? "comfyui-input" : "comfyui-output";
}

export function assetLocator(asset: { root: "input" | "output" | "training"; name: string; kind?: SolH3MediaKind; size?: number; modified?: string }): SolH3Locator {
  const mtimeMs = asset.modified ? Date.parse(asset.modified) : NaN;
  return {
    root: toSolH3Root(asset.root),
    relativePath: asset.name,
    ...(asset.kind ? { kind: asset.kind } : {}),
    fingerprint: {
      ...(Number.isFinite(asset.size) ? { size: asset.size } : {}),
      ...(Number.isFinite(mtimeMs) ? { mtimeMs } : {}),
    },
  };
}

export async function fetchSolH3Readiness() {
  return await json<SolH3Readiness>("/api/sol-h3/readiness");
}

export async function fetchSolH3Jobs() {
  const payload = await json<{ jobs: SolH3Job[] }>("/api/sol-h3/jobs");
  return payload.jobs || [];
}

export async function fetchSolH3Job(id: string) {
  const payload = await json<{ job: SolH3Job }>("/api/sol-h3/jobs/" + encodeURIComponent(id));
  return payload.job;
}

export async function createSolH3Job(request: {
  schemaVersion: 1;
  mode: SolH3Mode;
  prompt: string;
  seed?: number;
  audio: { generate: true };
  inputs: Record<string, SolH3Locator | SolH3Locator[]>;
}, options: { idempotencyKey?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
  const payload = await json<{ job: SolH3Job }>("/api/sol-h3/jobs", {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });
  return payload.job;
}

export async function cancelSolH3Job(id: string) {
  const payload = await json<{ job: SolH3Job }>("/api/sol-h3/jobs/" + encodeURIComponent(id) + "/cancel", { method: "POST" });
  return payload.job;
}
