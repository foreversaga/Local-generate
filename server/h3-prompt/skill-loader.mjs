import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildH3PromptSystem } from "./instruction.mjs";

const SKILL_NAME = "h3-prompt-writing";
const DEFAULT_CONTEXT_LENGTH = 32768;
const MIN_CONTEXT_LENGTH = 8192;
const MAX_CONTEXT_LENGTH = 131072;
const MAX_SKILL_FILE_BYTES = 512 * 1024;

function clean(value) {
  return String(value ?? "").trim();
}

function defaultSkillPath() {
  const codexRoot = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), ".codex");
  return path.resolve(process.env.H3_PROMPT_SKILL_PATH || path.join(codexRoot, "skills", SKILL_NAME, "SKILL.md"));
}

async function readBoundedText(filePath, readFile = fs.readFile, stat = fs.stat) {
  const info = await stat(filePath);
  if (!info.isFile() || info.size < 1 || info.size > MAX_SKILL_FILE_BYTES) {
    throw new Error(`Skill resource is not a regular bounded file: ${path.basename(filePath)}`);
  }
  return await readFile(filePath, "utf8");
}

function qualityPriorities() {
  return [
    "Quality priorities for every human or human-like subject:",
    "- Preserve the same facial identity, facial proportions, eye spacing, eye shape, brows, nose, mouth, skin tone, hairstyle silhouette, body silhouette, clothing design, colors, and distinctive marks across every shot and segment where visible.",
    "- When hands are visible, describe anatomically coherent hands, stable finger count, natural finger articulation, and physically correct hand-object contact, grip, occlusion, and release. Avoid vague hand activity when the interaction is story-critical.",
    "- Clothing must keep the same design and fit while following gravity, body motion, contact, inertia, and wind naturally. Prevent cloth/body intersection, fabric penetration, floating cloth, rigid cloth, implausible stretching, and independent garment motion.",
    "- Prefer observable motion paths and stable ending states over abstract quality adjectives. Preserve identity, object state, and spatial logic across storyboard cuts while allowing each shot to define its own composition, motion, and camera direction.",
  ].join("\n");
}

function planningContract({ referenceMode, continuationMode }) {
  return [
    "You are the structured long-video planning worker for H3 Studio.",
    "The user message defines the JSON planning envelope. Return that JSON object only; do not return Markdown or commentary.",
    "Use the trusted H3 skill material below to author the content inside every segment. The skill's final prompt field rules apply inside each segment, while the user message remains authoritative for the surrounding long-video JSON keys and global timing.",
    referenceMode === "multi_reference"
      ? "This is a Ref2VA storyboard sequence. Apply the full-reference guide to every independent shot. Static picture labels keep the same order; from shot 2 onward <Video 1> is only the preceding shot's final two silent seconds as a weak visual-consistency reference, never footage to replay or a frame-zero lock."
      : continuationMode === "motion_context"
        ? "This is a storyboard sequence. The first text-origin shot is T2VA and an image-origin first shot is I2VA. Every later independent shot is Ref2VA with <Video 1> used only as a silent weak visual-consistency reference and [reference generation]."
        : continuationMode === "latent_context"
          ? "This is one continuous audiovisual timeline. The first image-origin shot is I2VA. Every later shot uses Ref2VA static pictures plus an exact protected 39-frame AV latent prefix from the preceding shot, uses [video continuation + reference generation], and must not invent a <Video N> label."
        : "This is a legacy base-mode sequence. The first text-origin segment is T2VA; an image-origin first segment and all continuation segments are I2VA. Segment-internal shot times always restart at zero.",
    qualityPriorities(),
  ].join("\n");
}

function promptContract({ mode, duration, hasVisualReference }) {
  return [
    buildH3PromptSystem({ mode, duration, hasVisualReference }),
    qualityPriorities(),
    "Treat the supplied tail/reference image as visual truth. Preserve user-authored story intent; use the skill only to improve structure, continuity, audiovisual specificity, and physical plausibility.",
  ].join("\n\n");
}

