import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { allocateSequenceOutputPath, sequenceAttemptFile, validateOutputFolderName } from "../server/long-video/paths.mjs";
import { parseTimeline } from "../server/long-video/timeline-parser.mjs";
import { buildI2VAPrompt, buildRef2VAPrompt, buildT2VAPrompt } from "../server/long-video/prompt-builder.mjs";
import { validatePrompt } from "../server/long-video/prompt-validator.mjs";
import { appendEvent, atomicWriteJson, createJob, getJob, updateJob } from "../server/long-video/store.mjs";
import { extractTailAvContext, extractTailFrame } from "../server/long-video/media.mjs";
import { latentRenderedDuration, latentRenderedFrameCount, runSequence, sequenceProgressForSegment } from "../server/long-video/runner.mjs";
import { DEFAULT_NEGATIVE_PROMPT, normalizePlannerImages, parsePlannerResponse, planSequence } from "../server/long-video/planner.mjs";
import { handleLongVideoRoute } from "../server/long-video/api.mjs";
import { LongVideoError, createSequenceRecord, sanitizeAssetRef, validateContinuityBible, validateSequenceInput } from "../server/long-video/schema.mjs";
import { longJobIsActive } from "../app/lib/long-create-contract.mjs";
import { createOllamaCoordinator } from "../server/ollama-coordinator.mjs";
import { ensureRef2vaLatentContinuationPrompt, ensureRef2vaVisualContextPrompt } from "../server/long-video/continuation-finalizer.mjs";

function apiRequest(method, url, value = {}) {
  return { method, url, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(value)); } };
}

function apiResponse() {
  return { headersSent: false, writeHead(status) { this.status = status; }, end(value) { this.body = JSON.parse(value); } };
}

test("long-video routes report that the response was handled", async () => {
  const response = apiResponse();
  const handled = await handleLongVideoRoute(apiRequest("POST", "/api/sequences/plan", { inputType: "text", inputText: "brief" }), response, {
    plan: async () => ({
      inputType: "text",
      duration: 10,
      continuityBible: {},
      segments: [{ start: 0, end: 5, description: "first" }, { start: 5, end: 10, description: "second" }],
      timeline: [{ start: 0, end: 5, description: "first" }, { start: 5, end: 10, description: "second" }],
      planMeta: { model: "test", timelineSource: "ollama", promptSource: "ollama_structured" },
    }),
  });
  assert.equal(handled, true);
  assert.equal(response.status, 200);
  assert.equal(await handleLongVideoRoute(apiRequest("GET", "/api/health"), apiResponse(), {}), false);
  const bridge = await readFile(new URL("../local-bridge.mjs", import.meta.url), "utf8");
  assert.match(bridge, /if \(handledByDomainRouter \|\| res\.headersSent\) return/);
});

test("rejects Windows reserved names and traversal", async () => {
  assert.throws(() => validateOutputFolderName("CON"), { code: "OUTPUT_FOLDER_INVALID" });
  assert.throws(() => validateOutputFolderName("trail."), { code: "OUTPUT_FOLDER_INVALID" });
  assert.throws(() => validateOutputFolderName(" trail"), { code: "OUTPUT_FOLDER_INVALID" });
  assert.throws(() => validateOutputFolderName("x".repeat(81)), { code: "OUTPUT_FOLDER_INVALID" });
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-output-"));
  const allocated = await allocateSequenceOutputPath("safe-folder", { root });
  assert.equal(path.basename(allocated.path), "safe-folder");
  await assert.rejects(() => allocateSequenceOutputPath("safe-folder", { root }), { code: "OUTPUT_FOLDER_EXISTS" });
});

test("sanitizes asset refs and normalizes image first-frame inputs", () => {
  for (const value of [
    { name: "" },
    { name: "/tmp/frame.png" },
    { name: "C:\\tmp\\frame.png" },
    { name: "\\\\server\\share\\frame.png" },
    { name: "nested/../frame.png" },
  ]) {
    assert.throws(() => sanitizeAssetRef(value), { code: "ASSET_REF_INVALID" });
  }
  assert.deepEqual(sanitizeAssetRef({ root: "input", name: "nested\\frame.png", kind: "image" }), { root: "input", name: "nested/frame.png", kind: "image" });
  const normalized = validateSequenceInput({ inputType: "image", imagePurpose: "first_frame", inputAsset: { root: "input", name: "frame.png" }, timeline: [{ start: 0, end: 5, description: "a" }, { start: 5, end: 10, description: "b" }] });
  assert.equal(normalized.inputAsset.kind, "image");
  assert.throws(() => validateSequenceInput({ inputType: "image", imagePurpose: "first_frame", timeline: [{ start: 0, end: 5, description: "a" }, { start: 5, end: 10, description: "b" }] }), { code: "INPUT_ASSET_REQUIRED" });
  assert.throws(() => validateSequenceInput({ inputType: "image", imagePurpose: "first_frame", inputAsset: { name: "clip.mp4", kind: "video" }, timeline: [{ start: 0, end: 5, description: "a" }, { start: 5, end: 10, description: "b" }] }), { code: "INPUT_ASSET_KIND_INVALID" });
  assert.equal(createSequenceRecord({ outputFolder: "unallocated", outputAllocated: true, timeline: [{ start: 0, end: 5, description: "a" }, { start: 5, end: 10, description: "b" }] }).outputAllocated, undefined);
});

test("sequence script drafts preserve long-shot duration, prompt, and description", () => {
  const normalized = validateSequenceInput({
    scripts: [
      { name: "Opening", duration: 3.5, content: "prompt one", description: "rainy street opening" },
      { name: "Chase", duration: 6, prompt: "prompt two", description: "station chase" },
    ],
    timeline: [{ start: 0, end: 3.5, description: "rainy street opening" }, { start: 3.5, end: 9.5, description: "station chase" }],
  });
  assert.deepEqual(normalized.scripts.map(({ name, duration, content, description }) => ({ name, duration, content, description })), [
    { name: "Opening", duration: 3.5, content: "prompt one", description: "rainy street opening" },
    { name: "Chase", duration: 6, content: "prompt two", description: "station chase" },
  ]);
  assert.equal(validateSequenceInput({ scripts: [{ name: "Legacy", content: "legacy prompt" }], timeline: [{ start: 0, end: 5, description: "a" }, { start: 5, end: 10, description: "b" }] }).scripts[0].description, "legacy prompt");
});

test("parses timestamp and N-second timelines deterministically", () => {
  assert.deepEqual(parseTimeline("[00:00.000 - 00:05.000] opening\n[00:05.000 - 00:10.000] ending").map((item) => item.duration), [5, 5]);
  assert.deepEqual(parseTimeline("5秒：opening\n5s: ending").map((item) => [item.start, item.end]), [[0, 5], [5, 10]]);
  assert.throws(() => parseTimeline("[00:00 - 00:05] a\n[00:06 - 00:10] b"), { code: "TIMELINE_GAP" });
});

test("prompt field order and I2VA first line are stable", () => {
  const t2v = buildT2VAPrompt({ description: "walk" }, { sound: "wind", nonDiegeticMusic: "N/A" });
  validatePrompt(t2v, { mode: "t2v" });
  const i2v = buildI2VAPrompt({ description: "continue" });
  assert.match(i2v, /^For the target video, at 0\.00 seconds into the target video, <Picture 1> \(from \[Shot 1\]\) is fully referenced\./);
  validatePrompt(i2v, { mode: "i2v" });
  assert.doesNotThrow(() => validatePrompt("integrated_multimodal_description: walk\n\noverall_soundscape: wind\n\nnon_diegetic_music: N/A", { mode: "t2v" }));
});

