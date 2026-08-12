import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("routed Single Create keeps field-level validation accessible", async () => {
  const [form, styles] = await Promise.all([
    readFile(new URL("../app/components/create/SingleCreateForm.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/create/SingleCreateForm.module.css", import.meta.url), "utf8"),
  ]);

  assert.match(form, /error=\{errorFor\("lastFrameImage"\)\}/);
  assert.doesNotMatch(form, /error=\{errorFor\("referenceImage"\) \? "" : errorFor\("lastFrameImage"\)\}/);
  assert.match(form, /<AssetPickerButton/);
  assert.match(form, /allowedRoots=\{\["input", "output"\]\}/);
  assert.doesNotMatch(form, /<select[\s\S]*從資源庫選擇/);
  assert.match(form, /<FieldError id=\{`\$\{id\}-error`\} message=\{error\} \/>/);
  assert.match(form, /className=\{styles\.fileInput\}[\s\S]*type="file"/);
  assert.doesNotMatch(form, /<input\s+hidden\s+type="file"/);
  assert.match(styles, /\.iconButton,[\s\S]*\.secondaryButton,[\s\S]*\.uploadButton,[\s\S]*\.primaryButton \{[\s\S]*min-height: 44px;/);
  assert.match(styles, /\.fileInput \{[\s\S]*clip-path: inset\(50%\)/);
  assert.match(styles, /\.uploadButton:focus-within/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});

test("routed Single Create autosaves drafts and exposes mobile section anchors", async () => {
  const [form, styles, draftHook] = await Promise.all([
    readFile(new URL("../app/components/create/SingleCreateForm.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/create/SingleCreateForm.module.css", import.meta.url), "utf8"),
    readFile(new URL("../app/components/create/useSingleCreateDraft.ts", import.meta.url), "utf8"),
  ]);

  assert.match(form, /useSingleCreateDraft\(\{/);
  assert.match(form, /clearDraft\(\);\s*router\.push\(destination\)/);
  assert.match(form, /<nav className=\{styles\.sectionNav\} aria-label="Single Create sections">/);
  assert.match(form, /href="#single-source-section"/);
  assert.match(form, /href="#single-prompt-section"/);
  assert.match(form, /href="#single-setup-section"/);
  assert.match(form, /href="#single-review-section"/);
  assert.match(form, /role="status" aria-live="polite"/);
  assert.match(styles, /@media \(max-width: 768px\)[\s\S]*\.sectionNav \{[\s\S]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.sectionNav a \{[\s\S]*min-height: 44px/);
  assert.match(form, /const \[assetsLoaded\] = await Promise\.all\(\[refreshAssets\(\), refreshHealth\(\), refreshCharacterLoras\(\)\]\);/);
  assert.match(form, /setAssetsReady\(assetsLoaded\)/);
  assert.match(draftHook, /try \{[\s\S]*localStorage\.getItem\(SINGLE_CREATE_DRAFT_STORAGE_KEY\)/);
  assert.match(draftHook, /localStorage\.setItem\(SINGLE_CREATE_DRAFT_STORAGE_KEY/);
  assert.match(draftHook, /parseSingleCreateDraft\(JSON\.stringify\(\{ version: 1, \.\.\.value \}\)\)/);
  assert.match(draftHook, /try \{[\s\S]*localStorage\.removeItem\(SINGLE_CREATE_DRAFT_STORAGE_KEY\)/);
  assert.match(draftHook, /addEventListener\("beforeunload", handleBeforeUnload\)/);
});

test("Single Create asset selectors and compact controls expose usable targets", async () => {
  const [form, styles, assistantStyles] = await Promise.all([
    readFile(new URL("../app/components/create/SingleCreateForm.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/create/SingleCreateForm.module.css", import.meta.url), "utf8"),
    readFile(new URL("../app/components/create/SinglePromptAssistant.module.css", import.meta.url), "utf8"),
  ]);
  assert.match(form, /<label htmlFor="single-reference-images" className=\{styles\.fieldLabel\}>/);
  assert.match(form, /<label htmlFor=\{id\} className=\{styles\.fieldLabel\}>\{label\}<\/label>/);
  assert.match(styles, /\.range \{[\s\S]*min-height: 44px;[\s\S]*padding: 18px 0;/);
  assert.match(styles, /\.referenceChip button \{[\s\S]*width: 44px;[\s\S]*height: 44px;/);
  assert.match(assistantStyles, /\.providerSwitch button \{[\s\S]*min-height: 44px;/);
});

test("Replace exposes optional character LoRA controls with accessible guidance", async () => {
  const form = await readFile(new URL("../app/components/create/SingleCreateForm.tsx", import.meta.url), "utf8");
  assert.match(form, /single-character-lora/);
  assert.match(form, /single-character-lora-strength/);
  assert.match(form, /list="single-character-lora-options"/);
  assert.match(form, /type="number"[\s\S]*min=\{0\}[\s\S]*max=\{2\}[\s\S]*step=\{0\.05\}/);
  assert.match(form, /Wan2\.2 Animate/);
  assert.match(form, /0\.55–0\.75/);
  assert.match(form, /0\.7–0\.9/);
  assert.match(form, /LightX2V/);
});

test("Single Create derives final output resolution from the current image and rejects stale reads", async () => {
  const form = await readFile(new URL("../app/components/create/SingleCreateForm.tsx", import.meta.url), "utf8");
  assert.match(form, /readImageDimensions\(resolutionAssetUrl\)/);
  assert.match(form, /normalizeImageResolution\(dimensions\.width, dimensions\.height, mode\)/);
  assert.match(form, /scaleImageResolution\(sourceWidth, sourceHeight, mode, nextScale\)/);
  assert.match(form, /id="single-resolution-scale"/);
  assert.match(form, /min=\{10\}[\s\S]*max=\{100\}/);
  assert.match(form, /checked=\{aspectLocked\}/);
  assert.match(form, /原始圖片 \{resolutionInfo\.originalWidth\}/);
  assert.match(form, /輸出尺寸 \{width \|\| "—"\}/);
  assert.match(form, /resolutionRequestRef\.current !== requestId/);
  assert.match(form, /setWidth\(""\);\s*setHeight\(""\);/);
  assert.match(form, /data-resolution-status=\{resolutionStatus\}/);
  assert.match(form, /手動輸入輸出尺寸/);
  assert.match(form, /無法讀取 .* 的尺寸/);
  assert.match(form, /onChange=\{\(event\) => updateResolutionDimension\("width", numberDraft\(event\.target\.value\)\)\}/);
  assert.match(form, /onChange=\{\(event\) => updateResolutionDimension\("height", numberDraft\(event\.target\.value\)\)\}/);
  assert.match(form, /onClearReference=\{\(\) => \{\s*setReferenceImage\(null\);\s*resetResolutionToDefault\(\);/);
  assert.match(form, /onClearLastFrame=\{\(\) => \{\s*setLastFrameImage\(null\);\s*resetResolutionToDefault\(\);/);
  assert.match(form, /const canInteract = !submitting && !isUploading/);
  assert.match(form, /disabled=\{!canInteract\}/);
  assert.match(form, /focusValidationField\(validationIssues\[0\]\.field\)/);
  assert.match(form, /className=\{styles\.validationLink\}/);
});
