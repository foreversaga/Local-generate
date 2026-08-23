from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(relative_path: str, old: str, new: str) -> None:
    path = ROOT / relative_path
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{relative_path}: expected one replacement target, found {count}\nTARGET:\n{old[:500]}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def append_once(relative_path: str, marker: str, content: str) -> None:
    path = ROOT / relative_path
    text = path.read_text(encoding="utf-8")
    if marker in text:
        return
    path.write_text(text.rstrip() + "\n\n" + content.strip() + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# server/video-upscale/seedvr2.mjs
# ---------------------------------------------------------------------------
replace_once(
    "server/video-upscale/seedvr2.mjs",
    '''export const SEEDVR2_DEFAULT_RESIZE_METHOD = "lanczos";
export const SEEDVR2_DEFAULT_COLOR_CORRECTION = "wavelet";

export const H3_LATENT_UPSCALER_NAME = "h3_clean_latent_upscaler_v1_mamad8.safetensors";''',
    '''export const SEEDVR2_DEFAULT_RESIZE_METHOD = "lanczos";
export const SEEDVR2_DEFAULT_COLOR_CORRECTION = "wavelet";
export const SEEDVR2_MIN_STEPS = 1;
export const SEEDVR2_MAX_STEPS = 20;
export const SEEDVR2_MIN_CFG = 0;
export const SEEDVR2_MAX_CFG = 20;
export const SEEDVR2_MIN_DENOISE = 0;
export const SEEDVR2_MAX_DENOISE = 1;
export const SEEDVR2_DEFAULT_STEPS = 1;
export const SEEDVR2_DEFAULT_CFG = 1;
export const SEEDVR2_DEFAULT_SAMPLER_NAME = "euler";
export const SEEDVR2_DEFAULT_SCHEDULER = "simple";
export const SEEDVR2_DEFAULT_DENOISE = 1;
export const SEEDVR2_SAMPLER_NAMES = Object.freeze([
  "euler",
  "euler_cfg_pp",
  "euler_ancestral",
  "euler_ancestral_cfg_pp",
  "heun",
  "heunpp2",
  "dpm_2",
  "dpm_2_ancestral",
  "lms",
  "dpm_fast",
  "dpm_adaptive",
  "dpmpp_2s_ancestral",
  "dpmpp_2s_ancestral_cfg_pp",
  "dpmpp_sde",
  "dpmpp_sde_gpu",
  "dpmpp_2m",
  "dpmpp_2m_cfg_pp",
  "dpmpp_2m_sde",
  "dpmpp_2m_sde_gpu",
  "dpmpp_3m_sde",
  "dpmpp_3m_sde_gpu",
  "ddpm",
  "lcm",
  "ipndm",
  "ipndm_v",
  "deis",
  "res_multistep",
  "res_multistep_cfg_pp",
  "gradient_estimation",
  "gradient_estimation_cfg_pp",
  "er_sde",
  "sa_solver",
  "sa_solver_pece",
]);
export const SEEDVR2_SCHEDULERS = Object.freeze([
  "normal",
  "karras",
  "exponential",
  "sgm_uniform",
  "simple",
  "ddim_uniform",
  "beta",
  "linear_quadratic",
  "kl_optimal",
]);

export const H3_LATENT_UPSCALER_NAME = "h3_clean_latent_upscaler_v1_mamad8.safetensors";''',
)

replace_once(
    "server/video-upscale/seedvr2.mjs",
    '''export function buildSeedVR2Prompt({
  sourceName,
  filenamePrefix = "seedvr2_upscaled",
  unetName = SEEDVR2_UNET_NAME,
  vaeName = SEEDVR2_VAE_NAME,
  seed,
  scale = SEEDVR2_DEFAULT_SCALE,
  resizeMethod = SEEDVR2_DEFAULT_RESIZE_METHOD,
  colorCorrection = SEEDVR2_DEFAULT_COLOR_CORRECTION,
} = {}) {
  const file = normalizeVideoAssetName(sourceName);
  const safePrefix = sanitizeFilenamePrefix(filenamePrefix);
  const samplerSeed = Number.isSafeInteger(seed) && seed >= 0 ? seed : Math.floor(Math.random() * 2_147_483_647);
  const settings = normalizeSeedVR2Settings({ scale, resizeMethod, colorCorrection });''',
    '''export function buildSeedVR2Prompt({
  sourceName,
  filenamePrefix = "seedvr2_upscaled",
  unetName = SEEDVR2_UNET_NAME,
  vaeName = SEEDVR2_VAE_NAME,
  seed,
  scale = SEEDVR2_DEFAULT_SCALE,
  resizeMethod = SEEDVR2_DEFAULT_RESIZE_METHOD,
  colorCorrection = SEEDVR2_DEFAULT_COLOR_CORRECTION,
  steps = SEEDVR2_DEFAULT_STEPS,
  cfg = SEEDVR2_DEFAULT_CFG,
  samplerName = SEEDVR2_DEFAULT_SAMPLER_NAME,
  scheduler = SEEDVR2_DEFAULT_SCHEDULER,
  denoise = SEEDVR2_DEFAULT_DENOISE,
} = {}) {
  const file = normalizeVideoAssetName(sourceName);
  const safePrefix = sanitizeFilenamePrefix(filenamePrefix);
  const samplerSeed = Number.isSafeInteger(seed) && seed >= 0 ? seed : Math.floor(Math.random() * 2_147_483_647);
  const settings = normalizeSeedVR2Settings({ scale, resizeMethod, colorCorrection, steps, cfg, samplerName, scheduler, denoise });''',
)

replace_once(
    "server/video-upscale/seedvr2.mjs",
    '''        model: link(7),
        seed: samplerSeed,
        steps: 1,
        cfg: 1,
        sampler_name: "euler",
        scheduler: "simple",
        positive: link(8, 0),
        negative: link(8, 1),
        latent_image: link(9),
        denoise: 1,''',
    '''        model: link(7),
        seed: samplerSeed,
        steps: settings.steps,
        cfg: settings.cfg,
        sampler_name: settings.samplerName,
        scheduler: settings.scheduler,
        positive: link(8, 0),
        negative: link(8, 1),
        latent_image: link(9),
        denoise: settings.denoise,''',
)

replace_once(
    "server/video-upscale/seedvr2.mjs",
    '''export function buildSeedVR2ImagePrompt({
  sourceName,
  filenamePrefix = "seedvr2_image_upscaled",
  unetName = SEEDVR2_UNET_NAME,
  vaeName = SEEDVR2_VAE_NAME,
  seed,
  scale = SEEDVR2_DEFAULT_SCALE,
  resizeMethod = SEEDVR2_DEFAULT_RESIZE_METHOD,
  colorCorrection = SEEDVR2_DEFAULT_COLOR_CORRECTION,
} = {}) {
  const file = normalizeUpscaleAssetName(sourceName);
  if (sourceKindFromName(file) !== "image") {
    throw makeError("SeedVR2 image upscale requires a PNG, JPEG, or WebP source.", 415, "SOURCE_KIND_INVALID");
  }
  const safePrefix = sanitizeFilenamePrefix(filenamePrefix);
  const samplerSeed = Number.isSafeInteger(seed) && seed >= 0 ? seed : Math.floor(Math.random() * 2_147_483_647);
  const settings = normalizeSeedVR2Settings({ scale, resizeMethod, colorCorrection });''',
    '''export function buildSeedVR2ImagePrompt({
  sourceName,
  filenamePrefix = "seedvr2_image_upscaled",
  unetName = SEEDVR2_UNET_NAME,
  vaeName = SEEDVR2_VAE_NAME,
  seed,
  scale = SEEDVR2_DEFAULT_SCALE,
  resizeMethod = SEEDVR2_DEFAULT_RESIZE_METHOD,
  colorCorrection = SEEDVR2_DEFAULT_COLOR_CORRECTION,
  steps = SEEDVR2_DEFAULT_STEPS,
  cfg = SEEDVR2_DEFAULT_CFG,
  samplerName = SEEDVR2_DEFAULT_SAMPLER_NAME,
  scheduler = SEEDVR2_DEFAULT_SCHEDULER,
  denoise = SEEDVR2_DEFAULT_DENOISE,
} = {}) {
  const file = normalizeUpscaleAssetName(sourceName);
  if (sourceKindFromName(file) !== "image") {
    throw makeError("SeedVR2 image upscale requires a PNG, JPEG, or WebP source.", 415, "SOURCE_KIND_INVALID");
  }
  const safePrefix = sanitizeFilenamePrefix(filenamePrefix);
  const samplerSeed = Number.isSafeInteger(seed) && seed >= 0 ? seed : Math.floor(Math.random() * 2_147_483_647);
  const settings = normalizeSeedVR2Settings({ scale, resizeMethod, colorCorrection, steps, cfg, samplerName, scheduler, denoise });''',
)

replace_once(
    "server/video-upscale/seedvr2.mjs",
    '''        model: link(6), seed: samplerSeed, steps: 1, cfg: 1, sampler_name: "euler", scheduler: "simple",
        positive: link(7, 0), negative: link(7, 1), latent_image: link(5), denoise: 1,''',
    '''        model: link(6), seed: samplerSeed, steps: settings.steps, cfg: settings.cfg, sampler_name: settings.samplerName, scheduler: settings.scheduler,
        positive: link(7, 0), negative: link(7, 1), latent_image: link(5), denoise: settings.denoise,''',
)

replace_once(
    "server/video-upscale/seedvr2.mjs",
    '''function normalizeSeedVR2Choice(value, choices, fallback, field, code) {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (!choices.includes(normalized)) throw makeError(`SeedVR2 ${field} is invalid.`, 400, code);
  return normalized;
}

export function normalizeSeedVR2Settings(input = {}, profile = SEEDVR2_PROFILE) {
  const normalizedProfile = normalizeProfile(profile);
  return {
    scale: normalizeSeedVR2Scale(input.scale, normalizedProfile),
    resizeMethod: normalizeSeedVR2Choice(input.resizeMethod, SEEDVR2_RESIZE_METHODS, SEEDVR2_DEFAULT_RESIZE_METHOD, "resize method", "RESIZE_METHOD_INVALID"),
    colorCorrection: normalizeSeedVR2Choice(input.colorCorrection, SEEDVR2_COLOR_CORRECTION_METHODS, SEEDVR2_DEFAULT_COLOR_CORRECTION, "color correction", "COLOR_CORRECTION_INVALID"),
  };
}''',
    '''function normalizeSeedVR2Choice(value, choices, fallback, field, code) {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (!choices.includes(normalized)) throw makeError(`SeedVR2 ${field} is invalid.`, 400, code);
  return normalized;
}

function normalizeSeedVR2Integer(value, fallback, min, max, field, code) {
  const normalized = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) {
    throw makeError(`SeedVR2 ${field} must be an integer between ${min} and ${max}.`, 400, code);
  }
  return normalized;
}

function normalizeSeedVR2Decimal(value, fallback, min, max, field, code) {
  const numeric = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isFinite(numeric) || numeric < min || numeric > max) {
    throw makeError(`SeedVR2 ${field} must be between ${min} and ${max}.`, 400, code);
  }
  return Math.round(numeric * 100) / 100;
}

function hasSeedVR2SamplingOverride(input = {}) {
  return ["steps", "cfg", "samplerName", "scheduler", "denoise"]
    .some((key) => Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined);
}

export function normalizeSeedVR2Settings(input = {}, profile = SEEDVR2_PROFILE) {
  const normalizedProfile = normalizeProfile(profile);
  const base = {
    scale: normalizeSeedVR2Scale(input.scale, normalizedProfile),
    resizeMethod: normalizeSeedVR2Choice(input.resizeMethod, SEEDVR2_RESIZE_METHODS, SEEDVR2_DEFAULT_RESIZE_METHOD, "resize method", "RESIZE_METHOD_INVALID"),
    colorCorrection: normalizeSeedVR2Choice(input.colorCorrection, SEEDVR2_COLOR_CORRECTION_METHODS, SEEDVR2_DEFAULT_COLOR_CORRECTION, "color correction", "COLOR_CORRECTION_INVALID"),
  };
  if (normalizedProfile === H3_LATENT_PROFILE) {
    if (hasSeedVR2SamplingOverride(input)) {
      throw makeError("SeedVR2 advanced sampling settings are not supported by MiniMax H3 Latent.", 400, "SEEDVR2_SETTINGS_UNSUPPORTED");
    }
    return base;
  }
  return {
    ...base,
    steps: normalizeSeedVR2Integer(input.steps, SEEDVR2_DEFAULT_STEPS, SEEDVR2_MIN_STEPS, SEEDVR2_MAX_STEPS, "steps", "STEPS_INVALID"),
    cfg: normalizeSeedVR2Decimal(input.cfg, SEEDVR2_DEFAULT_CFG, SEEDVR2_MIN_CFG, SEEDVR2_MAX_CFG, "cfg", "CFG_INVALID"),
    samplerName: normalizeSeedVR2Choice(input.samplerName, SEEDVR2_SAMPLER_NAMES, SEEDVR2_DEFAULT_SAMPLER_NAME, "sampler", "SAMPLER_INVALID"),
    scheduler: normalizeSeedVR2Choice(input.scheduler, SEEDVR2_SCHEDULERS, SEEDVR2_DEFAULT_SCHEDULER, "scheduler", "SCHEDULER_INVALID"),
    denoise: normalizeSeedVR2Decimal(input.denoise, SEEDVR2_DEFAULT_DENOISE, SEEDVR2_MIN_DENOISE, SEEDVR2_MAX_DENOISE, "denoise", "DENOISE_INVALID"),
  };
}''',
)

replace_once(
    "server/video-upscale/seedvr2.mjs",
    '''    seed: job.seed,
    resizeMethod: job.resizeMethod,
    colorCorrection: job.colorCorrection,
    prompt: cloneValue(job.prompt),''',
    '''    seed: job.seed,
    resizeMethod: job.resizeMethod,
    colorCorrection: job.colorCorrection,
    ...(job.profile === SEEDVR2_PROFILE ? {
      steps: job.steps ?? SEEDVR2_DEFAULT_STEPS,
      cfg: job.cfg ?? SEEDVR2_DEFAULT_CFG,
      samplerName: job.samplerName || SEEDVR2_DEFAULT_SAMPLER_NAME,
      scheduler: job.scheduler || SEEDVR2_DEFAULT_SCHEDULER,
      denoise: job.denoise ?? SEEDVR2_DEFAULT_DENOISE,
    } : {}),
    prompt: cloneValue(job.prompt),''',
)

replace_once(
    "server/video-upscale/seedvr2.mjs",
    '''          scale: job.scale,
          resizeMethod: job.resizeMethod,
          colorCorrection: job.colorCorrection,
        }) : buildSeedVR2Prompt({''',
    '''          scale: job.scale,
          resizeMethod: job.resizeMethod,
          colorCorrection: job.colorCorrection,
          steps: job.steps,
          cfg: job.cfg,
          samplerName: job.samplerName,
          scheduler: job.scheduler,
          denoise: job.denoise,
        }) : buildSeedVR2Prompt({''',
)

replace_once(
    "server/video-upscale/seedvr2.mjs",
    '''          scale: job.scale,
          resizeMethod: job.resizeMethod,
          colorCorrection: job.colorCorrection,
        });
      await updateJob(job, { prompt, progress: 20, stage: "Submitting ComfyUI workflow" });''',
    '''          scale: job.scale,
          resizeMethod: job.resizeMethod,
          colorCorrection: job.colorCorrection,
          steps: job.steps,
          cfg: job.cfg,
          samplerName: job.samplerName,
          scheduler: job.scheduler,
          denoise: job.denoise,
        });
      await updateJob(job, { prompt, progress: 20, stage: "Submitting ComfyUI workflow" });''',
)

replace_once(
    "server/video-upscale/seedvr2.mjs",
    '''    resizeMethod = SEEDVR2_DEFAULT_RESIZE_METHOD,
    colorCorrection = SEEDVR2_DEFAULT_COLOR_CORRECTION,
    attempt = 1,''',
    '''    resizeMethod = SEEDVR2_DEFAULT_RESIZE_METHOD,
    colorCorrection = SEEDVR2_DEFAULT_COLOR_CORRECTION,
    steps = SEEDVR2_DEFAULT_STEPS,
    cfg = SEEDVR2_DEFAULT_CFG,
    samplerName = SEEDVR2_DEFAULT_SAMPLER_NAME,
    scheduler = SEEDVR2_DEFAULT_SCHEDULER,
    denoise = SEEDVR2_DEFAULT_DENOISE,
    attempt = 1,''',
)

replace_once(
    "server/video-upscale/seedvr2.mjs",
    '''    const id = String(idFactory());
    const createdAt = isoNow(now());
    const request = {
      sourceName,
      sourceRoot,
      scale,
      profile,
      seed,
      resizeMethod,
      colorCorrection,
    };''',
    '''    const id = String(idFactory());
    const createdAt = isoNow(now());
    const sampling = profile === SEEDVR2_PROFILE ? { steps, cfg, samplerName, scheduler, denoise } : {};
    const request = {
      sourceName,
      sourceRoot,
      scale,
      profile,
      seed,
      resizeMethod,
      colorCorrection,
      ...sampling,
    };''',
)

replace_once(
    "server/video-upscale/seedvr2.mjs",
    '''      seed,
      resizeMethod,
      colorCorrection,
      prompt: null,''',
    '''      seed,
      resizeMethod,
      colorCorrection,
      ...sampling,
      prompt: null,''',
)

replace_once(
    "server/video-upscale/seedvr2.mjs",
    '''      seed: source.seed,
      resizeMethod: source.resizeMethod,
      colorCorrection: source.colorCorrection,
    };''',
    '''      seed: source.seed,
      resizeMethod: source.resizeMethod,
      colorCorrection: source.colorCorrection,
      ...(source.profile === SEEDVR2_PROFILE ? {
        steps: source.steps,
        cfg: source.cfg,
        samplerName: source.samplerName,
        scheduler: source.scheduler,
        denoise: source.denoise,
      } : {}),
    };''',
)

replace_once(
    "server/video-upscale/seedvr2.mjs",
    '''        const profile = normalizeProfile(body?.profile);
        const cleanName = normalizeUpscaleAssetName(body?.sourceName);
        const sourceKind = sourceKindFromName(cleanName);''',
    '''        const profile = normalizeProfile(body?.profile);
        normalizeSeedVR2Settings(body, profile);
        const cleanName = normalizeUpscaleAssetName(body?.sourceName);
        const sourceKind = sourceKindFromName(cleanName);''',
)


# ---------------------------------------------------------------------------
# server/video-upscale/seedvr2-store.mjs
# ---------------------------------------------------------------------------
replace_once(
    "server/video-upscale/seedvr2-store.mjs",
    '''const RESIZE_METHODS = new Set(["lanczos", "bicubic", "bilinear", "area", "nearest-exact"]);
const COLOR_CORRECTION_METHODS = new Set(["wavelet", "lab", "adain", "none"]);
const LEGACY_JSON_MIGRATION = "seedvr2-json-v1";''',
    '''const RESIZE_METHODS = new Set(["lanczos", "bicubic", "bilinear", "area", "nearest-exact"]);
const COLOR_CORRECTION_METHODS = new Set(["wavelet", "lab", "adain", "none"]);
const DEFAULT_STEPS = 1;
const DEFAULT_CFG = 1;
const DEFAULT_SAMPLER_NAME = "euler";
const DEFAULT_SCHEDULER = "simple";
const DEFAULT_DENOISE = 1;
const SAMPLER_NAMES = new Set([
  "euler", "euler_cfg_pp", "euler_ancestral", "euler_ancestral_cfg_pp", "heun", "heunpp2",
  "dpm_2", "dpm_2_ancestral", "lms", "dpm_fast", "dpm_adaptive", "dpmpp_2s_ancestral",
  "dpmpp_2s_ancestral_cfg_pp", "dpmpp_sde", "dpmpp_sde_gpu", "dpmpp_2m", "dpmpp_2m_cfg_pp",
  "dpmpp_2m_sde", "dpmpp_2m_sde_gpu", "dpmpp_3m_sde", "dpmpp_3m_sde_gpu", "ddpm", "lcm",
  "ipndm", "ipndm_v", "deis", "res_multistep", "res_multistep_cfg_pp", "gradient_estimation",
  "gradient_estimation_cfg_pp", "er_sde", "sa_solver", "sa_solver_pece",
]);
const SCHEDULERS = new Set(["normal", "karras", "exponential", "sgm_uniform", "simple", "ddim_uniform", "beta", "linear_quadratic", "kl_optimal"]);
const LEGACY_JSON_MIGRATION = "seedvr2-json-v1";''',
)

replace_once(
    "server/video-upscale/seedvr2-store.mjs",
    '''function safeChoice(value, choices, fallback) {
  const normalized = String(value || fallback).trim().toLowerCase();
  return choices.has(normalized) ? normalized : fallback;
}

function safePrompt(value, depth = 0) {''',
    '''function safeChoice(value, choices, fallback) {
  const normalized = String(value || fallback).trim().toLowerCase();
  return choices.has(normalized) ? normalized : fallback;
}

function safeSteps(value) {
  const steps = safeInteger(value, DEFAULT_STEPS);
  return steps >= 1 && steps <= 20 ? steps : DEFAULT_STEPS;
}

function safeRoundedNumber(value, fallback, min, max) {
  const numeric = safeNumber(value, fallback);
  if (numeric < min || numeric > max) return fallback;
  return Math.round(numeric * 100) / 100;
}

function safePrompt(value, depth = 0) {''',
)

replace_once(
    "server/video-upscale/seedvr2-store.mjs",
    '''function safeProvenance(value, job) {
  const source = value && typeof value === "object" ? value : {};
  const request = source.request && typeof source.request === "object" ? source.request : {};
  const requestSeed = safeInteger(request.seed ?? job.seed, 0);
  const profile = safeText(request.profile || job.profile, DEFAULT_PROFILE, 80);
  return {
    request: {
      sourceName: safeRelative(request.sourceName || job.sourceName),
      sourceRoot: request.sourceRoot === "output" ? "output" : "input",
      scale: safeScale(request.scale ?? job.scale, profile),
      profile,
      seed: requestSeed === null ? 0 : Math.max(0, Math.min(2_147_483_647, requestSeed)),
      resizeMethod: safeChoice(request.resizeMethod ?? job.resizeMethod, RESIZE_METHODS, DEFAULT_RESIZE_METHOD),
      colorCorrection: safeChoice(request.colorCorrection ?? job.colorCorrection, COLOR_CORRECTION_METHODS, DEFAULT_COLOR_CORRECTION),
    },''',
    '''function safeProvenance(value, job) {
  const source = value && typeof value === "object" ? value : {};
  const request = source.request && typeof source.request === "object" ? source.request : {};
  const requestSeed = safeInteger(request.seed ?? job.seed, 0);
  const profile = safeText(request.profile || job.profile, DEFAULT_PROFILE, 80);
  const sampling = profile === DEFAULT_PROFILE ? {
    steps: safeSteps(request.steps ?? job.steps),
    cfg: safeRoundedNumber(request.cfg ?? job.cfg, DEFAULT_CFG, 0, 20),
    samplerName: safeChoice(request.samplerName ?? job.samplerName, SAMPLER_NAMES, DEFAULT_SAMPLER_NAME),
    scheduler: safeChoice(request.scheduler ?? job.scheduler, SCHEDULERS, DEFAULT_SCHEDULER),
    denoise: safeRoundedNumber(request.denoise ?? job.denoise, DEFAULT_DENOISE, 0, 1),
  } : {};
  return {
    request: {
      sourceName: safeRelative(request.sourceName || job.sourceName),
      sourceRoot: request.sourceRoot === "output" ? "output" : "input",
      scale: safeScale(request.scale ?? job.scale, profile),
      profile,
      seed: requestSeed === null ? 0 : Math.max(0, Math.min(2_147_483_647, requestSeed)),
      resizeMethod: safeChoice(request.resizeMethod ?? job.resizeMethod, RESIZE_METHODS, DEFAULT_RESIZE_METHOD),
      colorCorrection: safeChoice(request.colorCorrection ?? job.colorCorrection, COLOR_CORRECTION_METHODS, DEFAULT_COLOR_CORRECTION),
      ...sampling,
    },''',
)

replace_once(
    "server/video-upscale/seedvr2-store.mjs",
    '''  const seed = safeInteger(input.seed ?? input.provenance?.request?.seed, 0);
  const profile = safeText(input.profile, DEFAULT_PROFILE, 80);
  const job = {''',
    '''  const seed = safeInteger(input.seed ?? input.provenance?.request?.seed, 0);
  const profile = safeText(input.profile, DEFAULT_PROFILE, 80);
  const sampling = profile === DEFAULT_PROFILE ? {
    steps: safeSteps(input.steps ?? input.provenance?.request?.steps),
    cfg: safeRoundedNumber(input.cfg ?? input.provenance?.request?.cfg, DEFAULT_CFG, 0, 20),
    samplerName: safeChoice(input.samplerName ?? input.provenance?.request?.samplerName, SAMPLER_NAMES, DEFAULT_SAMPLER_NAME),
    scheduler: safeChoice(input.scheduler ?? input.provenance?.request?.scheduler, SCHEDULERS, DEFAULT_SCHEDULER),
    denoise: safeRoundedNumber(input.denoise ?? input.provenance?.request?.denoise, DEFAULT_DENOISE, 0, 1),
  } : {};
  const job = {''',
)

replace_once(
    "server/video-upscale/seedvr2-store.mjs",
    '''    resizeMethod: safeChoice(input.resizeMethod ?? input.provenance?.request?.resizeMethod, RESIZE_METHODS, DEFAULT_RESIZE_METHOD),
    colorCorrection: safeChoice(input.colorCorrection ?? input.provenance?.request?.colorCorrection, COLOR_CORRECTION_METHODS, DEFAULT_COLOR_CORRECTION),
    prompt: safePrompt(input.prompt),''',
    '''    resizeMethod: safeChoice(input.resizeMethod ?? input.provenance?.request?.resizeMethod, RESIZE_METHODS, DEFAULT_RESIZE_METHOD),
    colorCorrection: safeChoice(input.colorCorrection ?? input.provenance?.request?.colorCorrection, COLOR_CORRECTION_METHODS, DEFAULT_COLOR_CORRECTION),
    ...sampling,
    prompt: safePrompt(input.prompt),''',
)


# ---------------------------------------------------------------------------
# app/components/tools/upscale-client.ts
# ---------------------------------------------------------------------------
replace_once(
    "app/components/tools/upscale-client.ts",
    '''export const SEEDVR2_COLOR_CORRECTIONS = [
    { id: "wavelet", label: "Wavelet（保留高頻細節）" },
    { id: "lab", label: "LAB（色彩最貼近原圖）" },
    { id: "adain", label: "AdaIN（快速全域校色）" },
    { id: "none", label: "不校色" },
] as const;

export type SeedVR2ResizeMethod = typeof SEEDVR2_RESIZE_METHODS[number]["id"];
export type SeedVR2ColorCorrection = typeof SEEDVR2_COLOR_CORRECTIONS[number]["id"];''',
    '''export const SEEDVR2_COLOR_CORRECTIONS = [
    { id: "wavelet", label: "Wavelet（保留高頻細節）" },
    { id: "lab", label: "LAB（色彩最貼近原圖）" },
    { id: "adain", label: "AdaIN（快速全域校色）" },
    { id: "none", label: "不校色" },
] as const;

export const SEEDVR2_SAMPLERS = [
    { id: "euler", label: "Euler（官方預設）" },
    { id: "euler_ancestral", label: "Euler Ancestral" },
    { id: "heun", label: "Heun" },
    { id: "dpmpp_2m", label: "DPM++ 2M" },
    { id: "dpmpp_2m_sde", label: "DPM++ 2M SDE" },
    { id: "dpmpp_3m_sde", label: "DPM++ 3M SDE" },
    { id: "res_multistep", label: "RES Multistep" },
] as const;

export const SEEDVR2_SCHEDULERS = [
    { id: "simple", label: "Simple（官方預設）" },
    { id: "normal", label: "Normal" },
    { id: "karras", label: "Karras" },
    { id: "exponential", label: "Exponential" },
    { id: "sgm_uniform", label: "SGM Uniform" },
    { id: "ddim_uniform", label: "DDIM Uniform" },
    { id: "beta", label: "Beta" },
] as const;

export const SEEDVR2_DEFAULT_SAMPLING = {
    steps: 1,
    cfg: 1,
    samplerName: "euler",
    scheduler: "simple",
    denoise: 1,
} as const;

export type SeedVR2ResizeMethod = typeof SEEDVR2_RESIZE_METHODS[number]["id"];
export type SeedVR2ColorCorrection = typeof SEEDVR2_COLOR_CORRECTIONS[number]["id"];
export type SeedVR2SamplerName = typeof SEEDVR2_SAMPLERS[number]["id"];
export type SeedVR2Scheduler = typeof SEEDVR2_SCHEDULERS[number]["id"];''',
)

replace_once(
    "app/components/tools/upscale-client.ts",
    '''export type SeedVR2Settings = {
    scale: number;
    seed?: number;
    resizeMethod: SeedVR2ResizeMethod;
    colorCorrection: SeedVR2ColorCorrection;
};''',
    '''export type SeedVR2Settings = {
    scale: number;
    seed?: number;
    resizeMethod: SeedVR2ResizeMethod;
    colorCorrection: SeedVR2ColorCorrection;
    steps?: number;
    cfg?: number;
    samplerName?: SeedVR2SamplerName;
    scheduler?: SeedVR2Scheduler;
    denoise?: number;
};''',
)

replace_once(
    "app/components/tools/upscale-client.ts",
    '''    resizeMethod?: SeedVR2ResizeMethod;
    colorCorrection?: SeedVR2ColorCorrection;
    prompt?: Record<string, unknown> | null;''',
    '''    resizeMethod?: SeedVR2ResizeMethod;
    colorCorrection?: SeedVR2ColorCorrection;
    steps?: number;
    cfg?: number;
    samplerName?: SeedVR2SamplerName;
    scheduler?: SeedVR2Scheduler;
    denoise?: number;
    prompt?: Record<string, unknown> | null;''',
)


# ---------------------------------------------------------------------------
# app/components/tools/UpscaleWorkspace.tsx
# ---------------------------------------------------------------------------
replace_once(
    "app/components/tools/UpscaleWorkspace.tsx",
    '''    SEEDVR2_RESIZE_METHODS,
    SEEDVR2_COLOR_CORRECTIONS,
    upscaleAssetHref,''',
    '''    SEEDVR2_RESIZE_METHODS,
    SEEDVR2_COLOR_CORRECTIONS,
    SEEDVR2_SAMPLERS,
    SEEDVR2_SCHEDULERS,
    SEEDVR2_DEFAULT_SAMPLING,
    upscaleAssetHref,''',
)

replace_once(
    "app/components/tools/UpscaleWorkspace.tsx",
    '''    type UpscaleProfile,
    type SeedVR2ResizeMethod,
    type SeedVR2ColorCorrection,
} from "./upscale-client";''',
    '''    type UpscaleProfile,
    type SeedVR2ResizeMethod,
    type SeedVR2ColorCorrection,
    type SeedVR2SamplerName,
    type SeedVR2Scheduler,
} from "./upscale-client";''',
)

replace_once(
    "app/components/tools/UpscaleWorkspace.tsx",
    '''    const { locale } = useI18n();''',
    '''    const { locale, t } = useI18n();''',
)

replace_once(
    "app/components/tools/UpscaleWorkspace.tsx",
    '''    const [seed, setSeed] = useState("");
    const [resizeMethod, setResizeMethod] = useState<SeedVR2ResizeMethod>("lanczos");
    const [colorCorrection, setColorCorrection] = useState<SeedVR2ColorCorrection>("wavelet");
    const [health, setHealth] = useState<UpscaleHealth | null>(null);''',
    '''    const [seed, setSeed] = useState("");
    const [resizeMethod, setResizeMethod] = useState<SeedVR2ResizeMethod>("lanczos");
    const [colorCorrection, setColorCorrection] = useState<SeedVR2ColorCorrection>("wavelet");
    const [steps, setSteps] = useState(String(SEEDVR2_DEFAULT_SAMPLING.steps));
    const [cfg, setCfg] = useState(String(SEEDVR2_DEFAULT_SAMPLING.cfg));
    const [samplerName, setSamplerName] = useState<SeedVR2SamplerName>(SEEDVR2_DEFAULT_SAMPLING.samplerName);
    const [scheduler, setScheduler] = useState<SeedVR2Scheduler>(SEEDVR2_DEFAULT_SAMPLING.scheduler);
    const [denoise, setDenoise] = useState(String(SEEDVR2_DEFAULT_SAMPLING.denoise));
    const [health, setHealth] = useState<UpscaleHealth | null>(null);''',
)

replace_once(
    "app/components/tools/UpscaleWorkspace.tsx",
    '''    const isSeedVR2 = profile === "seedvr2_7b_sharp_nvfp4";
    const activeScale = isSeedVR2 ? (scale || "—") : UPSCALE_SCALE;
''',
    '''    const isSeedVR2 = profile === "seedvr2_7b_sharp_nvfp4";
    const activeScale = isSeedVR2 ? (scale || "—") : UPSCALE_SCALE;
    const samplingIsDefault = steps.trim() !== ""
        && Number(steps) === SEEDVR2_DEFAULT_SAMPLING.steps
        && cfg.trim() !== ""
        && Number(cfg) === SEEDVR2_DEFAULT_SAMPLING.cfg
        && samplerName === SEEDVR2_DEFAULT_SAMPLING.samplerName
        && scheduler === SEEDVR2_DEFAULT_SAMPLING.scheduler
        && denoise.trim() !== ""
        && Number(denoise) === SEEDVR2_DEFAULT_SAMPLING.denoise;
''',
)

replace_once(
    "app/components/tools/UpscaleWorkspace.tsx",
    '''            const parsedSeed = seed.trim() === "" ? undefined : Number(seed);
            if (parsedSeed !== undefined && (!Number.isSafeInteger(parsedSeed) || parsedSeed < 0 || parsedSeed > 2_147_483_647)) {
                throw new Error("隨機種子必須是 0 到 2147483647 的整數，留空則每次隨機。");
            }
            const next = await submitUpscale(source, profile, {
                scale: isSeedVR2 ? parsedScale : UPSCALE_SCALE,
                seed: parsedSeed,
                resizeMethod,
                colorCorrection,
            });''',
    '''            const parsedSeed = seed.trim() === "" ? undefined : Number(seed);
            if (parsedSeed !== undefined && (!Number.isSafeInteger(parsedSeed) || parsedSeed < 0 || parsedSeed > 2_147_483_647)) {
                throw new Error("隨機種子必須是 0 到 2147483647 的整數，留空則每次隨機。");
            }
            let samplingSettings = {};
            if (isSeedVR2) {
                const parsedSteps = Number(steps);
                const parsedCfg = Number(cfg);
                const parsedDenoise = Number(denoise);
                if (steps.trim() === "" || !Number.isSafeInteger(parsedSteps) || parsedSteps < 1 || parsedSteps > 20) {
                    throw new Error(t("upscale.seedvr2.steps.error"));
                }
                if (cfg.trim() === "" || !Number.isFinite(parsedCfg) || parsedCfg < 0 || parsedCfg > 20) {
                    throw new Error(t("upscale.seedvr2.cfg.error"));
                }
                if (denoise.trim() === "" || !Number.isFinite(parsedDenoise) || parsedDenoise < 0 || parsedDenoise > 1) {
                    throw new Error(t("upscale.seedvr2.denoise.error"));
                }
                samplingSettings = {
                    steps: parsedSteps,
                    cfg: Math.round(parsedCfg * 100) / 100,
                    samplerName,
                    scheduler,
                    denoise: Math.round(parsedDenoise * 100) / 100,
                };
            }
            const next = await submitUpscale(source, profile, {
                scale: isSeedVR2 ? parsedScale : UPSCALE_SCALE,
                seed: parsedSeed,
                resizeMethod,
                colorCorrection,
                ...samplingSettings,
            });''',
)

replace_once(
    "app/components/tools/UpscaleWorkspace.tsx",
    '''    function handleProfileChange(event: ChangeEvent<HTMLSelectElement>) {
        if (active || busy) return;
        const next = event.target.value as UpscaleProfile;
        if (!UPSCALE_PROFILES.some((item) => item.id === next)) return;
        setProfile(next);
        setHealth(null);
        setHealthError("");
        setJob(null);
        setError("");
    }

    return (''',
    '''    function handleProfileChange(event: ChangeEvent<HTMLSelectElement>) {
        if (active || busy) return;
        const next = event.target.value as UpscaleProfile;
        if (!UPSCALE_PROFILES.some((item) => item.id === next)) return;
        setProfile(next);
        setHealth(null);
        setHealthError("");
        setJob(null);
        setError("");
    }

    function resetSeedVR2Sampling() {
        if (active || busy) return;
        setSteps(String(SEEDVR2_DEFAULT_SAMPLING.steps));
        setCfg(String(SEEDVR2_DEFAULT_SAMPLING.cfg));
        setSamplerName(SEEDVR2_DEFAULT_SAMPLING.samplerName);
        setScheduler(SEEDVR2_DEFAULT_SAMPLING.scheduler);
        setDenoise(String(SEEDVR2_DEFAULT_SAMPLING.denoise));
        setError("");
    }

    return (''',
)

replace_once(
    "app/components/tools/UpscaleWorkspace.tsx",
    '''                            <div className={styles.parameterHeading}>
                                <strong>SeedVR2 參數</strong>
                                <span>採樣器維持官方單步設定</span>
                            </div>''',
    '''                            <div className={styles.parameterHeading}>
                                <strong>SeedVR2 參數</strong>
                                <span>{t("upscale.seedvr2.defaultSampling")}</span>
                            </div>''',
)

replace_once(
    "app/components/tools/UpscaleWorkspace.tsx",
    '''                            </div>
                            <p className={styles.helper}>1–4× 可調；倍數越高會明顯增加統一記憶體用量與處理時間。</p>
                        </div>
                    )}''',
    '''                            </div>
                            <p className={styles.helper}>1–4× 可調；倍數越高會明顯增加統一記憶體用量與處理時間。</p>
                            <details className={styles.advancedSampling}>
                                <summary>
                                    <span>{t("upscale.seedvr2.advancedSampling")}</span>
                                    <small>1 / 1 / euler / simple / 1.0</small>
                                </summary>
                                <div className={styles.advancedSamplingBody}>
                                    <div className={styles.parameterGrid}>
                                        <label className={styles.profileField}>
                                            <span>{t("upscale.seedvr2.steps")}</span>
                                            <input type="number" min="1" max="20" step="1" value={steps} onChange={(event) => setSteps(event.target.value)} disabled={active || Boolean(busy)} />
                                        </label>
                                        <label className={styles.profileField}>
                                            <span>{t("upscale.seedvr2.cfg")}</span>
                                            <input type="number" min="0" max="20" step="0.05" value={cfg} onChange={(event) => setCfg(event.target.value)} disabled={active || Boolean(busy)} />
                                        </label>
                                        <label className={styles.profileField}>
                                            <span>{t("upscale.seedvr2.sampler")}</span>
                                            <select value={samplerName} onChange={(event) => setSamplerName(event.target.value as SeedVR2SamplerName)} disabled={active || Boolean(busy)}>
                                                {SEEDVR2_SAMPLERS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                                            </select>
                                        </label>
                                        <label className={styles.profileField}>
                                            <span>{t("upscale.seedvr2.scheduler")}</span>
                                            <select value={scheduler} onChange={(event) => setScheduler(event.target.value as SeedVR2Scheduler)} disabled={active || Boolean(busy)}>
                                                {SEEDVR2_SCHEDULERS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                                            </select>
                                        </label>
                                        <label className={styles.profileField}>
                                            <span>{t("upscale.seedvr2.denoise")}</span>
                                            <input type="number" min="0" max="1" step="0.05" value={denoise} onChange={(event) => setDenoise(event.target.value)} disabled={active || Boolean(busy)} />
                                        </label>
                                    </div>
                                    <div className={styles.advancedSamplingFooter}>
                                        <button type="button" className={styles.textButton} onClick={resetSeedVR2Sampling} disabled={active || Boolean(busy)}>{t("upscale.seedvr2.resetSampling")}</button>
                                        {!samplingIsDefault && <p className={styles.samplingWarning} role="status">{t("upscale.seedvr2.experimentalWarning")}</p>}
                                    </div>
                                </div>
                            </details>
                        </div>
                    )}''',
)


# ---------------------------------------------------------------------------
# app/components/tools/UpscaleWorkspace.module.css
# ---------------------------------------------------------------------------
append_once(
    "app/components/tools/UpscaleWorkspace.module.css",
    ".advancedSampling{",
    '''.advancedSampling{overflow:hidden;border-top:1px solid var(--line-soft);padding-top:10px}.advancedSampling summary{display:flex;min-height:38px;align-items:center;justify-content:space-between;gap:10px;color:var(--text);font-size:11px;font-weight:800;cursor:pointer;list-style:none}.advancedSampling summary::-webkit-details-marker{display:none}.advancedSampling summary::after{content:"+";margin-left:auto;color:var(--lime);font-size:16px}.advancedSampling[open] summary::after{content:"−"}.advancedSampling summary small{color:var(--muted-2);font-size:10px;font-weight:650}.advancedSamplingBody{display:grid;gap:11px;padding-top:11px}.advancedSamplingFooter{display:flex;align-items:center;justify-content:space-between;gap:10px}.samplingWarning{margin:0;color:var(--warning,var(--danger));font-size:10px;line-height:1.45;text-align:right}@media(max-width:460px){.advancedSampling summary{align-items:flex-start;flex-wrap:wrap}.advancedSamplingFooter{align-items:flex-start;flex-direction:column}.samplingWarning{text-align:left}}''',
)


# ---------------------------------------------------------------------------
# app/i18n/dictionaries.ts
# ---------------------------------------------------------------------------
replace_once(
    "app/i18n/dictionaries.ts",
    '''  "tools.upscale.title": "圖片與影片升頻",
  "tools.upscale.description": "使用 SeedVR2 7B Sharp NVFP4 將圖片或影片升頻 2×，影片另可選 MiniMax H3 Latent 2x。",
  "tools.text2img.title": "本機文字生圖",''',
    '''  "tools.upscale.title": "圖片與影片升頻",
  "tools.upscale.description": "使用 SeedVR2 7B Sharp NVFP4 將圖片或影片升頻 1–4×，影片另可選 MiniMax H3 Latent 2x。",
  "upscale.seedvr2.defaultSampling": "預設維持官方單步採樣",
  "upscale.seedvr2.advancedSampling": "進階採樣（實驗性）",
  "upscale.seedvr2.steps": "Steps",
  "upscale.seedvr2.cfg": "CFG",
  "upscale.seedvr2.sampler": "Sampler",
  "upscale.seedvr2.scheduler": "Scheduler",
  "upscale.seedvr2.denoise": "Denoise",
  "upscale.seedvr2.resetSampling": "重設採樣預設值",
  "upscale.seedvr2.experimentalWarning": "目前不是官方 1-step 預設；可能改變細節、穩定性、耗時與記憶體用量。",
  "upscale.seedvr2.steps.error": "Steps 必須是 1 到 20 的整數。",
  "upscale.seedvr2.cfg.error": "CFG 必須介於 0 到 20。",
  "upscale.seedvr2.denoise.error": "Denoise 必須介於 0 到 1。",
  "tools.text2img.title": "本機文字生圖",''',
)

replace_once(
    "app/i18n/dictionaries.ts",
    '''  "tools.upscale.title": "Image and video upscale", "tools.upscale.description": "Upscale images or videos by 2× with SeedVR2 7B Sharp NVFP4; videos can also use MiniMax H3 Latent 2x.",
  "tools.text2img.title": "Local Text to Image",''',
    '''  "tools.upscale.title": "Image and video upscale", "tools.upscale.description": "Upscale images or videos by 1–4× with SeedVR2 7B Sharp NVFP4; videos can also use MiniMax H3 Latent 2x.",
  "upscale.seedvr2.defaultSampling": "Defaults preserve the official one-step sampler",
  "upscale.seedvr2.advancedSampling": "Advanced sampling (experimental)",
  "upscale.seedvr2.steps": "Steps",
  "upscale.seedvr2.cfg": "CFG",
  "upscale.seedvr2.sampler": "Sampler",
  "upscale.seedvr2.scheduler": "Scheduler",
  "upscale.seedvr2.denoise": "Denoise",
  "upscale.seedvr2.resetSampling": "Reset sampling defaults",
  "upscale.seedvr2.experimentalWarning": "These are not the official one-step defaults and may change detail, stability, runtime, and memory use.",
  "upscale.seedvr2.steps.error": "Steps must be an integer from 1 to 20.",
  "upscale.seedvr2.cfg.error": "CFG must be between 0 and 20.",
  "upscale.seedvr2.denoise.error": "Denoise must be between 0 and 1.",
  "tools.text2img.title": "Local Text to Image",''',
)


# ---------------------------------------------------------------------------
# tests/video-upscale.test.mjs
# ---------------------------------------------------------------------------
append_once(
    "tests/video-upscale.test.mjs",
    'test("SeedVR2 advanced sampling overrides reach both KSampler graphs"',
    '''test("SeedVR2 advanced sampling overrides reach both KSampler graphs", () => {
  const settings = {
    steps: 7,
    cfg: 2.35,
    samplerName: "dpmpp_2m",
    scheduler: "karras",
    denoise: 0.65,
  };
  const video = buildSeedVR2Prompt({ sourceName: "clips/source.mp4", seed: 7, ...settings });
  const image = buildSeedVR2ImagePrompt({ sourceName: "images/source.png", seed: 9, ...settings });
  for (const sampler of [video["10"].inputs, image["8"].inputs]) {
    assert.equal(sampler.steps, 7);
    assert.equal(sampler.cfg, 2.35);
    assert.equal(sampler.sampler_name, "dpmpp_2m");
    assert.equal(sampler.scheduler, "karras");
    assert.equal(sampler.denoise, 0.65);
  }

  const defaults = buildSeedVR2Prompt({ sourceName: "clips/source.mp4", seed: 7 })["10"].inputs;
  assert.equal(defaults.steps, 1);
  assert.equal(defaults.cfg, 1);
  assert.equal(defaults.sampler_name, "euler");
  assert.equal(defaults.scheduler, "simple");
  assert.equal(defaults.denoise, 1);
});

test("SeedVR2 advanced sampling validation uses stable 400-series error codes", () => {
  assert.throws(() => normalizeSeedVR2Settings({ steps: 0 }), { code: "STEPS_INVALID", status: 400 });
  assert.throws(() => normalizeSeedVR2Settings({ steps: 1.5 }), { code: "STEPS_INVALID", status: 400 });
  assert.throws(() => normalizeSeedVR2Settings({ cfg: -0.01 }), { code: "CFG_INVALID", status: 400 });
  assert.throws(() => normalizeSeedVR2Settings({ cfg: 20.01 }), { code: "CFG_INVALID", status: 400 });
  assert.throws(() => normalizeSeedVR2Settings({ samplerName: "invented" }), { code: "SAMPLER_INVALID", status: 400 });
  assert.throws(() => normalizeSeedVR2Settings({ scheduler: "invented" }), { code: "SCHEDULER_INVALID", status: 400 });
  assert.throws(() => normalizeSeedVR2Settings({ denoise: -0.01 }), { code: "DENOISE_INVALID", status: 400 });
  assert.throws(() => normalizeSeedVR2Settings({ denoise: 1.01 }), { code: "DENOISE_INVALID", status: 400 });
  assert.deepEqual(normalizeSeedVR2Settings({ cfg: 1.234, denoise: 0.666 }), {
    scale: 2,
    resizeMethod: "lanczos",
    colorCorrection: "wavelet",
    steps: 1,
    cfg: 1.23,
    samplerName: "euler",
    scheduler: "simple",
    denoise: 0.67,
  });
  assert.throws(
    () => normalizeSeedVR2Settings({ scale: 2, steps: 2 }, H3_LATENT_PROFILE),
    { code: "SEEDVR2_SETTINGS_UNSUPPORTED", status: 400 },
  );
});''',
)


# ---------------------------------------------------------------------------
# tests/seedvr2-lifecycle.test.mjs
# ---------------------------------------------------------------------------
replace_once(
    "tests/seedvr2-lifecycle.test.mjs",
    '''  const queued = await value.controller.enqueue({ sourceName: "source.mp4", sourceRoot: "input", scale: 2.5, profile: SEEDVR2_PROFILE, seed: 42, resizeMethod: "bicubic", colorCorrection: "lab" });''',
    '''  const queued = await value.controller.enqueue({ sourceName: "source.mp4", sourceRoot: "input", scale: 2.5, profile: SEEDVR2_PROFILE, seed: 42, resizeMethod: "bicubic", colorCorrection: "lab", steps: 6, cfg: 2.25, samplerName: "dpmpp_2m", scheduler: "karras", denoise: 0.7 });''',
)

replace_once(
    "tests/seedvr2-lifecycle.test.mjs",
    '''  assert.equal(completed.colorCorrection, "lab");
  assert.equal(completed.prompt["3"].inputs["resize_type.multiplier"], 2.5);''',
    '''  assert.equal(completed.colorCorrection, "lab");
  assert.equal(completed.steps, 6);
  assert.equal(completed.cfg, 2.25);
  assert.equal(completed.samplerName, "dpmpp_2m");
  assert.equal(completed.scheduler, "karras");
  assert.equal(completed.denoise, 0.7);
  assert.equal(completed.prompt["3"].inputs["resize_type.multiplier"], 2.5);''',
)

replace_once(
    "tests/seedvr2-lifecycle.test.mjs",
    '''  assert.equal(completed.prompt["10"].inputs.seed, 42);
  assert.equal(completed.stage, "Completed");''',
    '''  assert.equal(completed.prompt["10"].inputs.seed, 42);
  assert.equal(completed.prompt["10"].inputs.steps, 6);
  assert.equal(completed.prompt["10"].inputs.cfg, 2.25);
  assert.equal(completed.prompt["10"].inputs.sampler_name, "dpmpp_2m");
  assert.equal(completed.prompt["10"].inputs.scheduler, "karras");
  assert.equal(completed.prompt["10"].inputs.denoise, 0.7);
  assert.equal(completed.stage, "Completed");''',
)

replace_once(
    "tests/seedvr2-lifecycle.test.mjs",
    '''  assert.equal(completed.provenance.request.colorCorrection, "lab");
  assert.equal(completed.provenance.attempt, 1);''',
    '''  assert.equal(completed.provenance.request.colorCorrection, "lab");
  assert.equal(completed.provenance.request.steps, 6);
  assert.equal(completed.provenance.request.cfg, 2.25);
  assert.equal(completed.provenance.request.samplerName, "dpmpp_2m");
  assert.equal(completed.provenance.request.scheduler, "karras");
  assert.equal(completed.provenance.request.denoise, 0.7);
  assert.equal(completed.provenance.attempt, 1);''',
)

replace_once(
    "tests/seedvr2-lifecycle.test.mjs",
    '''  const failed = await value.controller.enqueue({ sourceName: "source.mp4", sourceRoot: "input", scale: 3, profile: SEEDVR2_PROFILE, seed: 77, resizeMethod: "area", colorCorrection: "none" });''',
    '''  const failed = await value.controller.enqueue({ sourceName: "source.mp4", sourceRoot: "input", scale: 3, profile: SEEDVR2_PROFILE, seed: 77, resizeMethod: "area", colorCorrection: "none", steps: 4, cfg: 1.75, samplerName: "heun", scheduler: "normal", denoise: 0.8 });''',
)

replace_once(
    "tests/seedvr2-lifecycle.test.mjs",
    '''  assert.equal(retried.provenance.request.colorCorrection, "none");
  assert.equal(retried.scale, 3);''',
    '''  assert.equal(retried.provenance.request.colorCorrection, "none");
  assert.equal(retried.provenance.request.steps, 4);
  assert.equal(retried.provenance.request.cfg, 1.75);
  assert.equal(retried.provenance.request.samplerName, "heun");
  assert.equal(retried.provenance.request.scheduler, "normal");
  assert.equal(retried.provenance.request.denoise, 0.8);
  assert.equal(retried.scale, 3);''',
)

replace_once(
    "tests/seedvr2-lifecycle.test.mjs",
    '''  assert.equal(retried.colorCorrection, "none");
  assert.equal(retried.seed, 77);''',
    '''  assert.equal(retried.colorCorrection, "none");
  assert.equal(retried.steps, 4);
  assert.equal(retried.cfg, 1.75);
  assert.equal(retried.samplerName, "heun");
  assert.equal(retried.scheduler, "normal");
  assert.equal(retried.denoise, 0.8);
  assert.equal(retried.seed, 77);''',
)

append_once(
    "tests/seedvr2-lifecycle.test.mjs",
    'test("legacy SeedVR2 records backfill official advanced sampling defaults"',
    '''test("legacy SeedVR2 records backfill official advanced sampling defaults", () => {
  const job = canonicalSeedVR2Job({
    id: "legacy-sampling",
    sourceName: "source.mp4",
    profile: SEEDVR2_PROFILE,
    status: "completed",
    provenance: { request: { sourceName: "source.mp4", sourceRoot: "input", profile: SEEDVR2_PROFILE } },
  });
  assert.equal(job.steps, 1);
  assert.equal(job.cfg, 1);
  assert.equal(job.samplerName, "euler");
  assert.equal(job.scheduler, "simple");
  assert.equal(job.denoise, 1);
  assert.equal(job.provenance.request.steps, 1);
  assert.equal(job.provenance.request.cfg, 1);
  assert.equal(job.provenance.request.samplerName, "euler");
  assert.equal(job.provenance.request.scheduler, "simple");
  assert.equal(job.provenance.request.denoise, 1);
});''',
)


# ---------------------------------------------------------------------------
# tests/seedvr2-settings-ui.test.mjs
# ---------------------------------------------------------------------------
append_once(
    "tests/seedvr2-settings-ui.test.mjs",
    'test("SeedVR2 advanced sampling UI stays collapsed and preserves string editing state"',
    '''test("SeedVR2 advanced sampling UI stays collapsed and preserves string editing state", async () => {
  const [workspace, client] = await Promise.all([
    readFile(new URL("../app/components/tools/UpscaleWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/tools/upscale-client.ts", import.meta.url), "utf8"),
  ]);

  assert.match(workspace, /<details className=\{styles\.advancedSampling\}>/);
  assert.doesNotMatch(workspace, /<details className=\{styles\.advancedSampling\} open/);
  assert.match(workspace, /setSteps\(event\.target\.value\)/);
  assert.match(workspace, /setCfg\(event\.target\.value\)/);
  assert.match(workspace, /setDenoise\(event\.target\.value\)/);
  assert.doesNotMatch(workspace, /setSteps\(Number\(event\.target\.value\)\)/);
  assert.match(workspace, /resetSeedVR2Sampling/);
  assert.match(workspace, /!samplingIsDefault/);
  assert.match(workspace, /steps: parsedSteps/);
  assert.match(workspace, /cfg: Math\.round\(parsedCfg \* 100\) \/ 100/);
  assert.match(workspace, /samplerName,/);
  assert.match(workspace, /scheduler,/);
  assert.match(workspace, /denoise: Math\.round\(parsedDenoise \* 100\) \/ 100/);
  assert.match(client, /SEEDVR2_DEFAULT_SAMPLING/);
  assert.match(client, /steps\?: number/);
  assert.match(client, /samplerName\?: SeedVR2SamplerName/);
  assert.match(client, /scheduler\?: SeedVR2Scheduler/);
  assert.match(client, /denoise\?: number/);
});''',
)

print("SeedVR2 advanced sampling implementation staged successfully.")