test("continuity bible preserves explicit face identity anchors and prompt builders reuse them", () => {
  const bible = validateContinuityBible({
    characters: [{
      id: "hero",
      faceIdentity: "oval face with a left-cheek scar",
      hair: "short black curls",
      silhouette: "lean athletic frame",
      palette: ["navy", "copper"],
      distinctiveMarks: "silver ear cuff",
      appearance: "young courier",
      clothing: "navy raincoat",
      voice: "low and urgent",
    }],
  });
  assert.deepEqual(bible.characters[0], {
    id: "hero",
    faceIdentity: "oval face with a left-cheek scar",
    hair: "short black curls",
    silhouette: "lean athletic frame",
    palette: "navy, copper",
    distinctiveMarks: "silver ear cuff",
    appearance: "young courier",
    clothing: "navy raincoat",
    voice: "low and urgent",
  });
  const t2v = buildT2VAPrompt({ description: "runs", endingState: "at the closing train door" }, bible);
  assert.match(t2v, /face identity: oval face with a left-cheek scar/);
  assert.match(t2v, /Ending state: at the closing train door/);
  const ref2v = buildRef2VAPrompt({ description: "runs" }, bible, { assets: [{ name: "hero.png" }] });
  assert.match(ref2v, /subject_definitions:[\s\S]*stable referenced character identity/);
  assert.match(ref2v, /retention_analysis:[\s\S]*face identity: oval face with a left-cheek scar/);
});

test("planner normalizes attached reference image bytes and forwards them only to Ollama images", async () => {
  assert.deepEqual(normalizePlannerImages([{ role: "hero", data: "data:image/png;base64, aGVsbG8=" }]), [{ role: "hero", data: "aGVsbG8=" }]);
  const requestBodies = [];
  const plan = await planSequence({
    inputType: "image",
    imagePurpose: "first_frame",
    inputAsset: { root: "input", name: "hero.png", kind: "image" },
    plannerImages: [{ role: "hero", data: "data:image/png;base64,aGVsbG8=" }],
    inputText: "A courier waits at the train door.",
    timelineMode: "auto",
    duration: 10,
  }, {
    fetchImpl: async (_url, init) => {
      requestBodies.push(JSON.parse(init.body));
      return { ok: true, text: async () => JSON.stringify({ continuityBible: {}, segments: [{ start: 0, end: 5, description: "waits" }, { start: 5, end: 10, description: "boards" }] }) };
    },
    ollamaCoordinator: createOllamaCoordinator({ commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }) }),
    loadSkillPack: async () => ({
      systemPrompt: "trusted H3 test skill",
      policy: { name: "h3-prompt-writing", guide: "base-en.txt", contentHash: "test-hash", source: "filesystem" },
    }),
  });
  assert.equal(plan.segments.length, 2);
  assert.equal(requestBodies.length, 2);
  const [bodyWithImage, unloadBody] = requestBodies;
  assert.deepEqual(bodyWithImage.images, ["aGVsbG8="]);
  assert.equal(bodyWithImage.options.temperature, 0);
  assert.equal(bodyWithImage.options.top_p, 0.85);
  assert.equal(bodyWithImage.options.num_ctx, 32768);
  assert.equal(bodyWithImage.stream, false);
  assert.equal(bodyWithImage.keep_alive, 0);
  assert.equal(bodyWithImage.system, "trusted H3 test skill");
  assert.match(bodyWithImage.prompt, /Actual reference image bytes are attached/);
  assert.deepEqual(unloadBody, { model: bodyWithImage.model, prompt: "", stream: false, keep_alive: 0 });
});

