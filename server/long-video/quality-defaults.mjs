export const DEFAULT_NEGATIVE_PROMPT = [
  "blurry", "low quality", "flicker", "jitter",
  "facial identity drift", "inconsistent facial features", "face morphing", "facial feature drift", "deformed face", "asymmetrical eyes",
  "extra limbs", "incorrect finger count", "extra fingers", "missing fingers", "fused fingers", "malformed fingers", "unnatural finger articulation",
  "incorrect hand-object interaction", "broken grip",
  "costume drift", "clothing identity changes", "cloth clipping", "body-clothing intersection", "fabric penetration", "unnatural cloth deformation",
  "rigid fabric", "floating fabric", "inconsistent garment motion", "broken cloth physics",
  "unwanted random text", "logo", "watermark",
].join(", ");

/**
 * Keep the quality baseline active at the actual generation boundary while
 * preserving user- and segment-specific exclusions. Exact comma-delimited
 * duplicates are removed without rewriting the user's wording.
 */
export function mergeLongVideoNegativePrompt(...values) {
  const terms = [DEFAULT_NEGATIVE_PROMPT, ...values]
    .flatMap((value) => String(value || "").split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const seen = new Set();
  return terms.filter((term) => {
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(", ");
}
