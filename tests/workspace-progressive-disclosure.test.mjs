import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("jobs workspace keeps filters and technical details out of the default view", async () => {
  const [workspace, detail] = await Promise.all([
    source("app/components/jobs/JobsWorkspace.tsx"),
    source("app/components/jobs/JobDetailWorkspace.tsx"),
  ]);

  assert.match(workspace, /const \[filtersOpen, setFiltersOpen\] = useState\(false\)/);
  assert.match(workspace, /aria-controls="jobs-filter-panel"/);
  assert.match(workspace, /activeFilterCount/);
  assert.match(workspace, /jobs\.elapsed/);
  assert.doesNotMatch(workspace, /ComfyUI:/);
  assert.doesNotMatch(workspace, /nativeCurrent\/.*nativeMaximum/);

  assert.match(detail, /styles\.statusPanel/);
  assert.match(detail, /<summary>生成參數<\/summary>/);
  assert.match(detail, /<summary>技術資訊<\/summary>/);
  assert.match(detail, /ComfyUI Node/);
  assert.match(detail, /預估總時間/);
  assert.match(detail, /aria-label="影片生成細項"/);
  assert.match(detail, /採樣進度/);
  assert.match(detail, /ComfyUI 連線/);
  assert.match(detail, /進度來源/);
  assert.doesNotMatch(detail, /Edit parameters and retry/);
  assert.doesNotMatch(detail, /RETRY_PROFILES/);
});

test("library separates media and scripts and only shows destructive selection controls on demand", async () => {
  const library = await source("app/components/library/LibraryWorkspace.tsx");

  assert.match(library, /type LibraryMode = "media" \| "scripts"/);
  assert.match(library, /type ScriptMode = "single" \| "long"/);
  assert.match(library, /const \[selectionMode, setSelectionMode\] = useState\(false\)/);
  assert.match(library, /媒體素材/);
  assert.match(library, /單影片劇本/);
  assert.match(library, /長影片劇本/);
  assert.match(library, /!selectionMode \? \(/);
  assert.match(library, /uploadLocationOpen/);
  assert.match(library, /更改位置/);
  assert.doesNotMatch(library, /className=\{styles\.actions\}/);
});

test("script editors collapse optional or repeated fields", async () => {
  const [singleScripts, longScripts] = await Promise.all([
    source("app/components/library/ScriptLibraryManager.tsx"),
    source("app/components/library/LongScriptLibraryManager.tsx"),
  ]);

  assert.match(singleScripts, /const \[negativePromptOpen, setNegativePromptOpen\] = useState\(false\)/);
  assert.match(singleScripts, /aria-controls="script-negative-prompt"/);
  assert.match(singleScripts, /\{negativePromptOpen && \(/);

  assert.match(longScripts, /const \[expandedShot, setExpandedShot\] = useState<number \| null>\(null\)/);
  assert.match(longScripts, /aria-controls=\{`long-shot-\$\{index\}`\}/);
  assert.match(longScripts, /\{expanded && \(/);
  assert.match(longScripts, /setExpandedShot\(invalidIndex\)/);
});