function embeddedSystem(options) {
  return options.purpose === "planning"
    ? planningContract(options)
    : promptContract(options);
}

function publicPolicy({ guide, contentHash, source, warning }) {
  return {
    name: SKILL_NAME,
    guide,
    contentHash,
    source,
    ...(warning ? { warning: clean(warning).slice(0, 240) } : {}),
  };
}

/**
 * Load the trusted filesystem skill for a known H3 route. The caller already
 * selected this skill, so no probabilistic skill routing is needed. Missing
 * resources fall back to the embedded H3 contract and never block generation.
 */
export async function loadH3PromptSkillPack({
  mode = "t2v",
  referenceMode,
  continuationMode,
  purpose = "prompt",
  duration,
  hasVisualReference = false,
  skillPath = defaultSkillPath(),
  readFile = fs.readFile,
  stat = fs.stat,
} = {}) {
  const normalizedMode = mode === "ref2v" || referenceMode === "multi_reference" ? "ref2v" : mode;
  const guide = normalizedMode === "ref2v" ? "ref-en.txt" : "base-en.txt";
  const options = { mode: normalizedMode, referenceMode, continuationMode, purpose, duration, hasVisualReference };
  const baseSystem = embeddedSystem(options);
  try {
    const resolvedSkillPath = path.resolve(skillPath);
    const skillRoot = path.dirname(resolvedSkillPath);
    const baseGuidePath = path.join(skillRoot, "references", "base-en.txt");
    const selectedGuidePath = path.join(skillRoot, "references", guide);
    const [skillText, baseGuide, selectedGuide] = await Promise.all([
      readBoundedText(resolvedSkillPath, readFile, stat),
      readBoundedText(baseGuidePath, readFile, stat),
      guide === "base-en.txt" ? Promise.resolve("") : readBoundedText(selectedGuidePath, readFile, stat),
    ]);
    const resources = [skillText, baseGuide, selectedGuide].filter(Boolean);
    const contentHash = createHash("sha256").update(resources.join("\n\n")).digest("hex").slice(0, 16);
    const systemPrompt = [
      baseSystem,
      "TRUSTED H3 SKILL START",
      skillText,
      "TRUSTED H3 SKILL END",
      "TRUSTED BASE GUIDE START",
      baseGuide,
      "TRUSTED BASE GUIDE END",
      ...(selectedGuide ? ["TRUSTED FULL-REFERENCE GUIDE START", selectedGuide, "TRUSTED FULL-REFERENCE GUIDE END"] : []),
      "Apply the trusted material above completely and resolve examples in favor of the current user's requested mode, duration, references, dialogue, and story.",
    ].join("\n\n");
    return {
      systemPrompt,
      policy: publicPolicy({ guide, contentHash, source: "filesystem" }),
    };
  } catch (error) {
    const warning = error?.message || String(error);
    return {
      systemPrompt: baseSystem,
      policy: publicPolicy({
        guide,
        contentHash: createHash("sha256").update(baseSystem).digest("hex").slice(0, 16),
        source: "embedded_fallback",
        warning,
      }),
    };
  }
}

export function resolveH3OllamaContextLength(value = process.env.H3_OLLAMA_PROMPT_CONTEXT) {
  const normalized = clean(value);
  const parsed = normalized ? Number(normalized) : Number.NaN;
  const selected = Number.isFinite(parsed) ? Math.round(parsed) : DEFAULT_CONTEXT_LENGTH;
  return Math.min(MAX_CONTEXT_LENGTH, Math.max(MIN_CONTEXT_LENGTH, selected));
}

export const H3_PROMPT_SKILL_NAME = SKILL_NAME;
export const DEFAULT_H3_OLLAMA_CONTEXT_LENGTH = DEFAULT_CONTEXT_LENGTH;
