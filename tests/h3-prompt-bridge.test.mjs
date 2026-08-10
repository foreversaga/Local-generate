import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test, { after } from "node:test";

const bridgeLogRoot = await mkdtemp(path.join(os.tmpdir(), "h3-prompt-bridge-logs-"));
process.env.MINIMAX_H3_LOGS_ROOT = bridgeLogRoot;
const { route } = await import("../local-bridge.mjs");

after(async () => {
  await rm(bridgeLogRoot, { recursive: true, force: true });
});

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
    const generationCalls = calls.filter((body) => body.prompt);
    assert.equal(generationCalls.length, 2);
    assert.equal(generationCalls[0].options.temperature, 0.2);
    assert.equal(generationCalls[1].options.temperature, 0.2);
    assert.match(generationCalls[1].prompt, /VALIDATION_CONTRACT_START/);
    assert.equal(calls.filter((body) => body.prompt === "").length, 2);
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

test("Ollama img2img prompt generation returns strict positive and negative fields", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return new Response(JSON.stringify({
      response: JSON.stringify({
        prompt: "cinematic portrait, rain-soaked neon street, detailed skin texture",
        negativePrompt: "blurry, low quality, watermark, distorted hands",
      }),
    }), { status: 200 });
  };
  try {
    const result = await invoke("/api/prompt", {
      provider: "ollama",
      model: "qwen3-vl",
      mode: "img2img",
      brief: "Turn the source into a cinematic rainy-night portrait.",
      images: [{ role: "source_image", data: "data:image/png;base64,aGVsbG8=" }],
    });
    assert.equal(result.status, 200);
    assert.match(result.body.prompt, /cinematic portrait/);
    assert.match(result.body.negativePrompt, /watermark/);
    const generationCalls = calls.filter((body) => body.prompt);
    assert.equal(generationCalls.length, 1);
    assert.deepEqual(generationCalls[0].images, ["aGVsbG8="]);
    assert.match(generationCalls[0].system, /exactly these two keys: prompt and negativePrompt/);
    assert.equal(calls.filter((body) => body.prompt === "").length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Ollama img2img rejects malformed model output without a fallback negative prompt", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ response: "not valid JSON" }), { status: 200 });
  try {
    const result = await invoke("/api/prompt", {
      provider: "ollama",
      model: "qwen3-vl",
      mode: "img2img",
      brief: "Make the source image look cinematic.",
      images: [{ role: "source_image", data: "aGVsbG8=" }],
    });
    assert.equal(result.status, 502);
    assert.equal(result.body.code, "IMG2IMG_PROMPT_FORMAT_INVALID");
    assert.match(result.body.error, /JSON/);
    assert.equal(Object.prototype.hasOwnProperty.call(result.body, "negativePrompt"), false);
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

test("runtime endpoint switches atomically between local and Vast targets", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    urls.push(value);
    if (value.endsWith("/system_stats")) return new Response(JSON.stringify({ devices: [] }), { status: 200 });
    if (value.endsWith("/api/tags")) return new Response(JSON.stringify({ models: [] }), { status: 200 });
    if (value.endsWith("/api/ps")) return new Response(JSON.stringify({ models: [] }), { status: 200 });
    if (value.endsWith("/free")) return new Response("{}", { status: 200 });
    throw new Error(`unexpected runtime URL: ${value}`);
  };
  try {
    const remote = await invoke("/api/runtime", { mode: "remote" });
    assert.equal(remote.status, 200);
    assert.equal(remote.body.health.runtime.mode, "remote");
    assert.equal(remote.body.health.comfy.remote, true);
    assert.match(remote.body.health.comfy.url, /18188$/);
    assert.match(remote.body.health.ollama.url, /11435$/);

    const local = await invoke("/api/runtime", { mode: "local" });
    assert.equal(local.status, 200);
    assert.equal(local.body.health.runtime.mode, "local");
    assert.equal(local.body.health.comfy.remote, false);
    assert.match(local.body.health.comfy.url, /8188$/);
    assert.match(local.body.health.ollama.url, /11434$/);
    assert.ok(urls.some((url) => url.endsWith(":18188/system_stats")));
    assert.ok(urls.some((url) => url.endsWith(":11435/api/tags")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("failed Ollama repairs return the last candidate and validation details", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const invalid = "integrated_multimodal_description: malformed\n\noverall_soundscape: Footsteps\n\nnon_diegetic_music: N/A";
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ response: invalid }), { status: 200 });
  };
  try {
    const result = await invoke("/api/prompt", { brief: "A subject enters", mode: "t2v", duration: 5 });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, "PROMPT_REPAIR_FAILED");
    assert.equal(result.body.candidatePrompt, invalid);
    assert.equal(result.body.details.candidatePrompt, invalid);
    assert.equal(result.body.details.repairAttempts, 2);
    assert.equal(result.body.details.finalValidation.code, "PROMPT_SHOT1_REQUIRED");
    assert.equal(path.dirname(result.body.errorLog), bridgeLogRoot);
    const saved = (await readFile(result.body.errorLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .at(-1);
    assert.equal(saved.stage, "prompt_generation");
    assert.equal(saved.prompts.candidate, invalid);
    assert.equal(saved.error.code, "PROMPT_REPAIR_FAILED");
    assert.equal(calls.filter((body) => body.prompt).length, 3);
    assert.equal(calls.filter((body) => body.prompt === "").length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
