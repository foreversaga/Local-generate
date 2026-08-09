import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { route } from "../local-bridge.mjs";

const VALID_T2V = [
  "integrated_multimodal_description: [Shot 1] Live-action subject enters the room.",
  "",
  "overall_soundscape: Footsteps and room tone continue.",
  "",
  "non_diegetic_music: N/A",
].join("\n");

function request(pathname, payload) {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))]);
  req.method = "POST";
  req.url = pathname;
  req.headers = {};
  return req;
}

async function invoke(pathname, payload) {
  let body = "";
  const res = {
    headersSent: false,
    setHeader() {},
    writeHead(status) { this.status = status; },
    end(chunk) { body += String(chunk || ""); },
  };
  await route(request(pathname, payload), res);
  return { status: res.status, body: JSON.parse(body || "{}") };
}

test("Ollama prompt output is validated and repaired once with low randomness", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const response = calls.length === 1
      ? "integrated_multimodal_description: malformed\n\noverall_soundscape: Footsteps\n\nnon_diegetic_music: N/A"
      : VALID_T2V;
    return new Response(JSON.stringify({ response }), { status: 200 });
  };
  try {
    const result = await invoke("/api/prompt", { brief: "A subject enters", mode: "t2v", duration: 5 });
    assert.equal(result.status, 200);
    assert.equal(result.body.prompt, VALID_T2V);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.temperature, 0.2);
    assert.equal(calls[1].options.temperature, 0.2);
    assert.match(calls[1].prompt, /VALIDATION_CONTRACT_START/);
    assert.match(result.body.negativePrompt, /unwanted random text/);
    assert.doesNotMatch(result.body.negativePrompt, /, text,/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Ollama image modes reject requests without an actual visual input", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ response: VALID_T2V }), { status: 200 });
  };
  try {
    for (const mode of ["i2v", "fl2v", "l2v", "ref2v"]) {
      const result = await invoke("/api/prompt", { brief: "Animate the reference", mode, duration: 5 });
      assert.equal(result.status, 400);
      assert.equal(result.body.code, "PROMPT_VISUAL_INPUT_REQUIRED");
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("invalid prompt modes return 400 for prompt and generation routes", async () => {
  const prompt = await invoke("/api/prompt", { brief: "A scene", mode: "unknown" });
  assert.equal(prompt.status, 400);
  assert.equal(prompt.body.code, "PROMPT_MODE_INVALID");

  const generation = await invoke("/api/generate", { prompt: VALID_T2V, mode: "unknown" });
  assert.equal(generation.status, 400);
  assert.equal(generation.body.code, "PROMPT_MODE_INVALID");
});
