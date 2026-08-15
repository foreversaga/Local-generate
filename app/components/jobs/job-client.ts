import { fetchUnifiedJobSnapshot } from "../../lib/job-source-fetch.mjs";
import { mergeJobCollections, outputAvailability } from "../../lib/job-adapter.mjs";

export type UnifiedJob = ReturnType<typeof mergeJobCollections>[number];

export type VideoRetryOverrides = {
  prompt: string;
  negativePrompt: string;
  modelProfile: string;
  width: number;
  height: number;
  duration: number;
  steps: number;
  seed: number;
  timeoutSeconds: number;
  outputName: string;
};

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

type OutputReference = {
  root?: string;
  name?: string;
  url?: string;
  downloadUrl?: string;
};

async function fetchOutputAssetKeys(fetchImpl: typeof fetch): Promise<Set<string> | null> {
  try {
    const response = await fetchImpl(`${BRIDGE_URL}/api/assets?root=all`, { cache: "no-store" });
    if (!response.ok) return null;
    const payload = await response.json() as { assets?: Array<{ root?: string; name?: string }> };
    const assets = Array.isArray(payload.assets) ? payload.assets : [];
    return new Set(assets
      .filter((asset) => (asset.root === "input" || asset.root === "output") && typeof asset.name === "string" && asset.name)
      .map((asset) => `${asset.root}:${asset.name!.replaceAll("\\", "/")}`));
  } catch {
    // A temporary library failure should not make the whole jobs view fail.
    return null;
  }
}

function markOutputAvailability(job: UnifiedJob, availableKeys: Set<string> | null): UnifiedJob {
  const output = job.output as OutputReference | null;
  if (!output) return job;
  const nextAvailability = outputAvailability(output, availableKeys);
  return nextAvailability === job.outputAvailable ? job : { ...job, outputAvailable: nextAvailability };
}

export async function fetchUnifiedJobs(options?: FetchUnifiedJobsOptions): Promise<UnifiedJobsSnapshot> {
  const snapshot = await fetchUnifiedJobSnapshot(options) as UnifiedJobsSnapshot;
  const fetchImpl = options?.fetchImpl || globalThis.fetch;
  const availableKeys = typeof fetchImpl === "function" ? await fetchOutputAssetKeys(fetchImpl) : null;
  return { ...snapshot, jobs: snapshot.jobs.map((job) => markOutputAvailability(job, availableKeys)) };
}

export async function performJobAction(job: UnifiedJob, action: "cancel" | "pause" | "resume" | "retry", retryOverrides?: VideoRetryOverrides) {
  if (job.source === "video" && action === "cancel") return request(`${BRIDGE_URL}/api/jobs/${encodeURIComponent(job.id)}/cancel`, "POST");
  if (job.source === "video" && action === "retry") return request(`${BRIDGE_URL}/api/jobs/${encodeURIComponent(job.id)}/retry`, "POST", retryOverrides);
  if (job.source === "long" && ["cancel", "pause", "resume"].includes(action)) return request(`${BRIDGE_URL}/api/sequences/${encodeURIComponent(job.id)}/${action}`, "POST");
  if (job.source === "long" && action === "retry") return request(`${BRIDGE_URL}/api/sequences/${encodeURIComponent(job.id)}/start`, "POST");
  if (job.source === "lora" && (action === "cancel" || action === "retry")) {
    return request(`${BRIDGE_URL}/api/lora-training/jobs/${encodeURIComponent(job.id)}/${action}`, "POST");
  }
  if (job.source === "upscale" && (action === "cancel" || action === "retry")) return request(`${BRIDGE_URL}/api/upscale/jobs/${encodeURIComponent(job.id)}/${action}`, "POST");
  if (job.source === "img2img" && (action === "cancel" || action === "retry")) return request(`${BRIDGE_URL}/api/img2img/jobs/${encodeURIComponent(job.id)}/${action}`, "POST");
  throw new Error("This action is not supported by the existing backend contract.");
}

async function request(url: string, method: string, body?: object) {
  const response = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json().catch(() => ({})) as { error?: string | { message?: string }; code?: string };
  if (!response.ok) { const message = typeof payload.error === "string" ? payload.error : payload.error?.message || "Job action failed."; throw new Error(payload.code ? `${payload.code}: ${message}` : message); }
  return payload;
}

export function jobOutputHref(job: UnifiedJob) {
  const output = job.output as OutputReference | null;
  if (!output) return "";
  if (job.outputAvailable === false) return "";
  const url = output.url || output.downloadUrl;
  if (url) return url.startsWith(`${BRIDGE_URL}/`) ? url : `${BRIDGE_URL}${url}`;
  if (job.source === "lora") return "";
  if (job.outputAvailable !== true) return "";
  if (output.name) return `${BRIDGE_URL}/media?root=${encodeURIComponent(output.root || "output")}&name=${encodeURIComponent(output.name)}`;
  return "";
}
