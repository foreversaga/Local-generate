import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("renders the Create landing at the public root", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>H3 Studio/);
  assert.match(html, /H3 STUDIO/);
  assert.match(html, /單次影片/);
  assert.match(html, /長影片/);
  assert.match(html, /從素材開始/);
  assert.match(html, /最近工作/);
  assert.doesNotMatch(html, /id="prompt"/);
  assert.doesNotMatch(html, /LOCAL RENDER CONSOLE|LOCAL VIDEO LAB|8787|local bridge/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|Building your site/i);
});

test("uses the same-origin API and current web route wiring", async () => {
  const [vite, packageJson, readme, bridge, restartScript, h3Instruction, h3Validator] = await Promise.all([
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../local-bridge.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/restart-web.ps1", import.meta.url), "utf8"),
    readFile(new URL("../server/h3-prompt/instruction.mjs", import.meta.url), "utf8"),
    readFile(new URL("../server/h3-prompt/validator.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(vite, /name:\s*["']h3-local-api["']/);
  assert.match(vite, /port:\s*webPort/);
  assert.match(vite, /const listenHost = "0\.0\.0\.0"/);
  assert.match(vite, /const webPort = 8787/);
  assert.match(vite, /parsed\.pathname\.startsWith\("\/components\/"\)/);
  assert.match(vite, /parsed\.pathname\.startsWith\("\/lib\/"\)/);
  assert.match(vite, /hmr:\s*false/);
  assert.match(vite, /ws:\s*false/);
  assert.match(vite, /forwardConsole:\s*false/);
  assert.match(vite, /disableRemoteDevHmr/);

  assert.match(bridge, /const generationQueue = \[\]/);
  assert.match(bridge, /const COMFY_ROOT = path\.resolve\(/);
  assert.match(bridge, /const INPUT_ROOT = path\.join\(COMFY_ROOT, "input"\)/);
  assert.match(bridge, /const OUTPUT_ROOT = path\.join\(COMFY_ROOT, "output"\)/);
  assert.match(bridge, /pathname === "\/api\/prompt"/);
  assert.match(bridge, /pathname === "\/api\/runtime"/);
  assert.match(bridge, /pathname === "\/api\/img2img"/);
  assert.match(bridge, /pathname === "\/api\/assets"/);
  assert.doesNotMatch(bridge, /STUDIO_OUTPUT_ROOT/);
  assert.match(h3Instruction, /integrated_multimodal_description/);
  assert.match(h3Validator, /subject_definitions.*summary.*retention_analysis.*detailed_description.*overall_soundscape.*non_diegetic_music/s);

  assert.doesNotMatch(packageJson, /npm run bridge|local-bridge\.mjs/);
  assert.match(packageJson, /restart:web/);
  assert.match(restartScript, /healthUrl = "http:\/\/127\.0\.0\.1:8787\/app\/api\/health"/);
  assert.match(readme, /8787/);
  assert.match(readme, /ComfyUI\\input/);
  assert.match(readme, /ComfyUI\\output/);
  assert.match(readme, /restart-web\.ps1/);
  assert.doesNotMatch(readme, /npm\.cmd run bridge|local bridge/i);
});
