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

export const SINGLE_VIDEO_PROFILE_MODELS = Object.freeze({
  nvfp4_blackwell: "minimax_h3_fl2va_pruned_nvfp4.safetensors",
  int8_convrot_quality: "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
  ref2va_pruned_nvfp4: "minimax_h3_ref2va_pruned_nvfp4.safetensors",
  ref2va_pruned_int8_convrot: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
  wan22_animate_fp8: "Wan2_2-Animate-14B_fp8_e4m3fn_scaled_KJ.safetensors",
});

function comboValues(objectInfo, nodeName, inputName) {
  const value = objectInfo?.[nodeName]?.input?.required?.[inputName]?.[0];
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
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

  return {
    ready: Object.values(modes).some((item) => item.available),
    comfyUi: comfyOnline,
    generator: { lastFrame },
    modes,
    profiles,
  };
}
