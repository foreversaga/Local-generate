import type { StudioAsset } from "../library/asset-client";

const BRIDGE_URL = "/app";

export type Text2ImgHealth = {
  ready: boolean;
  comfyUi: boolean;
  remote: boolean;
  modelId: string;
  reason?: string;
  nodes: Record<string, boolean>;
  models: {
    diffusion: boolean;
    textEncoder: boolean;
    clipType: boolean;
    vae: boolean;
  };
  profiles: Record<string, Text2ImgModelHealth>;
  promptAssistant?: {
    ready: boolean;
    online: boolean;
    models: string[];
    model: string;
    profile: string;
    reason?: string;
  };
};

export type Text2ImgModelHealth = {
  id: string;
  label: string;
  model: string;
  textEncoder: string;
  vae: string;
  clipType: string;
  precision: string;
  license: string;
  commercial: boolean;
  ready: boolean;
  reason?: string;
  models: Text2ImgHealth["models"];
};

export type Text2ImgPromptResult = {
  description: string;
  prompt: string;
  model: string;
  profile: string;
};

export type Text2ImgJob = {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  stage: string;
  prompt: string;
  width: number;
  height: number;
  steps: number;
  seed: number;
  modelId: string;
  model: string;
  modelLabel: string;
  precision: string;
  license: string;
  commercial: boolean;
  output?: StudioAsset | null;
  error?: string;
  errorCode?: string;
};

export type Text2ImgSubmitInput = {
  prompt: string;
  width: number;
  height: number;
  steps: number;
  seed: number;
  modelId: string;
};

type Text2ImgPayload = {
  job?: Text2ImgJob;
  health?: Text2ImgHealth;
  error?: string | { message?: string; code?: string };
  code?: string;
  description?: string;
  prompt?: string;
  model?: string;
  profile?: string;
};

export class Text2ImgApiError extends Error {
  readonly status: number;
  readonly payload: Text2ImgPayload;

  constructor(message: string, status: number, payload: Text2ImgPayload) {
    super(message);
    this.name = "Text2ImgApiError";
    this.status = status;
    this.payload = payload;
  }
}

function payloadMessage(payload: Text2ImgPayload, fallback: string) {
  const detail = typeof payload.error === "string" ? payload.error : payload.error?.message;
  const code = payload.code || (typeof payload.error === "object" ? payload.error?.code : "");
  return code ? `${code}: ${detail || fallback}` : detail || fallback;
}

async function readPayload(response: Response) {
  return await response.json().catch(() => ({})) as Text2ImgPayload;
}

export async function fetchText2ImgHealth() {
  const response = await fetch(`${BRIDGE_URL}/api/text2img/health`, { cache: "no-store" });
  const payload = await readPayload(response);
  if (!response.ok) throw new Text2ImgApiError(payloadMessage(payload, "Unable to check FLUX readiness."), response.status, payload);
  return payload as unknown as Text2ImgHealth;
}

export async function submitText2Img(input: Text2ImgSubmitInput) {
  const response = await fetch(`${BRIDGE_URL}/api/text2img`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const payload = await readPayload(response);
  if (!response.ok || !payload.job) throw new Text2ImgApiError(payloadMessage(payload, "Unable to start FLUX generation."), response.status, payload);
  return payload.job;
}

export async function generateText2ImgPrompt(description: string) {
  const response = await fetch(`${BRIDGE_URL}/api/text2img/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description }),
  });
  const payload = await readPayload(response);
  if (!response.ok || !payload.prompt || !payload.model || !payload.profile) {
    throw new Text2ImgApiError(payloadMessage(payload, "Unable to generate the photographic prompt."), response.status, payload);
  }
  return payload as Text2ImgPromptResult;
}

export async function fetchText2ImgJob(id: string) {
  const response = await fetch(`${BRIDGE_URL}/api/text2img/jobs/${encodeURIComponent(id)}`, { cache: "no-store" });
  const payload = await readPayload(response);
  if (!response.ok || !payload.job) throw new Text2ImgApiError(payloadMessage(payload, "Unable to load FLUX generation."), response.status, payload);
  return payload.job;
}
