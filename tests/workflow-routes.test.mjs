import assert from "node:assert/strict";
import test from "node:test";
import { primaryRouteForPath, routeTitle } from "../app/lib/webui-routes.mjs";

test("workspace route remains under Create navigation", () => {
    const path = "/app/create/workspace/project-123";
    assert.equal(primaryRouteForPath(path), "create");
    assert.equal(routeTitle(path, "zh-TW"), "建立 / 專案工作區");
    assert.equal(routeTitle(path, "en"), "Create / Project workspace");
});
