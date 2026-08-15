import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("locale is persisted before navigation without delayed initialization", async () => {
  const provider = await readFile(new URL("../app/i18n/I18nProvider.tsx", import.meta.url), "utf8");

  assert.match(provider, /document\.cookie\s*=.*Path=\/app/);
  assert.match(provider, /setLocaleState\(next\);\s*persistLocale\(next\)/s);
  assert.doesNotMatch(provider, /setTimeout/);
});
