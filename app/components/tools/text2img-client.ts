import type { StudioAsset } from "../library/asset-client";

const BRIDGE_URL = "/app";

export type Text2ImgHealth = {
  ready: boolean;
  comfyUi: boolean;
  remote: boolean;
  modelId: string;
  encoderId: string;
  reason?: string;
  nodes: Record<string, boolean>;
  models: {
    diffusion?: boolean;
    textEncoder?: boolean;
    clipType?: boolean;
    vae?: boolean;
    checkpoint?: boolean;
  };
  profiles: Record<string, Text2ImgModelHealth>;
  promptAssistant?: {
    ready: boolean;
    online: boolean;
    models: string[];
    model: string;
    profile: string;
    provider?: string;
    reason?: string;
  };
};

export type Text2ImgModelHealth = {
  id: string;
  label: string;
  model: string;
  textEncoder?: string;
  vae?: string;
  clipType?: string;
  precision: string;
  license: string;
  commercial: boolean;
  ready: boolean;
  reason?: string;
  models: Text2ImgHealth["models"];
  encoders: Record<string, Text2ImgEncoderHealth>;
  loras: Record<string, Text2ImgLoraHealth>;
  architecture: "flux2";
  defaultSteps: number;
  maxSteps: number;
  cfg: number;
  sampler: string;
  scheduler?: string;
  flowShift?: number;
  denoise?: number;
  minDimension: number;
  maxDimension: number;
  dimensionStep: number;
};

export type Text2ImgLoraSelection = {
  id: string;
  strength: number;
};

export type Text2ImgLoraHealth = {
  id: string;
  label: string;
  filename: string;
  defaultStrength: number;
  available: boolean;
};

export type Text2ImgEncoderHealth = {
  id: string;
  label: string;
  textEncoder: string;
  precision: string;
  thirdParty: boolean;
  license: string;
  available: boolean;
  ready: boolean;
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
  cfg: number;
  seed: number;
  modelId: string;
  encoderId: string;
  model: string;
  modelLabel: string;
  encoder: string;
  encoderLabel: string;
  encoderPrecision: string;
  thirdPartyEncoder: boolean;
  precision: string;
  license: string;
  commercial: boolean;
  loras: Text2ImgLoraSelection[];
  output?: StudioAsset | null;
  error?: string;
  errorCode?: string;
};

export type Text2ImgSubmitInput = {
  prompt: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  seed: number;
  modelId: string;
  encoderId: string;
  loras: Text2ImgLoraSelection[];
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
  if (!response.ok) throw new Text2ImgApiError(payloadMessage(payload, "Unable to check image-model readiness."), response.status, payload);
  return payload as unknown as Text2ImgHealth;
}

export async function submitText2Img(input: Text2ImgSubmitInput) {
  const response = await fetch(`${BRIDGE_URL}/api/text2img`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const payload = await readPayload(response);
  if (!response.ok || !payload.job) throw new Text2ImgApiError(payloadMessage(payload, "Unable to start image generation."), response.status, payload);
  return payload.job;
}

export async function generateText2ImgPrompt(description: string, { unloadPromptModel = false } = {}) {
  const response = await fetch(`${BRIDGE_URL}/api/text2img/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description, unloadPromptModel }),
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
  if (!response.ok || !payload.job) throw new Text2ImgApiError(payloadMessage(payload, "Unable to load image generation."), response.status, payload);
  return payload.job;
}
