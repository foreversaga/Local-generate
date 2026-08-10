import assert from "node:assert/strict";
import test from "node:test";
import {
  primaryRouteForPath,
  routeTitle,
  WEB_UI_ROUTES,
} from "../app/lib/webui-routes.mjs";
import {
  validateSingleRender,
} from "../app/lib/single-render-validation.mjs";

const ASSET = { name: "asset.png" };

function validSingleInput(overrides = {}) {
  return {
    mode: "t2v",
    prompt: "A cinematic tracking shot.",
    promptMaxChars: 7000,
    enforcePromptMaxChars: true,
    width: 736,
    height: 416,
    steps: 20,
    seed: 12345,
    renderCount: 1,
    referenceImage: null,
    referenceImages: [],
    lastFrameImage: null,
    sourceVideo: null,
    ...overrides,
  };
}

function messages(input) {
  return validateSingleRender(input).map((issue) => issue.message);
}

test("primary WebUI routes match the approved navigation", () => {
  assert.deepEqual(
    WEB_UI_ROUTES.map(({ id, label, href }) => ({ id, label, href })),
    [
      { id: "create", label: "Create", href: "/app/create" },
      { id: "jobs", label: "Jobs", href: "/app/jobs" },
      { id: "library", label: "Library", href: "/app/library" },
      { id: "tools", label: "Tools", href: "/app/tools/upscale" },
      { id: "settings", label: "Settings", href: "/app/settings" },
    ],
  );
});

test("route mapping keeps nested routes on the correct primary navigation item", () => {
  assert.equal(primaryRouteForPath("/app"), "create");
  assert.equal(primaryRouteForPath("/app/create/single"), "create");
  assert.equal(primaryRouteForPath("/app/create/long?draft=abc"), "create");
  assert.equal(primaryRouteForPath("/app/jobs/job-123"), "jobs");
  assert.equal(primaryRouteForPath("/app/library/"), "library");
  assert.equal(primaryRouteForPath("/app/tools/image-to-image"), "tools");
  assert.equal(primaryRouteForPath("/app/settings#runtime"), "settings");
});

test("route titles identify important child pages", () => {
  assert.equal(routeTitle("/app/create"), "Create");
  assert.equal(routeTitle("/app/create/single"), "Create / Single");
  assert.equal(routeTitle("/app/create/long"), "Create / Long");
  assert.equal(routeTitle("/app/jobs/job-123"), "Job Detail");
  assert.equal(routeTitle("/app/tools/upscale"), "Upscale");
  assert.equal(routeTitle("/app/tools/image-to-image"), "Image to Image");
});

test("valid t2v render has no validation issues", () => {
  assert.deepEqual(validateSingleRender(validSingleInput()), []);
});

test("single render requires a non-empty prompt and enforces H3 prompt length", () => {
  assert.match(messages(validSingleInput({ prompt: "   " }))[0], /提示詞/);
  assert.match(messages(validSingleInput({ prompt: "x".repeat(7001) }))[0], /7000/);
  assert.equal(
    messages(validSingleInput({
      mode: "replace",
      prompt: "x".repeat(7001),
      referenceImage: ASSET,
      sourceVideo: { name: "source.mp4" },
    })).some((message) => message.includes("7000")),
    false,
  );
});

test("single render validates required assets per mode", () => {
  assert.match(messages(validSingleInput({ mode: "i2v" }))[0], /I2VA/);
  assert.match(messages(validSingleInput({ mode: "ref2v" }))[0], /Ref2VA/);
  assert.match(messages(validSingleInput({ mode: "fl2v", referenceImage: ASSET }))[0], /FL2VA/);
  assert.match(messages(validSingleInput({ mode: "l2v" }))[0], /L2VA/);
  assert.match(messages(validSingleInput({ mode: "replace", referenceImage: ASSET }))[0], /來源影片/);

  assert.deepEqual(validateSingleRender(validSingleInput({ mode: "i2v", referenceImage: ASSET })), []);
  assert.deepEqual(validateSingleRender(validSingleInput({ mode: "ref2v", referenceImages: [ASSET] })), []);
  assert.deepEqual(validateSingleRender(validSingleInput({ mode: "ref2v", sourceVideo: { name: "ref.mp4" } })), []);
  assert.deepEqual(validateSingleRender(validSingleInput({ mode: "fl2v", referenceImage: ASSET, lastFrameImage: ASSET })), []);
  assert.deepEqual(validateSingleRender(validSingleInput({ mode: "l2v", lastFrameImage: ASSET })), []);
  assert.deepEqual(validateSingleRender(validSingleInput({ mode: "replace", referenceImage: ASSET, sourceVideo: { name: "source.mp4" } })), []);
});

test("single render validates dimension bounds and mode-specific grid", () => {
  assert.match(messages(validSingleInput({ width: "" }))[0], /影片寬度/);
  assert.match(messages(validSingleInput({ width: 16 }))[0], /32/);
  assert.match(messages(validSingleInput({ width: 2050 }))[0], /2048/);
  assert.match(messages(validSingleInput({ width: 750 }))[0], /32 的倍數/);

  assert.deepEqual(
    validateSingleRender(validSingleInput({
      mode: "replace",
      width: 720,
      height: 416,
      referenceImage: ASSET,
      sourceVideo: { name: "source.mp4" },
    })),
    [],
  );
  assert.match(
    messages(validSingleInput({
      mode: "replace",
      width: 728,
      referenceImage: ASSET,
      sourceVideo: { name: "source.mp4" },
    }))[0],
    /16 的倍數/,
  );
});

test("single render validates steps seed and render count limits", () => {
  assert.match(messages(validSingleInput({ steps: 0 }))[0], /Steps/);
  assert.match(messages(validSingleInput({ steps: 81 }))[0], /80/);
  assert.match(messages(validSingleInput({ seed: -1 }))[0], /Seed/);
  assert.match(messages(validSingleInput({ seed: 2147483648 }))[0], /2147483647/);
  assert.match(messages(validSingleInput({ renderCount: 0 }))[0], /影片數量/);
  assert.match(messages(validSingleInput({ renderCount: 21 }))[0], /20/);
});
