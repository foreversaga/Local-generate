const COMMON_H3_NODES = Object.freeze([
  "UNETLoader", "CLIPLoader", "VAELoader", "RandomNoise", "KSamplerSelect",
  "BasicScheduler", "BasicGuider", "SamplerCustomAdvanced", "VAEDecode",
  "VAEDecodeAudio", "CreateVideo", "SaveVideo",
]);

const WAN_ANIMATE_NODES = Object.freeze([
  "UNETLoader", "CLIPLoader", "VAELoader", "CLIPVisionLoader", "CLIPVisionEncode",
  "LoadVideo", "GetVideoComponents", "ImageScale", "LoadImage", "ImageToMask",
  "DrawMaskOnImage", "CLIPTextEncode", "DWPreprocessor", "LoraLoaderModelOnly",
  "ModelSamplingSD3", "WanAnimateToVideo", "KSampler", "TrimVideoLatent",
  "VAEDecode", "ImageFromBatch", "CreateVideo", "SaveVideo",
]);

export const ALPHA_T1_FAST_PROFILE = "alpha_t1_fast";
export const ALPHA_T1_MODEL = "minimax_h3_fl2va_pruned_int8_convrot.safetensors";
export const ALPHA_T1_CLIP = "qwen3vl-32B-MiniMax-H3-Q4_K_M.gguf";
export const ALPHA_T1_TURBO_LORA = "minimax_h3_fl2v_lightx2v_turbo_4step_v1.0_768p_resized_avg_rank_31_bf16.safetensors";
const ALPHA_T1_NODES = Object.freeze([
  ...COMMON_H3_NODES.filter((name) => name !== "CLIPLoader"),
  "MiniMaxH3ImageToVideo",
  "LoraLoaderModelOnly",
  "MiniMaxH3FusedModulation",
  "MiniMaxH3MemoryEfficientSolAttentionPatch",
  "CLIPLoaderGGUF",
]);

export const SINGLE_VIDEO_PROFILE_MODELS = Object.freeze({
  nvfp4_blackwell: "minimax_h3_fl2va_pruned_nvfp4.safetensors",
  int8_convrot_quality: "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
  ref2va_pruned_nvfp4: "minimax_h3_ref2va_pruned_nvfp4.safetensors",
  ref2va_pruned_int8_convrot: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
  wan22_animate_fp8: "Wan2_2-Animate-14B_fp8_e4m3fn_scaled_KJ.safetensors",
});

function comboValues(objectInfo, nodeName, inputName) {
  const definition = objectInfo?.[nodeName]?.input?.required?.[inputName];
  const options = Array.isArray(definition?.[1]?.options)
    ? definition[1].options
    : Array.isArray(definition?.[0])
      ? definition[0]
      : [];
  return options.map((item) => String(item));
}

function comboValuesAny(objectInfo, nodeName, inputNames) {
  for (const inputName of inputNames) {
    const values = comboValues(objectInfo, nodeName, inputName);
    if (values.length) return values;
  }
  return [];
}

function missingNodes(objectInfo, required) {
  return required.filter((name) => !objectInfo?.[name]);
}

export function inspectSingleVideoReadiness(objectInfo, { comfyOnline = Boolean(objectInfo), lastFrame = true } = {}) {
  const modelNames = new Set(comboValues(objectInfo, "UNETLoader", "unet_name"));
  const profiles = Object.fromEntries(Object.entries(SINGLE_VIDEO_PROFILE_MODELS).map(([id, model]) => {
    const required = id === "wan22_animate_fp8"
      ? WAN_ANIMATE_NODES
      : [...COMMON_H3_NODES, id.startsWith("ref2va_") ? "MiniMaxH3ReferenceToVideo" : "MiniMaxH3ImageToVideo"];
    const nodes = missingNodes(objectInfo, required);
    const missingModels = modelNames.has(model) ? [] : [model];
    const available = comfyOnline && nodes.length === 0 && missingModels.length === 0;
    return [id, { available, model, missingNodes: nodes, missingModels }];
  }));

  const modeProfiles = {
    t2v: ["nvfp4_blackwell", "int8_convrot_quality"],
    i2v: ["nvfp4_blackwell", "int8_convrot_quality"],
    fl2v: ["nvfp4_blackwell", "int8_convrot_quality"],
    l2v: ["nvfp4_blackwell", "int8_convrot_quality"],
    ref2v: ["ref2va_pruned_nvfp4", "ref2va_pruned_int8_convrot"],
    ref2v_motion: ["ref2va_pruned_nvfp4", "ref2va_pruned_int8_convrot"],
    replace: ["wan22_animate_fp8"],
  };
  const modes = Object.fromEntries(Object.entries(modeProfiles).map(([id, profileIds]) => {
    const needsLastFrame = id === "fl2v" || id === "l2v";
    const availableProfiles = profileIds.filter((profile) => profiles[profile]?.available);
    const available = comfyOnline && (!needsLastFrame || lastFrame) && availableProfiles.length > 0;
    const reason = !comfyOnline
      ? "ComfyUI 未連線"
      : needsLastFrame && !lastFrame
        ? "目前生成器不支援尾幀輸入"
        : availableProfiles.length === 0
          ? "所需節點或模型尚未就緒"
          : "";
    return [id, { available, profiles: profileIds, availableProfiles, reason }];
  }));

  const alphaMissingNodes = missingNodes(objectInfo, ALPHA_T1_NODES);
  const alphaModelNames = new Set(comboValues(objectInfo, "UNETLoader", "unet_name"));
  const alphaLoraNames = new Set(comboValuesAny(objectInfo, "LoraLoaderModelOnly", ["lora_name", "lora_name1"]));
  const alphaClipNames = new Set(comboValues(objectInfo, "CLIPLoaderGGUF", "clip_name"));
  const alphaSchedulers = new Set(comboValues(objectInfo, "BasicScheduler", "scheduler"));
  const alphaMissingModels = [
    ...(alphaModelNames.has(ALPHA_T1_MODEL) ? [] : [ALPHA_T1_MODEL]),
    ...(alphaClipNames.has(ALPHA_T1_CLIP) ? [] : [ALPHA_T1_CLIP]),
    ...(alphaLoraNames.has(ALPHA_T1_TURBO_LORA) ? [] : [ALPHA_T1_TURBO_LORA]),
  ];
  const alphaMissingComponents = alphaSchedulers.has("bong_tangent") ? [] : ["BasicScheduler:bong_tangent"];
  const alphaAvailable = comfyOnline
    && alphaMissingNodes.length === 0
    && alphaMissingModels.length === 0
    && alphaMissingComponents.length === 0;
  const accelerations = {
    [ALPHA_T1_FAST_PROFILE]: {
      available: alphaAvailable,
      mode: "i2v",
      modelProfile: "int8_convrot_quality",
      model: ALPHA_T1_MODEL,
      defaults: { width: 704, height: 384, duration: 7, steps: 12 },
      missingNodes: alphaMissingNodes,
      missingModels: alphaMissingModels,
      missingComponents: alphaMissingComponents,
      reason: !comfyOnline
        ? "ComfyUI 未連線"
        : alphaMissingNodes.length || alphaMissingModels.length || alphaMissingComponents.length
          ? "ALPHA-T1 所需節點、模型或 scheduler 尚未就緒"
          : "",
    },
  };

  return {
    ready: Object.values(modes).some((item) => item.available),
    comfyUi: comfyOnline,
    generator: { lastFrame },
    modes,
    profiles,
    accelerations,
  };
}
