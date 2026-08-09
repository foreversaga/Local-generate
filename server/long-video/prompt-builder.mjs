import { validateH3Prompt } from "../h3-prompt/validator.mjs";

const T2VA_FIELDS = ["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"];
const REF2VA_FIELDS = ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"];

function clean(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function identityField(value) {
  if (Array.isArray(value)) return value.map((item) => clean(item)).filter(Boolean).join(", ");
  return clean(value);
}

function characterDescriptor(character = {}) {
  const id = clean(character.id, "character");
  return [
    id,
    identityField(character.faceIdentity) && `face identity: ${identityField(character.faceIdentity)}`,
    identityField(character.hair) && `hair: ${identityField(character.hair)}`,
    identityField(character.silhouette) && `silhouette: ${identityField(character.silhouette)}`,
    identityField(character.palette) && `palette: ${identityField(character.palette)}`,
    identityField(character.distinctiveMarks) && `distinctive marks: ${identityField(character.distinctiveMarks)}`,
    identityField(character.appearance) && `appearance: ${identityField(character.appearance)}`,
    identityField(character.clothing) && `clothing: ${identityField(character.clothing)}`,
    identityField(character.voice) && `voice: ${identityField(character.voice)}`,
  ].filter(Boolean).join("; ");
}

function identityAnchors(bible = {}) {
  const characters = Array.isArray(bible.characters) ? bible.characters : [];
  const identityKeys = ["faceIdentity", "hair", "silhouette", "palette", "distinctiveMarks"];
  if (!characters.length || !characters.some((character) => identityKeys.some((key) => identityField(character?.[key])))) return "";
  return `Identity anchors (reuse unchanged for every visible appearance): ${characters.map(characterDescriptor).join(" | ")}`;
}

function appendIdentityAnchors(value, bible = {}) {
  const body = clean(value);
  const anchors = identityAnchors(bible);
  if (!anchors || body.includes(anchors)) return body;
  return [body, anchors].filter(Boolean).join("\n");
}

function bibleText(bible = {}) {
  const characters = Array.isArray(bible.characters)
    ? bible.characters.map((item) => `${item.id || "character"}: ${item.appearance || ""}; clothing: ${item.clothing || ""}`).join(" | ")
    : "";
  const anchors = identityAnchors(bible);
  return [
    bible.visualStyle && `Visual style: ${bible.visualStyle}`,
    characters && `Characters: ${characters}`,
    anchors,
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
    segment.endingState && `Ending state: ${segment.endingState}`,
    segment.endingState && identityAnchors(bible) && "If a face is visible at the ending state, preserve the same face identity, hair, silhouette, palette, and distinctive marks.",
  ].filter(Boolean).join("\n");
}

function stripFieldPrefix(value, field) {
  return clean(value).replace(new RegExp(`^${field}\\s*:\\s*`, "i"), "").trim();
}

const SHOT_MARKER_RE = /\[Shot\s+(\d+)\]/gi;
const SHOT_CUT_RE = /^\s*At\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?|\d+(?:\.\d+)?)\s*,/i;

function hasUsableShotStructure(value) {
  const text = clean(value);
  const markers = [...text.matchAll(SHOT_MARKER_RE)];
  if (!markers.length || Number(markers[0][1]) !== 1) return false;
  let previousTimestamp;
  for (let index = 0; index < markers.length; index += 1) {
    if (Number(markers[index][1]) !== index + 1) return false;
    const end = index + 1 < markers.length ? markers[index + 1].index : text.length;
    const afterMarker = text.slice(markers[index].index + markers[index][0].length, end);
    const cut = afterMarker.match(SHOT_CUT_RE);
    if (index === 0) {
      if (cut) return false;
      continue;
    }
    if (!cut) return false;
    const timestamp = parsePromptClock(cut[1]);
    if (!Number.isFinite(timestamp) || (previousTimestamp !== undefined && timestamp <= previousTimestamp)) return false;
    previousTimestamp = timestamp;
  }
  return true;
}

function parsePromptClock(value) {
  const text = String(value);
  if (!text.includes(":")) return Number(text);
  const parts = text.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part)) || parts.length < 2 || parts.length > 3) return NaN;
  return parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function shotBody(value, fallback) {
  const candidate = stripFieldPrefix(value, "integrated_multimodal_description") || stripFieldPrefix(value, "detailed_description");
  const candidateMarkers = [...candidate.matchAll(SHOT_MARKER_RE)];
  // Plain prose is safe to anchor at Shot 1 and retains the model's semantic
  // detail.  Only a present-but-malformed shot sequence is replaced by the
  // deterministic segment/bible description.
  const candidateIsUsable = Boolean(candidate) && (!candidateMarkers.length || hasUsableShotStructure(candidate));
  const source = candidateIsUsable ? candidate : clean(fallback);
  const withoutMarkers = source.replace(/\[Shot\s+\d+\]/gi, "").trim();
  const body = hasUsableShotStructure(source) ? source : withoutMarkers;
  return /^\[Shot\s+1\]/i.test(body) ? body : `[Shot 1] ${body || "The scene develops according to the supplied direction."}`;
}

