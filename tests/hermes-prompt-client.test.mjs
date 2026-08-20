import assert from "node:assert/strict";
import test from "node:test";
import { createHermesPromptClient } from "../server/hermes-prompt-client.mjs";

function jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

test("Hermes prompt client discovers model and H3 skill before completing a prompt", async () => {
    const calls = [];
    const client = createHermesPromptClient({
        baseUrl: "http://127.0.0.1:8642/v1",
        apiKey: "test-key",
        model: "hermes-agent",
        skillName: "h3-prompt-writing",
        fetchImpl: async (url, init = {}) => {
            calls.push({ url: String(url), init });
            if (String(url).endsWith("/health")) return jsonResponse({ status: "ok" });
            if (String(url).endsWith("/v1/models")) return jsonResponse({ data: [{ id: "hermes-agent" }] });
            if (String(url).endsWith("/v1/skills")) return jsonResponse([{ name: "h3-prompt-writing", description: "H3 prompt skill" }]);
            if (String(url).endsWith("/v1/chat/completions")) {
                return jsonResponse({ choices: [{ message: { content: "final H3 prompt" } }] });
            }
            return jsonResponse({ error: "unexpected" }, 404);
        },
    });

    const status = await client.status();
    assert.equal(status.online, true);
    assert.equal(status.skill, true);
    assert.equal(status.model, "hermes-agent");
    assert.equal(status.url, "http://127.0.0.1:8642");

    const result = await client.complete({
        system: "Use the H3 skill.",
        prompt: "Create a five-second walking shot.",
        visualInputs: [{ role: "reference_image", data: "aGVsbG8=" }],
    });
    assert.equal(result, "final H3 prompt");

    const chat = calls.find((call) => call.url.endsWith("/v1/chat/completions"));
    assert.ok(chat);
    assert.equal(chat.init.headers.get("Authorization"), "Bearer test-key");
    const body = JSON.parse(chat.init.body);
    assert.equal(body.model, "hermes-agent");
    assert.equal(body.stream, false);
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.messages[1].content[0].type, "text");
    assert.equal(body.messages[1].content[1].type, "image_url");
    assert.match(body.messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/);
});

test("Hermes prompt client fails closed when the configured skill is unavailable", async () => {
    const client = createHermesPromptClient({
        fetchImpl: async (url) => {
            if (String(url).endsWith("/health")) return jsonResponse({ status: "ok" });
            if (String(url).endsWith("/v1/models")) return jsonResponse({ data: [{ id: "hermes-agent" }] });
            if (String(url).endsWith("/v1/skills")) return jsonResponse([]);
            return jsonResponse({ choices: [{ message: { content: "should not run" } }] });
        },
    });

    await assert.rejects(
        () => client.complete({ system: "test", prompt: "test" }),
        (error) => error?.code === "HERMES_SKILL_MISSING" && error?.status === 503,
    );
});
