import assert from "node:assert/strict";
import test from "node:test";
import { primaryRouteForPath, routeTitle } from "../app/lib/webui-routes.mjs";

test("route contract accepts both external /app paths and internal base-path-free paths", () => {
  assert.equal(primaryRouteForPath("/app/create/single"), "create");
  assert.equal(primaryRouteForPath("/create/single"), "create");
  assert.equal(primaryRouteForPath("/jobs/job-123"), "jobs");
  assert.equal(primaryRouteForPath("/tools/image-to-image"), "tools");
  assert.equal(routeTitle("/create/long"), "Create / Long");
  assert.equal(routeTitle("/tools/upscale"), "Upscale");
});
