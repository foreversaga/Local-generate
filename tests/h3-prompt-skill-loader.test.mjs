import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadH3PromptSkillPack,
  resolveH3OllamaContextLength,
} from "../server/h3-prompt/skill-loader.mjs";

async function createSkillFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "h3-skill-pack-"));
  const references = path.join(root, "references");
  await mkdir(references);
  await Promise.all([
    writeFile(path.join(root, "SKILL.md"), "SKILL_SENTINEL: route H3 prompt requests by mode."),
    writeFile(path.join(references, "base-en.txt"), "BASE_GUIDE_SENTINEL: base prompt structure."),
    writeFile(path.join(references, "ref-en.txt"), "REF_GUIDE_SENTINEL: ordered reference labels."),
  ]);
  return path.join(root, "SKILL.md");
}

test("H3 skill loader uses progressive disclosure for base and Ref2VA modes", async () => {
  const skillPath = await createSkillFixture();
  const base = await loadH3PromptSkillPack({
    skillPath,
    purpose: "planning",
    mode: "t2v",
  });
  assert.match(base.systemPrompt, /SKILL_SENTINEL/);
  assert.match(base.systemPrompt, /BASE_GUIDE_SENTINEL/);
  assert.doesNotMatch(base.systemPrompt, /REF_GUIDE_SENTINEL/);
  assert.deepEqual(base.policy, {
    name: "h3-prompt-writing",
    guide: "base-en.txt",
    contentHash: base.policy.contentHash,
    source: "filesystem",
  });
  assert.match(base.policy.contentHash, /^[a-f0-9]{16}$/);

  const reference = await loadH3PromptSkillPack({
    skillPath,
    purpose: "planning",
    mode: "ref2v",
    referenceMode: "multi_reference",
  });
  assert.match(reference.systemPrompt, /SKILL_SENTINEL/);
  assert.match(reference.systemPrompt, /BASE_GUIDE_SENTINEL/);
  assert.match(reference.systemPrompt, /REF_GUIDE_SENTINEL/);
  assert.equal(reference.policy.guide, "ref-en.txt");
  assert.equal(reference.policy.source, "filesystem");
});

test("H3 skill loader falls back to its embedded contract without blocking", async () => {
  const skillPath = path.join(await mkdtemp(path.join(os.tmpdir(), "h3-skill-missing-")), "SKILL.md");
  const pack = await loadH3PromptSkillPack({ skillPath, mode: "i2v", duration: 5, hasVisualReference: true });
  assert.equal(pack.policy.source, "embedded_fallback");
  assert.equal(pack.policy.guide, "base-en.txt");
  assert.match(pack.policy.contentHash, /^[a-f0-9]{16}$/);
  assert.match(pack.policy.warning, /ENOENT|no such file/i);
  assert.match(pack.systemPrompt, /integrated_multimodal_description/);
  assert.match(pack.systemPrompt, /anatomically coherent hands/);
  assert.match(pack.systemPrompt, /Clothing must keep the same design and fit/);
});

test("Ollama H3 context length defaults high and remains bounded", () => {
  assert.equal(resolveH3OllamaContextLength("not-a-number"), 32768);
  assert.equal(resolveH3OllamaContextLength(""), 32768);
  assert.equal(resolveH3OllamaContextLength(1), 8192);
  assert.equal(resolveH3OllamaContextLength(16384), 16384);
  assert.equal(resolveH3OllamaContextLength(999999), 131072);
});