function integratedDescription(segment, bible) {
  const generated = stripFieldPrefix(
    segment.integratedMultimodalDescription || segment.integrated_multimodal_description,
    "integrated_multimodal_description",
  );
  const body = shotBody(generated, description(segment, bible));
  return appendIdentityAnchors(
    [body, segment.endingState && `Ending state: ${segment.endingState}`].filter(Boolean).join("\n"),
    bible,
  );
}

function soundscape(segment, bible) {
  return stripFieldPrefix(
    segment.overallSoundscape || segment.overall_soundscape || bible.sound,
    "overall_soundscape",
  ) || "Natural diegetic sound";
}

function music(segment, bible) {
  return stripFieldPrefix(
    segment.nonDiegeticMusic || segment.non_diegetic_music || bible.nonDiegeticMusic,
    "non_diegetic_music",
  ) || "N/A";
}

export function buildT2VAPrompt(segment, bible = {}) {
  const prompt = [
    `integrated_multimodal_description: ${integratedDescription(segment, bible)}`,
    `overall_soundscape: ${soundscape(segment, bible)}`,
    `non_diegetic_music: ${music(segment, bible)}`,
  ].join("\n\n");
  return ensureValidPrompt(prompt, "t2v", segment, bible);
}

export function buildI2VAPrompt(segment, bible = {}) {
  // The H3 contract intentionally fixes this line.  Callers may supply
  // continuation metadata, but must not alter the frame-zero alignment.
  const firstLine = "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.";
  const prompt = [
    firstLine,
    "",
    `integrated_multimodal_description: ${integratedDescription(segment, bible)}`,
    "",
    `overall_soundscape: ${soundscape(segment, bible)}`,
    "",
    `non_diegetic_music: ${music(segment, bible)}`,
  ].join("\n");
  return ensureValidPrompt(prompt, "i2v", segment, bible);
}

export function buildRef2VAPrompt(segment, bible = {}, references = {}) {
  const fields = ref2vaFields(segment, bible, references);
  const prompt = REF2VA_FIELDS.map((field) => `${field}: ${fields[field]}`).join("\n\n");
  return ensureValidPrompt(prompt, "ref2v", segment, bible, references);
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

const H3_LABEL_RE = /<(Subject|Picture|Video|Audio)\s+(\d+)>/gi;
const SUMMARY_PREFIX_RE = /^\[((?:keyframe completion|reference generation|video editing|video continuation|audio reuse|audio reference)(?:\s*\+\s*(?:keyframe completion|reference generation|video editing|video continuation|audio reuse|audio reference))*)\]\s*/i;

function normalizeLabel(type, number) {
  return `<${type[0].toUpperCase()}${type.slice(1).toLowerCase()} ${Number(number)}>`;
}

function referenceSources(references = {}) {
  if (Array.isArray(references)) return references;
  if (!references || typeof references !== "object") return [];
  return references.assets || references.referenceAssets || references.images || [];
}

function labelsUsedIn(...values) {
  const labels = new Map();
  for (const value of values) {
    for (const match of String(value || "").matchAll(H3_LABEL_RE)) {
      const label = normalizeLabel(match[1], match[2]);
      if (!labels.has(label)) labels.set(label, "referenced content");
    }
  }
  return labels;
}

function buildReferenceDefinitions(segment, references, usage) {
  const referenceConfig = references && typeof references === "object" && !Array.isArray(references) ? references : {};
  const source = clean(referenceConfig.subjectDefinitions || segment.subjectDefinitions);
  const definitions = new Map();
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*<(Subject|Picture|Video|Audio)\s+(\d+)>\s*(.*)$/i);
    if (!match) continue;
    const label = normalizeLabel(match[1], match[2]);
    definitions.set(label, `${label} ${match[3].trim() || "is referenced content."}`.trim());
  }
  const assets = referenceSources(referenceConfig);
  assets.forEach((asset, index) => {
    const label = `<Picture ${index + 1}>`;
    if (!definitions.has(label)) definitions.set(label, `${label} is ordered reference picture ${index + 1}${asset?.name ? ` (${asset.name})` : ""}.`);
  });
  for (const [label, hint] of usage) {
    if (!definitions.has(label)) definitions.set(label, `${label} is ${hint}.`);
  }
  if (!definitions.has("<Subject 1>")) definitions.set("<Subject 1>", "<Subject 1> is the principal referenced subject.");
  if (!definitions.has("<Picture 1>")) definitions.set("<Picture 1>", "<Picture 1> is the first ordered reference picture.");
  return [...definitions.values()].join("\n");
}

