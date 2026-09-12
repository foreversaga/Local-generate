export type SolH3Mode = "t2va" | "fl2va" | "ref2va";
export type SolH3MediaKind = "image" | "video" | "audio";
export type SolH3Locator = {
  root: "comfyui-input" | "comfyui-output";
  relativePath: string;
  kind?: SolH3MediaKind;
  fingerprint?: { size?: number; mtimeMs?: number };
};

export type SolH3OutputMetadata = {
  container: string;
  video: { width: number; height: number; frames: number; fps: number };
  audio: { codec: string; streams: number };
  duration: number | null;
  artifact: {
    name: string;
    size: number;
    sha256: string;
    producer: string;
    pipelineFingerprint: string | null;
  };
};

export type SolH3DurationProfile = {
  durationSeconds: number;
  sourceFrames: number;
  width: number;
  height: number;
  frames: number;
  fps: number;
  container: string;
  audioCodec: string;
};

export type SolH3Timing = {
  source: string;
  startupAndWarmupMs: number | null;
  formalGenerationMs: number | null;
  qwenMs: number | null;
  stage1Ms: number | null;
  stage2Ms: number | null;
  stage2PhasesMs: Record<string, number>;
  requestCount: number;
};

export type SolH3Job = {
  id: string;
  mode: SolH3Mode;
  prompt: string;
  seed: number | null;
  durationSeconds?: number;
  refImageMatch?: "stage1" | "stage2" | null;
  refStage1Attn?: "dense" | "sol" | null;
  status: string;
  stage: string;
  progress: number | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  retryOf?: string | null;
  timing?: SolH3Timing | null;
  cancelRequested?: boolean;
  output: { id: string; name: string; url: string; kind: "video" } | null;
  outputSpec: { width: number; height: number; frames: number; fps: number; container: string; audioCodec: string };
  outputMetadata?: SolH3OutputMetadata | null;
  error: string;
  errorCode?: string | null;
  events: Array<{ seq?: number; at: string; status?: string; stage?: string; progress?: number | null; phase?: string; detail?: unknown }>;
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
  managerLock?: { held: boolean };
  conflictPolicy?: string;
  output?: SolH3Job["outputSpec"];
  durationProfiles?: SolH3DurationProfile[];
};

export type SolH3Capabilities = {
  enabled: boolean;
  schemaVersion: number;
  durationProfiles: SolH3DurationProfile[];
  controls?: Record<string, unknown>;
  fixedRecipe?: Record<string, unknown>;
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

export async function fetchSolH3Capabilities() {
  return await json<SolH3Capabilities>("/api/sol-h3/capabilities");
}

export async function fetchSolH3Jobs() {
  const payload = await json<{ jobs: SolH3Job[] }>("/api/sol-h3/jobs");
  return payload.jobs || [];
}

export async function fetchSolH3Job(id: string) {
  const payload = await json<{ job: SolH3Job }>("/api/sol-h3/jobs/" + encodeURIComponent(id));
  return payload.job;
}

export async function pollSolH3JobEvents(id: string) {
  return await json<{ events: SolH3Job["events"]; job: SolH3Job }>(
    "/api/sol-h3/jobs/" + encodeURIComponent(id) + "/events?poll=1",
  );
}

export function subscribeSolH3JobEvents(
  id: string,
  handlers: {
    onJob: (job: SolH3Job) => void;
    onOpen?: () => void;
    onError?: () => void;
  },
) {
  const source = new EventSource(BRIDGE_URL + "/api/sol-h3/jobs/" + encodeURIComponent(id) + "/events");
  const parseJob = (event: MessageEvent<string>, wrapped: boolean) => {
    try {
      const payload = JSON.parse(event.data) as SolH3Job | { job?: SolH3Job };
      const job = wrapped && "job" in payload ? payload.job : payload as SolH3Job;
      if (job) handlers.onJob(job);
    } catch {
      handlers.onError?.();
    }
  };
  source.addEventListener("snapshot", (event) => parseJob(event as MessageEvent<string>, false));
  source.addEventListener("job", (event) => parseJob(event as MessageEvent<string>, true));
  source.addEventListener("done", (event) => {
    parseJob(event as MessageEvent<string>, false);
    source.close();
  });
  source.onopen = () => handlers.onOpen?.();
  source.onerror = () => handlers.onError?.();
  return () => source.close();
}

export async function createSolH3Job(request: {
  schemaVersion: 1;
  mode: SolH3Mode;
  prompt: string;
  durationSeconds?: 5 | 10;
  seed?: number;
  refImageMatch?: "stage1" | "stage2";
  refStage1Attn?: "dense" | "sol";
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

export async function retrySolH3Job(id: string) {
  const payload = await json<{ job: SolH3Job }>("/api/sol-h3/jobs/" + encodeURIComponent(id) + "/retry", { method: "POST" });
  return payload.job;
}
