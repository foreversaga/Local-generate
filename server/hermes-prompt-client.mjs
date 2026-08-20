const DEFAULT_URL = "http://127.0.0.1:8642";
const DEFAULT_MODEL = "hermes-agent";
const DEFAULT_SKILL = "h3-prompt-writing";
const DEFAULT_TIMEOUT_MS = 180000;
const STATUS_TIMEOUT_MS = 5000;

export class HermesPromptError extends Error {
    constructor(code, message, status = 502, details = {}) {
        super(message);
        this.name = "HermesPromptError";
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

export function createHermesPromptClient({
    baseUrl = process.env.HERMES_API_URL || DEFAULT_URL,
    apiKey = process.env.HERMES_API_KEY || "",
    model = process.env.HERMES_MODEL || DEFAULT_MODEL,
    skillName = process.env.HERMES_H3_PROMPT_SKILL || DEFAULT_SKILL,
    timeoutMs = Number(process.env.HERMES_PROMPT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
    const url = normalizeBaseUrl(baseUrl);
    const configuredModel = normalizeText(model) || DEFAULT_MODEL;
    const configuredSkill = normalizeSkillName(skillName) || DEFAULT_SKILL;
    const requestTimeoutMs = clampTimeout(timeoutMs);

    async function status() {
        const health = await requestJson("/health", { method: "GET" }, STATUS_TIMEOUT_MS).catch(() => null);
        if (!health) {
            return {
                online: false,
                url,
                model: configuredModel,
                models: [],
                skill: false,
                skillName: configuredSkill,
            };
        }

        const [modelsPayload, skillsPayload] = await Promise.all([
            requestJson("/v1/models", { method: "GET" }, STATUS_TIMEOUT_MS).catch(() => null),
            requestJson("/v1/skills", { method: "GET" }, STATUS_TIMEOUT_MS).catch(() => null),
        ]);
        const models = parseModelNames(modelsPayload);
        const skills = parseSkillNames(skillsPayload);
        const selectedModel = models.includes(configuredModel) ? configuredModel : models[0] || configuredModel;
        return {
            online: true,
            url,
            model: selectedModel,
            models,
            skill: skills.includes(configuredSkill),
            skillName: configuredSkill,
        };
    }

    async function complete({ system, prompt, visualInputs = [], model: requestedModel = "" } = {}) {
        const capability = await status();
        if (!capability.online) {
            throw new HermesPromptError("HERMES_UNAVAILABLE", `Hermes Agent 無法連線：${url}`, 503, { url });
        }
        if (!capability.skill) {
            throw new HermesPromptError(
                "HERMES_SKILL_MISSING",
                `Hermes Agent 找不到 ${configuredSkill} skill。`,
                503,
                { skill: configuredSkill },
            );
        }

        const selectedModel = normalizeText(requestedModel) || capability.model;
        if (capability.models.length && !capability.models.includes(selectedModel)) {
            throw new HermesPromptError(
                "HERMES_MODEL_UNAVAILABLE",
                `Hermes Agent 模型 ${selectedModel} 不在目前可用清單中。`,
                400,
                { model: selectedModel, models: capability.models },
            );
        }

        const userContent = buildUserContent(prompt, visualInputs);
        const payload = await requestJson("/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: selectedModel,
                stream: false,
                messages: [
                    { role: "system", content: String(system || "") },
                    { role: "user", content: userContent },
                ],
            }),
        }, requestTimeoutMs);
        const content = messageText(payload?.choices?.[0]?.message?.content).trim();
        if (!content) {
            throw new HermesPromptError("HERMES_EMPTY_RESPONSE", "Hermes Agent 回傳了空的提示詞。", 502);
        }
        return content;
    }

    async function requestJson(pathname, init = {}, requestTimeout = requestTimeoutMs) {
        const headers = new Headers(init.headers || {});
        if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
        const response = await fetchImpl(`${url}${pathname}`, {
            ...init,
            headers,
            signal: AbortSignal.timeout(requestTimeout),
        });
        const text = await response.text();
        let payload = {};
        try {
            payload = JSON.parse(text || "{}");
        } catch {
            payload = { raw: text };
        }
        if (!response.ok) {
            const message = typeof payload?.error === "string"
                ? payload.error
                : payload?.error?.message || payload?.message || response.statusText || "Hermes request failed.";
            throw new HermesPromptError(
                response.status === 401 || response.status === 403 ? "HERMES_AUTH_FAILED" : "HERMES_REQUEST_FAILED",
                String(message),
                response.status || 502,
                { pathname },
            );
        }
        return payload;
    }

    return {
        url,
        model: configuredModel,
        skillName: configuredSkill,
        status,
        complete,
    };
}

function buildUserContent(prompt, visualInputs) {
    const inputs = Array.isArray(visualInputs) ? visualInputs.filter((item) => item?.data) : [];
    if (!inputs.length) return String(prompt || "");
    return [
        { type: "text", text: String(prompt || "") },
        ...inputs.map((item) => ({
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${String(item.data).trim()}` },
        })),
    ];
}

function parseModelNames(payload) {
    const values = Array.isArray(payload?.data) ? payload.data : [];
    return [...new Set(values.map((item) => normalizeText(item?.id || item?.name)).filter(Boolean))];
}

function parseSkillNames(payload) {
    const values = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
    return [...new Set(values.map((item) => normalizeText(item?.name || item?.id)).filter(Boolean))];
}

function messageText(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .map((part) => typeof part === "string" ? part : part?.text || part?.content || "")
        .join("\n");
}

function normalizeBaseUrl(value) {
    const normalized = normalizeText(value) || DEFAULT_URL;
    return normalized.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function normalizeSkillName(value) {
    const normalized = normalizeText(value);
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized) ? normalized : "";
}

function normalizeText(value) {
    return typeof value === "string" ? value.trim() : "";
}

function clampTimeout(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return DEFAULT_TIMEOUT_MS;
    return Math.min(10 * 60 * 1000, Math.max(1000, Math.round(number)));
}
