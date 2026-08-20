import { createDomainRouter } from "../runtime/domain-router.mjs";
import { createHermesPromptClient } from "../hermes-prompt-client.mjs";
import { createHermesWorkflowPlanner } from "../workflow/hermes-workflow-planner.mjs";
import { buildH3PromptSystem } from "../h3-prompt/instruction.mjs";
import { validateH3Prompt } from "../h3-prompt/validator.mjs";

const HERMES_DEFAULT_NEGATIVE_PROMPT = "blurry, low quality, flicker, jitter, deformed face, extra limbs, warped hands, unwanted random text, logo, watermark, identity drift, face drift, face morphing, facial feature drift, age drift, hairstyle drift, costume drift, body-shape drift";
const hermesPromptClient = createHermesPromptClient();
const hermesWorkflowPlanner = createHermesWorkflowPlanner({ hermesClient: hermesPromptClient });

const POSE_PREVIEW_MAX_BYTES = 20 * 1024 * 1024;
const POSE_PREVIEW_TIMEOUT_MS = 60_000;
const POSE_PREVIEW_POLL_MS = 250;
const POSE_PREVIEW_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function posePreviewError(message, status = 500, code = "POSE_PREVIEW_ERROR") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

export function decodePosePreviewImage(value) {
  if (typeof value !== "string") {
    throw posePreviewError("Pose preview imageData must be a base64 data URL.", 400, "POSE_PREVIEW_IMAGE_INVALID");
  }
  const match = value.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) {
    throw posePreviewError("Pose preview accepts PNG, JPG, or WEBP image data only.", 415, "POSE_PREVIEW_IMAGE_INVALID");
  }
  const mime = match[1].toLowerCase();
  if (!POSE_PREVIEW_MIME_TYPES.has(mime)) {
    throw posePreviewError("Pose preview accepts PNG, JPG, or WEBP image data only.", 415, "POSE_PREVIEW_IMAGE_INVALID");
  }
  const bytes = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  if (!bytes.length || bytes.length > POSE_PREVIEW_MAX_BYTES) {
    throw posePreviewError("Pose preview image must be between 1 byte and 20 MB.", 413, "POSE_PREVIEW_IMAGE_TOO_LARGE");
  }
  return { mime, bytes };
}

export function normalizePosePreviewResolution(value, fallback = 768) {
  const number = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 256 || number > 1536 || number % 64 !== 0) {
    throw posePreviewError("Pose preview resolution must be a multiple of 64 between 256 and 1536.", 400, "POSE_PREVIEW_RESOLUTION_INVALID");
  }
  return number;
}

export function buildPosePreviewGraph(imageName, resolution = 768) {
  const cleanImageName = String(imageName || "").trim();
  if (!cleanImageName) throw posePreviewError("Pose preview image name is required.", 400, "POSE_PREVIEW_IMAGE_INVALID");
  const size = normalizePosePreviewResolution(resolution);
  return {
    "1": { class_type: "LoadImage", inputs: { image: cleanImageName } },
    "2": {
      class_type: "DWPreprocessor",
      inputs: {
        image: ["1", 0],
        detect_hand: "enable",
        detect_body: "enable",
        detect_face: "disable",
        resolution: size,
        bbox_detector: "yolox_l.onnx",
        pose_estimator: "dw-ll_ucoco_384_bs5.torchscript.pt",
        scale_stick_for_xinsr_cn: "enable",
      },
    },
    "3": { class_type: "PreviewImage", inputs: { images: ["2", 0] } },
  };
}

function normalizeComfyBaseUrl(value) {
  const url = String(value || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) throw posePreviewError("ComfyUI URL is unavailable.", 503, "COMFY_UNAVAILABLE");
  return url;
}

async function readComfyJson(response, fallbackMessage) {
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text || "{}");
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    const message = typeof payload?.error === "string" ? payload.error : payload?.message || fallbackMessage;
    throw posePreviewError(String(message || fallbackMessage), response.status === 404 ? 404 : 502, "COMFY_REQUEST_FAILED");
  }
  return payload;
}

async function comfyJson(comfyUrl, endpoint, init = {}) {
  let response;
  try {
    response = await fetch(`${normalizeComfyBaseUrl(comfyUrl)}${endpoint}`, init);
  } catch (error) {
    throw posePreviewError(`ComfyUI request failed: ${error instanceof Error ? error.message : String(error)}`, 503, "COMFY_UNAVAILABLE");
  }
  return await readComfyJson(response, "ComfyUI request failed.");
}

