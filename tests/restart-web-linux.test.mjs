import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptUrl = new URL("../scripts/restart-web-linux.sh", import.meta.url);

test("Linux WebUI restart script is executable and wired to npm", async () => {
  const [script, packageJson, readme, scriptStat] = await Promise.all([
    readFile(scriptUrl, "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    stat(scriptUrl),
  ]);

  await access(scriptUrl, constants.X_OK);
  assert.notEqual(scriptStat.mode & 0o111, 0);
  assert.equal(packageJson.scripts["restart:web:linux"], "bash ./scripts/restart-web-linux.sh");
  assert.match(readme, /npm run restart:web:linux/);

  assert.match(script, /SERVICE_UNIT="h3-studio-web\.service"/);
  assert.match(script, /runtime\?\.activeOperations/);
  assert.match(script, /gpu\?\.activeCount/);
  assert.match(script, /queue_running/);
  assert.match(script, /queue_pending/);
  assert.match(script, /systemctl --user restart "\$\{SERVICE_UNIT\}"/);
  assert.match(script, /systemd-run/);
  assert.match(script, /dist\/server\/index\.js/);
  assert.match(script, /dist\/client\/\.vite\/manifest\.json/);
  assert.match(script, /Production build is stale/);
  assert.match(script, /app\/api\/health/);
  assert.match(script, /static_assets/);
  assert.doesNotMatch(script, /systemctl\s+(?:restart|stop|start)\s+(?:comfy|ollama)/i);
});

test("Linux WebUI restart script passes Bash syntax validation", () => {
  const result = spawnSync("bash", ["-n", scriptUrl.pathname], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("Linux WebUI restart script exposes help without changing services", () => {
  const result = spawnSync("bash", [scriptUrl.pathname, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /--force/);
});
