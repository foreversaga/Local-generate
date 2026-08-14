import { fetchUnifiedJobSnapshot } from "../../lib/job-source-fetch.mjs";
import { mergeJobCollections } from "../../lib/job-adapter.mjs";

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

export async function fetchUnifiedJobs(options?: FetchUnifiedJobsOptions): Promise<UnifiedJobsSnapshot> {
  return await fetchUnifiedJobSnapshot(options) as UnifiedJobsSnapshot;
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
  const output = job.output as { root?: string; name?: string; url?: string; downloadUrl?: string } | null;
  if (!output) return "";
  const url = output.url || output.downloadUrl;
  if (url) return url.startsWith(`${BRIDGE_URL}/`) ? url : `${BRIDGE_URL}${url}`;
  if (job.source === "lora") return "";
  if (output.name) return `${BRIDGE_URL}/media?root=${encodeURIComponent(output.root || "output")}&name=${encodeURIComponent(output.name)}`;
  return "";
}
