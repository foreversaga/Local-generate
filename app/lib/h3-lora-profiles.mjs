export const H3_REALISM_PEOPLE_LORA_NAME = "h3-realism-people-t2v-i2v-r2v.safetensors";
export const H3_TURBO_V4_LORA_NAME = "minimax_h3_turbo_v4_step600_ema.safetensors";

export const H3_LORA_PROFILES = Object.freeze([
  Object.freeze({ value: H3_REALISM_PEOPLE_LORA_NAME, label: "H3 Realism People", kind: "standard", trigger: "r34l1sm", defaultStrength: 0.8, modes: Object.freeze(["t2v", "i2v", "fl2v", "l2v", "ref2v"]) }),
  Object.freeze({ value: H3_TURBO_V4_LORA_NAME, label: "H3 Turbo v4 · step600 EMA", kind: "turbo", trigger: "", defaultStrength: 1, minSteps: 4, maxSteps: 8, suggestedSteps: 6, modes: Object.freeze(["t2v", "i2v", "fl2v", "l2v"]) }),
]);

const BY_VALUE = new Map(H3_LORA_PROFILES.map((profile) => [profile.value.toLowerCase(), profile]));
const ALIASES = new Map([
  ["h3-realism-people", H3_REALISM_PEOPLE_LORA_NAME], ["realism-people", H3_REALISM_PEOPLE_LORA_NAME], ["realism", H3_REALISM_PEOPLE_LORA_NAME],
  ["h3-turbo", H3_TURBO_V4_LORA_NAME], ["h3-turbo-v4", H3_TURBO_V4_LORA_NAME], ["turbo", H3_TURBO_V4_LORA_NAME],
]);

export function h3LoraProfile(value) {
  const normalized = String(value || "").trim().toLowerCase().replaceAll("_", "-").replaceAll(" ", "-");
  const canonical = ALIASES.get(normalized) || String(value || "").trim();
  return BY_VALUE.get(canonical.toLowerCase()) || null;
}

export function h3LoraOptionsForMode(mode) {
  return H3_LORA_PROFILES.filter((profile) => profile.modes.includes(mode));
}
