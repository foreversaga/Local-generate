from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file_path = Path(path)
    text = file_path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected exactly one match in {path}, found {count}: {old[:120]!r}")
    file_path.write_text(text.replace(old, new, 1), encoding="utf-8")


def replace_exact_count(path: str, old: str, new: str, expected: int) -> None:
    file_path = Path(path)
    text = file_path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != expected:
        raise SystemExit(f"Expected {expected} matches in {path}, found {count}: {old[:120]!r}")
    file_path.write_text(text.replace(old, new), encoding="utf-8")


replace_once(
    "app/components/library/LibraryWorkspace.tsx",
    "            setPendingDelete(null);\n            setSelectionMode(false);\n            await refresh();",
    "            setPendingDelete(null);\n            setSelectionMode(false);\n            setPreview(null);\n            await refresh();",
)

replace_once(
    "app/components/library/LibraryWorkspace.module.css",
    ".previewButton img,.previewButton video{width:100%;height:100%;object-fit:cover}",
    ".previewButton img,.previewButton video{width:100%;height:100%;object-fit:contain}",
)

replace_once(
    "app/components/library/AssetPickerButton.module.css",
    ".thumb img,.thumb video{width:100%;height:100%;object-fit:cover}",
    ".thumb img,.thumb video{width:100%;height:100%;object-fit:contain}",
)

replace_once(
    "app/lib/job-adapter.mjs",
    "    title: jobTitle(raw, source),\n    subtitle: jobSubtitle(raw, source),\n    prompt: typeof raw?.prompt === \"string\"",
    "    title: jobTitle(raw, source),\n    subtitle: jobSubtitle(raw, source),\n    description: jobDescription(raw, source),\n    prompt: typeof raw?.prompt === \"string\"",
)

replace_once(
    "app/lib/job-adapter.mjs",
    "function jobTitle(raw, source) {",
    """function firstNonEmptyText(...values) {
  for (const value of values) {
    if (typeof value === \"string\" && value.trim()) return value;
  }
  return \"\";
}

function jobDescription(raw, source) {
  const request = raw?.provenance?.request && typeof raw.provenance.request === \"object\"
    ? raw.provenance.request
    : {};
  if (source === \"long\") {
    return firstNonEmptyText(raw?.description, raw?.inputText, request.description, request.inputText);
  }
  if (source === \"img2img\") {
    return firstNonEmptyText(raw?.promptDescription, request.promptDescription, raw?.description, request.description);
  }
  return firstNonEmptyText(
    raw?.initialDescription,
    request.initialDescription,
    raw?.promptDescription,
    request.promptDescription,
    raw?.description,
    request.description,
  );
}

function jobTitle(raw, source) {""",
)

replace_once(
    "app/components/jobs/JobDetailWorkspace.tsx",
    "  const complete = job.status === \"complete\" || job.status === \"partial\";\n  const hasElapsed = Number.isFinite(job.elapsedMs);",
    "  const complete = job.status === \"complete\" || job.status === \"partial\";\n  const showPromptText = Boolean(job.prompt && (!job.description || job.prompt.trim() !== job.description.trim()));\n  const hasElapsed = Number.isFinite(job.elapsedMs);",
)

replace_once(
    "app/components/jobs/JobDetailWorkspace.tsx",
    """          {job.prompt && (
            <details className={styles.detailDisclosure}>
              <summary>提示詞</summary>
              <div className={styles.detailDisclosureBody}>
                {complete && <SaveJobAsScript defaultName={job.title} prompt={job.prompt} negativePrompt={job.negativePrompt || \"\"} />}
                <strong>Prompt</strong>
                <pre className={styles.promptPreview}>{job.prompt}</pre>
                {job.negativePrompt && <><strong>Negative Prompt</strong><pre className={styles.promptPreview}>{job.negativePrompt}</pre></>}
              </div>
            </details>
          )}""",
    """          {(job.description || job.prompt || job.negativePrompt) && (
            <details className={styles.detailDisclosure}>
              <summary>提示詞與描述</summary>
              <div className={styles.detailDisclosureBody}>
                {job.description && <><strong>提示詞描述</strong><pre className={styles.promptPreview}>{job.description}</pre></>}
                {complete && job.prompt && <SaveJobAsScript defaultName={job.title} prompt={job.prompt} negativePrompt={job.negativePrompt || \"\"} />}
                {showPromptText && <><strong>Prompt</strong><pre className={styles.promptPreview}>{job.prompt}</pre></>}
                {job.negativePrompt && <><strong>Negative Prompt</strong><pre className={styles.promptPreview}>{job.negativePrompt}</pre></>}
              </div>
            </details>
          )}""",
)

replace_exact_count(
    "app/components/tools/img2img-client.ts",
    "    prompt: string;\n    negativePrompt: string;",
    "    promptDescription?: string;\n    prompt: string;\n    negativePrompt: string;",
    2,
)

replace_once(
    "app/components/tools/ImageToImageWorkspace.tsx",
    "            return `${record.id} ${record.prompt} ${record.model} ${record.characterLoraName || \"\"} ${record.characterLoraStrength ?? \"\"} ${baseParameters} ${itemParameters}`.toLowerCase().includes(needle);",
    "            return `${record.id} ${record.promptDescription || \"\"} ${record.prompt} ${record.model} ${record.characterLoraName || \"\"} ${record.characterLoraStrength ?? \"\"} ${baseParameters} ${itemParameters}`.toLowerCase().includes(needle);",
)

