import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

const { route } = await import("../local-bridge.mjs");

function request(method, pathname, payload = null) {
  const req = payload === null ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(payload))]);
  req.method = method;
  req.url = pathname;
  req.headers = {};
  return req;
}

async function invoke(method, pathname, payload = null) {
  let body = "";
  const res = {
    headersSent: false,
    setHeader() {},
    writeHead(status) { this.status = status; },
    end(chunk) { body += String(chunk || ""); },
  };
  await route(request(method, pathname, payload), res);
  return { status: res.status, body: JSON.parse(body || "{}") };
}

function hermesFetch(url, init = {}) {
  const value = String(url);
  if (value.endsWith("/health")) return Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
  if (value.endsWith("/v1/models")) return Promise.resolve(new Response(JSON.stringify({ data: [{ id: "hermes-agent" }] }), { status: 200 }));
  if (value.endsWith("/v1/skills")) return Promise.resolve(new Response(JSON.stringify([{ name: "h3-prompt-writing" }]), { status: 200 }));
  if (value.endsWith("/v1/chat/completions")) {
    const body = JSON.parse(init.body || "{}");
    const system = String(body.messages?.[0]?.content || "");
    if (system.includes("workflow planner")) {
      return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ mode: "i2v", duration: 5, promptSkill: "h3-prompt", useOpenPose: false, useUpscale: true, assetRoles: [], reason: "Use the image reference." }) } }] }), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: "integrated_multimodal_description: [Shot 1] The subject walks naturally.\n\noverall_soundscape: Light room tone.\n\nnon_diegetic_music: N/A" } }] }), { status: 200 }));
  }
  return Promise.resolve(new Response(JSON.stringify({ error: `unexpected ${value}` }), { status: 404 }));
}

test("Hermes bridge domain exposes status, prompt, and allow-listed workflow planning without changing /api/prompt", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = hermesFetch;
  try {
    const status = await invoke("GET", "/api/hermes/status");
    assert.equal(status.status, 200);
    assert.equal(status.body.online, true);
    assert.equal(status.body.skill, true);

    const prompt = await invoke("POST", "/api/hermes/prompt", {
      brief: "A subject walks through a room.",
      mode: "t2v",
      duration: 5,
      skill: "h3-prompt",
      images: [],
    });
    assert.equal(prompt.status, 200);
    assert.equal(prompt.body.provider, "hermes");
    assert.match(prompt.body.prompt, /integrated_multimodal_description/);
    assert.ok(prompt.body.negativePrompt);

    const plan = await invoke("POST", "/api/hermes/plan", {
      brief: "Animate the supplied character reference and upscale it.",
      assets: [{ key: "input:person.png", kind: "image", role: "character" }],
    });
    assert.equal(plan.status, 200);
    assert.equal(plan.body.mode, "i2v");
    assert.equal(plan.body.useUpscale, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
