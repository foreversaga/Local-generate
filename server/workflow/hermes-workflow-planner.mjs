const MODES = new Set(["t2v", "i2v", "fl2v", "l2v", "ref2v", "ref2v_motion", "replace"]);
const PROMPT_SKILLS = new Set(["auto", "h3-prompt", "ref2v-prompt", "camera-control"]);
const ASSET_ROLES = new Set([
    "character", "face", "clothing", "first-frame", "last-frame", "motion-video",
    "pose", "scene", "video", "audio", "reference", "output",
]);

export function createHermesWorkflowPlanner({ hermesClient } = {}) {
    if (!hermesClient || typeof hermesClient.complete !== "function") {
        throw new TypeError("Hermes workflow planner requires a Hermes prompt client.");
    }

    async function plan({ brief, assets = [] } = {}) {
        const normalizedBrief = text(brief);
        if (!normalizedBrief) throw plannerError("WORKFLOW_PLAN_BRIEF_REQUIRED", "請先填寫 Project Brief。", 400);
        if (normalizedBrief.length > 4000) throw plannerError("WORKFLOW_PLAN_BRIEF_TOO_LONG", "Project Brief 不可超過 4000 字元。", 400);
        const normalizedAssets = normalizeAssets(assets);
        const system = [
            `Use the installed "${hermesClient.skillName}" skill as domain guidance for MiniMax H3 video modes.`,
            "You are the workflow planner for a local H3 Studio canvas. Plan only; never claim to execute generation, edit files, or call external services.",
            "Return exactly one JSON object and no Markdown.",
            "Allowed mode values: t2v, i2v, fl2v, l2v, ref2v, ref2v_motion, replace.",
            "Allowed promptSkill values: auto, h3-prompt, ref2v-prompt, camera-control.",
            "Allowed asset roles: character, face, clothing, first-frame, last-frame, motion-video, pose, scene, video, audio, reference, output.",
            "Schema: {\"mode\":string,\"duration\":number,\"promptSkill\":string,\"useOpenPose\":boolean,\"useUpscale\":boolean,\"assetRoles\":[{\"key\":string,\"role\":string}],\"reason\":string}.",
            "Only use asset keys from the supplied asset inventory. Do not invent assets. Prefer the simplest valid graph. OpenPose is useful only when pose conditioning is materially requested; Upscale is optional post-processing.",
        ].join("\n");
        const prompt = [
            "Project brief:",
            normalizedBrief,
            "",
            "Available project assets:",
            normalizedAssets.length
                ? normalizedAssets.map((asset) => `- ${asset.key} | ${asset.kind} | current role: ${asset.role}`).join("\n")
                : "- none",
        ].join("\n");
        const response = await hermesClient.complete({ system, prompt });
        return parseWorkflowPlan(response, normalizedAssets);
    }

    return { plan };
}

export function parseWorkflowPlan(value, assets = []) {
    const raw = String(value || "")
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw plannerError("WORKFLOW_PLAN_INVALID_JSON", "Hermes Agent 沒有回傳有效的 workflow plan JSON。", 502);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw plannerError("WORKFLOW_PLAN_INVALID", "Hermes Agent workflow plan 格式無效。", 502);
    }
    const mode = text(parsed.mode).toLowerCase();
    if (!MODES.has(mode)) throw plannerError("WORKFLOW_PLAN_MODE_INVALID", `Hermes Agent 回傳不支援的模式：${mode || "<empty>"}。`, 502);
    const promptSkill = PROMPT_SKILLS.has(text(parsed.promptSkill).toLowerCase())
        ? text(parsed.promptSkill).toLowerCase()
        : (mode === "ref2v" || mode === "ref2v_motion" ? "ref2v-prompt" : "h3-prompt");
    const duration = clampDuration(parsed.duration);
    const allowedKeys = new Set(normalizeAssets(assets).map((asset) => asset.key));
    const assetRoles = [];
    const seen = new Set();
    for (const item of Array.isArray(parsed.assetRoles) ? parsed.assetRoles : []) {
        const key = text(item?.key);
        const role = text(item?.role).toLowerCase();
        if (!allowedKeys.has(key) || !ASSET_ROLES.has(role) || seen.has(key)) continue;
        seen.add(key);
        assetRoles.push({ key, role });
    }
    return {
        mode,
        duration,
        promptSkill,
        useOpenPose: parsed.useOpenPose === true,
        useUpscale: parsed.useUpscale === true,
        assetRoles,
        reason: text(parsed.reason).slice(0, 1000),
    };
}

function normalizeAssets(assets) {
    return (Array.isArray(assets) ? assets : [])
        .map((asset) => ({
            key: text(asset?.key),
            kind: text(asset?.kind),
            role: text(asset?.role) || (asset?.kind === "video" ? "video" : "reference"),
        }))
        .filter((asset) => asset.key && ["image", "video"].includes(asset.kind));
}

function clampDuration(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 5;
    return Math.min(60, Math.max(1, Math.round(number * 2) / 2));
}

function plannerError(code, message, status) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
}

function text(value) {
    return typeof value === "string" ? value.trim() : "";
}