test("tail extraction selects the PNG encoder on FFmpeg 9", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-tail-"));
  const inputPath = path.join(root, "segment.mp4");
  const outputPath = path.join(root, "segment-tail.png");
  let receivedArgs = [];
  await extractTailFrame({
    inputPath,
    outputPath,
    tools: { executables: { ffmpeg: "ffmpeg-test", ffprobe: "ffprobe-test" } },
    run: async (_executable, args) => {
      receivedArgs = args;
      await writeFile(outputPath, "fake-png");
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(receivedArgs.includes("format=png"), false);
  assert.deepEqual(receivedArgs.slice(receivedArgs.indexOf("-c:v"), receivedArgs.indexOf("-c:v") + 4), ["-c:v", "png", "-pix_fmt", "rgb24"]);
});

test("runner maps native segment progress into overall long-video progress", async () => {
  const updates = [];
  const folder = path.join(os.tmpdir(), "h3-progress-output");
  const job = {
    id: "x",
    inputType: "text",
    outputPath: folder,
    outputFolder: "progress",
    status: "ready",
    revision: 1,
    width: 736,
    height: 416,
    steps: 2,
    seed: 1,
    continuityBible: {},
    segments: [{ id: "s1", start: 0, end: 5, duration: 5, description: "a" }, { id: "s2", start: 5, end: 10, duration: 5, description: "b" }],
  };
  const result = await runSequence(job, {
    generate: async (payload) => {
      await payload.onProgress({ id: `legacy-${payload.segmentIndex}`, progress: 20, stage: "已送入 ComfyUI 佇列", progressSource: "estimated" });
      await payload.onProgress({ id: `legacy-${payload.segmentIndex}`, progress: 60, stage: "採樣生成影格…", progressSource: "native", nativeCurrent: 6, nativeMaximum: 10 });
      return { rawPath: payload.outputPath, id: `legacy-${payload.segmentIndex}` };
    },
    normalize: async () => {},
    extractTail: async () => {},
    assemble: async () => ({ outputPath: path.join(folder, "final-r001.mp4"), revision: 1, probe: {} }),
    writeManifest: async () => {},
    updateJob: async (target, patch) => { updates.push({ ...patch }); return Object.assign(target, patch); },
    updateSegment: async (target, index, patch) => Object.assign(target.segments[index], patch),
  });
  assert.equal(sequenceProgressForSegment(0, 2, 20), 9);
  assert.ok(updates.some((patch) => patch.segmentProgress === 60 && patch.progress === 26 && patch.progressSource === "native"));
  assert.equal(result.progress, 100);
});

test("manual planner parses author timeline before Ollama and ignores model timing", async () => {
  let called = 0;
  const plan = await planSequence({ inputType: "text", inputText: "brief", timelineText: "5s: first\n5s: second" }, {
    request: async () => { called += 1; return { continuityBible: {}, segments: [{ start: 100, end: 200, description: "model first" }, { start: 200, end: 300, description: "model second" }] }; },
  });
  assert.equal(called, 1);
  assert.deepEqual(plan.segments.map((segment) => [segment.start, segment.end]), [[0, 5], [5, 10]]);
  await assert.rejects(() => planSequence({ inputType: "text", inputText: "brief", timelineText: "[00:00 - 00:05] first\n[00:06 - 00:10] second" }, { request: async () => { throw new Error("must not call"); } }), { code: "TIMELINE_GAP" });
});

test("automatic planner uses Ollama storyboard timing and structured H3 content", async () => {
  let receivedPrompt = "";
  const plan = await planSequence({
    inputType: "text",
    inputText: "A courier races through a rainy station and boards the last train.",
    timelineMode: "auto",
    duration: 12,
    segmentDurationHint: 5,
    negativePrompt: "no readable signs",
  }, {
    request: async ({ prompt }) => {
      receivedPrompt = prompt;
      return {
        negativePrompt: "flicker, watermark",
        continuityBible: { visualStyle: "live-action cinematic", sound: "rain and footsteps", nonDiegeticMusic: "low strings" },
        segments: [
          {
            start: 0,
            end: 4.5,
            description: "The courier spots the train.",
            integratedMultimodalDescription: "[Shot 1] Live-action, cinematic, a wide shot follows the courier through rain as the train doors begin to close.",
            overallSoundscape: "Rain strikes the platform while shoes splash through puddles.",
            nonDiegeticMusic: "Low strings pulse at a moderate tempo.",
            endingState: "The courier reaches the final carriage door.",
            negativePrompt: "",
          },
          {
            start: 4.5,
            end: 8,
            description: "The courier catches the door.",
            integratedMultimodalDescription: "[Shot 1] The first frame continues as the courier grips the closing door and pulls forward.",
            overallSoundscape: "The warning chime sounds over the rain.",
            nonDiegeticMusic: "Low strings accelerate.",
            endingState: "The courier steps into the carriage.",
            negativePrompt: "hand distortion",
          },
          {
            start: 8,
            end: 12,
            description: "The train departs.",
            integratedMultimodalDescription: "[Shot 1] The courier steadies inside the carriage while the wet platform begins sliding past the window.",
            overallSoundscape: "The doors seal and rail noise rises.",
            nonDiegeticMusic: "Sustained low strings fade at the end.",
            endingState: "The courier watches the platform recede.",
            negativePrompt: "",
          },
        ],
      };
    },
  });
  assert.match(receivedPrompt, /Create the global storyboard timing yourself for exactly 12\.000 seconds/);
  assert.match(receivedPrompt, /integratedMultimodalDescription/);
  assert.deepEqual(plan.segments.map((segment) => [segment.start, segment.end]), [[0, 4.5], [4.5, 8], [8, 12]]);
  assert.equal(plan.planMeta.timelineSource, "ollama");
  assert.equal(plan.planningSettings.segmentCount, 3);
  assert.equal(plan.negativePrompt, `${DEFAULT_NEGATIVE_PROMPT}, no readable signs`);
  assert.match(plan.negativePrompt, /facial identity drift/);
  assert.match(plan.negativePrompt, /incorrect finger count/);
  assert.match(plan.negativePrompt, /broken cloth physics/);
  assert.equal(plan.continuityBible.mustPreserve.length, 3);
  assert.equal(plan.continuityBible.mustAvoid.length, 3);
  assert.match(plan.segments[0].prompt, /a wide shot follows the courier/);
  assert.match(plan.segments[1].prompt, /^For the target video, at 0\.00 seconds into the target video/);
  assert.equal(plan.segments[1].negativePrompt, "hand distortion");
});

test("Codex planner preserves provider metadata and structured H3 segments", async () => {
  const plan = await planSequence({
    promptProvider: "codex",
    codexModel: "gpt-5.6-luna",
    inputType: "text",
    inputText: "A lantern bearer crosses a quiet mountain bridge.",
    timelineMode: "auto",
    duration: 10,
  }, {
    request: async () => ({
      continuityBible: { visualStyle: "cinematic", environment: "mountain bridge" },
      segments: [
        { start: 0, end: 5, description: "The lantern bearer reaches the bridge." },
        { start: 5, end: 10, description: "The lantern bearer crosses into the mist." },
      ],
    }),
  });
  assert.equal(plan.promptProvider, "codex");
  assert.equal(plan.codexModel, "gpt-5.6-luna");
  assert.equal(plan.planMeta.source, "codex");
  assert.equal(plan.planMeta.timelineSource, "codex");
  assert.equal(plan.planMeta.promptSource, "codex_structured");
  assert.match(plan.segments[1].prompt, /^For the target video, at 0\.00 seconds into the target video/);
});

test("vLLM planner preserves provider metadata and model selection", async () => {
  const plan = await planSequence({
    promptProvider: "sglang",
    sglangModel: "qwen3.8-27b-uncensored-nvfp4",
    inputType: "text",
    inputText: "A lantern bearer crosses a quiet mountain bridge.",
    timelineMode: "auto",
    duration: 10,
  }, {
    request: async () => ({
      continuityBible: { visualStyle: "cinematic", environment: "mountain bridge" },
      segments: [
        { start: 0, end: 5, description: "The lantern bearer reaches the bridge." },
        { start: 5, end: 10, description: "The lantern bearer crosses into the mist." },
      ],
    }),
  });
  assert.equal(plan.promptProvider, "sglang");
  assert.equal(plan.sglangModel, "qwen3.8-27b-uncensored-nvfp4");
  assert.equal(plan.planMeta.source, "sglang");
  assert.equal(plan.planMeta.timelineSource, "sglang");
  assert.equal(plan.planMeta.promptSource, "sglang_structured");
});

test("Codex planner extracts a JSON object surrounded by short commentary", () => {
  const parsed = parsePlannerResponse("Here is the plan:\n{\"continuityBible\":{},\"segments\":[]}\n", "codex");
  assert.deepEqual(parsed, { continuityBible: {}, segments: [] });
});

test("Codex planner retries a transient CLI response failure", async () => {
  let attempts = 0;
  const plan = await planSequence({
    promptProvider: "codex",
    codexModel: "gpt-5.6-luna",
    inputType: "text",
    inputText: "A lantern bearer crosses a quiet mountain bridge.",
    timelineMode: "auto",
    duration: 10,
  }, {
    request: async ({ attempt }) => {
      attempts += 1;
      if (attempt === 1) throw new LongVideoError("CODEX_REQUEST_FAILED", "temporary CLI exit", 502);
      return {
        continuityBible: {},
        segments: [{ start: 0, end: 5, description: "first" }, { start: 5, end: 10, description: "second" }],
      };
    },
  });
  assert.equal(attempts, 2);
  assert.equal(plan.planMeta.repairAttempts, 0);
  assert.equal(plan.planMeta.retryAttempts, 1);
  assert.deepEqual(plan.planMeta.retryCodes, ["CODEX_REQUEST_FAILED"]);
});

test("Codex planner recovers a malformed automatic timeline after one repair", async () => {
  let attempts = 0;
  const plan = await planSequence({
    promptProvider: "codex",
    codexModel: "gpt-5.6-luna",
    inputType: "text",
    inputText: "A lantern bearer crosses a quiet mountain bridge.",
    timelineMode: "auto",
    duration: 10,
  }, {
    request: async () => {
      attempts += 1;
      return {
        continuityBible: {},
        segments: attempts === 1
          ? [{ start: 0, end: 4, description: "first" }, { start: 5, end: 10, description: "second" }]
          : [{ start: 0, end: 6, description: "first" }, { start: 7, end: 10, description: "second" }],
      };
    },
  });
  assert.equal(attempts, 2);
  assert.equal(plan.planMeta.repairAttempts, 1);
  assert.equal(plan.planMeta.timelineRepair, "server_contiguous");
  assert.deepEqual(plan.segments.map((segment) => [segment.start, segment.end]), [[0, 6], [6, 10]]);
});

test("Codex planner keeps provider-specific request failures", async () => {
  await assert.rejects(() => planSequence({
    promptProvider: "codex",
    codexModel: "gpt-5.6-luna",
    inputType: "text",
    inputText: "A lantern bearer crosses a quiet mountain bridge.",
    timelineMode: "auto",
    duration: 10,
  }, {
    request: async () => { throw new Error("CLI unavailable"); },
  }), {
    code: "CODEX_UNAVAILABLE",
    message: /Unable to reach Codex CLI: CLI unavailable/,
  });
});

test("automatic planner recovers invalid Ollama storyboard arithmetic without blocking", async () => {
  let attempts = 0;
  const plan = await planSequence({ inputType: "text", inputText: "brief", timelineMode: "auto", duration: 10 }, {
    request: async () => {
      attempts += 1;
      return { continuityBible: {}, segments: [{ start: 0, end: 5, description: "first" }, { start: 6, end: 10, description: "second" }] };
    },
  });
  assert.equal(attempts, 2);
  assert.equal(plan.planMeta.timelineRepair, "server_contiguous");
  assert.deepEqual(plan.segments.map((segment) => [segment.start, segment.end]), [[0, 5], [5, 10]]);
});

test("video-only storyboard reference does not invent a first-frame picture", () => {
  const prompt = buildRef2VAPrompt(
    { duration: 5, description: "A new independent close-up shot", detailedDescription: "[Shot 1] A close-up begins with its own composition." },
    {},
    { hasVideo: true },
  );
  assert.match(prompt, /<Video 1>/);
  assert.doesNotMatch(prompt, /<Picture 1>/);
  assert.match(prompt, /\[reference generation\]/);
  validatePrompt(prompt, { mode: "ref2v" });
});

test("storyboard reference admission fixes visual context to two seconds and keeps older jobs on legacy tail mode", () => {
  const timeline = [{ start: 0, end: 5, description: "opening" }, { start: 5, end: 10, description: "continuation" }];
  const legacy = validateSequenceInput({ inputType: "text", timeline });
  assert.equal(legacy.continuationMode, "legacy_tail");
  assert.equal(legacy.timeline[1].mode, "t2v");
  const motion = validateSequenceInput({ inputType: "text", continuationMode: "motion_context", motionContextSeconds: 1.5, timeline });
  assert.equal(motion.continuationMode, "motion_context");
  assert.equal(motion.motionContextSeconds, 2);
  assert.equal(motion.timeline[0].mode, "t2v");
  assert.equal(motion.timeline[1].mode, "ref2v");
  const latent = validateSequenceInput({
    inputType: "image",
    imagePurpose: "first_frame",
    inputAsset: { root: "input", name: "start.png", kind: "image" },
    continuationMode: "latent_context",
    timeline,
  });
  assert.equal(latent.timeline[1].mode, "ref2v");
  assert.throws(() => validateSequenceInput({ inputType: "text", continuationMode: "latent_context", timeline }), { code: "LATENT_CONTEXT_IMAGE_REQUIRED" });
  assert.throws(() => validateSequenceInput({ inputType: "text", continuationMode: "motion_context", motionContextSeconds: 2.1, timeline }), { code: "MOTION_CONTEXT_DURATION_INVALID" });
});

test("automatic planner repairs one invalid Ollama timeline response", async () => {
  const requests = [];
  const plan = await planSequence({ inputType: "text", inputText: "brief", timelineMode: "auto", duration: 10 }, {
    request: async (request) => {
      requests.push(request);
      if (request.attempt === 1) return { continuityBible: {}, segments: [] };
      return {
        continuityBible: { visualStyle: "cinematic" },
        segments: [{ start: 0, end: 4, description: "first" }, { start: 4, end: 10, description: "second" }],
      };
    },
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].repair, true);
  assert.match(requests[1].prompt, /Failure code: OLLAMA_TIMELINE_INVALID/);
  assert.equal(plan.planMeta.repairAttempts, 1);
  assert.deepEqual(plan.segments.map((segment) => [segment.start, segment.end]), [[0, 4], [4, 10]]);
});

test("automatic planner repairs one invalid JSON response", async () => {
  let attempts = 0;
  const plan = await planSequence({ inputType: "text", inputText: "brief", timelineMode: "auto", duration: 10 }, {
    request: async ({ prompt }) => {
      attempts += 1;
      if (attempts === 1) return "this is not JSON";
      assert.match(prompt, /Failure code: OLLAMA_INVALID_JSON/);
      return { continuityBible: {}, segments: [{ start: 0, end: 5, description: "first" }, { start: 5, end: 10, description: "second" }] };
    },
  });
  assert.equal(attempts, 2);
  assert.equal(plan.planMeta.repairAttempts, 1);
});

test("automatic planner uses a deterministic storyboard after repeated invalid JSON", async () => {
  let attempts = 0;
  const plan = await planSequence({ inputType: "text", inputText: "brief", timelineMode: "auto", duration: 10 }, {
    request: async () => {
      attempts += 1;
      return "not JSON";
    },
  });
  assert.equal(attempts, 2);
  assert.deepEqual(plan.segments.map((segment) => [segment.start, segment.end]), [[0, 5], [5, 10]]);
  assert.deepEqual(plan.planMeta.validationFallback, {
    code: "OLLAMA_INVALID_JSON",
    strategy: "server_storyboard_structured",
  });
});

test("planner preserves malformed segment prompt text without format fallback", async () => {
  const plan = await planSequence({ inputType: "text", inputText: "brief", timelineMode: "manual", timelineText: "5s: first\n5s: second" }, {
    request: async () => ({
      continuityBible: {},
      segments: [
        { start: 0, end: 5, description: "first", prompt: "integrated_multimodal_description: missing shot marker\n\noverall_soundscape: wind\n\nnon_diegetic_music: N/A" },
        { start: 5, end: 10, description: "second" },
      ],
    }),
  });
  assert.equal(plan.segments[0].prompt, "integrated_multimodal_description: missing shot marker\n\noverall_soundscape: wind\n\nnon_diegetic_music: N/A");
  assert.equal(plan.segments[0].promptFallback, undefined);
  assert.equal(plan.planMeta.promptFallbacks, undefined);
});

test("planner accepts timeline-only text briefs", async () => {
  const plan = await planSequence({ inputType: "text", timelineText: "5s: first\n5s: second" }, { request: async () => ({ continuityBible: {}, segments: [] }) });
  assert.equal(plan.segments.length, 2);
  assert.match(plan.negativePrompt, /unwanted random text/);
});

test("segment PATCH persists canonical duration and invalidates downstream", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-segment-api-"));
  process.env.H3_SEQUENCE_DATA_ROOT = path.join(root, "data");
  process.env.COMFYUI_OUTPUT_ROOT = path.join(root, "output");
  const job = await createJob({ title: "segment-api", inputType: "text", inputText: "brief", outputFolder: "segment-api", duration: 9, timeline: [{ start: 0, end: 4, description: "a" }, { start: 4, end: 7, description: "b" }, { start: 7, end: 9, description: "c" }] });
  const seeded = await updateJob(job.id, { segments: job.segments.map((segment, index) => ({ ...segment, status: index === 0 ? "completed" : "completed", normalizedAsset: { root: "output", name: `segment-api/${index + 1}.mp4`, kind: "video" } })), timeline: job.segments });
  const response = apiResponse();
  await handleLongVideoRoute(apiRequest("PATCH", `/api/sequences/${job.id}/segments/1`, { start: 4, end: 7, description: "changed" }), response, {});
  assert.equal(response.status, 200);
  assert.equal(response.body.job.segments[1].duration, 3);
  assert.equal(response.body.job.segments[1].status, "pending");
  assert.equal(response.body.job.segments[2].status, "stale");
  assert.equal(response.body.job.segments[2].normalizedAsset.name, "segment-api/3.mp4");
  const invalid = apiResponse();
  await handleLongVideoRoute(apiRequest("PATCH", `/api/sequences/${job.id}/segments/1`, { duration: 99 }), invalid, {});
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, "SEGMENT_PATCH_INVALID");
  assert.equal(seeded.revision, 2);
});