function posePreviewArtifact(history, promptId) {
  const record = history?.[promptId] && typeof history[promptId] === "object" ? history[promptId] : null;
  if (!record) return null;
  const outputs = record.outputs && typeof record.outputs === "object" ? record.outputs : {};
  for (const output of Object.values(outputs)) {
    const image = Array.isArray(output?.images) ? output.images[0] : null;
    if (!image?.filename) continue;
    return {
      filename: String(image.filename),
      subfolder: String(image.subfolder || ""),
      type: String(image.type || "temp"),
    };
  }
  return record.status?.completed ? false : null;
}

async function waitForPosePreview(comfyUrl, promptId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < POSE_PREVIEW_TIMEOUT_MS) {
    const history = await comfyJson(comfyUrl, `/history/${encodeURIComponent(promptId)}`);
    const artifact = posePreviewArtifact(history, promptId);
    if (artifact === false) {
      throw posePreviewError("ComfyUI completed pose extraction without a preview image.", 502, "POSE_PREVIEW_OUTPUT_MISSING");
    }
    if (artifact) return artifact;
    await new Promise((resolve) => setTimeout(resolve, POSE_PREVIEW_POLL_MS));
  }
  throw posePreviewError("Timed out while extracting the pose skeleton.", 504, "POSE_PREVIEW_TIMEOUT");
}

async function extractPosePreview({ comfyUrl, imageData, resolution }) {
  const { mime, bytes } = decodePosePreviewImage(imageData);
  const objectInfo = await comfyJson(comfyUrl, "/object_info");
  const missingNodes = ["LoadImage", "DWPreprocessor", "PreviewImage"].filter((name) => !objectInfo?.[name]);
  if (missingNodes.length) {
    throw posePreviewError(`ComfyUI is missing pose preview nodes: ${missingNodes.join(", ")}.`, 503, "POSE_PREVIEW_NODE_MISSING");
  }

  if (typeof FormData !== "function" || typeof Blob !== "function") {
    throw posePreviewError("Pose preview upload is unavailable in this Node runtime.", 500, "POSE_PREVIEW_UPLOAD_UNAVAILABLE");
  }

  const extension = mime === "image/png" ? ".png" : mime === "image/webp" ? ".webp" : ".jpg";
  const fileName = `pose-preview-${Date.now()}-${Math.random().toString(36).slice(2, 10)}${extension}`;
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: mime }), fileName);
  form.append("subfolder", "h3-studio-pose-preview");
  form.append("type", "input");
  form.append("overwrite", "true");

  const uploaded = await comfyJson(comfyUrl, "/upload/image", { method: "POST", body: form });
  const uploadedName = [String(uploaded?.subfolder || "").replace(/^\/+|\/+$/g, ""), String(uploaded?.name || fileName)]
    .filter(Boolean)
    .join("/");
  const graph = buildPosePreviewGraph(uploadedName, resolution);
  const submitted = await comfyJson(comfyUrl, "/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph, client_id: `h3-pose-preview-${Date.now()}` }),
  });
  const promptId = String(submitted?.prompt_id || submitted?.promptId || "").trim();
  if (!promptId) throw posePreviewError("ComfyUI rejected the pose preview workflow.", 502, "POSE_PREVIEW_REJECTED");

  const artifact = await waitForPosePreview(comfyUrl, promptId);
  const query = new URLSearchParams({
    filename: artifact.filename,
    subfolder: artifact.subfolder,
    type: artifact.type,
  });
  let response;
  try {
    response = await fetch(`${normalizeComfyBaseUrl(comfyUrl)}/view?${query.toString()}`);
  } catch (error) {
    throw posePreviewError(`Unable to read the pose preview: ${error instanceof Error ? error.message : String(error)}`, 502, "POSE_PREVIEW_DOWNLOAD_FAILED");
  }
  if (!response.ok) throw posePreviewError(`Unable to read the pose preview: HTTP ${response.status}.`, 502, "POSE_PREVIEW_DOWNLOAD_FAILED");
  const outputMime = String(response.headers.get("content-type") || "image/png").split(";")[0].trim() || "image/png";
  const outputBytes = Buffer.from(await response.arrayBuffer());
  if (!outputBytes.length) throw posePreviewError("Pose preview output was empty.", 502, "POSE_PREVIEW_OUTPUT_MISSING");
  return `data:${outputMime};base64,${outputBytes.toString("base64")}`;
}

