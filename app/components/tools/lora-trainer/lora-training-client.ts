const API_ROOT = "/app/api/lora-training";

export type LoraFamily = "sdxl" | "illustrious";
export type CaptionReviewMode = "auto" | "manual";
export type LoraJobStatus =
  | "draft" | "ready" | "captioning" | "caption_review" | "caption_failed"
  | "preflight_failed" | "queued" | "training" | "cancelling"
  | "cancelled" | "installing" | "completed" | "failed" | "interrupted";

export type ApiError = {
  code: string;
  message: string;
  retryable: boolean;
  field?: string;
  details?: Record<string, unknown>;
  requestId?: string;
};

export type LoraTrainingConfig = {
  family: LoraFamily;
  baseProfile: string;
  presetId: string;
  outputName: string;
  triggerWords: string[];
  overrides?: {
    rank?: number;
    alpha?: number;
    learningRate?: number;
    epochs?: number;
    steps?: number;
    batchSize?: number;
    resolution?: number;
    seed?: number;
  };
};

export type LoraTrainingHealthCheck = {
  name: string;
  ok: boolean;
  path?: string;
  error?: string;
  message?: string;
};

export type LoraTrainingHealth = {
  ok: boolean;
  checks: LoraTrainingHealthCheck[];
};

export type LoraJob = {
  schemaVersion: 1;
  id: string;
  revision: number;
  status: LoraJobStatus;
  createdAt: string;
  updatedAt: string;
  dataset: { imageCount: number; manifestPath?: string };
  captionReviewMode: CaptionReviewMode;
  captions: { total: number; confirmed: number; failed: number };
  training: {
    family: LoraFamily;
    presetId: string;
    baseProfile: string;
    attempt: number;
    startedAt?: string;
    endedAt?: string;
    step?: number;
    totalSteps?: number;
    epoch?: number;
    loss?: number;
    etaSeconds?: number;
  };
  artifact?: { registryId: string; sha256: string; sizeBytes: number };
  error?: ApiError;
  provenance: { sourceJobId?: string; retryOf?: string; sourceAssets?: string[]; sourceAssetCount?: number };
};

export type CaptionRecord = {
  imageId: string;
  imageFile: string;
  status: "pending" | "generating" | "ready" | "edited" | "failed";
  caption: string;
  model: string;
  promptVersion: string;
  attempts: number;
  updatedAt: string;
  error?: ApiError;
};

export type PreflightCheck = {
  id?: string;
  label?: string;
  name?: string;
  status: "pass" | "warning" | "fail";
  message?: string;
};

export type PreflightResult = {
  status?: "pass" | "warning" | "fail";
  checks: PreflightCheck[];
  preflightToken?: string;
  resolvedConfig?: Record<string, unknown>;
  revision?: number;
  job?: LoraJob;
};

export type ArtifactDetails = {
  registryId: string;
  displayName?: string;
  family: string;
  baseProfile: string;
  triggerWords?: string[];
  sha256: string;
  sizeBytes: number;
  installedAt?: string;
  provenance?: Record<string, unknown>;
  downloadUrl?: string;
};

type Payload = {
  job?: LoraJob;
  captions?: CaptionRecord[];
  records?: CaptionRecord[];
  nextCursor?: string | null;
  checks?: PreflightCheck[];
  preflight?: PreflightResult;
  preflightToken?: string;
  resolvedConfig?: Record<string, unknown>;
  artifact?: ArtifactDetails;
  revision?: number;
  error?: ApiError | string;
  code?: string;
  message?: string;
};

export class LoraTrainingApiError extends Error {
  readonly status: number;
  readonly detail?: ApiError;
  readonly details?: Record<string, unknown>;

  constructor(message: string, status: number, detail?: ApiError) {
    super(message);
    this.name = "LoraTrainingApiError";
    this.status = status;
    this.detail = detail;
    this.details = detail?.details;
  }
}

export function isLoraRevisionConflict(reason: unknown): reason is LoraTrainingApiError {
  return reason instanceof LoraTrainingApiError
    && reason.status === 409
    && reason.detail?.code === "REVISION_CONFLICT";
}