test("sequence draft ignores allocation injection and locks an allocated folder", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-sequence-patch-"));
  process.env.H3_SEQUENCE_DATA_ROOT = path.join(root, "data");
  process.env.COMFYUI_OUTPUT_ROOT = path.join(root, "output");
  const payload = { title: "draft", inputType: "text", inputText: "brief", outputFolder: "draft-folder", outputAllocated: true, status: "running", duration: 10, timeline: [{ start: 0, end: 5, description: "a" }, { start: 5, end: 10, description: "b" }] };
  const created = apiResponse();
  await handleLongVideoRoute(apiRequest("POST", "/api/sequences", payload), created, {});
  assert.equal(created.status, 201);
  assert.equal(created.body.job.outputAllocated, undefined);
  assert.equal(created.body.job.status, "ready");
  assert.deepEqual(created.body.job.planningSettings, { timelineMode: "manual", targetDuration: 10, segmentDurationHint: 5, segmentCount: 2 });
  const renamed = apiResponse();
  await handleLongVideoRoute(apiRequest("PATCH", `/api/sequences/${created.body.job.id}`, { revision: created.body.job.revision, outputFolder: "renamed-folder" }), renamed, {});
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.job.outputFolder, "renamed-folder");
  const badWidth = apiResponse();
  await handleLongVideoRoute(apiRequest("PATCH", `/api/sequences/${created.body.job.id}`, { revision: renamed.body.job.revision, width: 735 }), badWidth, {});
  assert.equal(badWidth.status, 400);
  assert.equal(badWidth.body.error.code, "WIDTH_INVALID");
  const injected = apiResponse();
  await handleLongVideoRoute(apiRequest("PATCH", `/api/sequences/${created.body.job.id}`, { revision: renamed.body.job.revision, status: "completed", outputAllocated: true, unknownField: "must-not-persist", title: "safe" }), injected, {});
  assert.equal(injected.status, 200);
  assert.equal(injected.body.job.status, "ready");
  assert.equal(injected.body.job.outputAllocated, false);
  assert.equal(injected.body.job.unknownField, undefined);
  const completedSegments = injected.body.job.segments.map((segment) => ({ ...segment, status: "completed", normalizedAsset: { root: "output", name: `renamed-folder/${segment.index + 1}.mp4`, kind: "video" } }));
  const completed = await updateJob(created.body.job.id, { segments: completedSegments, timeline: completedSegments });
  const changedSeed = apiResponse();
  await handleLongVideoRoute(apiRequest("PATCH", `/api/sequences/${created.body.job.id}`, { revision: completed.revision, seed: 9876 }), changedSeed, {});
  assert.equal(changedSeed.status, 200);
  assert.equal(changedSeed.body.job.segments[0].status, "pending");
  assert.equal(changedSeed.body.job.segments.slice(1).every((segment) => segment.status === "stale"), true);
  const allocated = await updateJob(created.body.job.id, { outputAllocated: true });
  const locked = apiResponse();
  await handleLongVideoRoute(apiRequest("PATCH", `/api/sequences/${created.body.job.id}`, { revision: allocated.revision, outputFolder: "another-folder" }), locked, {});
  assert.equal(locked.status, 409);
  assert.equal(locked.body.error.code, "OUTPUT_FOLDER_LOCKED");
  const paused = await updateJob(created.body.job.id, { status: "paused" });
  const startPaused = apiResponse();
  await handleLongVideoRoute(apiRequest("POST", `/api/sequences/${created.body.job.id}/start`), startPaused, {});
  assert.equal(startPaused.status, 409);
  assert.equal(startPaused.body.error.code, "SEQUENCE_ALREADY_RUNNING");
  assert.equal(paused.status, "paused");
});