replace_once(
    "app/components/tools/ImageToImageWorkspace.tsx",
    "            prompt: prompt.trim(),\n            negativePrompt: negativePrompt.trim(),",
    "            ...(promptDescription.trim() ? { promptDescription: promptDescription.trim() } : {}),\n            prompt: prompt.trim(),\n            negativePrompt: negativePrompt.trim(),",
)

replace_once(
    "app/components/tools/ImageToImageWorkspace.tsx",
    "                    <span>搜尋工作編號、提示詞、模型或隨機種子</span>",
    "                    <span>搜尋工作編號、提示詞描述、提示詞、模型或隨機種子</span>",
)

replace_once(
    "app/components/tools/ImageToImageWorkspace.tsx",
    """                                    <div className={styles.historyDetails}>
                                        <p>{record.prompt}</p>
                                        <small>{FIELD_LABELS.seed}：{recordSeeds || record.seed}</small>""",
    """                                    <div className={styles.historyDetails}>
                                        {record.promptDescription && <><strong>提示詞描述</strong><p>{record.promptDescription}</p></>}
                                        <strong>Prompt</strong>
                                        <p>{record.prompt}</p>
                                        <small>{FIELD_LABELS.seed}：{recordSeeds || record.seed}</small>""",
)

replace_once(
    "server/image-generation/img2img.mjs",
    """    const prompt = String(input.prompt || \"\").trim();
    const ollamaPromptReceipt = typeof input.ollamaPromptReceipt === \"string\"""",
    """    const prompt = String(input.prompt || \"\").trim();
    const promptDescription = typeof input.promptDescription === \"string\"
      ? input.promptDescription.trim()
      : \"\";
    const ollamaPromptReceipt = typeof input.ollamaPromptReceipt === \"string\"""",
)

replace_once(
    "server/image-generation/img2img.mjs",
    "      prompt,\n      negativePrompt: String(input.negativePrompt || \"\").trim(),\n      model,",
    "      ...(promptDescription ? { promptDescription } : {}),\n      prompt,\n      negativePrompt: String(input.negativePrompt || \"\").trim(),\n      model,",
)

replace_once(
    "server/image-generation/img2img.mjs",
    "          prompt,\n          negativePrompt: String(input.negativePrompt || \"\").trim(),\n          model,",
    "          ...(promptDescription ? { promptDescription } : {}),\n          prompt,\n          negativePrompt: String(input.negativePrompt || \"\").trim(),\n          model,",
)

replace_once(
    "server/image-generation/img2img.mjs",
    "      prompt: source.prompt,\n      negativePrompt: source.negativePrompt,",
    "      ...(source.promptDescription ? { promptDescription: source.promptDescription } : {}),\n      prompt: source.prompt,\n      negativePrompt: source.negativePrompt,",
)

Path("tests/ui-library-job-description.test.mjs").write_text(r'''import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { adaptJob } from "../app/lib/job-adapter.mjs";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("job history exposes the original prompt description across supported generation sources", () => {
  assert.equal(adaptJob({ id: "video", initialDescription: "原始單影片描述" }, "video").description, "原始單影片描述");
  assert.equal(adaptJob({ id: "legacy-video", provenance: { request: { initialDescription: "provenance 描述" } } }, "video").description, "provenance 描述");
  assert.equal(adaptJob({ id: "long", inputText: "長影片故事描述" }, "long").description, "長影片故事描述");
  assert.equal(adaptJob({ id: "image", promptDescription: "把背景改成海邊" }, "img2img").description, "把背景改成海邊");
});

test("job detail shows prompt description separately from the generated prompt", async () => {
  const detail = await source("app/components/jobs/JobDetailWorkspace.tsx");
  assert.match(detail, /提示詞與描述/);
  assert.match(detail, /提示詞描述/);
  assert.match(detail, /job\.description/);
  assert.match(detail, /showPromptText/);
});

test("img2img persists prompt descriptions into new jobs, provenance, retry, and local history", async () => {
  const workspace = await source("app/components/tools/ImageToImageWorkspace.tsx");
  const client = await source("app/components/tools/img2img-client.ts");
  const server = await source("server/image-generation/img2img.mjs");
  assert.match(workspace, /promptDescription: promptDescription\.trim\(\)/);
  assert.match(workspace, /record\.promptDescription/);
  assert.match(client, /promptDescription\?: string;/);
  assert.match(server, /const promptDescription = typeof input\.promptDescription/);
  assert.match(server, /promptDescription: source\.promptDescription/);
});

test("successful library deletion closes preview and asset thumbnails never crop media", async () => {
  const workspace = await source("app/components/library/LibraryWorkspace.tsx");
  const libraryCss = await source("app/components/library/LibraryWorkspace.module.css");
  const pickerCss = await source("app/components/library/AssetPickerButton.module.css");
  assert.match(workspace, /setSelectionMode\(false\);\s*setPreview\(null\);\s*await refresh\(\);/);
  assert.match(libraryCss, /\.previewButton img,\.previewButton video\{[^}]*object-fit:contain/);
  assert.doesNotMatch(libraryCss, /\.previewButton img,\.previewButton video\{[^}]*object-fit:cover/);
  assert.match(pickerCss, /\.thumb img,\.thumb video\{[^}]*object-fit:contain/);
  assert.doesNotMatch(pickerCss, /\.thumb img,\.thumb video\{[^}]*object-fit:cover/);
});
''', encoding="utf-8")

print("UI library and job-description fixes staged successfully.")
