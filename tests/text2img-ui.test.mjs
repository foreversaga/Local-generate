import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("exposes the FLUX text-to-image tool through the existing Studio route and API", async () => {
  const [toolsPage, routePage, workspace, client, dictionaries] = await Promise.all([
    readFile(new URL("../app/(studio)/tools/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/(studio)/tools/text-to-image/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/tools/TextToImageWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/tools/text2img-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/i18n/dictionaries.ts", import.meta.url), "utf8"),
  ]);

  assert.match(toolsPage, /href="\/app\/tools\/text-to-image"/);
  assert.match(routePage, /TextToImageWorkspace/);
  assert.match(workspace, /text2img\.model\.4b\.name/);
  assert.match(workspace, /assetUrl\(job\.output\)/);
  assert.match(workspace, /generateText2ImgPrompt/);
  assert.match(workspace, /text2img\.description\.label/);
  assert.match(workspace, /nature-camera/);
  assert.match(workspace, /flux2-klein-9b/);
  assert.match(workspace, /name="image-model"/);
  assert.match(workspace, /text2img\.model\.9b\.warning/);
  assert.match(workspace, /text2img\.section\.prompt/);
  assert.match(workspace, /text2img\.section\.output/);
  assert.match(workspace, /text2img\.result\.seed/);
  assert.match(workspace, /text2img\.result\.steps/);
  assert.match(workspace, /jobStageKey\(job\.stage\)/);
  assert.doesNotMatch(workspace, /\? job\.error : job\.stage/);
  assert.match(workspace, /setSteps\(event\.target\.value\)/);
  assert.match(workspace, /setSeed\(event\.target\.value\)/);
  assert.match(workspace, /onBlur=\{\(\) => setSteps\(String\(normalizeIntegerField/);
  assert.match(workspace, /onBlur=\{\(\) => setSeed\(String\(normalizeIntegerField/);
  assert.doesNotMatch(workspace, /set(?:Steps|Seed)\(Number\(event\.target\.value\)\)/);
  assert.match(client, /\/api\/text2img\/health/);
  assert.match(client, /\/api\/text2img\/prompt/);
  assert.match(client, /\/api\/text2img\/jobs/);
  assert.match(client, /modelId: string/);
  assert.match(dictionaries, /"page\.text2img\.title"/);
  assert.match(dictionaries, /"text2img\.generate\.action"/);
  assert.match(dictionaries, /"text2img\.model\.9b\.license"/);
  assert.match(dictionaries, /FLUX Non-Commercial License/);
  assert.match(dictionaries, /"text2img\.job\.stage\.registering"/);
});
