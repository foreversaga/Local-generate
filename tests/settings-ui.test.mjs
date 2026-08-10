import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Settings route mounts the real workspace without generation controls", async () => {
  const [page, workspace, client] = await Promise.all([
    readFile(new URL("../app/(studio)/settings/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/settings/SettingsWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/settings/settings-client.ts", import.meta.url), "utf8"),
  ]);
  assert.match(page, /SettingsWorkspace/);
  assert.doesNotMatch(page, /MigrationPanel/);
  assert.match(workspace, /STUDIO_SETTINGS_STORAGE_KEY/);
  assert.match(workspace, /loadStudioSettings/);
  assert.match(workspace, /saveStudioSettings/);
  assert.doesNotMatch(workspace, /\/api\/generate/);
  assert.doesNotMatch(workspace, /\/api\/prompt/);
  assert.match(client, /\/api\/health/);
  assert.match(client, /\/api\/runtime/);
  assert.match(client, /method: "POST"/);
  assert.match(client, /JSON\.stringify\(\{ mode \}\)/);
});
