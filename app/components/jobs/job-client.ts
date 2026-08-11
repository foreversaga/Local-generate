import { mergeJobCollections } from "../../lib/job-adapter.mjs";

export type UnifiedJob = ReturnType<typeof mergeJobCollections>[number];

const BRIDGE_URL = "/app";

export async function fetchUnifiedJobs(): Promise<UnifiedJob[]> {
  const specs = [
    { source: "video", url: `${BRIDGE_URL}/api/jobs` },
    { source: "long", url: `${BRIDGE_URL}/api/sequences` },
    { source: "upscale", url: `${BRIDGE_URL}/api/upscale/jobs` },
    { source: "img2img", url: `${BRIDGE_URL}/api/img2img/jobs` },
  ] as const;
  const collections = await Promise.all(specs.map(async (spec) => {
    try {
      const response = await fetch(spec.url, { cache: "no-store" });
      if (!response.ok) return { source: spec.source, jobs: [] };
      const payload = await response.json() as { jobs?: unknown[]; job?: unknown };
      const jobs = payload.jobs || (spec.source === "img2img" && payload.job ? [payload.job] : []);
      return { source: spec.source, jobs };
    } catch {
      return { source: spec.source, jobs: [] };
    }
  }));
  return mergeJobCollections(collections) as UnifiedJob[];
}

export async function performJobAction(job: UnifiedJob, action: "cancel" | "pause" | "resume" | "retry") {
  if (job.source === "video" && action === "cancel") return request(`${BRIDGE_URL}/api/jobs/${encodeURIComponent(job.id)}/cancel`, "POST");
  if (job.source === "long" && ["cancel", "pause", "resume"].includes(action)) return request(`${BRIDGE_URL}/api/sequences/${encodeURIComponent(job.id)}/${action}`, "POST");
  if (job.source === "long" && action === "retry") return request(`${BRIDGE_URL}/api/sequences/${encodeURIComponent(job.id)}/start`, "POST");
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
  const output = job.output as { root?: string; name?: string; url?: string } | null;
  if (!output) return "";
  if (output.url) return `${BRIDGE_URL}${output.url}`;
  if (output.name) return `${BRIDGE_URL}/media?root=${encodeURIComponent(output.root || "output")}&name=${encodeURIComponent(output.name)}`;
  return "";
}