async function handlePosePreviewRoute({ req, res, readJson, sendJson, sendError, runtimeContext }) {
  try {
    const body = await readJson(req);
    const previewDataUrl = await extractPosePreview({
      comfyUrl: runtimeContext.comfyUrl,
      imageData: body?.imageData,
      resolution: body?.resolution,
    });
    sendJson(res, 200, { previewDataUrl });
  } catch (error) {
    sendError(
      res,
      Number.isInteger(error?.status) ? error.status : 500,
      error instanceof Error ? error.message : "Unable to extract pose skeleton.",
      error?.code || "POSE_PREVIEW_ERROR",
    );
  }
}

function hermesMode(value) {
  const mode = String(value || "t2v").trim().toLowerCase();
  if (mode === "replace") return "i2v";
  if (["t2v", "i2v", "fl2v", "l2v", "ref2v"].includes(mode)) return mode;
  throw Object.assign(new Error(`Unsupported Hermes prompt mode: ${mode}.`), { status: 400, code: "HERMES_MODE_INVALID" });
}

async function handleHermesRoute({ req, res, pathname, readJson, sendJson, sendError }) {
  try {
    if (pathname === "/api/hermes/status") {
      if (req.method !== "GET") {
        sendError(res, 405, "Hermes status accepts GET requests only.", "METHOD_NOT_ALLOWED");
        return true;
      }
      sendJson(res, 200, await hermesPromptClient.status());
      return true;
    }

    if (req.method !== "POST") {
      sendError(res, 405, "Hermes prompt endpoints accept POST requests only.", "METHOD_NOT_ALLOWED");
      return true;
    }
    const body = await readJson(req);
    if (pathname === "/api/hermes/plan") {
      sendJson(res, 200, await hermesWorkflowPlanner.plan({ brief: body?.brief, assets: body?.assets }));
      return true;
    }
    if (pathname === "/api/hermes/prompt") {
      const mode = hermesMode(body?.mode);
      const duration = Number(body?.duration);
      const images = Array.isArray(body?.images) ? body.images.slice(0, 9) : [];
      const skillHint = String(body?.skill || "auto").trim();
      const system = [
        `Use the installed "${hermesPromptClient.skillName}" skill for H3 prompt-writing guidance.`,
        skillHint && skillHint !== "auto" ? `Prompt specialty requested by the workflow: ${skillHint}.` : "",
        buildH3PromptSystem({ mode, duration, hasVisualReference: images.length > 0 }),
      ].filter(Boolean).join("\n\n");
      const prompt = await hermesPromptClient.complete({
        system,
        prompt: String(body?.brief || "").trim(),
        visualInputs: images,
        model: String(body?.model || "").trim(),
      });
      const validated = validateH3Prompt(prompt, { mode, duration });
      sendJson(res, 200, {
        provider: "hermes",
        model: String(body?.model || hermesPromptClient.model || "hermes-agent"),
        prompt: validated.prompt,
        negativePrompt: String(body?.negativePrompt || "").trim() || HERMES_DEFAULT_NEGATIVE_PROMPT,
      });
      return true;
    }
    sendError(res, 404, "Hermes endpoint not found.", "NOT_FOUND");
    return true;
  } catch (error) {
    sendError(
      res,
      Number.isInteger(error?.status) ? error.status : 500,
      error instanceof Error ? error.message : "Hermes request failed.",
      error?.code || "HERMES_ERROR",
      error?.details,
    );
    return true;
  }
}

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
      name: "hermes",
      matches: ({ pathname }) => pathname === "/api/hermes/status" || pathname === "/api/hermes/prompt" || pathname === "/api/hermes/plan",
      handle: ({ req, res, pathname, readJson, sendJson, sendError }) => handleHermesRoute({ req, res, pathname, readJson, sendJson, sendError }),
    },
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
      name: "pose-preview",
      matches: ({ pathname }) => pathname === "/api/img2img/pose-preview",
      handle: ({ req, res, readJson, sendJson, sendError }) => {
        if (req.method !== "POST") {
          sendError(res, 405, "Pose preview accepts POST requests only.", "METHOD_NOT_ALLOWED");
          return true;
        }
        return withAssetLifecycleLock(() => withRuntimeOperation(() => handlePosePreviewRoute({
          req,
          res,
          readJson,
          sendJson,
          sendError,
          runtimeContext,
        })));
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
