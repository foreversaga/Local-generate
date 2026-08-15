import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("long-running Windows service launchers share the interactive-user guard", async () => {
  const guard = await readFile(path.join(projectRoot, "scripts", "service-launch-guard.ps1"), "utf8");
  assert.match(guard, /CodexSandbox/);
  assert.match(guard, /SessionId/);
  assert.match(guard, /SpecialFolder.*UserProfile/);

  for (const relativePath of [
    ["scripts", "restart-web.ps1"],
    ["scripts", "vast", "start-local-runtime.ps1"],
    ["scripts", "vast", "start-tunnel.ps1"],
  ]) {
    const source = await readFile(path.join(projectRoot, ...relativePath), "utf8");
    assert.match(source, /service-launch-guard\.ps1/);
    assert.match(source, /Assert-H3InteractiveServiceLaunch/);
  }
});
