import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Create landing keeps generation, continuity, and asset-start as the primary flow", async () => {
    const landing = await readFile(
        new URL("../app/components/create/CreateLanding.tsx", import.meta.url),
        "utf8",
    );

    const singleIndex = landing.indexOf('href="/app/create/single"');
    const longIndex = landing.indexOf('href="/app/create/long"');
    const recentIndex = landing.indexOf('aria-labelledby="recent-jobs-heading"');
    const assetIndex = landing.indexOf('aria-labelledby="start-from-asset-heading"');

    assert.ok(singleIndex >= 0, "Single workflow must stay on Create landing");
    assert.ok(longIndex > singleIndex, "Long workflow must follow Single");
    assert.ok(recentIndex > longIndex, "Recent jobs must follow the primary generation choices");
    assert.ok(assetIndex > recentIndex, "Start-from-asset must remain available after continuity actions");

    assert.doesNotMatch(landing, /href="\/app\/tools\//, "Tools belong to the dedicated Tools workspace");
    assert.match(landing, /allowedRoots=\{\["input", "output"\]\}/, "Asset start must preserve both media roots");
});
