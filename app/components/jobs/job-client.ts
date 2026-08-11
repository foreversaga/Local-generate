import { fetchUnifiedJobSnapshot } from "../../lib/job-source-fetch.mjs";
import { mergeJobCollections } from "../../lib/job-adapter.mjs";

export type UnifiedJob = ReturnType<typeof mergeJobCollections>[number];

const BRIDGE_URL = "/app";

export type JobSourceError = {
  source: string;
  status: number | null;
  code: string;
  message: string;
};

export type UnifiedJobsSnapshot = {
  jobs: UnifiedJob[];
  errors: JobSourceError[];
};

export type FetchUnifiedJobsOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export async function fetchUnifiedJobs(options?: FetchUnifiedJobsOptions): Promise<UnifiedJobsSnapshot> {
  return await fetchUnifiedJobSnapshot(options) as UnifiedJobsSnapshot;
}

export async function performJobAction(job: UnifiedJob, action: "cancel" | "pause" | "resume" | "retry") {
  if (job.source === "video" && action === "cancel") return request(`${BRIDGE_URL}/api/jobs/${encodeURIComponent(job.id)}/cancel`, "POST");
  if (job.source === "long" && ["cancel", "pause", "resume"].includes(action)) return request(`${BRIDGE_URL}/api/sequences/${encodeURIComponent(job.id)}/${action}`, "POST");
  if (job.source === "long" && action === "retry") return request(`${BRIDGE_URL}/api/sequences/${encodeURIComponent(job.id)}/start`, "POST");
  if (job.source === "lora" && (action === "cancel" || action === "retry")) {
    return request(`${BRIDGE_URL}/api/lora-training/jobs/${encodeURIComponent(job.id)}/${action}`, "POST");
  }
  if (job.source === "upscale" && action === "retry") return request(`${BRIDGE_URL}/api/upscale`, "POST", { sourceName: job.raw.sourceName, sourceRoot: job.raw.sourceRoot, scale: job.raw.scale });
  if (job.source === "img2img" && action === "retry") {
    const body: Record<string, unknown> = {
      sourceName: job.raw.sourceName,
      sourceRoot: job.raw.sourceRoot,
      prompt: job.raw.prompt,
      negativePrompt: job.raw.negativePrompt,
      model: job.raw.model,
      denoise: job.raw.denoise,
      steps: job.raw.steps,
      cfg: job.raw.cfg,
      seed: job.raw.seed,
    };
    if (typeof job.raw.characterLoraId === "string" && job.raw.characterLoraId) body.characterLoraId = job.raw.characterLoraId;
    if (typeof job.raw.characterLoraName === "string" && job.raw.characterLoraName) body.characterLoraName = job.raw.characterLoraName;
    if (Number.isFinite(job.raw.characterLoraStrength)) body.characterLoraStrength = job.raw.characterLoraStrength;
    if (Number.isInteger(job.raw.batchCount)) body.batchCount = job.raw.batchCount;
    if (job.raw.randomRanges && typeof job.raw.randomRanges === "object") body.randomRanges = job.raw.randomRanges;
    return request(`${BRIDGE_URL}/api/img2img`, "POST", body);
  }
  throw new Error("This action is not supported by the existing backend contract.");
}

async function request(url: string, method: string, body?: object) {
  const response = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json().catch(() => ({})) as { error?: string | { message?: string }; code?: string };
  if (!response.ok) { const message = typeof payload.error === "string" ? payload.error : payload.error?.message || "Job action failed."; throw new Error(payload.code ? `${payload.code}: ${message}` : message); }
  return payload;
}

export function jobOutputHref(job: UnifiedJob) {
  const output = job.output as { root?: string; name?: string; url?: string; downloadUrl?: string } | null;
  if (!output) return "";
  const url = output.url || output.downloadUrl;
  if (url) return url.startsWith(`${BRIDGE_URL}/`) ? url : `${BRIDGE_URL}${url}`;
  if (job.source === "lora") return "";
  if (output.name) return `${BRIDGE_URL}/media?root=${encodeURIComponent(output.root || "output")}&name=${encodeURIComponent(output.name)}`;
  return "";
}
