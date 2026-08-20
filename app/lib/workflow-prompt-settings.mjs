import { reconcileStudioSettings } from "./studio-settings.mjs";

export function resolveWorkflowPromptConfiguration(storedSettings, health, configuredProvider = "auto") {
    const providerOverride = normalizeText(configuredProvider).toLowerCase();
    const settings = reconcileStudioSettings(storedSettings, health);
    const provider = providerOverride === "ollama" || providerOverride === "codex" || providerOverride === "hermes"
        ? providerOverride
        : settings.promptProvider;

    if (provider === "hermes") {
        if (!health?.hermes?.online) throw new Error("Hermes Agent 尚未連線。");
        if (!health?.hermes?.skill) throw new Error(`Hermes Agent 找不到 ${health?.hermes?.skillName || "h3-prompt-writing"} skill。`);
        return {
            provider,
            model: normalizeText(health?.hermes?.model) || "hermes-agent",
            codexModel: settings.codexModel,
            reasoningEffort: settings.codexReasoningEffort,
        };
    }

    if (provider === "ollama") {
        const models = Array.isArray(health?.ollama?.models) ? health.ollama.models.map(String).filter(Boolean) : [];
        if (!health?.ollama?.online) throw new Error("Ollama 尚未連線。");
        if (!models.includes(settings.ollamaModel)) throw new Error(`模型 ${settings.ollamaModel} 尚未安裝。`);
        return {
            provider,
            model: settings.ollamaModel,
            codexModel: settings.codexModel,
            reasoningEffort: settings.codexReasoningEffort,
        };
    }

    if (!health?.codex?.online) throw new Error("Codex CLI 尚未安裝或無法執行。");
    if (!health?.codex?.skill) throw new Error("找不到 h3-prompt-writing skill。");
    return {
        provider,
        model: settings.codexModel,
        codexModel: settings.codexModel,
        reasoningEffort: settings.codexReasoningEffort,
    };
}

function normalizeText(value) {
    return typeof value === "string" ? value.trim() : "";
}