test("retry and prompt edits stale dependent segments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-retry-api-"));
  process.env.H3_SEQUENCE_DATA_ROOT = path.join(root, "data");
  process.env.COMFYUI_OUTPUT_ROOT = path.join(root, "output");
  const job = await createJob({ title: "retry", inputType: "text", inputText: "brief", outputFolder: "retry-job", duration: 15, timeline: [{ start: 0, end: 5, description: "a" }, { start: 5, end: 10, description: "b" }, { start: 10, end: 15, description: "c" }] });
  const segments = job.segments.map((segment, index) => ({ ...segment, status: "completed", prompt: index === 0 ? buildT2VAPrompt(segment) : buildI2VAPrompt(segment), normalizedAsset: { root: "output", name: `retry-job/${index + 1}.mp4`, kind: "video" } }));
  await updateJob(job.id, { segments, timeline: segments });
  const response = apiResponse();
  await handleLongVideoRoute(apiRequest("POST", `/api/sequences/${job.id}/segments/0/retry`), response, {});
  assert.equal(response.status, 200);
  assert.equal(response.body.job.segments[0].status, "pending");
  assert.equal(response.body.job.segments[1].status, "stale");
  assert.equal(response.body.job.segments[2].status, "stale");
  const promptResponse = apiResponse();
  await handleLongVideoRoute(apiRequest("POST", `/api/sequences/${job.id}/segments/0/prompt`, { revision: response.body.job.revision, prompt: buildT2VAPrompt({ description: "new opening" }) }), promptResponse, {});
  assert.equal(promptResponse.status, 200);
  assert.equal(promptResponse.body.job.segments[0].status, "ready");
  assert.equal(promptResponse.body.job.segments[1].status, "stale");
});

test("long-video polling is source-limited to active statuses", async () => {
  for (const status of ["queued", "running", "paused", "assembling", "planning"]) {
    assert.equal(longJobIsActive(status), true);
  }
  for (const status of ["draft", "ready", "completed", "failed", "cancelled", "interrupted", ""]) {
    assert.equal(longJobIsActive(status), false);
  }
});

test("legacy generation retains bounded stderr and exit code diagnostics", async () => {
  const bridge = await readFile(new URL("../local-bridge.mjs", import.meta.url), "utf8");
  assert.match(bridge, /job\.stderrTail = `\$\{job\.stderrTail \|\| ""\}\$\{text\}`\.slice\(-stderrLimit\)/);
  assert.match(bridge, /entry\.job\.exitCode = Number\.isInteger\(code\) \? code : null/);
  assert.match(bridge, /job\.exitCode = job\.cancelRequested \? null : \(Number\.isInteger\(code\) \? code : \(job\.exitCode \?\? null\)\)/);
});

