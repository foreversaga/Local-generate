import { normalizeH3Mode, REF2VA_FIELDS, T2VA_FIELDS } from "./validator.mjs";

function durationText(value) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? duration.toFixed(2) : "<DURATION_SECONDS>";
}

function modeLabel(mode) {
  return mode === "ref2v" ? "Ref2VA" : `${mode.toUpperCase()}A`;
}

function alignmentRules(mode, duration) {
  const seconds = durationText(duration);
  if (mode === "i2v") {
    return [
      "The first line must be exactly: For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.",
      "Follow that line with exactly one blank line, then the three core fields.",
    ];
  }
  if (mode === "fl2v") {
    return [
      `The first line must be exactly: How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot <FINAL_SHOT>) aligns with the ${seconds}-second mark of the target video.`,
      "Replace <FINAL_SHOT> with the actual final numeric shot; never emit a placeholder or literal Shot N.",
      "Follow that line with exactly one blank line, then the three core fields.",
    ];
  }
  if (mode === "l2v") {
    return [
      `The first line must be exactly: How the reference pictures align with the target video — <Picture 1> (from [Shot <FINAL_SHOT>]) aligns with the ${seconds}-second mark of the target video.`,
      "Replace <FINAL_SHOT> with the actual final numeric shot; never emit a placeholder or literal Shot N.",
      "Follow that line with exactly one blank line, then the three core fields.",
    ];
  }
  return [];
}

const CORE_RULES = [
  "Use English for rewrite sections. Preserve the user's original language inside dialogue, lyrics, and visible scene text.",
  "Use [Shot 1] for the opening shot. Later shots must be numbered sequentially and start with At MM:SS.mmm, followed by a cut or transition description.",
  "Shot 1 has no timestamp. Later shot timestamps must be strictly increasing and remain within the requested duration.",
  "Write camera movement as natural prose: include a motion type (such as Push In, Pan Left, Tracking Shot, Static Shot), and add amplitude (with small amplitude / with large amplitude) and speed (at slow speed / at fast speed) when meaningful. Do not stack camera labels as a detached list.",
  "Give vocal sources stable IDs such as (S1) and (S2), reusing each ID across shots; use a compound ID such as (S1,S2) when numbered speakers vocalize together. Put only the language tag and exact spoken words inside <d>[Language] ...</d>; do not translate, invent, or paraphrase dialogue.",
  "For an off-screen voiceover, write says in an off-screen voiceover and immediately state that the corresponding on-screen character's lips remain completely closed.",
  "Use <scenetrans> when the same dialogue or lyric continues across a cut, and <cutoff> when speech is truncated by the video ending; state the audible continuity in prose.",
  "Put visible banners, signs, labels, subtitles, and neon text in English double quotation marks while preserving the original text and punctuation verbatim.",
  "Keep diegetic dialogue, singing, instruments, radio, television, and physical sounds in the integrated/detailed description. Use overall_soundscape only for ambience, physical action sounds, and non-verbal human sounds. Use non_diegetic_music only for audience-only background music; use N/A when absent.",
  "Conditional identity-consistency rule: when a human or human-like character clearly appears more than once, establish a stable visual identity block at the first clear appearance using only traits stated by the user or visibly supplied by a reference; never invent unseen identity details.",
  "For every later shot in which that character's face is visible, briefly restate the same identity anchors with consistent wording: face shape, eye spacing/eye shape, brows, nose, mouth, skin tone, hairstyle silhouette, clothing, body silhouette, and distinctive marks. Keep this concise and do not require every task to be front-facing or closed-mouth; preserve the user's requested pose, expression, and action.",
  "Unless the user explicitly requests it, a transition, MG, warping, compression, inversion, overlay, or similar graphic/camera effect must not reset, obscure, reconstruct, or distort the character's face or identity. Describe the effect around a preserved face and stable identity instead.",
  "Return only the requested fields and their content. Do not add Markdown fences, commentary, or extra top-level fields.",
];

/**
 * Build the complete system contract sent to a local prompt-writing model.
 * It is self-contained: the model is not told to read a local skill or file.
 */
export function buildH3PromptSystem({ mode = "t2v", duration, hasVisualReference = false } = {}) {
  const normalizedMode = normalizeH3Mode(mode);
  const fields = normalizedMode === "ref2v" ? REF2VA_FIELDS : T2VA_FIELDS;
  const visualRule = hasVisualReference
    ? "Visual references are supplied by the caller. Anchor only visible, supplied reference content and preserve its identity, composition, and spatial relationships without inventing unseen details."
    : "No visual reference is available. Construct the visual timeline from the user's text and do not claim to have inspected an image or video.";
  const sections = [
    `You are an H3 prompt formatter for ${modeLabel(normalizedMode)}. Return one production-ready prompt only.`,
    `Target mode: ${normalizedMode}. Target duration: ${durationText(duration)} seconds.`,
    visualRule,
    `Required top-level fields, in this exact order: ${fields.join(", ")}.`,
  ];
  if (normalizedMode === "ref2v") {
    sections.push(
      "Ref2VA subject_definitions must define every <Subject N>, <Picture N>, <Video N>, and <Audio N> label on its own definition line before any later section uses that label.",
      "Ref2VA summary must begin with a bracketed task prefix using only keyframe completion, reference generation, video editing, video continuation, audio reuse, and audio reference joined by + when needed.",
      "Ref2VA retention_analysis must state how each defined reference is fully_preserved, partially_preserved, attribute_transfer, weak_reference, fully_copy, partially_copy, or reference, according to its role; for identity attributes, put fully_preserved or the appropriate marker explicitly next to those attributes.",
      "Ref2VA detailed_description is the playback-order visual and audio body and must contain [Shot 1].",
    );
  } else {
    sections.push("integrated_multimodal_description is the audiovisual timeline; it must contain [Shot 1].");
  }
  sections.push(...alignmentRules(normalizedMode, duration));
  sections.push("Contract rules:", ...CORE_RULES);
  return sections.join("\n");
}

export const buildH3SystemInstruction = buildH3PromptSystem;
