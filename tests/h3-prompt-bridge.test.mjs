import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test, { after } from "node:test";

const bridgeLogRoot = await mkdtemp(path.join(os.tmpdir(), "h3-prompt-bridge-logs-"));
process.env.MINIMAX_H3_LOGS_ROOT = bridgeLogRoot;
const originalOllamaCliPath = process.env.OLLAMA_CLI_PATH;
const fakeOllamaCliPath = path.join(bridgeLogRoot, process.platform === "win32" ? "ollama-stop.cmd" : "ollama-stop");
await writeFile(
  fakeOllamaCliPath,
  process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
  "utf8",
);
if (process.platform !== "win32") await chmod(fakeOllamaCliPath, 0o755);
process.env.OLLAMA_CLI_PATH = fakeOllamaCliPath;
const {
  route,
  normalizeCharacterLoraName,
  normalizeCharacterLoraStrength,
  characterLoraOptions,
  resolveGenerationModelProfile,
  elapsedMilliseconds,
  markComfyExecutionStarted,
  requestSglangPrompt,
} = await import("../local-bridge.mjs");

after(async () => {
  if (originalOllamaCliPath === undefined) delete process.env.OLLAMA_CLI_PATH;
  else process.env.OLLAMA_CLI_PATH = originalOllamaCliPath;
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

async function invokeGet(pathname) {
  let body = "";
  const req = Readable.from([]);
  req.method = "GET";
  req.url = pathname;
  req.headers = {};
  const res = {
    headersSent: false,
    setHeader() {},
    writeHead(status) { this.status = status; },
    end(chunk) { body += String(chunk || ""); },
  };
  await route(req, res);
  return { status: res.status, body: JSON.parse(body || "{}") };
}

test("health exposes structured safe Python resolver diagnostics", async () => {
  const response = await invokeGet("/api/health");
  assert.equal(response.status, 200);
  assert.equal(typeof response.body.python, "object");
  assert.equal(typeof response.body.python.available, "boolean");
  assert.equal(typeof response.body.python.source, "string");
  assert.ok(Object.hasOwn(response.body.python, "version"));
  assert.ok(Object.hasOwn(response.body.python, "error"));
  assert.doesNotMatch(JSON.stringify(response.body.python), /MINIMAX_H3_PYTHON=.*[A-Za-z]:|private|secret/i);
});

test("GB10 generation defaults resolve to the NVFP4 model family", () => {
  assert.equal(resolveGenerationModelProfile("t2v", ""), "nvfp4_blackwell");
  assert.equal(resolveGenerationModelProfile("i2v", "nvfp4_blackwell"), "nvfp4_blackwell");
  assert.equal(resolveGenerationModelProfile("ref2v", "nvfp4_blackwell"), "ref2va_pruned_nvfp4");
  assert.equal(resolveGenerationModelProfile("ref2v", "ref2va_pruned_nvfp4"), "ref2va_pruned_nvfp4");
  assert.equal(resolveGenerationModelProfile("t2v", "int8_convrot_quality"), "int8_convrot_quality");
  assert.equal(resolveGenerationModelProfile("ref2v", "int8_convrot_quality"), "ref2va_pruned_int8_convrot");
  assert.equal(resolveGenerationModelProfile("ref2v", "ref2va_pruned_int8_convrot"), "ref2va_pruned_int8_convrot");
});

test("Vast Ref2VA resolves to the manifest's installed NVFP4 artifact", () => {
  assert.equal(resolveGenerationModelProfile("ref2v", "nvfp4_blackwell", { remote: true }), "ref2va_pruned_nvfp4");
  assert.throws(
    () => resolveGenerationModelProfile("ref2v", "int8_convrot_quality", { remote: true }),
    { code: "REF2VA_PROFILE_UNSUPPORTED", status: 422 },
  );
});

test("Vast FL2VA defaults to the manifest's installed NVFP4 artifact", () => {
  assert.equal(resolveGenerationModelProfile("t2v", "", { remote: true }), "nvfp4_blackwell");
  assert.throws(
    () => resolveGenerationModelProfile("t2v", "10eros_max_beta2_nvfp4", { remote: true }),
    { code: "FL2VA_PROFILE_UNSUPPORTED", status: 422 },
  );
  assert.throws(
    () => resolveGenerationModelProfile("t2v", "int8_convrot_quality", { remote: true }),
    { code: "FL2VA_PROFILE_UNSUPPORTED", status: 422 },
  );
});

test("terminal video jobs do not count queue time as execution time", () => {
  assert.equal(elapsedMilliseconds({
    status: "cancelled",
    startedAt: "2026-08-19T09:12:24.439Z",
    finishedAt: "2026-08-19T09:16:51.736Z",
    elapsedMs: 0,
  }), 0);
  assert.equal(elapsedMilliseconds({
    status: "interrupted",
    executionStartedAt: "2026-08-19T09:12:24.439Z",
    finishedAt: "2026-08-19T09:16:51.736Z",
    elapsedMs: 0,
  }), 267_297);
});

test("ComfyUI execution progress promotes queued video jobs to running", () => {
  const queued = {
    status: "queued",
    executionStartedAt: "2026-08-21T03:19:53.118Z",
  };
  markComfyExecutionStarted(queued);
  assert.equal(queued.status, "running");

  const cancelling = { status: "cancelling", executionStartedAt: null };
  markComfyExecutionStarted(cancelling);
  assert.equal(cancelling.status, "cancelling");
});

test("Character LoRA bridge validation accepts safe relative paths only", () => {
  assert.equal(normalizeCharacterLoraName(" characters\\hero.safetensors "), "characters/hero.safetensors");
  assert.throws(() => normalizeCharacterLoraName("../escape.safetensors"), { code: "CHARACTER_LORA_NAME_INVALID" });
  assert.throws(() => normalizeCharacterLoraName("C:\\models\\hero.safetensors"), { code: "CHARACTER_LORA_NAME_INVALID" });
  assert.throws(() => normalizeCharacterLoraName("\\\\server\\share\\hero.safetensors"), { code: "CHARACTER_LORA_NAME_INVALID" });
  assert.equal(normalizeCharacterLoraStrength(undefined), 0.75);
  assert.equal(normalizeCharacterLoraStrength("0.8"), 0.8);
  assert.throws(() => normalizeCharacterLoraStrength("   "), { code: "CHARACTER_LORA_STRENGTH_INVALID" });
  assert.throws(() => normalizeCharacterLoraStrength(2.1), { code: "CHARACTER_LORA_STRENGTH_INVALID" });
});

test("Character LoRA options come from the ComfyUI combo and omit built-ins", () => {
  assert.deepEqual(
    characterLoraOptions({
      LoraLoaderModelOnly: {
        input: {
          required: {
            lora_name: [[
              "characters/hero.safetensors",
              "LIGHTX2V_I2V_14B_480P_CFG_STEP_DISTILL_RANK64_BF16.SAFETENSORS",
              "characters\\hero.safetensors",
            ]],
          },
        },
      },
    }),
    ["characters/hero.safetensors"],
  );
  assert.deepEqual(
    characterLoraOptions({
      LoraLoaderModelOnly: {
        input: {
          required: {
            lora_name: [{ value: ["characters/current-schema.safetensors"] }],
          },
        },
      },
    }),
    ["characters/current-schema.safetensors"],
  );
});

test("Character LoRA discovery degrades to an empty list when ComfyUI is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("ComfyUI unavailable"); };
  try {
    const result = await invokeGet("/api/loras");
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {
      loras: [],
      items: [],
      available: false,
      registryVersion: 0,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Generate rejects unsafe character LoRA payloads before starting a job", async () => {
  const result = await invoke("/api/generate", {
    mode: "replace",
    prompt: "Replace the subject.",
    characterLoraName: "../escape.safetensors",
    characterLoraStrength: 0.75,
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, "CHARACTER_LORA_NAME_INVALID");
});

test("Ollama prompt output accepts malformed H3 structure without repair", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const response = "integrated_multimodal_description: malformed\n\noverall_soundscape: Footsteps\n\nnon_diegetic_music: N/A";
    return new Response(JSON.stringify({ response }), { status: 200 });
  };
  try {
    const result = await invoke("/api/prompt", { brief: "A subject enters", mode: "t2v", duration: 5 });
    assert.equal(result.status, 200);
    assert.equal(result.body.prompt, "integrated_multimodal_description: malformed\n\noverall_soundscape: Footsteps\n\nnon_diegetic_music: N/A");
    assert.match(result.body.ollamaPromptReceipt?.id || "", /^ollama-prompt-[0-9a-f-]+$/i);
    assert.equal(result.body.ollamaPromptReceipt.unload, "explicit");
    const generationCalls = calls.filter((body) => body.prompt);
    assert.equal(generationCalls.length, 1);
    assert.equal(generationCalls[0].options.temperature, 0.2);
    assert.equal(calls.filter((body) => typeof body.prompt === "string" && body.prompt.includes("VALIDATION_CONTRACT_START")).length, 0);
    assert.match(result.body.negativePrompt, /unwanted random text/);
    assert.doesNotMatch(result.body.negativePrompt, /, text,/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("vLLM prompt provider calls OpenAI chat completions with thinking disabled", async () => {
  const calls = [];
  const result = await requestSglangPrompt({
    model: "qwen3.8-27b-uncensored-nvfp4",
    system: "Return an H3 prompt.",
    prompt: "User idea:\nA subject enters",
    fetcher: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ choices: [{ message: { content: VALID_T2V } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  assert.equal(result, VALID_T2V);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1\/chat\/completions$/);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "qwen3.8-27b-uncensored-nvfp4");
  assert.equal(body.messages[0].content, "Return an H3 prompt.");
  assert.equal(body.messages[1].content, "User idea:\nA subject enters");
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
});

test("vLLM provider is routed independently from Ollama", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: VALID_T2V } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const result = await invoke("/api/prompt", {
      provider: "sglang",
      model: "qwen3.8-27b-uncensored-nvfp4",
      brief: "A subject enters",
      mode: "t2v",
      duration: 5,
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.prompt, VALID_T2V);
    assert.equal(result.body.ollamaPromptReceipt, undefined);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/v1\/chat\/completions$/);
    assert.equal(calls[0].body.model, "qwen3.8-27b-uncensored-nvfp4");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Ollama creates a later long-video segment prompt from the previous prompt and current description", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const refPrompt = `subject_definitions:\n<Video 1> is the previous segment's final two silent seconds.\n<Subject 1> is the recurring traveler described by the previous prompt.\n\nsummary:\n[reference generation] <Subject 1> enters a station using <Video 1> as a weak visual reference.\n\nretention_analysis:\n<Video 1>: weak_reference - only identity and lighting continuity are retained.\n<Subject 1> ([Shot 1]): fully_preserved - the recurring identity remains consistent.\n\ndetailed_description:\n[Shot 1] <Subject 1> enters the station in a slow Tracking Shot while the previous camera motion is not continued.\n\noverall_soundscape:\nStation room tone and footsteps.\n\nnon_diegetic_music:\nN/A`;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return new Response(JSON.stringify({ response: JSON.stringify({ prompt: refPrompt, negativePrompt: "identity drift, camera-motion carryover" }) }), { status: 200 });
  };
  try {
    const result = await invoke("/api/prompt", {
      purpose: "long_video_segment_continuation",
      provider: "ollama",
      model: "test-model",
      mode: "ref2v",
      segmentIndex: 1,
      duration: 5,
      previousPrompt: "integrated_multimodal_description: [Shot 1] A traveler leaves a platform.",
      description: "The same traveler enters the station lobby.",
      staticReferenceCount: 0,
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.prompt, refPrompt);
    assert.match(result.body.negativePrompt, /identity drift/);
    assert.match(result.body.negativePrompt, /camera-motion carryover/);
    assert.match(calls[0].prompt, /Previous segment H3 prompt/);
    assert.match(calls[0].prompt, /Current storyboard description/);
    assert.match(calls[0].system, /subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("long-video continuation prompt normalizes Ref2VA headings before returning them", async () => {
  const originalFetch = globalThis.fetch;
  const promptWithoutHeadingColons = `subject_definitions\n<Video 1> is the prior silent context.\n\nsummary\n[reference generation] Use <Video 1> weakly.\n\nretention_analysis\n<Video 1>: weak_reference - retain only broad continuity.\n\ndetailed_description\n[Shot 1] A generic traveler crosses the lobby.\n\noverall_soundscape\nQuiet room tone.\n\nnon_diegetic_music\nN/A`;
  globalThis.fetch = async () => new Response(JSON.stringify({ response: JSON.stringify({ prompt: promptWithoutHeadingColons, negativePrompt: "identity drift" }) }), { status: 200 });
  try {
    const result = await invoke("/api/prompt", {
      purpose: "long_video_segment_continuation",
      provider: "ollama",
      model: "test-model",
      segmentIndex: 1,
      duration: 5,
      previousPrompt: "A generic traveler waits.",
      description: "The traveler crosses the lobby.",
    });
    assert.equal(result.status, 200);
    for (const field of ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"]) {
      assert.match(result.body.prompt, new RegExp(`^${field}:`, "m"));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("long-video continuation prompt repairs a response that omits the previous-video label", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const missingVideo = `subject_definitions:\n<Subject 1> is a generic traveler.\n\nsummary:\n[reference generation] A traveler crosses a lobby.\n\nretention_analysis:\n<Subject 1>: fully_preserved - generic identity remains stable.\n\ndetailed_description:\n[Shot 1] <Subject 1> crosses the lobby.\n\noverall_soundscape:\nRoom tone.\n\nnon_diegetic_music:\nN/A`;
  const repaired = `subject_definitions:\n<Video 1> is the previous segment's final two silent seconds.\n<Subject 1> is a generic traveler represented in <Video 1>.\n\nsummary:\n[reference generation] A traveler crosses a lobby using <Video 1> weakly.\n\nretention_analysis:\n<Video 1>: weak_reference - only visual continuity is retained.\n<Subject 1>: fully_preserved - generic identity remains stable.\n\ndetailed_description:\n[Shot 1] <Subject 1> crosses the lobby while <Video 1> supplies weak continuity only.\n\noverall_soundscape:\nRoom tone.\n\nnon_diegetic_music:\nN/A`;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (!body.prompt) return new Response(JSON.stringify({ response: "" }), { status: 200 });
    const prompt = calls.length ? repaired : missingVideo;
    calls.push(prompt);
    return new Response(JSON.stringify({ response: JSON.stringify({ prompt, negativePrompt: "identity drift" }) }), { status: 200 });
  };
  try {
    const result = await invoke("/api/prompt", {
      purpose: "long_video_segment_continuation",
      provider: "ollama",
      model: "test-model",
      segmentIndex: 1,
      duration: 5,
      previousPrompt: "A generic traveler waits.",
      description: "The traveler crosses the lobby.",
    });
    assert.equal(result.status, 200);
    assert.equal(calls.length, 2);
    assert.match(result.body.prompt, /<Video 1>/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("single prompt duration accepts 60 seconds and rejects values above the maximum", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ response: VALID_T2V }), { status: 200 });
  try {
    const accepted = await invoke("/api/prompt", { brief: "A subject enters", mode: "t2v", duration: 60 });
    assert.equal(accepted.status, 200);

    const rejected = await invoke("/api/prompt", { brief: "A subject enters", mode: "t2v", duration: 60.5 });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.code, "SINGLE_DURATION_INVALID");
    assert.equal(rejected.body.details.max, 60);

    const rejectedGeneration = await invoke("/api/generate", { prompt: VALID_T2V, mode: "t2v", duration: 60.5 });
    assert.equal(rejectedGeneration.status, 400);
    assert.equal(rejectedGeneration.body.code, "SINGLE_DURATION_INVALID");
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

test("Ref2V camera planning is compiled into the model request and negative prompt", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const validRef2V = `subject_definitions:\n<Picture 1> is the supplied appearance reference.\n<Subject 1> is the principal person shown in <Picture 1>.\n\nsummary:\n[reference generation] Preserve <Subject 1> from <Picture 1>.\n\nretention_analysis:\n<Picture 1>: fully_preserved - appearance and identity remain consistent.\n<Subject 1> ([Shot 1]): fully_preserved - identity remains consistent.\n\ndetailed_description:\n[Shot 1] <Subject 1> walks through the scene in a handheld follow shot.\n\noverall_soundscape:\nNatural room tone and footsteps.\n\nnon_diegetic_music:\nN/A`;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return new Response(JSON.stringify({ response: validRef2V }), { status: 200 });
  };
  try {
    const result = await invoke("/api/prompt", {
      provider: "ollama", model: "vision-model", brief: "Keep the same person walking.", mode: "ref2v", duration: 5,
      referenceImageNames: ["person.png"], images: [{ role: "picture_1", data: "aGVsbG8=" }],
      cameraPlan: {
        videoPolicy: "none",
        global: { style: "smartphone", composition: "thirds", transition: "cut", imperfections: ["film_grain"], avoidances: ["random_zoom"] },
        shots: [{ startMs: 0, pictureRefs: [1], pictureRole: "appearance", size: "medium", angle: "eye_level", primaryMotion: "handheld_follow", secondaryMotion: "none", amplitude: "small", speed: "slow", transition: "cut", composition: "thirds" }],
      },
    });
    assert.equal(result.status, 200);
    const generation = calls.find((body) => typeof body.prompt === "string" && body.prompt.includes("User-selected Ref2VA camera plan"));
    assert.ok(generation);
    assert.match(generation.prompt, /casual smartphone footage/);
    assert.match(generation.prompt, /handheld follow shot/);
    assert.match(generation.prompt, /Do not output detached camera tags/);
    assert.match(result.body.negativePrompt, /unmotivated random zooms/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Ollama img2img prompt generation returns structured positive and negative fields", async () => {
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
    assert.equal(generationCalls[0].model, "qwen3-vl");
    assert.deepEqual(generationCalls[0].images, ["aGVsbG8="]);
    assert.match(generationCalls[0].system, /exactly these two keys: prompt and negativePrompt/);
    assert.match(generationCalls[0].system, /finger count, joints, overlaps, grip/);
    assert.match(generationCalls[0].system, /plastic or uniformly smooth skin/);
    assert.equal(calls.filter((body) => body.prompt === "").length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Ollama img2img keeps free-form model output without prompt validation", async () => {
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
    assert.equal(result.status, 200);
    assert.equal(result.body.prompt, "not valid JSON");
    assert.equal(result.body.negativePrompt, "");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Ollama img2img does not silently default a prompt model", async () => {
  const result = await invoke("/api/prompt", {
    provider: "ollama",
    mode: "img2img",
    brief: "Make the source image look cinematic.",
    images: [{ role: "source_image", data: "aGVsbG8=" }],
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, "IMG2IMG_MODEL_REQUIRED");
});

test("vLLM img2img uses the text-only OpenAI-compatible route while ComfyUI receives the source image", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: `{"prompt":"preserve the person and make the lighting feel candid and natural","negativePrompt":""}`,
        },
      }],
    }), { status: 200 });
  };
  try {
    const result = await invoke("/api/prompt", {
      provider: "sglang",
      model: "qwen3.8-27b-uncensored-nvfp4",
      imageModel: "flux-2-klein-9b-fp8.safetensors",
      mode: "img2img",
      brief: "Keep the person and make the photo feel candid.",
      images: [{ role: "source_image", data: "data:image/png;base64,aGVsbG8=" }],
    });
    assert.equal(result.status, 200);
    assert.match(result.body.prompt, /preserve the person/);
    assert.equal(result.body.negativePrompt, "");
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/v1\/chat\/completions$/);
    assert.equal(calls[0].body.model, "qwen3.8-27b-uncensored-nvfp4");
    assert.equal(calls[0].body.max_tokens, 512);
    assert.deepEqual(calls[0].body.response_format, { type: "json_object" });
    assert.match(calls[0].body.messages[0].content, /<nature-camera-skill>/);
    assert.match(calls[0].body.messages[0].content, /# Nature Camera/);
    assert.match(calls[0].body.messages[0].content, /# Camera Language Reference/);
    assert.match(calls[0].body.messages[0].content, /FLUX\.2 Image Edit/);
    assert.match(calls[0].body.messages[0].content, /You do not receive or inspect the source image/);
    assert.match(calls[0].body.messages[0].content, /negativePrompt must be an empty string/);
    const userContent = calls[0].body.messages.find((message) => message.role === "user")?.content;
    assert.equal(typeof userContent, "string");
    assert.match(userContent, /The image generator will receive one source image separately/);
    assert.match(userContent, /Direct edit request/);
    assert.match(userContent, /Keep the person and make the photo feel candid\./);
    assert.doesNotMatch(JSON.stringify(calls[0].body), /image_url/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("img2img prompt generation rejects an unknown target image model", async () => {
  const result = await invoke("/api/prompt", {
    provider: "sglang",
    model: "qwen3.5-9b-vision",
    imageModel: "unknown-image-model.safetensors",
    mode: "img2img",
    brief: "Change only the hairstyle.",
    images: [{ role: "source_image", data: "aGVsbG8=" }],
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, "IMG2IMG_IMAGE_MODEL_UNSUPPORTED");
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

test("oversized Ollama prompts retain the size boundary and validation details", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const invalid = "x".repeat(7001);
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
    assert.equal(result.body.details.finalValidation.code, "PROMPT_TOO_LONG");
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