test("store increments revision atomically and records events", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-store-"));
  process.env.H3_SEQUENCE_DATA_ROOT = path.join(root, "data");
  process.env.COMFYUI_OUTPUT_ROOT = path.join(root, "output");
  const job = await createJob({ title: "store", inputType: "text", inputText: "brief", outputFolder: "store-job", duration: 10, timeline: [{ start: 0, end: 5, description: "a" }, { start: 5, end: 10, description: "b" }] });
  const changed = await updateJob(job.id, { title: "changed" }, { expectedRevision: 1 });
  assert.equal(changed.revision, 2);
  assert.equal((await getJob(job.id)).title, "changed");
  await appendEvent(job.id, { event: "test.event", level: "info", segmentIndex: 0 });
  await appendEvent(job.id, { event: "test.redaction", nested: { token: "secret", base64: "blob", safe: "ok" } });
  const events = await readFile(path.join(root, "data", "jobs", job.id, "events.jsonl"), "utf8");
  assert.match(events, /test\.event/);
  assert.doesNotMatch(events, /secret|blob/);
  const tmpFiles = (await readdir(path.join(root, "data", "jobs", job.id))).filter((item) => item.endsWith(".tmp"));
  assert.equal(tmpFiles.length, 0);
});

test("sequence PATCH persists motion context and per-segment camera plans", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-motion-patch-"));
  process.env.H3_SEQUENCE_DATA_ROOT = path.join(root, "data");
  process.env.COMFYUI_OUTPUT_ROOT = path.join(root, "output");
  const payload = { title: "motion", inputType: "text", inputText: "brief", outputFolder: "motion-patch", duration: 10, timeline: [{ start: 0, end: 5, description: "a" }, { start: 5, end: 10, description: "b" }] };
  const created = apiResponse();
  await handleLongVideoRoute(apiRequest("POST", "/api/sequences", payload), created, {});
  const segments = created.body.job.segments.map((segment, index) => ({
    ...segment,
    cameraPlan: { version: 1, global: { style: "documentary" }, shots: [{ id: `shot-${index + 1}`, startMs: 0, primaryMotion: "tracking" }] },
  }));
  const patched = apiResponse();
  await handleLongVideoRoute(apiRequest("PATCH", `/api/sequences/${created.body.job.id}`, {
    revision: created.body.job.revision,
    continuationMode: "motion_context",
    motionContextSeconds: 2,
    segments,
  }), patched, {});
  assert.equal(patched.status, 200);
  assert.equal(patched.body.job.continuationMode, "motion_context");
  assert.equal(patched.body.job.motionContextSeconds, 2);
  assert.equal(patched.body.job.segments[1].mode, "ref2v");
  assert.equal(patched.body.job.segments[0].cameraPlan.global.style, "documentary");
});

test("long-video atomic JSON replace retries transient rename errors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-long-video-atomic-"));
  try {
    const target = path.join(root, "job.json");
    let calls = 0;
    const waits = [];
    await atomicWriteJson(target, { revision: 3 }, {
      renameImpl: async (from, to) => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error("file is temporarily locked"), { code: "EPERM" });
        return rename(from, to);
      },
      sleep: async (milliseconds) => waits.push(milliseconds),
    });
    assert.equal(calls, 3);
    assert.deepEqual(waits, [25, 75]);
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { revision: 3 });
    assert.deepEqual(await readdir(root), ["job.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("long-video revision conflicts preserve 409 and do not leak tracker rejection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-long-video-conflict-"));
  const previousDataRoot = process.env.H3_SEQUENCE_DATA_ROOT;
  const previousOutputRoot = process.env.COMFYUI_OUTPUT_ROOT;
  try {
    process.env.H3_SEQUENCE_DATA_ROOT = path.join(root, "data");
    process.env.COMFYUI_OUTPUT_ROOT = path.join(root, "output");
    const job = await createJob({ title: "conflict", inputType: "text", inputText: "brief", outputFolder: "conflict-job", duration: 10, timeline: [{ start: 0, end: 5, description: "a" }, { start: 5, end: 10, description: "b" }] });
    const changed = await updateJob(job.id, { title: "changed" });
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const response = apiResponse();
      await handleLongVideoRoute(apiRequest("PATCH", `/api/sequences/${job.id}`, { revision: job.revision, title: "stale" }), response, {});
      assert.equal(response.status, 409);
      assert.equal(response.body.error.code, "REVISION_CONFLICT");
      assert.equal(response.body.error.details.expectedRevision, job.revision);
      assert.equal(response.body.error.details.actualRevision, changed.revision);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    assert.deepEqual(unhandled, []);
  } finally {
    if (previousDataRoot === undefined) delete process.env.H3_SEQUENCE_DATA_ROOT;
    else process.env.H3_SEQUENCE_DATA_ROOT = previousDataRoot;
    if (previousOutputRoot === undefined) delete process.env.COMFYUI_OUTPUT_ROOT;
    else process.env.COMFYUI_OUTPUT_ROOT = previousOutputRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("runner strictly sequences fake generation and uses prior tail", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-runner-"));
  process.env.COMFYUI_OUTPUT_ROOT = path.join(root, "output");
  const output = path.join(root, "output", "job");
  const calls = [];
  const job = {
    id: "memory-job",
    inputType: "text",
    outputPath: output,
    outputFolder: "job",
    status: "ready",
    revision: 1,
    duration: 10,
    width: 736,
    height: 416,
    steps: 2,
    seed: 1,
    negativePrompt: "global blur constraint",
    continuityBible: { sound: "wind", nonDiegeticMusic: "N/A" },
    segments: [{ id: "s1", start: 0, end: 5, duration: 5, description: "a" }, { id: "s2", start: 5, end: 10, duration: 5, description: "b", negativePrompt: "hand distortion" }],
  };
  const result = await runSequence(job, {
    generate: async (payload) => { calls.push(payload); return { rawPath: payload.outputPath, id: `g${payload.segmentIndex}` }; },
    normalize: async ({ outputPath }) => ({ outputPath }),
    extractTail: async ({ outputPath }) => ({ outputPath }),
    assemble: async ({ segmentPaths }) => ({ outputPath: path.join(output, "final-r001.mp4"), segmentPaths }),
    updateJob: async (target, patch) => Object.assign(target, patch),
    updateSegment: async (target, index, patch) => Object.assign(target.segments[index], patch),
  });
  assert.equal(result.status, "completed");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].mode, "t2v");
  assert.equal(calls[1].mode, "i2v");
  assert.equal(calls[0].negativePrompt, `${DEFAULT_NEGATIVE_PROMPT}, global blur constraint`);
  assert.equal(calls[1].negativePrompt, `${DEFAULT_NEGATIVE_PROMPT}, global blur constraint, hand distortion`);
  assert.ok(calls[1].tailImagePath);
});

