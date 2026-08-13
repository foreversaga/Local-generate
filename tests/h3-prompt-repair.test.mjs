import assert from "node:assert/strict";
import test from "node:test";
import { buildH3PromptSystem } from "../server/h3-prompt/instruction.mjs";
import { normalizeDeterministicH3Prompt, validateOrRepairH3Prompt } from "../server/h3-prompt/repair.mjs";

const validT2V = [
  "integrated_multimodal_description: [Shot 1] Live-action, cinematic, a subject enters the room.",
  "",
  "overall_soundscape: Footsteps and room tone continue.",
  "",
  "non_diegetic_music: N/A",
].join("\n");
const invalidT2V = "integrated_multimodal_description: A subject enters the room.\n\noverall_soundscape: Footsteps.\n\nnon_diegetic_music: N/A";
const tooLongPrompt = "x".repeat(7001);
const i2vaFirstLine = "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.";
const mergedI2va = `integrated_multimodal_description: ${i2vaFirstLine}\n\n[Shot 1] The referenced subject walks forward.\n\noverall_soundscape: Footsteps.\n\nnon_diegetic_music: N/A`;

test("does not call repair when the first validation succeeds", async () => {
  let calls = 0;
  const result = await validateOrRepairH3Prompt(validT2V, {
    mode: "t2v",
    duration: 5,
    repair: async () => { calls += 1; return validT2V; },
  });
  assert.equal(calls, 0);
  assert.equal(result.repaired, false);
  assert.equal(result.repairAttempts, 0);
});

test("accepts malformed H3 structure without calling repair", async () => {
  let calls = 0;
  let request = "";
  const result = await validateOrRepairH3Prompt(invalidT2V, {
    mode: "t2v",
    duration: 5,
    repair: async (repairPrompt, context) => {
      calls += 1;
      request = repairPrompt;
      assert.equal(context.mode, "t2v");
      assert.equal(context.duration, 5);
      return validT2V;
    },
  });
  assert.equal(calls, 0);
  assert.equal(request, "");
  assert.equal(result.repaired, false);
  assert.equal(result.repairAttempts, 0);
  assert.equal(result.prompt, invalidT2V);
});

test("preserves merged I2VA text without deterministic format rewriting", async () => {
  let calls = 0;
  const normalized = normalizeDeterministicH3Prompt(mergedI2va, { mode: "i2v" });
  assert.equal(normalized, mergedI2va);
  const result = await validateOrRepairH3Prompt(mergedI2va, {
    mode: "i2v",
    duration: 5,
    repair: async () => { calls += 1; return mergedI2va; },
  });
  assert.equal(calls, 0);
  assert.equal(result.valid, true);
  assert.equal(result.repaired, false);
  assert.equal(result.repairAttempts, 0);
  assert.equal(result.deterministicRepairs, 0);
  assert.equal(result.prompt, mergedI2va);
});

test("repairs twice when a retained boundary remains invalid", async () => {
  let calls = 0;
  const result = await validateOrRepairH3Prompt(tooLongPrompt, {
    mode: "t2v",
    repair: async (_repairPrompt, context) => {
      calls += 1;
      assert.equal(context.attempt, calls);
      assert.equal(context.maxRepairAttempts, 2);
      return calls === 1 ? tooLongPrompt : validT2V;
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.repaired, true);
  assert.equal(result.repairAttempts, 2);
  assert.equal(result.repairPrompts.length, 2);
});

test("stops after two repairs and retains non-format validation errors", async () => {
  let calls = 0;
  await assert.rejects(
    () => validateOrRepairH3Prompt(tooLongPrompt, {
      mode: "t2v",
      repair: async () => { calls += 1; return tooLongPrompt; },
    }),
    (error) => {
      assert.equal(error.code, "PROMPT_REPAIR_FAILED");
      assert.equal(error.details.firstValidation.code, "PROMPT_TOO_LONG");
      assert.equal(error.details.secondValidation.code, "PROMPT_TOO_LONG");
      assert.equal(error.details.finalValidation.code, "PROMPT_TOO_LONG");
      assert.equal(error.details.validationHistory.length, 3);
      assert.equal(error.details.candidatePrompt, tooLongPrompt);
      assert.equal(error.details.repairAttempts, 2);
      return true;
    },
  );
  assert.equal(calls, 2);
});

test("system instructions cover mode-specific H3 contracts without local skill claims", () => {
  const common = buildH3PromptSystem({ mode: "t2v", duration: 8 });
  for (const phrase of [
    "integrated_multimodal_description",
    "overall_soundscape",
    "non_diegetic_music",
    "camera movement",
    "amplitude",
    "speed",
    "(S1)",
    "<d>[Language]",
    "lips remain completely closed",
    "<scenetrans>",
    "<cutoff>",
    "double quotation marks",
    "diegetic",
    "stable visual identity block",
    "face shape",
    "eye spacing/eye shape",
    "hairstyle silhouette",
    "body silhouette",
    "distinctive marks",
    "transition, MG, warping, compression, inversion, overlay",
    "front-facing or closed-mouth",
  ]) assert.match(common, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(common, /local skill|read .*skill/i);

  const i2v = buildH3PromptSystem({ mode: "i2v", duration: 8, hasVisualReference: true });
  assert.match(i2v, /For the target video, at 0\.00 seconds.*<Picture 1>/);
  assert.match(i2v, /Visual references are supplied/);
  const fl2v = buildH3PromptSystem({ mode: "fl2v", duration: 8 });
  assert.match(fl2v, /target video — Picture 1 \(from Shot 1\)/);
  assert.match(fl2v, /8\.00-second mark/);
  const l2v = buildH3PromptSystem({ mode: "l2v", duration: 8 });
  assert.match(l2v, /target video — <Picture 1> \(from \[Shot <FINAL_SHOT>\]\)/);
  const ref2v = buildH3PromptSystem({ mode: "ref2v", duration: 8 });
  for (const field of ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"]) assert.match(ref2v, new RegExp(field));
  assert.match(ref2v, /fully_preserved/);
  assert.match(ref2v, /identity attributes.*fully_preserved.*appropriate marker/);
});

