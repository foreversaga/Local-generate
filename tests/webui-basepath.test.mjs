import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { primaryRouteForPath, routeTitle } from "../app/lib/webui-routes.mjs";

test("route contract accepts both external /app paths and internal base-path-free paths", () => {
  assert.equal(primaryRouteForPath("/"), "create");
  assert.equal(routeTitle("/"), "Create");
  assert.equal(primaryRouteForPath("/app/create/single"), "create");
  assert.equal(primaryRouteForPath("/create/single"), "create");
  assert.equal(primaryRouteForPath("/jobs/job-123"), "jobs");
  assert.equal(primaryRouteForPath("/tools/image-to-image"), "tools");
  assert.equal(primaryRouteForPath("/tools"), "tools");
  assert.equal(routeTitle("/tools"), "Tools");
  assert.equal(routeTitle("/create/long"), "Create / Long");
  assert.equal(routeTitle("/tools/upscale"), "Upscale");
});

test("dev RSC module paths keep one /app prefix", async () => {
  const [viteConfig, rootPage] = await Promise.all([
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);
  const modulePrefixer = viteConfig.slice(
    viteConfig.indexOf("function prefixWebModulePaths"),
    viteConfig.indexOf("function webResponseKind"),
  );
  const pluginBrowser = await readFile(
    new URL("../node_modules/@vitejs/plugin-rsc/dist/browser.js", import.meta.url),
    "utf8",
  );
  const clientReferenceId = "/app/components/shell/AppShell.tsx";
  const loaderPathWithRootBase = `/${clientReferenceId.slice(1)}`;

  assert.match(pluginBrowser, /withTrailingSlash\(import\.meta\.env\.BASE_URL\) \+ id\.slice\(1\)/);
  assert.equal(loaderPathWithRootBase, clientReferenceId);
  assert.doesNotMatch(loaderPathWithRootBase, /^\/app\/app\//);
  assert.doesNotMatch(modulePrefixer, /\.replace\(\s*\/"BASE_URL":/);
  assert.doesNotMatch(modulePrefixer, /\/app\/app/);
  assert.match(viteConfig, /parsed\.pathname\.startsWith\("\/components\/"\)/);
  assert.match(viteConfig, /parsed\.pathname\.startsWith\("\/lib\/"\)/);
  assert.match(viteConfig, /\["\/globals\.css", "\/page\.tsx", "\/layout\.tsx"\]/);
  assert.match(rootPage, /<AppShell>[\s\S]*<CreateLanding \/>/);
});