test("storyboard runner sends only the previous silent visual excerpt to Ref2VA", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-motion-context-"));
  const previousOutputRoot = process.env.COMFYUI_OUTPUT_ROOT;
  process.env.COMFYUI_OUTPUT_ROOT = path.join(root, "output");
  const output = path.join(root, "output", "motion-context");
  const calls = [];
  const contexts = [];
  const job = {
    id: "motion-context-job",
    inputType: "image",
    inputAsset: { root: "input", name: "identity.png", kind: "image" },
    referenceMode: "continuity",
    continuationMode: "motion_context",
    motionContextSeconds: 2,
    outputPath: output,
    outputFolder: "motion-context",
    status: "ready",
    revision: 1,
    width: 736,
    height: 416,
    steps: 2,
    seed: 10,
    continuityBible: { sound: "room ambience", nonDiegeticMusic: "N/A" },
    segments: [
      { id: "s1", start: 0, end: 5, duration: 5, description: "opening" },
      {
        id: "s2", start: 5, end: 10, duration: 5, description: "continue the motion",
        cameraPlan: { version: 1, global: { avoidances: ["camera_jitter"] }, shots: [{ id: "shot-1", startMs: 0, primaryMotion: "tracking", videoReference: true }] },
      },
    ],
  };
  try {
    const result = await runSequence(job, {
      generate: async (payload) => { calls.push(payload); return { rawPath: payload.outputPath, id: `g-${payload.segmentIndex}` }; },
      normalize: async ({ outputPath }) => ({ outputPath }),
      extractContext: async (payload) => { contexts.push(payload); return { outputPath: payload.outputPath }; },
      extractTail: async ({ outputPath }) => ({ outputPath }),
      assemble: async () => ({ outputPath: path.join(output, "final-r001.mp4"), revision: 1, probe: {} }),
      updateJob: async (target, patch) => Object.assign(target, patch),
      updateSegment: async (target, index, patch) => Object.assign(target.segments[index], patch),
      writeManifest: async () => {},
      log: async () => {},
    });
    assert.equal(result.status, "completed");
    assert.equal(calls[0].mode, "i2v");
    assert.equal(calls[1].mode, "ref2v");
    assert.equal(calls[1].referenceMode, "motion_context");
    assert.deepEqual(calls[1].referenceAssets.map(({ name }) => name), ["identity.png"]);
    assert.match(calls[1].inputVideoPath, /segment-001-attempt-001-context\.mp4$/);
    assert.match(calls[1].prompt, /<Video 1>/);
    assert.doesNotMatch(calls[1].prompt, /<Audio 1>/);
    assert.match(calls[1].prompt, /\[reference generation\]/);
    assert.match(calls[1].prompt, /independent storyboard shot/i);
    assert.match(calls[1].prompt, /Camera plan:/);
    assert.match(calls[1].negativePrompt, /digital camera jitter/i);
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].duration, 1.625);
    assert.equal(contexts[0].includeAudio, false);
    assert.match(job.segments[0].contextAsset.name, /segment-001-attempt-001-context\.mp4$/);
  } finally {
    if (previousOutputRoot === undefined) delete process.env.COMFYUI_OUTPUT_ROOT;
    else process.env.COMFYUI_OUTPUT_ROOT = previousOutputRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("Ref2VA continuation normalizes heading-only sections before injecting context", () => {
  const prompt = [
    "subject_definitions", "A person.", "", "summary", "[reference generation]", "", "retention_analysis", "Keep identity.", "",
    "detailed_description", "[Shot 1] The person turns.", "", "overall_soundscape", "Room tone.", "", "non_diegetic_music", "N/A",
  ].join("\n");
  const visual = ensureRef2vaVisualContextPrompt(prompt);
  assert.match(visual, /subject_definitions:/);
  assert.match(visual, /<Video 1>/);
  assert.match(visual, /independent storyboard shot/i);
  const latent = ensureRef2vaLatentContinuationPrompt(visual);
  assert.match(latent, /summary:\s*\[video continuation \+ reference generation\]/i);
  assert.match(latent, /exact ending of the previous storyboard shot/i);
  assert.doesNotMatch(latent, /<Video\s+1>/i);
});

test("latent continuation sends checkpoint metadata and no MP4 context", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-latent-context-"));
  const previousOutputRoot = process.env.COMFYUI_OUTPUT_ROOT;
  process.env.COMFYUI_OUTPUT_ROOT = path.join(root, "output");
  const output = path.join(root, "output", "latent-context");
  const calls = [];
  const normalizeDurations = [];
  const job = {
    id: "latent-context-job",
    inputType: "image",
    inputAsset: { root: "input", name: "identity.png", kind: "image" },
    referenceMode: "continuity",
    continuationMode: "latent_context",
    outputPath: output,
    outputFolder: "latent-context",
    status: "ready",
    revision: 1,
    width: 736,
    height: 416,
    steps: 2,
    seed: 10,
    continuityBible: {},
    segments: [
      { id: "s1", start: 0, end: 5, duration: 5, description: "opening" },
      { id: "s2", start: 5, end: 10, duration: 5, description: "continue the same movement" },
    ],
  };
  try {
    const result = await runSequence(job, {
      generate: async (payload) => { calls.push(payload); return { rawPath: payload.outputPath, id: `g-${payload.segmentIndex}` }; },
      normalize: async ({ outputPath, duration }) => { normalizeDurations.push(duration); return { outputPath }; },
      extractTail: async ({ outputPath }) => ({ outputPath }),
      extractContext: async () => { throw new Error("latent mode must not extract MP4 context"); },
      assemble: async () => ({ outputPath: path.join(output, "final-r001.mp4"), revision: 1, probe: {} }),
      updateJob: async (target, patch) => Object.assign(target, patch),
      updateSegment: async (target, index, patch) => Object.assign(target.segments[index], patch),
      writeManifest: async () => {},
      log: async () => {},
    });
    assert.equal(result.status, "completed");
    assert.equal(calls[0].mode, "i2v");
    assert.equal(calls[1].mode, "ref2v");
    assert.equal(calls[0].latentClipIndex, 1);
    assert.equal(calls[1].latentClipIndex, 2);
    assert.equal(calls[1].latentPreviousClipIndex, 1);
    assert.equal(calls[1].latentContextFrames, 39);
    assert.equal(calls[1].latentCheckpointPrefix, "h3_sequence_checkpoints/latent-context-job/clip");
    assert.equal(calls[1].inputVideoPath, undefined);
    assert.deepEqual(normalizeDurations, [124 / 24, 119 / 24]);
    assert.equal(job.segments[0].renderedDuration, 124 / 24);
    assert.equal(job.segments[1].renderedDuration, 119 / 24);
    assert.match(calls[1].prompt, /\[video continuation \+ reference generation\]/i);
    assert.doesNotMatch(calls[1].prompt, /<Video\s+1>/i);
  } finally {
    if (previousOutputRoot === undefined) delete process.env.COMFYUI_OUTPUT_ROOT;
    else process.env.COMFYUI_OUTPUT_ROOT = previousOutputRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("latent rendered durations preserve native H3 phase at every seam", () => {
  assert.equal(latentRenderedFrameCount(5, 0), 124);
  assert.equal(latentRenderedFrameCount(5, 1), 119);
  assert.equal(latentRenderedDuration(5, 0), 124 / 24);
  assert.equal(latentRenderedDuration(5, 1), 119 / 24);
  for (const duration of [0.5, 1, 3.25, 5, 8, 12.5, 60]) {
    assert.equal(latentRenderedFrameCount(duration, 0) % 17, 5);
    assert.equal((latentRenderedFrameCount(duration, 1) + 39) % 17, 5);
  }
});

test("storyboard context extraction keeps a bounded silent H.264 tail", async () => {
  const calls = [];
  const outputPath = path.join(os.tmpdir(), `h3-context-${Date.now()}.mp4`);
  try {
    await extractTailAvContext({
      inputPath: "normalized.mp4",
      outputPath,
      duration: 2,
      tools: { executables: { ffmpeg: "ffmpeg-test" } },
      run: async (executable, args) => {
        calls.push({ executable, args });
        await writeFile(outputPath, "fixture");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(calls[0].executable, "ffmpeg-test");
    assert.deepEqual(calls[0].args.slice(0, 5), ["-y", "-sseof", "-2.000", "-i", "normalized.mp4"]);
    assert.ok(calls[0].args.includes("libx264"));
    assert.ok(calls[0].args.includes("-an"));
    assert.ok(!calls[0].args.includes("aac"));
    assert.ok(!calls[0].args.includes("0:a:0?"));
  } finally {
    await rm(outputPath, { force: true });
  }
});

test("start media preflight fails before allocating output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-api-"));
  process.env.H3_SEQUENCE_DATA_ROOT = path.join(root, "data");
  process.env.COMFYUI_OUTPUT_ROOT = path.join(root, "output");
  const request = (method, url, value) => ({ method, url, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(value || {})); } });
  const response = () => ({ headersSent: false, writeHead(status) { this.status = status; }, end(value) { this.body = JSON.parse(value); } });
  const plan = { title: "preflight", inputType: "text", inputText: "brief", outputFolder: "preflight-job", duration: 10, continuityBible: {}, segments: [{ start: 0, end: 5, description: "a" }, { start: 5, end: 10, description: "b" }] };
  const createdResponse = response();
  await handleLongVideoRoute(request("POST", "/api/sequences", plan), createdResponse, {});
  const startResponse = response();
  let runCalled = false;
  await handleLongVideoRoute(request("POST", `/api/sequences/${createdResponse.body.job.id}/start`), startResponse, {
    preflight: async () => { throw Object.assign(new Error("missing ffmpeg"), { code: "MEDIA_TOOLS_UNAVAILABLE" }); },
    runJob: async () => { runCalled = true; },
  });
  assert.equal(startResponse.status, 503);
  assert.equal(startResponse.body.error.code, "MEDIA_TOOLS_UNAVAILABLE");
  assert.equal(runCalled, false);
  assert.deepEqual(await readdir(path.join(root, "output")).catch(() => []), []);
});

test("runner resumes after a completed segment without regenerating it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-resume-"));
  process.env.COMFYUI_OUTPUT_ROOT = path.join(root, "output");
  const output = path.join(root, "output", "resume");
  const calls = [];
  const job = {
    id: "resume-memory", inputType: "text", outputPath: output, outputFolder: "resume", status: "interrupted", revision: 1,
    width: 736, height: 416, steps: 2, seed: 1, continuityBible: {},
    segments: [
      { id: "s1", start: 0, end: 5, duration: 5, description: "a", status: "completed", normalizedAsset: { root: "output", name: "resume/s1.mp4", kind: "video" }, tailAsset: { root: "output", name: "resume/s1-tail.png", kind: "image" } },
      { id: "s2", start: 5, end: 10, duration: 5, description: "b", status: "rendering" },
    ],
  };
  const result = await runSequence(job, {
    verifyCompletedSegment: async () => ({ normalizedPath: path.join(output, "s1.mp4"), tailPath: path.join(output, "s1-tail.png") }),
    generate: async (payload) => { calls.push(payload); return { rawPath: payload.outputPath }; },
    normalize: async () => {}, extractTail: async () => {},
    assemble: async () => ({ outputPath: path.join(output, "final-r001.mp4"), revision: 1, probe: {} }),
    updateJob: async (target, patch) => Object.assign(target, patch), updateSegment: async (target, index, patch) => Object.assign(target.segments[index], patch),
  });
  assert.equal(result.status, "completed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].segmentIndex, 1);
  assert.equal(calls[0].mode, "i2v");
  assert.match(calls[0].tailImagePath, /s1-tail\.png$/);
});

