const STANDARD_H3_MODES = Object.freeze(["t2v", "i2v", "fl2v", "l2v"]);
const REF2VA_MODES = Object.freeze(["ref2v", "ref2v_motion"]);

export const DEFAULT_VIDEO_MODEL_PROFILE = "nvfp4_blackwell";
export const DEFAULT_REF2VA_MODEL_PROFILE = "ref2va_pruned_nvfp4";

export const VIDEO_MODEL_PROFILES = Object.freeze([
  Object.freeze({ value: DEFAULT_VIDEO_MODEL_PROFILE, label: "NVFP4 Blackwell", note: "推薦 · 16GB VRAM", modes: STANDARD_H3_MODES, ref2vaProfile: DEFAULT_REF2VA_MODEL_PROFILE, longVideo: true }),
  Object.freeze({ value: "10eros_max_beta2_nvfp4", label: "10Eros-Max beta2 NVFP4", note: "12.53 GB · Blackwell", modes: STANDARD_H3_MODES, longVideo: true }),
  Object.freeze({ value: "int4_convrot_low_vram", label: "INT4 ConvRot", note: "低顯存 fallback", modes: STANDARD_H3_MODES, longVideo: true }),
  Object.freeze({ value: "official_pruned_int8_convrot", label: "Official INT8", note: "品質比較", modes: STANDARD_H3_MODES, ref2vaProfile: "ref2va_pruned_int8_convrot", longVideo: true }),
  Object.freeze({ value: DEFAULT_REF2VA_MODEL_PROFILE, label: "Ref2VA Pruned NVFP4", note: "12.5 GB · Blackwell", modes: REF2VA_MODES, longVideo: false }),
  Object.freeze({ value: "ref2va_pruned_int8_convrot", label: "Ref2VA Official INT8", note: "品質比較", modes: REF2VA_MODES, longVideo: false }),
  Object.freeze({ value: "wan22_animate_fp8", label: "Wan2.2 Animate", note: "影片替換模式", modes: Object.freeze(["replace"]), longVideo: false }),
]);

const PROFILE_BY_VALUE = new Map(VIDEO_MODEL_PROFILES.map((profile) => [profile.value, profile]));
const REF2VA_PROFILE_ALIASES = Object.freeze({
  nvfp4_blackwell: DEFAULT_REF2VA_MODEL_PROFILE,
  official_pruned_int8_convrot: "ref2va_pruned_int8_convrot",
});

export const LONG_VIDEO_MODEL_OPTIONS = Object.freeze(VIDEO_MODEL_PROFILES.filter((profile) => profile.longVideo));

export function videoModelOptionsForMode(mode) {
  return VIDEO_MODEL_PROFILES.filter((profile) => profile.modes.includes(mode));
}

export function videoModelProfile(value) {
  return PROFILE_BY_VALUE.get(String(value || "").trim()) || null;
}

export function videoModelSupportsMode(value, mode) {
  const profile = videoModelProfile(value);
  if (mode === "ref2v" && profile?.ref2vaProfile) return true;
  return profile?.modes.includes(mode) === true;
}

export function resolveVideoModelProfile(value, mode) {
  if (mode === "replace") return "wan22_animate_fp8";
  const requested = String(value || "").trim();
  if (mode === "ref2v") {
    const resolved = REF2VA_PROFILE_ALIASES[requested] || requested || DEFAULT_REF2VA_MODEL_PROFILE;
    return videoModelSupportsMode(resolved, mode) ? resolved : null;
  }
  const resolved = requested || DEFAULT_VIDEO_MODEL_PROFILE;
  return videoModelSupportsMode(resolved, mode) ? resolved : null;
}