function ref2vaFields(segment, bible, references = {}) {
  const summaryText = stripFieldPrefix(segment.summary, "summary") || clean(segment.description) || "The target video follows the supplied reference direction.";
  const summaryBase = SUMMARY_PREFIX_RE.test(summaryText)
    ? summaryText
    : `[reference generation] ${summaryText}`;
  const detailedCandidate = stripFieldPrefix(segment.detailedDescription || segment.detailed_description, "detailed_description");
  const detailedFallback = description(segment, bible);
  const usage = labelsUsedIn(summaryBase, segment.retentionAnalysis || segment.retention_analysis, detailedCandidate, segment.description);
  const subjectDefinitionLines = buildReferenceDefinitions(segment, references, usage).split(/\r?\n/).filter(Boolean);
  const characters = Array.isArray(bible?.characters) ? bible.characters : [];
  characters.forEach((character, index) => {
    const label = `<Subject ${index + 1}>`;
    const descriptor = characterDescriptor(character);
    const existingIndex = subjectDefinitionLines.findIndex((line) => line.startsWith(`${label} `));
    const identityLine = `${label} is the stable referenced character identity: ${descriptor}.`;
    if (existingIndex >= 0) {
      if (/principal referenced subject/i.test(subjectDefinitionLines[existingIndex])) {
        subjectDefinitionLines[existingIndex] = identityLine;
      } else if (!/stable referenced character identity|identity anchors/i.test(subjectDefinitionLines[existingIndex])) {
        subjectDefinitionLines[existingIndex] = `${subjectDefinitionLines[existingIndex]} ${identityLine}`;
      }
    } else {
      subjectDefinitionLines.push(identityLine);
    }
  });
  const subjectDefinitions = subjectDefinitionLines.join("\n");
  const defined = labelsUsedIn(subjectDefinitions);
  const retentionCandidate = stripFieldPrefix(segment.retentionAnalysis || segment.retention_analysis, "retention_analysis");
  const retentionBase = retentionCandidate && [...labelsUsedIn(retentionCandidate).keys()].every((label) => defined.has(label))
    ? retentionCandidate
    : [...defined.keys()].map((label) => `${label} ([Shot 1]): fully_preserved - the referenced identity and composition remain consistent.`).join("\n");
  const retention = appendIdentityAnchors(retentionBase, bible);
  const summary = appendIdentityAnchors(summaryBase, bible);
  return {
    subject_definitions: subjectDefinitions,
    summary,
    retention_analysis: retention,
    detailed_description: appendIdentityAnchors(shotBody(detailedCandidate, detailedFallback), bible),
    overall_soundscape: stripFieldPrefix(segment.overallSoundscape || segment.overall_soundscape || bible.sound, "overall_soundscape") || "Natural diegetic sound",
    non_diegetic_music: stripFieldPrefix(segment.nonDiegeticMusic || segment.non_diegetic_music || bible.nonDiegeticMusic, "non_diegetic_music") || "N/A",
  };
}

function fallbackPrompt(mode, segment, bible, references) {
  if (mode === "ref2v") {
    const fallback = ref2vaFields({ ...segment, summary: "The target video preserves the supplied reference subject." }, bible, references);
    return REF2VA_FIELDS.map((field) => `${field}: ${fallback[field]}`).join("\n\n");
  }
  const body = `[Shot 1] ${description(segment, bible) || "The scene develops according to the supplied direction."}`;
  const fields = [
    `integrated_multimodal_description: ${body}`,
    `overall_soundscape: ${soundscape(segment, bible)}`,
    `non_diegetic_music: ${music(segment, bible)}`,
  ];
  const core = fields.join("\n\n");
  return mode === "i2v"
    ? `For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\n${core}`
    : core;
}

function ensureValidPrompt(prompt, mode, segment, bible, references = {}) {
  try {
    validateH3Prompt(prompt, { mode, ...(Number.isFinite(Number(segment?.duration)) ? { duration: Number(segment.duration) } : {}) });
    return prompt;
  } catch {
    const fallback = fallbackPrompt(mode, segment, bible, references);
    validateH3Prompt(fallback, { mode, ...(Number.isFinite(Number(segment?.duration)) ? { duration: Number(segment.duration) } : {}) });
    return fallback;
  }
}
