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
    assert.equal(result.structured, true);
    assert.equal(result.shots.at(-1).shot, 2);
  }
});

test("keeps the long-video adapter compatible with inputType and duration", () => {
  const result = validatePrompt(basePrompt(), { inputType: "text", duration: 5 });
  assert.equal(result.mode, "t2v");
  assert.equal(result.duration, 5);
});

test("accepts ordinary free-form text in every video mode", () => {
  const prompts = {
    t2v: "A quiet cinematic room at dawn; the camera slowly pushes toward the window.",
    i2v: "Use the supplied image as inspiration and animate a slow push-in.",
    fl2v: "Transition smoothly from the first reference image to the last.",
    l2v: "End on the supplied last frame while the subject turns.",
    ref2v: "Use the supplied references to guide a coherent cinematic sequence.",
  };
  for (const [mode, prompt] of Object.entries(prompts)) {
    const result = validateH3Prompt(prompt, { mode, duration: 5 });
    assert.equal(result.valid, true);
    assert.equal(result.structured, false);
    assert.deepEqual(result.fields, []);
    assert.deepEqual(result.shots, []);
  }
});

test("accepts malformed or partial field structures without format rejection", () => {
  const prompts = [
    ["t2v", "overall_soundscape: wind\n\nnon_diegetic_music: N/A\n\nintegrated_multimodal_description: [Shot 1] scene"],
    ["t2v", "integrated_multimodal_description: [Shot 1] scene\n\nnon_diegetic_music: N/A"],
    ["t2v", "preamble\n\n" + basePrompt()],
    ["ref2v", refPrompt().replace("subject_definitions:", "preamble\n\nsubject_definitions:")],
    ["l2v", "How the reference pictures align with the target video — <Picture 1> (from [Shot N]) aligns with the wrong mark."],
  ];
  for (const [mode, prompt] of prompts) assert.doesNotThrow(() => validateH3Prompt(prompt, { mode, duration: 5 }));
});

test("does not reject arbitrary shot numbering, timestamps, references, or dialogue tags", () => {
  const prompts = [
    basePrompt().replace("[Shot 2]", "[Shot 3]"),
    basePrompt().replace("[Shot 2] At 00:03.500", "[Shot 2] camera cuts"),
    basePrompt().replace("[Shot 1] Live-action", "[Shot 1] At 00:00.000, Live-action"),
    basePrompt().replace("00:03.500", "00:06.000"),
    basePrompt().replace("the camera cuts", "the speaker says <d>Hello</d>; the camera cuts"),
    refPrompt().replace("[reference generation]", "[creative idea]").replace("<Subject 1>", "<Subject 2>"),
  ];
  for (const prompt of prompts) assert.doesNotThrow(() => validateH3Prompt(prompt, { mode: prompt.startsWith("subject_definitions") ? "ref2v" : "t2v", duration: 5 }));
});

test("retains non-format mode, prompt, duration, and character boundaries", () => {
  assert.throws(() => validateH3Prompt("scene", { mode: "unknown" }), { code: "PROMPT_MODE_INVALID" });
  assert.throws(() => validateH3Prompt("", { mode: "t2v" }), { code: "PROMPT_REQUIRED" });
  assert.throws(() => validateH3Prompt("scene", { mode: "t2v", duration: 0 }), { code: "PROMPT_DURATION_INVALID" });
  assert.throws(() => validateH3Prompt("scene", { mode: "t2v", duration: "not-a-number" }), { code: "PROMPT_DURATION_INVALID" });
  assert.throws(() => validateH3Prompt("x".repeat(7001), { mode: "t2v" }), { code: "PROMPT_TOO_LONG" });
});

test("checkH3Prompt returns a displayable error instead of throwing", () => {
  const result = checkH3Prompt("", { mode: "t2v" });
  assert.equal(result.valid, false);
  assert.equal(result.error.code, "PROMPT_REQUIRED");
  assert.match(result.error.message, /required/i);
});
