import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendPromptError, buildPromptErrorRecord } from "../server/h3-prompt/error-log.mjs";

test("builds a prompt error record without image payloads or duplicate repair prompts", () => {
  const error = Object.assign(new Error("Prompt needs Shot 1."), {
    code: "PROMPT_SHOT1_REQUIRED",
    status: 400,
    details: {
      candidatePrompt: "integrated_multimodal_description: malformed",
      repairPrompts: ["large internal repair instruction"],
      finalValidation: { code: "PROMPT_SHOT1_REQUIRED", message: "Shot 1 is required." },
    },
  });
  error.details.validationHistory = [error.details.finalValidation];
  const record = buildPromptErrorRecord({
    timestamp: "2026-08-09T15:30:00.000Z",
    stage: "prompt_generation",
    endpoint: "/api/prompt",
    payload: {
      provider: "ollama",
      model: "gemma-test",
      mode: "t2v",
      duration: 5,
      brief: "A rainy platform",
      images: [{ role: "reference_image", data: "base64-secret" }],
    },
    error,
    runtime: { mode: "remote" },
  });

  assert.equal(record.prompts.candidate, "integrated_multimodal_description: malformed");
  assert.equal(record.prompts.sourceBrief, "A rainy platform");
  assert.equal(record.request.visualInputs.count, 1);
  assert.deepEqual(record.request.visualInputs.roles, ["reference_image"]);
  assert.equal(record.error.details.finalValidation.code, "PROMPT_SHOT1_REQUIRED");
  assert.equal(record.error.details.validationHistory[0].code, "PROMPT_SHOT1_REQUIRED");
  assert.equal("candidatePrompt" in record.error.details, false);
  assert.equal("repairPrompts" in record.error.details, false);
  assert.doesNotMatch(JSON.stringify(record), /base64-secret|large internal repair instruction/);
});

test("appends newline-delimited prompt error records to the dated project log", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-prompt-errors-"));
  try {
    const result = await appendPromptError({
      logRoot: root,
      timestamp: "2026-08-09T15:31:00.000Z",
      stage: "video_submission",
      endpoint: "/api/generate",
      payload: { prompt: "bad prompt", mode: "t2v", duration: 5 },
      error: Object.assign(new Error("Invalid H3 prompt."), { code: "PROMPT_INVALID", status: 400 }),
    });
    assert.equal(path.basename(result.filePath), "prompt-errors-20260809.jsonl");
    const lines = (await readFile(result.filePath, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const saved = JSON.parse(lines[0]);
    assert.equal(saved.prompts.submitted, "bad prompt");
    assert.equal(saved.error.code, "PROMPT_INVALID");
    assert.equal(saved.stage, "video_submission");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
