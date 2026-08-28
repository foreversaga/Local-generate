export const MMH3_ULTIMATE_PROFILE = "h3_ultimate_tiled_2x";
export const MMH3_ULTIMATE_PROFILE_LABEL = "MiniMax H3 Ultimate Tiled 2× · 實驗";
export const MMH3_ULTIMATE_SCALE = 2;
export const MMH3_ULTIMATE_PASS1_STEPS = 25;
export const MMH3_ULTIMATE_PASS2_SIGMAS = "0.9864, 0.9740, 0.9587, 0.9400, 0.9158, 0.8845, 0.8406, 0.7774, 0.6744, 0.4856, 0.0000";
export const MMH3_ULTIMATE_PROMPT = "Use <Video 1> as the exact source for the subjects, motion, camera movement, composition, lighting, and pacing. Preserve <Audio 1> exactly. Reconstruct clean, natural fine detail at the larger canvas without changing the scene.";

export const MMH3_ULTIMATE_PRESET = Object.freeze({
  upscaleMethod: "bilinear",
  temporalChunkLength: 85,
  temporalOverlap: 17,
  anchorStrength: 0.999,
  tileWidth: 512,
  tileHeight: 512,
  spatialWidthOverlap: 128,
  spatialHeightOverlap: 128,
  fadeWidth: 32,
  fadeHeight: 32,
  minTileSize: 256,
  overlapMode: "earlier",
  overlapBlend: "linear",
});

export const MMH3_ULTIMATE_REQUIRED_NODES = Object.freeze([
  "LoadVideo",
  "GetVideoComponents",
  "ResizeImageMaskNode",
  "GetImageSize",
  "ComfyMathExpression",
  "UNETLoader",
  "CLIPLoader",
  "VAELoader",
  "MiniMaxH3ReferenceToVideo",
  "RandomNoise",
  "KSamplerSelect",
  "BasicScheduler",
  "BasicGuider",
  "SamplerCustomAdvanced",
  "MiniMaxH3ConditioningUpscale",
  "ManualSigmas",
  "MMH3LatentUpscaleParams",
  "MMH3TemporalSplitParams",
  "MMH3SpatialSplitParams",
  "MMH3UltimateUpscale",
  "VAEDecode",
  "VAEDecodeAudio",
  "CreateVideo",
  "SaveVideo",
]);

function comboValues(nodeInfo, inputName) {
  const spec = nodeInfo?.input?.required?.[inputName] || nodeInfo?.input?.optional?.[inputName];
  if (!Array.isArray(spec)) return [];
  if (Array.isArray(spec[0])) return spec[0].map(String);
  const options = spec[1]?.options;
  return Array.isArray(options) ? options.map(String) : [];
}

function link(node, output = 0) {
  return [String(node), output];
}

export function evaluateMMH3UltimateReadiness(objectInfo, {
  diffusionNames = [],
  encoderName = "",
  vaeName = "",
  audioVaeName = "",
  modelFiles = {},
  comfyUi = true,
} = {}) {
  const nodes = Object.fromEntries(MMH3_ULTIMATE_REQUIRED_NODES.map((name) => [name, Boolean(objectInfo?.[name])]));
  const diffusionOptions = comboValues(objectInfo?.UNETLoader, "unet_name");
  const encoderOptions = comboValues(objectInfo?.CLIPLoader, "clip_name");
  const vaeOptions = comboValues(objectInfo?.VAELoader, "vae_name");
  const diffusionFileMap = modelFiles.diffusion && typeof modelFiles.diffusion === "object"
    ? modelFiles.diffusion
    : {};
  const diffusionName = diffusionNames.find((name) => diffusionOptions.includes(name) && diffusionFileMap[name] !== false)
    || diffusionNames.find((name) => diffusionOptions.includes(name))
    || diffusionNames[0];
  const models = {
    diffusion: {
      name: diffusionName,
      available: Boolean(diffusionName)
        && diffusionOptions.includes(diffusionName)
        && (modelFiles.diffusion === undefined || Boolean(diffusionFileMap[diffusionName])),
    },
    encoder: {
      name: encoderName,
      available: encoderOptions.includes(encoderName) && (modelFiles.encoder === undefined || Boolean(modelFiles.encoder)),
    },
    videoVae: {
      name: vaeName,
      available: vaeOptions.includes(vaeName) && (modelFiles.videoVae === undefined || Boolean(modelFiles.videoVae)),
    },
    audioVae: {
      name: audioVaeName,
      available: vaeOptions.includes(audioVaeName) && (modelFiles.audioVae === undefined || Boolean(modelFiles.audioVae)),
    },
  };
  return {
    ready: Boolean(comfyUi) && Object.values(nodes).every(Boolean) && Object.values(models).every((model) => model.available),
    comfyUi: Boolean(comfyUi),
    models,
    nodes,
    preset: MMH3_ULTIMATE_PRESET,
  };
}

