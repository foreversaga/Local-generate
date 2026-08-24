import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("exposes FLUX.2 Dev and Klein 9B through the existing Studio text-to-image route and API", async () => {
  const [toolsPage, routePage, workspace, client, dictionaries, bridge, envExample, settings] = await Promise.all([
    readFile(new URL("../app/(studio)/tools/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/(studio)/tools/text-to-image/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/tools/TextToImageWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/tools/text2img-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/i18n/dictionaries.ts", import.meta.url), "utf8"),
    readFile(new URL("../local-bridge.mjs", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/studio-settings.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(toolsPage, /href="\/app\/tools\/text-to-image"/);
  assert.match(routePage, /TextToImageWorkspace/);
  assert.match(workspace, /text2img\.model\.dev\.name/);
  assert.match(workspace, /assetUrl\(job\.output\)/);
  assert.match(workspace, /generateText2ImgPrompt/);
  assert.match(workspace, /text2img\.description\.label/);
  assert.match(workspace, /copyDescription/);
  assert.match(workspace, /navigator\.clipboard\?\.writeText/);
  assert.match(workspace, /navigator\.clipboard\.writeText\(description\)/);
  assert.match(workspace, /document\.execCommand\("copy"\)/);
  assert.match(workspace, /text2img\.description\.copy\.\$\{descriptionCopyStatus\}/);
  assert.match(workspace, /nature-camera/);
  assert.match(workspace, /flux2-dev/);
  assert.match(workspace, /flux2-klein-9b/);
  assert.match(workspace, /text2img\.model\.klein9b\.name/);
  assert.doesNotMatch(workspace, /krea2-turbo/);
  assert.doesNotMatch(workspace, /text2img\.model\.krea\.name/);
  assert.doesNotMatch(workspace, /flux2-klein-4b/);
  assert.doesNotMatch(workspace, /juggernaut-xl-v9/);
  assert.match(workspace, /name="image-model"/);
  assert.doesNotMatch(workspace, /name="text-encoder"/);
  assert.doesNotMatch(workspace, /name="adult-mode"/);
  assert.match(workspace, /generateText2ImgPrompt\(description\.trim\(\), \{ unloadPromptModel \}\)/);
  assert.match(workspace, /role="switch"/);
  assert.match(workspace, /aria-checked=\{unloadPromptModel\}/);
  assert.match(workspace, /text2img\.assistant\.unload\.label/);
  assert.doesNotMatch(workspace, /licenseKey|warningKey|licenseWarning|licenseTag/);
  assert.match(workspace, /text2img\.lora\.consistency\.use/);
  assert.match(workspace, /text2img\.lora\.restore\.use/);
  assert.match(workspace, /text2img\.lora\.ultrareal\.use/);
  assert.match(workspace, /type="checkbox"/);
  assert.match(workspace, /loras: selectedLoras\(\)/);
  assert.match(workspace, /loras: completedJob\.loras \|\| \[\]/);
  assert.match(workspace, /text2img\.section\.prompt/);
  assert.match(workspace, /text2img\.section\.output/);
  assert.match(workspace, /text2img\.result\.seed/);
  assert.match(workspace, /text2img\.result\.steps/);
  assert.match(workspace, /repeatGeneration\(job\)/);
  assert.match(workspace, /text2img\.output\.repeat/);
  assert.match(workspace, /prompt: completedJob\.prompt/);
  assert.match(workspace, /seed: completedJob\.seed/);
  assert.match(workspace, /encoderId: encoder/);
  assert.match(workspace, /jobStageKey\(job\.stage\)/);
  assert.doesNotMatch(workspace, /\? job\.error : job\.stage/);
  assert.match(workspace, /const next = await fetchText2ImgJob\(job\.id\);[\s\S]*setJob\(next\);[\s\S]*setSubmitError\(""\);/);
  assert.match(workspace, /setSteps\(event\.target\.value\)/);
  assert.match(workspace, /setGuidance\(event\.target\.value\)/);
  assert.match(workspace, /min=\{MIN_GUIDANCE\}/);
  assert.match(workspace, /max=\{MAX_GUIDANCE\}/);
  assert.match(workspace, /step=\{0\.1\}/);
  assert.match(workspace, /cfg: normalizedGuidance/);
  assert.match(workspace, /cfg: completedJob\.cfg/);
  assert.match(workspace, /setSeed\(event\.target\.value\)/);
  assert.match(workspace, /setWidth\(event\.target\.value\)/);
  assert.match(workspace, /setHeight\(event\.target\.value\)/);
  assert.match(workspace, /normalizeDimensionField\(width, DEFAULT_WIDTH, minDimension, maxDimension\)/);
  assert.match(workspace, /normalizeDimensionField\(height, DEFAULT_HEIGHT, minDimension, maxDimension\)/);
  assert.match(workspace, /resolutionScaleBounds/);
  assert.match(workspace, /scaledDimension\(selectedPreset\.width, nextScale\)/);
  assert.match(workspace, /scaledDimension\(selectedPreset\.height, nextScale\)/);
  assert.match(workspace, /type="range"/);
  assert.match(workspace, /text2img\.size\.scale/);
  assert.match(workspace, /onBlur=\{\(\) => setSteps\(String\(normalizeIntegerField/);
  assert.match(workspace, /onBlur=\{\(\) => setSeed\(String\(normalizeIntegerField/);
  assert.doesNotMatch(workspace, /set(?:Steps|Seed)\(Number\(event\.target\.value\)\)/);
  assert.doesNotMatch(workspace, /setGuidance\(Number\(event\.target\.value\)\)/);
  assert.doesNotMatch(workspace, /set(?:Width|Height)\(Number\(event\.target\.value\)\)/);
  assert.match(client, /\/api\/text2img\/health/);
  assert.match(client, /\/api\/text2img\/prompt/);
  assert.match(client, /\/api\/text2img\/jobs/);
  assert.match(client, /modelId: string/);
  assert.match(client, /encoderId: string/);
  assert.match(client, /cfg: number/);
  assert.match(client, /loras: Text2ImgLoraSelection\[\]/);
  assert.doesNotMatch(client, /adultMode: boolean/);
  assert.match(client, /unloadPromptModel = false/);
  assert.match(client, /JSON\.stringify\(\{ description, unloadPromptModel \}\)/);
  assert.match(dictionaries, /"page\.text2img\.title"/);
  assert.match(dictionaries, /"text2img\.generate\.action"/);
  assert.match(dictionaries, /"text2img\.description\.copy\.idle"/);
  assert.match(dictionaries, /"text2img\.description\.copy\.copied"/);
  assert.match(dictionaries, /"text2img\.description\.copy\.failed"/);
  assert.match(dictionaries, /"text2img\.model\.dev\.name"/);
  assert.match(dictionaries, /"text2img\.model\.klein9b\.name"/);
  assert.doesNotMatch(dictionaries, /"text2img\.model\.krea\.name"/);
  assert.doesNotMatch(dictionaries, /"text2img\.size\.realisticPortrait"/);
  assert.doesNotMatch(dictionaries, /"text2img\.model\.4b\.name"/);
  assert.doesNotMatch(dictionaries, /"text2img\.model\.juggernaut\.name"/);
  assert.doesNotMatch(dictionaries, /"text2img\.adultMode\.on\.name"/);
  assert.match(dictionaries, /"text2img\.assistant\.unload\.on"/);
  assert.match(dictionaries, /"text2img\.assistant\.unload\.off"/);
  assert.match(dictionaries, /"text2img\.output\.repeat"/);
  assert.match(dictionaries, /"text2img\.guidance\.label"/);
  assert.match(dictionaries, /"text2img\.guidance\.help"/);
  assert.match(dictionaries, /"text2img\.result\.guidance"/);
  assert.match(dictionaries, /"text2img\.size\.width"/);
  assert.match(dictionaries, /"text2img\.size\.scale"/);
  assert.match(dictionaries, /"text2img\.lora\.available"/);
  assert.match(dictionaries, /"text2img\.job\.stage\.registering"/);
  assert.match(dictionaries, /Qwen3\.8 27B/);
  assert.doesNotMatch(dictionaries, /Qwen3\.5 9B/);
  assert.match(bridge, /http:\/\/100\.82\.76\.80:8003\/v1/);
  assert.match(bridge, /DEFAULT_SGLANG_MODEL[\s\S]*Qwen3\.8-27B-UD-IQ3_XXS\.gguf/);
  assert.match(bridge, /provider: "vllm"/);
  assert.match(envExample, /VLLM_URL=http:\/\/100\.82\.76\.80:8003\/v1/);
  assert.match(envExample, /VLLM_PROMPT_MODEL=\/models\/Qwen3\.8-27B-UD-IQ3_XXS\.gguf/);
  assert.match(settings, /vllmModel: "\/models\/Qwen3\.8-27B-UD-IQ3_XXS\.gguf"/);
});
