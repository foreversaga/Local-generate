import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("long create UI keeps long-script storage isolated while importing general scripts as shots", async () => {
  const composer = await readFile(new URL("../app/components/create/LongScriptComposer.tsx", import.meta.url), "utf8");
  assert.match(composer, /\/api\/long-scripts/);
  assert.match(composer, /\/api\/scripts/);
  assert.match(composer, /importGeneralScript/);
  assert.match(composer, /negativePrompt: script\.negativePrompt/);
  assert.match(composer, /匯入為分鏡/);
  assert.match(composer, /prompt: script\.content/);
  assert.match(composer, /description: script\.description/);
  assert.match(composer, /分鏡描述/);
  assert.match(composer, /總長/);
  assert.match(composer, /method: selectedId \? "PUT" : "POST"/);
});

test("library exposes a separate long-video script manager without mixing Single scripts", async () => {
  const [workspace, manager, single] = await Promise.all([
    readFile(new URL("../app/components/library/LibraryWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/library/LongScriptLibraryManager.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/create/SingleCreateForm.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(workspace, /"long-scripts"/);
  assert.match(workspace, /root === "long-scripts" \? <LongScriptLibraryManager/);
  assert.match(manager, /\/api\/long-scripts/);
  assert.match(manager, /shots: draft\.shots\.map/);
  assert.match(manager, /分鏡描述/);
  assert.doesNotMatch(single, /api\/long-scripts/);
});

test("long segment cards can generate Ollama continuation prompts and save them as general scripts", async () => {
  const form = await readFile(new URL("../app/components/create/LongCreateForm.tsx", import.meta.url), "utf8");
  assert.match(form, /long_video_segment_continuation/);
  assert.match(form, /previousPrompt: previous\.prompt/);
  assert.match(form, /description: segment\.description/);
  assert.match(form, /用 Ollama 產生/);
  assert.match(form, /\/api\/scripts/);
  assert.match(form, /存成一般劇本/);
});
