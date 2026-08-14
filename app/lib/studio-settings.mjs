export const STUDIO_SETTINGS_STORAGE_KEY = "h3-studio.settings.v1";
export const STUDIO_SETTINGS_VERSION = 1;

export const STUDIO_SETTINGS_DEFAULTS = Object.freeze({
  version: STUDIO_SETTINGS_VERSION,
  promptProvider: "ollama",
  ollamaModel: "qwen3.5-hauhaucs-aggressive:9b-q6_k",
  codexModel: "gpt-5.6-luna",
  codexReasoningEffort: "medium",
});

const PROVIDERS = new Set(["ollama", "codex"]);
const DEFAULT_REASONING = ["low", "medium", "high", "xhigh", "max", "ultra"];

export function createStudioSettings(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  return {
    version: STUDIO_SETTINGS_VERSION,
    promptProvider: PROVIDERS.has(source.promptProvider) ? source.promptProvider : STUDIO_SETTINGS_DEFAULTS.promptProvider,
    ollamaModel: normalizeString(source.ollamaModel, STUDIO_SETTINGS_DEFAULTS.ollamaModel),
    codexModel: normalizeString(source.codexModel, STUDIO_SETTINGS_DEFAULTS.codexModel),
    codexReasoningEffort: normalizeString(source.codexReasoningEffort, STUDIO_SETTINGS_DEFAULTS.codexReasoningEffort),
  };
}

export function parseStudioSettings(serialized) {
  if (typeof serialized !== "string" || !serialized.trim()) return createStudioSettings();
  try {
    const parsed = JSON.parse(serialized);
    if (!parsed || typeof parsed !== "object" || parsed.version !== STUDIO_SETTINGS_VERSION) return createStudioSettings();
    return createStudioSettings(parsed);
  } catch {
    return createStudioSettings();
  }
}

export function serializeStudioSettings(settings) {
  return JSON.stringify(createStudioSettings(settings));
}

export function loadStudioSettings(storage = browserStorage()) {
  try {
    return parseStudioSettings(storage?.getItem(STUDIO_SETTINGS_STORAGE_KEY));
  } catch {
    return createStudioSettings();
  }
}

export function saveStudioSettings(settings, storage = browserStorage()) {
  try {
    if (!storage || typeof storage.setItem !== "function") return false;
    storage.setItem(STUDIO_SETTINGS_STORAGE_KEY, serializeStudioSettings(settings));
    return true;
  } catch {
    return false;
  }
}

export function reconcileStudioSettings(settings, health = {}) {
  const current = createStudioSettings(settings);
  const ollamaModels = Array.isArray(health?.ollama?.models)
    ? health.ollama.models.map(String).filter(Boolean)
    : [];
  const codexModels = Array.isArray(health?.codex?.models)
    ? health.codex.models.filter((model) => model && typeof model === "object" && String(model.value || "").trim())
    : [];
  const selectedCodex = codexModels.find((model) => String(model.value) === current.codexModel) || codexModels[0];
  const reasoningOptions = Array.isArray(selectedCodex?.reasoningEfforts) && selectedCodex.reasoningEfforts.length
    ? selectedCodex.reasoningEfforts.map(String).filter(Boolean)
    : DEFAULT_REASONING;
  return createStudioSettings({
    ...current,
    ollamaModel: ollamaModels.includes(current.ollamaModel) ? current.ollamaModel : ollamaModels[0] || current.ollamaModel,
    codexModel: selectedCodex ? String(selectedCodex.value) : current.codexModel,
    codexReasoningEffort: reasoningOptions.includes(current.codexReasoningEffort)
      ? current.codexReasoningEffort
      : reasoningOptions.includes("medium") ? "medium" : reasoningOptions[0] || current.codexReasoningEffort,
  });
}

function normalizeString(value, fallback) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
}

function browserStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
