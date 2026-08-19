import { createDomainRouter } from "../runtime/domain-router.mjs";

/**
 * Build the ComfyUI-backed domain routers without importing the bridge
 * composition root. Runtime-switched controllers are supplied through getters
 * so an active router never retains a stale local/remote adapter.
 */
export function createBridgeDomainRouter({
  getSeedVR2Controller,
  getImg2ImgController,
  getText2ImgController,
  handleLoraTrainingRoute,
  handleLongVideoRoute,
  planSequence,
  runSequence,
  startSequenceGeneration,
  checkMediaTools,
  outputRoot,
  ollamaCoordinator,
  continuationPromptFinalizer,
  runtimeContext,
  withAssetLifecycleLock,
  withRuntimeOperation,
} = {}) {
  const required = {
    getSeedVR2Controller,
    getImg2ImgController,
    getText2ImgController,
    handleLoraTrainingRoute,
    handleLongVideoRoute,
    planSequence,
    runSequence,
    startSequenceGeneration,
    checkMediaTools,
    outputRoot,
    ollamaCoordinator,
    continuationPromptFinalizer,
    runtimeContext,
    withAssetLifecycleLock,
    withRuntimeOperation,
  };
  for (const [name, value] of Object.entries(required)) {
    if (typeof value === "undefined" || value === null) throw new TypeError(`Bridge domain router dependency ${name} is required.`);
  }

  return createDomainRouter([
    {
      name: "upscale",
      matches: ({ pathname }) => pathname === "/api/upscale" || pathname.startsWith("/api/upscale/"),
      handle: ({ req, res, pathname, readJson, sendJson, sendError }) => {
        const dispatch = () => getSeedVR2Controller().handleRoute(req, res, { pathname, readJson, sendJson, sendError });
        return req.method === "GET" ? dispatch() : withAssetLifecycleLock(() => withRuntimeOperation(dispatch));
      },
    },
    {
      name: "sequences",
      matches: ({ pathname }) => pathname === "/api/sequences" || pathname.startsWith("/api/sequences/"),
      handle: ({ req, res }) => {
        const dispatch = () => handleLongVideoRoute(req, res, {
          plan: planSequence,
          planOptions: {
            ollamaUrl: runtimeContext.ollamaUrl,
            comfyUrl: runtimeContext.comfyUrl,
            remoteComfy: runtimeContext.isRemote,
            ollamaCoordinator,
          },
          outputOptions: { root: outputRoot },
          preflight: () => checkMediaTools(),
          runJob: (job, deps) => runSequence(job, {
            ...deps,
            finalizePrompt: deps.finalizePrompt || continuationPromptFinalizer,
            generate: startSequenceGeneration,
          }),
        });
        return req.method === "GET" ? dispatch() : withAssetLifecycleLock(() => withRuntimeOperation(dispatch));
      },
    },
    {
      name: "lora-training",
      matches: ({ pathname }) => pathname === "/api/lora-training/assets" || pathname === "/api/lora-training/health" || pathname.startsWith("/api/lora-training/jobs"),
      handle: ({ req, res, requestUrl }) => handleLoraTrainingRoute(req, res, { pathname: requestUrl.pathname, requestUrl }),
    },
    {
      name: "text2img",
      matches: ({ pathname }) => pathname === "/api/text2img" || pathname.startsWith("/api/text2img/"),
      handle: ({ req, res, pathname, readJson, sendJson, sendError }) => {
        const dispatch = () => getText2ImgController().handleRoute(req, res, { pathname, readJson, sendJson, sendError });
        return req.method === "GET" ? dispatch() : withAssetLifecycleLock(() => withRuntimeOperation(dispatch));
      },
    },
    {
      name: "img2img",
      matches: ({ pathname }) => pathname === "/api/img2img" || pathname.startsWith("/api/img2img/"),
      handle: ({ req, res, pathname, readJson, sendJson, sendError }) => {
        const dispatch = () => getImg2ImgController().handleRoute(req, res, { pathname, readJson, sendJson, sendError });
        return req.method === "GET" ? dispatch() : withAssetLifecycleLock(() => withRuntimeOperation(dispatch));
      },
    },
  ]);
}
