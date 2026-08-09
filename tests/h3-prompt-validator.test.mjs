import assert from "node:assert/strict";
import test from "node:test";
import { checkH3Prompt, validateH3Prompt } from "../server/h3-prompt/validator.mjs";
import { validatePrompt } from "../server/long-video/prompt-validator.mjs";

const baseBody = "[Shot 1] Live-action, cinematic, a subject enters the room.\n[Shot 2] At 00:03.500, the camera cuts to a close-up.";

function basePrompt(prefix = "") {
  return `${prefix}integrated_multimodal_description: ${baseBody}\n\noverall_soundscape: Footsteps and room tone continue.\n\nnon_diegetic_music: N/A`;
}

function refPrompt({ undefinedLabel = false, undefinedPicture = false } = {}) {
  const label = undefinedLabel ? "<Subject 2>" : undefinedPicture ? "<Picture 1>" : "<Subject 1>";
  return `subject_definitions:\n<Subject 1> is the principal subject shown in Picture 1.\n\nsummary:\n[reference generation] The target video preserves <Subject 1>.\n\nretention_analysis:\n<Subject 1> ([Shot 1], [Shot 2]): fully_preserved - identity remains consistent.\n\ndetailed_description:\nThe target video uses a cinematic style. [Shot 1] <Subject 1> stands in the scene.\n[Shot 2] At 00:03.500, the camera cuts closer to ${label}.\n\noverall_soundscape:\nRoom tone and footsteps continue.\n\nnon_diegetic_music:\nN/A`;
}

test("accepts every H3 mode with the official field structure", () => {
  const cases = [
    ["t2v", basePrompt(), 5],
    ["i2v", basePrompt("For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\n"), 5],
    ["fl2v", basePrompt("How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 2) aligns with the 5.00-second mark of the target video.\n\n"), 5],
    ["l2v", basePrompt("How the reference pictures align with the target video — <Picture 1> (from [Shot 2]) aligns with the 5.00-second mark of the target video.\n\n"), 5],
    ["ref2v", refPrompt(), 5],
  ];
  for (const [mode, prompt, duration] of cases) {
    const result = validateH3Prompt(prompt, { mode, duration });
    assert.equal(result.valid, true);
    assert.equal(result.mode, mode);
    assert.equal(result.shots.at(-1).shot, 2);
  }
});

test("keeps the long-video adapter compatible with inputType and duration", () => {
  const result = validatePrompt(basePrompt(), { inputType: "text", duration: 5 });
  assert.equal(result.mode, "t2v");
  assert.equal(result.duration, 5);
});

test("rejects missing or reordered fields", () => {
  assert.throws(() => validateH3Prompt("overall_soundscape: wind\n\nnon_diegetic_music: N/A\n\nintegrated_multimodal_description: [Shot 1] scene", { mode: "t2v" }), { code: "PROMPT_FIRST_LINE_INVALID" });
  assert.throws(() => validateH3Prompt("integrated_multimodal_description: [Shot 1] scene\n\nnon_diegetic_music: N/A", { mode: "t2v" }), { code: "PROMPT_FIELD_MISSING" });
  assert.throws(() => validateH3Prompt("preamble\n\n" + basePrompt(), { mode: "t2v" }), { code: "PROMPT_FIRST_LINE_INVALID" });
  assert.throws(() => validateH3Prompt(refPrompt().replace("subject_definitions:", "preamble\n\nsubject_definitions:"), { mode: "ref2v" }), { code: "PROMPT_FIRST_LINE_INVALID" });
});

test("requires sequential shots and bounded, increasing cut timestamps", () => {
  assert.throws(() => validateH3Prompt(basePrompt().replace("[Shot 2]", "[Shot 3]"), { mode: "t2v", duration: 5 }), { code: "PROMPT_SHOT_SEQUENCE" });
  assert.throws(() => validateH3Prompt(basePrompt().replace("[Shot 2] At 00:03.500", "[Shot 2] camera cuts"), { mode: "t2v", duration: 5 }), { code: "PROMPT_SHOT_TIMESTAMP_REQUIRED" });
  assert.throws(() => validateH3Prompt(basePrompt().replace("[Shot 1] Live-action", "[Shot 1] At 00:00.000, Live-action"), { mode: "t2v", duration: 5 }), { code: "PROMPT_SHOT1_TIMESTAMP_FORBIDDEN" });
  assert.throws(() => validateH3Prompt(basePrompt().replace("00:03.500", "00:06.000"), { mode: "t2v", duration: 5 }), { code: "PROMPT_SHOT_TIMESTAMP_OUT_OF_RANGE" });
  const nonIncreasing = basePrompt().replace("[Shot 2] At 00:03.500, the camera cuts to a close-up.", "[Shot 2] At 00:03.500, the camera cuts. [Shot 3] At 00:03.500, the camera holds.");
  assert.throws(() => validateH3Prompt(nonIncreasing, { mode: "t2v", duration: 5 }), { code: "PROMPT_SHOT_TIMESTAMP_ORDER" });
});

