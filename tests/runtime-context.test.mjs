import assert from "node:assert/strict";
import test from "node:test";
import { createBridgeDomainRouter } from "../server/routes/bridge-domain-routes.mjs";
import { createDomainRouter } from "../server/runtime/domain-router.mjs";
import { createRuntimeContext } from "../server/runtime/runtime-context.mjs";

function context(initialMode = "local") {
  return createRuntimeContext({
    initialMode,
    local: { comfyUrl: "http://local-comfy/", ollamaUrl: "http://local-ollama/" },
    remote: { comfyUrl: "http://remote-comfy/", ollamaUrl: "http://remote-ollama/" },
  });
}

test("runtime context tracks operation admission and always releases it", async () => {
  const runtime = context();
  assert.equal(runtime.mode, "local");
  assert.equal(runtime.comfyUrl, "http://local-comfy");
  await runtime.withOperation(async () => {
    assert.equal(runtime.activeOperations, 1);
    await assert.rejects(() => runtime.switchMode("remote", {
      busyReason: async () => "active operation",
      probe: async () => ({ comfyOnline: true, ollamaOnline: true }),
    }), { code: "RUNTIME_IN_USE" });
  });
  assert.equal(runtime.activeOperations, 0);
});

test("runtime context switches only after health, GPU release, and adapter refresh", async () => {
  const runtime = context();
  const events = [];
  const result = await runtime.switchMode("remote", {
    probe: async (remote) => {
      events.push(`probe:${remote}`);
      return { mode: "remote", remote: true, comfyUrl: "http://remote-comfy", ollamaUrl: "http://remote-ollama", comfyOnline: true, ollamaOnline: true };
    },
    releaseGpu: async (target) => events.push(`release:${target.mode}`),
    onSwitched: async (target) => events.push(`switched:${target.mode}:${runtime.mode}`),
  });
  assert.equal(result.comfyOnline, true);
  assert.equal(runtime.mode, "remote");
  assert.deepEqual(events, ["probe:true", "release:local", "switched:remote:remote"]);
  assert.equal(runtime.snapshot().local.comfyUrl, "http://local-comfy");
});

test("runtime context rejects an unavailable target and leaves the active mode intact", async () => {
  const runtime = context();
  await assert.rejects(
    () => runtime.switchMode("remote", {
      probe: async () => ({ comfyOnline: false, ollamaOnline: true }),
    }),
    { code: "RUNTIME_UNAVAILABLE", status: 503 },
  );
  assert.equal(runtime.mode, "local");
  assert.equal(runtime.isSwitching, false);
});

test("domain router dispatches the first matching domain and remains independently testable", async () => {
  const calls = [];
  const router = createDomainRouter([
    { name: "assets", matches: ({ pathname }) => pathname === "/api/assets", handle: async () => { calls.push("assets"); return false; } },
    { name: "jobs", matches: ({ pathname }) => pathname.startsWith("/api/jobs"), handle: async ({ res }) => { calls.push("jobs"); res.headersSent = true; return true; } },
  ]);
  assert.deepEqual(router.names, ["assets", "jobs"]);
  assert.equal(await router.dispatch({ pathname: "/api/jobs/1", res: {} }), true);
  assert.deepEqual(calls, ["jobs"]);
  assert.equal(await router.dispatch({ pathname: "/api/unknown", res: {} }), false);
});

test("bridge domain router keeps runtime-switched controller lookup injectable", async () => {
  const router = createBridgeDomainRouter({
    getSeedVR2Controller: () => ({ handleRoute: async () => true }),
    getImg2ImgController: () => ({ handleRoute: async () => true }),
    getText2ImgController: () => ({ handleRoute: async () => true }),
    handleLoraTrainingRoute: async () => true,
    handleLongVideoRoute: async () => true,
    planSequence: async () => ({}),
    runSequence: async () => ({}),
    startSequenceGeneration: async () => ({}),
    cancelSingleVideoJob: async () => ({}),
    checkMediaTools: async () => ({}),
    outputRoot: "C:/output",
    ollamaCoordinator: {},
    continuationPromptFinalizer: async () => "",
    runtimeContext: { comfyUrl: "http://comfy", ollamaUrl: "http://ollama", isRemote: false },
    withAssetLifecycleLock: (operation) => operation(),
    withRuntimeOperation: (operation) => operation(),
  });
  assert.deepEqual(router.names, ["upscale", "sequences", "lora-training", "text2img", "pose-preview", "img2img"]);
  assert.equal(await router.dispatch({ pathname: "/api/text2img", req: { method: "GET" }, res: {}, readJson() {}, sendJson() {}, sendError() {} }), true);
  assert.equal(await router.dispatch({ pathname: "/api/img2img", req: { method: "GET" }, res: {}, readJson() {}, sendJson() {}, sendError() {} }), true);
});
