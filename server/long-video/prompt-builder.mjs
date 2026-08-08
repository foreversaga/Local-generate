const T2VA_FIELDS = ["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"];
const REF2VA_FIELDS = ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"];

function clean(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function bibleText(bible = {}) {
  const characters = Array.isArray(bible.characters)
    ? bible.characters.map((item) => `${item.id || "character"}: ${item.appearance || ""}; clothing: ${item.clothing || ""}`).join(" | ")
    : "";
  return [
    bible.visualStyle && `Visual style: ${bible.visualStyle}`,
    characters && `Characters: ${characters}`,
    bible.environment && `Environment: ${bible.environment}`,
    bible.lighting && `Lighting: ${bible.lighting}`,
    bible.camera && `Camera: ${bible.camera}`,
    bible.motionDirection && `Motion direction: ${bible.motionDirection}`,
    Array.isArray(bible.keyObjects) && bible.keyObjects.length ? `Key objects: ${bible.keyObjects.join(", ")}` : "",
    bible.sound && `Sound: ${bible.sound}`,
    bible.nonDiegeticMusic && `Music: ${bible.nonDiegeticMusic}`,
    Array.isArray(bible.mustPreserve) && bible.mustPreserve.length ? `Must preserve: ${bible.mustPreserve.join(", ")}` : "",
    Array.isArray(bible.mustAvoid) && bible.mustAvoid.length ? `Must avoid: ${bible.mustAvoid.join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

function description(segment, bible) {
  return [
    clean(segment.description || segment.scene || segment.brief),
    bibleText(bible),
    segment.continuityNote && `Continuity note: ${segment.continuityNote}`,
    segment.camera && `Camera: ${segment.camera}`,
    segment.action && `Action: ${segment.action}`,
  ].filter(Boolean).join("\n");
}

export function buildT2VAPrompt(segment, bible = {}) {
  return [
    `integrated_multimodal_description: ${description(segment, bible)}`,
    `overall_soundscape: ${clean(segment.overallSoundscape || bible.sound, "Natural diegetic sound")}`,
    `non_diegetic_music: ${clean(segment.nonDiegeticMusic || bible.nonDiegeticMusic, "N/A")}`,
  ].join("\n\n");
}

export function buildI2VAPrompt(segment, bible = {}, options = {}) {
  const shot = clean(options.shotId || segment.shotId, "Shot 1");
  const picture = clean(options.pictureLabel || segment.pictureLabel, "Picture 1");
  const firstLine = `For the target video, at 0.00 seconds into the target video, <${picture}> (from [${shot}]) is fully referenced.`;
  return [
    firstLine,
    "",
    `integrated_multimodal_description: ${description(segment, bible)}`,
    "",
    `overall_soundscape: ${clean(segment.overallSoundscape || bible.sound, "Natural diegetic sound")}`,
    "",
    `non_diegetic_music: ${clean(segment.nonDiegeticMusic || bible.nonDiegeticMusic, "N/A")}`,
  ].join("\n");
}

export function buildRef2VAPrompt(segment, bible = {}, references = {}) {
  const fields = {
    subject_definitions: clean(references.subjectDefinitions || segment.subjectDefinitions, "<Subject 1>: the principal subject."),
    summary: `[reference generation] ${clean(segment.summary || segment.description)}`,
    retention_analysis: clean(segment.retentionAnalysis, "fully_preserved: subject identity and composition; weak_reference: none"),
    detailed_description: description(segment, bible),
    overall_soundscape: clean(segment.overallSoundscape || bible.sound, "Natural diegetic sound"),
    non_diegetic_music: clean(segment.nonDiegeticMusic || bible.nonDiegeticMusic, "N/A"),
  };
  return REF2VA_FIELDS.map((field) => `${field}: ${fields[field]}`).join("\n\n");
}

export function buildSegmentPrompt(segment, bible = {}, options = {}) {
  const mode = options.mode || (options.firstFrame ? "i2v" : "t2v");
  if (mode === "i2v") return buildI2VAPrompt(segment, bible, options);
  if (mode === "ref2v") return buildRef2VAPrompt(segment, bible, options.references);
  return buildT2VAPrompt(segment, bible);
}

export { T2VA_FIELDS, REF2VA_FIELDS };
export const buildT2VPrompt = buildT2VAPrompt;
export const buildI2VPrompt = buildI2VAPrompt;