async function request(path: string, init?: RequestInit): Promise<Payload> {
  const response = await fetch(`${API_ROOT}${path}`, {
    cache: "no-store",
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  const payload = await response.json().catch(() => ({})) as Payload;
  if (!response.ok) {
    const detail = typeof payload.error === "object" ? payload.error : undefined;
    const message = detail?.message || (typeof payload.error === "string" ? payload.error : payload.message) || "LoRA Trainer request failed.";
    throw new LoraTrainingApiError(payload.code ? `${payload.code}: ${message}` : message, response.status, detail);
  }
  return payload;
}

function requireJob(payload: Payload) {
  if (!payload.job) throw new LoraTrainingApiError("The server response did not include a job.", 502);
  return payload.job;
}

export async function createLoraJob(input: { sourceAssetIds: string[]; captionReviewMode: CaptionReviewMode; config: LoraTrainingConfig }) {
  return requireJob(await request("/jobs", { method: "POST", body: JSON.stringify(input) }));
}

export async function fetchLoraJob(id: string) {
  return requireJob(await request(`/jobs/${encodeURIComponent(id)}`));
}

export async function fetchLoraTrainingHealth(family: LoraFamily, baseProfile: string) {
  const params = new URLSearchParams({ family, baseProfile });
  const response = await fetch(`${API_ROOT}/health?${params}`, { cache: "no-store" });
  const payload = await response.json().catch(() => ({})) as Partial<LoraTrainingHealth> & Pick<Payload, "error" | "code" | "message">;

  if (typeof payload.ok === "boolean" && Array.isArray(payload.checks)) {
    return { ok: payload.ok, checks: payload.checks } as LoraTrainingHealth;
  }

  const detail = typeof payload.error === "object" ? payload.error : undefined;
  const message = detail?.message
    || (typeof payload.error === "string" ? payload.error : payload.message)
    || (response.ok ? "The health response is invalid." : "Unable to check LoRA Trainer readiness.");
  throw new LoraTrainingApiError(payload.code ? `${payload.code}: ${message}` : message, response.ok ? 502 : response.status, detail);
}

export async function startLoraJob(id: string, input: { revision: number; captionReviewMode: CaptionReviewMode; config: LoraTrainingConfig }) {
  return requireJob(await request(`/jobs/${encodeURIComponent(id)}/start`, { method: "POST", body: JSON.stringify(input) }));
}

export async function fetchCaptions(id: string, cursor?: string, limit = 8) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  const payload = await request(`/jobs/${encodeURIComponent(id)}/captions?${params}`);
  return { captions: payload.captions || payload.records || [], nextCursor: payload.nextCursor || null };
}

export async function updateCaption(id: string, imageId: string, caption: string, revision: number) {
  return requireJob(await request(`/jobs/${encodeURIComponent(id)}/captions/${encodeURIComponent(imageId)}`, {
    method: "PATCH", body: JSON.stringify({ caption, revision }),
  }));
}

export async function retryCaption(id: string, imageId: string, revision: number) {
  return requireJob(await request(`/jobs/${encodeURIComponent(id)}/captions/${encodeURIComponent(imageId)}/retry`, {
    method: "POST", body: JSON.stringify({ revision }),
  }));
}

export async function confirmCaptions(id: string, revision: number) {
  return requireJob(await request(`/jobs/${encodeURIComponent(id)}/captions/confirm`, {
    method: "POST", body: JSON.stringify({ revision }),
  }));
}

export async function saveLoraConfig(id: string, config: LoraTrainingConfig, revision: number) {
  return requireJob(await request(`/jobs/${encodeURIComponent(id)}/config`, {
    method: "PUT", body: JSON.stringify({ ...config, revision }),
  }));
}

export async function runPreflight(id: string, revision: number) {
  const payload = await request(`/jobs/${encodeURIComponent(id)}/preflight`, {
    method: "POST", body: JSON.stringify({ revision }),
  });
  const result = payload.preflight || {
    checks: payload.checks || [],
    preflightToken: payload.preflightToken,
    resolvedConfig: payload.resolvedConfig,
  };
  return {
    ...result,
    ...(payload.revision !== undefined ? { revision: payload.revision } : {}),
    ...(payload.job ? { job: payload.job } : {}),
  };
}

export async function enqueueLoraJob(id: string, revision: number, preflightToken: string) {
  return requireJob(await request(`/jobs/${encodeURIComponent(id)}/enqueue`, {
    method: "POST", body: JSON.stringify({ revision, preflightToken }),
  }));
}

export async function cancelLoraJob(id: string) {
  return requireJob(await request(`/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" }));
}

export async function retryLoraJob(id: string) {
  return requireJob(await request(`/jobs/${encodeURIComponent(id)}/retry`, { method: "POST" }));
}

export async function fetchArtifact(id: string) {
  const payload = await request(`/jobs/${encodeURIComponent(id)}/artifact`);
  if (!payload.artifact) throw new LoraTrainingApiError("The artifact is not available yet.", 404);
  return payload.artifact;
}

export function artifactDownloadUrl(id: string) {
  return `${API_ROOT}/jobs/${encodeURIComponent(id)}/artifact/download`;
}