test("runner regenerates stale downstream segments after retry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-stale-runner-"));
  process.env.COMFYUI_OUTPUT_ROOT = path.join(root, "output");
  const output = path.join(root, "output", "stale-runner");
  const calls = [];
  const job = {
    id: "stale-runner", inputType: "text", outputPath: output, outputFolder: "stale-runner", status: "ready", revision: 1,
    width: 736, height: 416, steps: 2, seed: 1, continuityBible: {},
    segments: [
      { id: "s1", start: 0, end: 5, duration: 5, description: "a", status: "completed", normalizedAsset: { root: "output", name: "stale-runner/s1.mp4", kind: "video" }, tailAsset: { root: "output", name: "stale-runner/s1-tail.png", kind: "image" } },
      { id: "s2", start: 5, end: 10, duration: 5, description: "b", status: "stale", normalizedAsset: { root: "output", name: "stale-runner/old-s2.mp4", kind: "video" } },
    ],
  };
  const result = await runSequence(job, {
    verifyCompletedSegment: async () => ({ normalizedPath: path.join(output, "s1.mp4"), tailPath: path.join(output, "s1-tail.png") }),
    generate: async (payload) => { calls.push(payload); return { rawPath: payload.outputPath }; },
    normalize: async () => {}, extractTail: async () => {},
    assemble: async () => ({ outputPath: path.join(output, "final-r001.mp4"), revision: 1, probe: {} }),
    updateJob: async (target, patch) => Object.assign(target, patch), updateSegment: async (target, index, patch) => Object.assign(target.segments[index], patch),
  });
  assert.equal(result.status, "completed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].segmentIndex, 1);
  assert.match(calls[0].tailImagePath, /s1-tail\.png$/);
});

test("runner failure preserves attempt prompt, settings, generation id and media diagnostics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-attempt-failure-"));
  process.env.H3_SEQUENCE_DATA_ROOT = path.join(root, "data");
  process.env.COMFYUI_OUTPUT_ROOT = path.join(root, "output");
  const output = path.join(root, "output", "attempt-failure");
  const job = {
    id: "attempt-failure", inputType: "text", outputPath: output, outputFolder: "attempt-failure", status: "ready", revision: 1,
    width: 736, height: 416, steps: 12, seed: 42, modelProfile: "profile-x", negativePrompt: "no blur", continuityBible: {},
    segments: [{ id: "s1", start: 0, end: 5, duration: 5, description: "opening" }, { id: "s2", start: 5, end: 10, duration: 5, description: "ending" }],
  };
  await assert.rejects(() => runSequence(job, {
    generate: async (payload) => ({ rawPath: payload.outputPath, id: "generation-123" }),
    normalize: async () => { throw Object.assign(new Error("fake ffmpeg failed"), { code: "FFMPEG_FAILED", details: { stderrTail: "stderr tail", exitCode: 7 } }); },
    updateJob: async (target, patch) => Object.assign(target, patch),
    updateSegment: async (target, index, patch) => Object.assign(target.segments[index], patch),
  }), { message: "fake ffmpeg failed" });
  const attempt = JSON.parse(await readFile(sequenceAttemptFile(job.id, 0, 1), "utf8"));
  assert.equal(attempt.status, "failed");
  assert.equal(attempt.mode, "t2v");
  assert.equal(attempt.generationJobId, "generation-123");
  assert.equal(attempt.exitCode, 7);
  assert.equal(attempt.stderrTail, "stderr tail");
  assert.equal(attempt.seed, 42);
  assert.equal(attempt.modelProfile, "profile-x");
  assert.match(attempt.prompt, /integrated_multimodal_description/);
  assert.doesNotMatch(JSON.stringify(attempt), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