export function buildMMH3UltimatePrompt({
  sourceName,
  filenamePrefix = "h3ultimate/h3ultimate_upscaled",
  diffusionName,
  encoderName,
  vaeName,
  audioVaeName,
  promptText = MMH3_ULTIMATE_PROMPT,
  pass1Steps = MMH3_ULTIMATE_PASS1_STEPS,
  pass2Sigmas = MMH3_ULTIMATE_PASS2_SIGMAS,
  seed = 0,
  preset = MMH3_ULTIMATE_PRESET,
} = {}) {
  const samplerSeed = Number.isSafeInteger(seed) && seed >= 0 ? seed : 0;
  const pass2Seed = Number.isSafeInteger(samplerSeed + 1) ? samplerSeed + 1 : samplerSeed;
  return {
    "1": { class_type: "LoadVideo", inputs: { file: String(sourceName || "") } },
    "2": { class_type: "GetVideoComponents", inputs: { video: link(1) } },
    // Keep this experimental workflow self-contained: source frames are aligned
    // to the H3 grid here without changing any existing upscale profile.
    "3": {
      class_type: "ResizeImageMaskNode",
      inputs: {
        input: link(2, 0),
        resize_type: "scale to multiple",
        "resize_type.multiple": 16,
        scale_method: "area",
      },
    },
    "4": { class_type: "GetImageSize", inputs: { image: link(3) } },
    "5": { class_type: "UNETLoader", inputs: { unet_name: diffusionName, weight_dtype: "default" } },
    "6": { class_type: "CLIPLoader", inputs: { clip_name: encoderName, type: "minimax", device: "default" } },
    "7": { class_type: "VAELoader", inputs: { vae_name: vaeName } },
    "8": { class_type: "VAELoader", inputs: { vae_name: audioVaeName } },
    "9": {
      class_type: "MiniMaxH3ReferenceToVideo",
      inputs: {
        clip: link(6),
        vae: link(7),
        audio_vae: link(8),
        prompt: String(promptText || MMH3_ULTIMATE_PROMPT),
        width: link(4, 0),
        height: link(4, 1),
        length: link(4, 2),
        ref_image_size: "match",
        "ref_videos.ref_video_0": link(3),
        "ref_video_audios.ref_video_audio_0": link(2, 1),
      },
    },
    "10": { class_type: "RandomNoise", inputs: { noise_seed: samplerSeed } },
    "11": { class_type: "KSamplerSelect", inputs: { sampler_name: "res_multistep" } },
    "12": { class_type: "BasicScheduler", inputs: { model: link(5), scheduler: "simple", steps: pass1Steps, denoise: 1.0 } },
    "13": { class_type: "BasicGuider", inputs: { model: link(5), conditioning: link(9, 0) } },
    "14": {
      class_type: "SamplerCustomAdvanced",
      inputs: { noise: link(10), guider: link(13), sampler: link(11), sigmas: link(12), latent_image: link(9, 1) },
    },
    "15": {
      class_type: "MiniMaxH3ConditioningUpscale",
      inputs: { conditioning: link(9, 0), scale_by: MMH3_ULTIMATE_SCALE, upscale_method: preset.upscaleMethod },
    },
    "16": { class_type: "ComfyMathExpression", inputs: { expression: "a * 2", "values.a": link(4, 0) } },
    "17": { class_type: "ComfyMathExpression", inputs: { expression: "a * 2", "values.a": link(4, 1) } },
    "18": {
      class_type: "MMH3LatentUpscaleParams",
      inputs: { method: preset.upscaleMethod, width: link(16, 1), height: link(17, 1) },
    },
    "19": {
      class_type: "MMH3TemporalSplitParams",
      inputs: {
        chunk_length: preset.temporalChunkLength,
        temporal_overlap: preset.temporalOverlap,
        anchor_strength: preset.anchorStrength,
      },
    },
    "20": {
      class_type: "MMH3SpatialSplitParams",
      inputs: {
        tile_width: preset.tileWidth,
        tile_height: preset.tileHeight,
        spatial_w_overlap: preset.spatialWidthOverlap,
        spatial_h_overlap: preset.spatialHeightOverlap,
        fade_width: preset.fadeWidth,
        fade_height: preset.fadeHeight,
        min_tile_size: preset.minTileSize,
        overlap_mode: preset.overlapMode,
        overlap_blend: preset.overlapBlend,
      },
    },
    "21": { class_type: "RandomNoise", inputs: { noise_seed: pass2Seed } },
    "22": { class_type: "ManualSigmas", inputs: { sigmas: String(pass2Sigmas || MMH3_ULTIMATE_PASS2_SIGMAS) } },
    "23": {
      class_type: "MMH3UltimateUpscale",
      inputs: {
        model: link(5),
        conditioning: link(15),
        latent: link(14, 1),
        noise: link(21),
        sampler: link(11),
        sigmas: link(22),
        cfg: 1.0,
        latent_upscale_param: link(18),
        temporal_split_param: link(19),
        spatial_split_param: link(20),
      },
    },
    "24": { class_type: "VAEDecode", inputs: { samples: link(23), vae: link(7) } },
    "25": { class_type: "VAEDecodeAudio", inputs: { samples: link(23), vae: link(8) } },
    "26": { class_type: "CreateVideo", inputs: { images: link(24), fps: link(2, 2), audio: link(25) } },
    "27": {
      class_type: "SaveVideo",
      inputs: {
        video: link(26),
        filename_prefix: sanitizeOutputPrefix(filenamePrefix, "h3ultimate/h3ultimate_upscaled"),
        format: "mp4",
        codec: "h264",
        "codec.encoding": "re-encode",
        "codec.encoding.crf": 18,
      },
    },
  };
}

function sanitizeOutputPrefix(value, fallback) {
  const parts = String(value || fallback || "h3ultimate/h3ultimate_upscaled")
    .replaceAll("\\", "/")
    .split("/")
    .map((part) => part
      .replace(/[^A-Za-z0-9_.-]+/g, "_")
      .replace(/^\.+/, "")
      .slice(0, 120))
    .filter(Boolean);
  return parts.length ? parts.join("/") : "h3ultimate/h3ultimate_upscaled";
}
