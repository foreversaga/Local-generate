export type PromptProvider = "ollama" | "sglang" | "codex";

export type CodexHealthModel = {
  value: string;
  label?: string;
  note?: string;
  reasoningEfforts?: string[];
};

export type StudioHealth = {
  bridge?: boolean;
  h3Root?: boolean;
  ollama?: {
    online?: boolean;
    url?: string;
    models?: string[];
  };
  vllm?: {
    online?: boolean;
    url?: string;
    model?: string;
    models?: string[];
  };
  sglang?: {
    online?: boolean;
    url?: string;
    model?: string;
    models?: string[];
  };
  codex?: {
    online?: boolean;
    version?: string;
    skill?: boolean;
    models?: CodexHealthModel[];
  };
  comfy?: {
    online?: boolean;
    url?: string;
    remote?: boolean;
    devices?: Array<{
      name?: string;
      vram_total?: number;
      vram_free?: number;
      total_memory?: number;
      free_memory?: number;
    }>;
  };
  runtime?: {
    mode?: "local" | "remote";
    switching?: boolean;
    activeOperations?: number;
    local?: { comfyUrl?: string; ollamaUrl?: string };
    remote?: { comfyUrl?: string; ollamaUrl?: string };
  };
  paths?: {
    h3Root?: string;
    comfyRoot?: string;
    input?: string;
    output?: string;
  };
};

export type RuntimeProbe = {
  mode?: "local" | "remote";
  remote?: boolean;
  comfyUrl?: string;
  ollamaUrl?: string;
  comfyOnline?: boolean;
  ollamaOnline?: boolean;
};

export type RuntimeResponse = {
  runtime?: RuntimeProbe;
  health?: StudioHealth;
  error?: string;
  code?: string;
  details?: Record<string, unknown>;
};

export class SettingsApiError extends Error {
  readonly status: number;
  readonly payload: RuntimeResponse;

  constructor(message: string, status: number, payload: RuntimeResponse) {
    super(message);
    this.name = "SettingsApiError";
    this.status = status;
    this.payload = payload;
  }
}

const BRIDGE_URL = "/app";

function apiErrorMessage(payload: RuntimeResponse, fallback: string) {
  const code = payload.code ? `${payload.code}: ` : "";
  return `${code}${payload.error || fallback}`;
}

async function readPayload(response: Response) {
  return await response.json().catch(() => ({})) as RuntimeResponse;
}

export async function fetchStudioHealth() {
  const response = await fetch(`${BRIDGE_URL}/api/health`, { cache: "no-store" });
  const payload = await readPayload(response);
  if (!response.ok) throw new SettingsApiError(apiErrorMessage(payload, "Unable to load service health."), response.status, payload);
  return payload as StudioHealth;
}

export async function fetchRuntimeStatus() {
  const response = await fetch(`${BRIDGE_URL}/api/runtime`, { cache: "no-store" });
  const payload = await readPayload(response);
  if (!response.ok || !payload.runtime) throw new SettingsApiError(apiErrorMessage(payload, "Unable to load runtime status."), response.status, payload);
  return payload;
}

export async function switchRuntime(mode: "local" | "remote") {
  const response = await fetch(`${BRIDGE_URL}/api/runtime`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  const payload = await readPayload(response);
  if (!response.ok || !payload.health) throw new SettingsApiError(apiErrorMessage(payload, "Runtime switch failed."), response.status, payload);
  return payload;
}