test("enforces exact I2VA and concrete FL2VA/L2VA alignment lines", () => {
  assert.throws(() => validateH3Prompt(basePrompt("For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 2]) is fully referenced.\n\n"), { mode: "i2v" }), { code: "PROMPT_I2VA_FIRST_LINE" });
  assert.throws(() => validateH3Prompt(basePrompt("For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\nintegrated_multimodal_description: [Shot 1] Live-action.\n\noverall_soundscape: wind\n\nnon_diegetic_music: N/A"), { mode: "i2v" }), { code: "PROMPT_ALIGNMENT_FIELD_GAP" });
  assert.throws(() => validateH3Prompt(basePrompt("How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 2) aligns with the 5-second mark of the target video.\n\n"), { mode: "fl2v" }), { code: "PROMPT_FL2VA_FIRST_LINE" });
  assert.throws(() => validateH3Prompt(basePrompt("How the reference pictures align with the target video —<Picture 1> (from [Shot 2]) aligns with the 5.00-second mark of the target video.\n\n"), { mode: "l2v" }), { code: "PROMPT_L2VA_FIRST_LINE" });
  assert.throws(() => validateH3Prompt(basePrompt("How the reference pictures align with the target video — <Picture 1> (from [Shot N]) aligns with the 5.00-second mark of the target video.\n\n"), { mode: "l2v" }), { code: "PROMPT_L2VA_FIRST_LINE" });
  assert.throws(() => validateH3Prompt(basePrompt("How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with the 5.00-second mark of the target video.\n\n"), { mode: "l2v" }), { code: "PROMPT_FINAL_SHOT_MISMATCH" });
});

test("validates Ref2VA task prefix, shot body, and reference definitions", () => {
  assert.throws(() => validateH3Prompt(refPrompt().replace("[reference generation]", "[creative idea]"), { mode: "ref2v" }), { code: "PROMPT_SUMMARY_TASK_PREFIX" });
  assert.throws(() => validateH3Prompt(refPrompt({ undefinedLabel: true }), { mode: "ref2v" }), { code: "PROMPT_REFERENCE_UNDEFINED" });
  assert.throws(() => validateH3Prompt(refPrompt({ undefinedPicture: true }), { mode: "ref2v" }), { code: "PROMPT_REFERENCE_UNDEFINED" });
  assert.throws(() => validateH3Prompt(refPrompt().replace("detailed_description:\nThe target video uses a cinematic style. [Shot 1]", "detailed_description:\nThe target video uses a cinematic style. [Shot 2]"), { mode: "ref2v" }), { code: "PROMPT_SHOT1_REQUIRED" });
});

test("requires language-tagged dialogue blocks and enforces the character limit", () => {
  assert.throws(() => validateH3Prompt(basePrompt().replace("the camera cuts", "the speaker says <d>Hello</d>; the camera cuts"), { mode: "t2v" }), { code: "PROMPT_DIALOGUE_LANGUAGE_TAG" });
  assert.throws(() => validateH3Prompt(basePrompt().replace("the camera cuts", "the speaker says <d>[English] Hello; the camera cuts"), { mode: "t2v" }), { code: "PROMPT_DIALOGUE_TAG_UNBALANCED" });
  assert.throws(() => validateH3Prompt("x".repeat(7001), { mode: "t2v" }), { code: "PROMPT_TOO_LONG" });
});

test("checkH3Prompt returns a displayable error instead of throwing", () => {
  const result = checkH3Prompt("", { mode: "t2v" });
  assert.equal(result.valid, false);
  assert.equal(result.error.code, "PROMPT_REQUIRED");
  assert.match(result.error.message, /required/i);
});
