const MAX_LONG_REFERENCE_IMAGES = 8;
const ACTIVE_STATUSES = new Set(["queued", "running", "paused", "assembling", "planning"]);
export const CHARACTER_LORA_DEFAULT_STRENGTH = 0.75;
export const CHARACTER_LORA_MAX_NAME_LENGTH = 512;
export const H3_REALISM_PEOPLE_PRESET = "h3-realism-people-t2v-i2v-r2v.safetensors";
export const H3_REALISM_PEOPLE_TRIGGER = "r34l1sm";
export const H3_REALISM_PEOPLE_DEFAULT_STRENGTH = 0.8;
export const H3_REALISM_PEOPLE_LORA_NAME = H3_REALISM_PEOPLE_PRESET;
export const H3_REALISM_PEOPLE_LORA_TRIGGER = H3_REALISM_PEOPLE_TRIGGER;
export const MULTISHOT_FPS = 24;
export const MULTISHOT_FRAME_OPTIONS = Object.freeze([243, 362]);

function multishotFields(input) {
  if (input.longVideoEnabled !== true) return { longVideoEnabled: false };
  const targetDurationSeconds = Number(input.targetDurationSeconds);
  const framesPerShot = Number(input.framesPerShot);
  const secondsPerShot = framesPerShot / MULTISHOT_FPS;
  return {
    longVideoEnabled: true,
    targetDurationSeconds,
    framesPerShot,
    fps: MULTISHOT_FPS,
    secondsPerShot,
    shotCount: Math.max(1, Math.ceil(targetDurationSeconds / secondsPerShot)),
    continuityMode: input.continuityMode || "first_frame",
    promptMode: input.promptMode || "auto_extend",
    identityAnchor: input.identityAnchor !== false,
    voiceContinuity: input.voiceContinuity !== false,
    contextFrames: Number(input.contextFrames ?? 22),
    chainGainControl: input.chainGainControl || "off",
    masterNormalize: input.masterNormalize || "off",
  };
}

function multishotWindows(settings) {
  const windows = [];
  let start = 0;
  for (let index = 0; index < settings.shotCount; index += 1) {
    const end = Math.min(settings.targetDurationSeconds, start + settings.secondsPerShot);
    windows.push({ start: Number(start.toFixed(3)), end: Number(end.toFixed(3)), duration: Number((end - start).toFixed(3)) });
    start = end;
  }
  return windows;
}

function autoExtendPrompt(premise, index) {
  const boundary = "End this window on a stable readable face and continuing action. Avoid fast turns, full face occlusion, back-to-camera poses, heavy motion blur, abrupt camera motion, scene transitions, or cutting dialogue mid-word.";
  if (index === 0) return `${premise}\n\n${boundary}`;
  return `Continue naturally from the previous moment. Preserve the same people, identity, clothing, environment, time, camera, lens, lighting, action direction, and dialogue continuity. Do not introduce a new scene, new shot, cut, or camera cut unless explicitly requested.\n\nContinue this same take: ${premise}\n\n${boundary}`;
}

/** Keep the long-video contract aligned with the bridge admission rules. */
export function normalizeCharacterLoraName(value) {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return "";
  if (typeof value !== "string") return null;
  const normalized = value.trim().replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    !normalized || normalized.length > CHARACTER_LORA_MAX_NAME_LENGTH || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)
    || normalized.includes("\0") || segments.some((segment) => !segment || segment === "." || segment === ".." || /[<>:"|?*]/.test(segment))
  ) return null;
  return normalized;
}

export function normalizeCharacterLoraStrength(value, fallback = CHARACTER_LORA_DEFAULT_STRENGTH) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 2 ? number : null;
}

function characterLoraIssue(input) {
  if (input.h3LoraEnabled === false && !String(input.characterLoraName || "").trim() && !String(input.characterLoraId || "").trim() && !String(input.h3LoraPreset || "").trim()) return null;
  if (input.h3LoraEnabled === true || String(input.h3LoraPreset || "").trim() || String(input.characterLoraName || "").trim() === H3_REALISM_PEOPLE_PRESET) {
    const preset = String(input.h3LoraPreset || "").trim();
    const name = String(input.characterLoraName || "").trim().replaceAll("\\", "/");
    if (preset && preset !== H3_REALISM_PEOPLE_PRESET) return { field: "h3LoraPreset", message: "Unsupported H3 Realism People preset." };
    if (name && name !== H3_REALISM_PEOPLE_PRESET) return { field: "characterLoraName", message: "H3 Realism People uses its fixed preset filename." };
    if (String(input.characterLoraId || "").trim()) return { field: "characterLoraId", message: "H3 Realism People uses its fixed preset filename, not a registry id." };
    if (normalizeCharacterLoraStrength(input.characterLoraStrength, H3_REALISM_PEOPLE_DEFAULT_STRENGTH) === null) return { field: "characterLoraStrength", message: "Character LoRA strength must be between 0 and 2." };
    return null;
  }
  const rawName = String(input.characterLoraName || "").trim();
  const rawId = String(input.characterLoraId || "").trim();
  if (!rawName && !rawId) {
    const strength = input.characterLoraStrength;
    if (strength !== undefined && strength !== null && strength !== "" && Number(strength) !== CHARACTER_LORA_DEFAULT_STRENGTH) {
      return { field: "characterLoraStrength", message: "LoRA strength requires a LoRA name or registry id." };
    }
    return null;
  }
  if (rawName && !normalizeCharacterLoraName(rawName)) return { field: "characterLoraName", message: "Character LoRA must be a safe relative path under models/loras." };
  if (rawId && (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawId) || rawId.length > 128)) {
    return { field: "characterLoraId", message: "Character LoRA registry id is invalid." };
  }
  if (normalizeCharacterLoraStrength(input.characterLoraStrength) === null) return { field: "characterLoraStrength", message: "Character LoRA strength must be between 0 and 2." };
  return null;
}

export function selectHydratableLongJob(jobs) {
  if (!Array.isArray(jobs)) return null;
  return jobs.find((job) => job && job.status !== "completed") || null;
}

export function parseLongTimelineDraft(value, fallback = []) {
  const text = String(value || "");
  const parsed = [];
  let cursor = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const range = line.match(/^\[?\s*(\d+(?:\.\d+)?)\s*(?:-|–|—|~|to)\s*(\d+(?:\.\d+)?)\s*\]?\s*(.*)$/i);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      parsed.push({ start, end, duration: end - start, description: range[3].trim() });
      cursor = end;
      continue;
    }
    const durationLine = line.match(/^(\d+(?:\.\d+)?)\s*(?:sec(?:ond)?s?|秒|s)\s*(?:-|:|：)?\s*(.*)$/i);
    if (durationLine) {
      const duration = Number(durationLine[1]);
      if (!Number.isFinite(duration) || duration <= 0) continue;
      parsed.push({ start: cursor, end: cursor + duration, duration, description: durationLine[2].trim() });
      cursor += duration;
    }
  }
  return parsed.length >= 2 ? parsed : fallback;
}

/**
 * Resize one storyboard segment while keeping the timeline contiguous.
 * Segments before the edited one keep their timestamps; the edited segment
 * and every following segment are reflowed from the preceding end time.
 */
export function resizeLongSegment(segments, index, duration) {
  if (!Array.isArray(segments) || index < 0 || index >= segments.length) return segments;
  const nextDuration = Number(duration);
  if (!Number.isFinite(nextDuration) || nextDuration < 0.5 || nextDuration > 60) return segments;
  let cursor = 0;
  return segments.map((segment, segmentIndex) => {
    const originalStart = Number(segment?.start);
    const originalEnd = Number(segment?.end);
    const originalDuration = originalEnd - originalStart;
    if (segmentIndex < index) {
      cursor = Number(originalEnd.toFixed(3));
      return segment;
    }
    const start = segmentIndex === 0 ? 0 : cursor;
    const segmentDuration = segmentIndex === index ? nextDuration : originalDuration;
    const end = Number((start + segmentDuration).toFixed(3));
    cursor = end;
    return { ...segment, start, end, duration: Number((end - start).toFixed(3)) };
  });
}

export function normalizeLongScripts(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 120).map((script, index) => ({
    id: String(script?.id || `script-${index + 1}`),
    name: String(script?.name || `劇本 ${index + 1}`).trim().slice(0, 80),
    content: String(script?.content || script?.prompt || "").trim(),
    // `description` is the shot-level scene description.  Keep old drafts
    // usable by falling back to their prompt/content, never to the title.
    description: String(script?.description || script?.scene || script?.content || script?.prompt || "").trim(),
    negativePrompt: String(script?.negativePrompt || "").trim(),
    duration: Number(script?.duration),
  }));
}

export function longScriptsToTimeline(value) {
  let cursor = 0;
  return normalizeLongScripts(value).map((script, index) => {
    const duration = Number(script.duration.toFixed(3));
    const start = cursor;
    const end = Number((start + duration).toFixed(3));
    cursor = end;
    return {
      id: `segment-${String(index + 1).padStart(3, "0")}`,
      start,
      end,
      duration,
      description: script.description || script.content,
      negativePrompt: script.negativePrompt,
    };
  });
}

export function composeLongScriptText(value) {
  return normalizeLongScripts(value).map((script, index) => `【劇本 ${index + 1}：${script.name}】\n${script.content}`).join("\n\n");
}

export function buildLongDirectPlan(input) {
  const scripts = normalizeLongScripts(input.scripts);
  const multishot = multishotFields(input);
  if (multishot.longVideoEnabled) {
    const premise = String(input.inputText || "").trim();
    const windows = multishotWindows(multishot);
    const prompts = multishot.promptMode === "auto_extend"
      ? windows.map((_, index) => autoExtendPrompt(premise, index))
      : scripts.map((script) => script.content);
    const referenceMode = input.inputType === "image" ? input.referenceMode : "continuity";
    const segments = windows.map((window, index) => ({
      id: `segment-${String(index + 1).padStart(3, "0")}`,
      ...window,
      description: multishot.promptMode === "manual_shots" ? scripts[index]?.description || prompts[index] : `Continuous take window ${index + 1}`,
      prompt: prompts[index],
      negativePrompt: multishot.promptMode === "manual_shots" ? scripts[index]?.negativePrompt || "" : "",
      promptSource: multishot.promptMode,
      mode: referenceMode === "multi_reference" || index > 0 && input.inputType === "image" && multishot.identityAnchor ? "ref2v" : index === 0 && input.inputType === "text" || index > 0 && multishot.continuityMode === "context_pin" ? "t2v" : "i2v",
      status: "pending",
    }));
    return {
      title: input.title || "Untitled long video",
      inputType: input.inputType,
      inputText: premise || composeLongScriptText(scripts),
      ...(multishot.promptMode === "manual_shots" ? { scripts } : {}),
      referenceMode,
      continuationMode: multishot.continuityMode,
      referenceAssets: input.referenceAssets || [],
      duration: multishot.targetDurationSeconds,
      negativePrompt: String(input.negativePrompt || ""),
      continuityBible: {},
      ...multishot,
      segments,
      timeline: segments,
      planningSettings: { timelineMode: "manual", targetDuration: multishot.targetDurationSeconds, segmentDurationHint: multishot.secondsPerShot, segmentCount: multishot.shotCount },
      planMeta: { source: "author", timelineSource: "author", promptSource: multishot.promptMode, generatedAt: new Date().toISOString() },
    };
  }
  const timeline = longScriptsToTimeline(scripts);
  const referenceMode = input.inputType === "image" ? input.referenceMode : "continuity";
  const segments = timeline.map((segment, index) => ({
    ...segment,
    description: scripts[index].description || scripts[index].content,
    prompt: scripts[index].content,
    negativePrompt: scripts[index].negativePrompt,
    promptSource: "manual",
    mode: referenceMode === "multi_reference" || index > 0 ? "ref2v" : input.inputType === "image" ? "i2v" : "t2v",
    status: "pending",
  }));
  const duration = segments.length ? segments[segments.length - 1].end : 0;
  return {
    title: input.title || "Untitled long video",
    inputType: input.inputType,
    inputText: composeLongScriptText(scripts),
    scripts,
    referenceMode,
    continuationMode: input.continuationMode || "motion_context",
    motionContextSeconds: 2,
    referenceAssets: input.referenceAssets || [],
    duration,
    negativePrompt: String(input.negativePrompt || ""),
    continuityBible: {},
    segments,
    timeline: segments,
    planningSettings: { timelineMode: "manual", targetDuration: duration, segmentDurationHint: scripts.length ? duration / scripts.length : 5, segmentCount: scripts.length },
    planMeta: { source: "author", timelineSource: "author", promptSource: "manual", generatedAt: new Date().toISOString() },
  };
}

export function buildLongPlanRequest(input) {
  const refs = (input.referenceAssets || []).slice(0, MAX_LONG_REFERENCE_IMAGES);
  const characterLoraName = String(input.characterLoraName || "").trim().replaceAll("\\", "/");
  const characterLoraId = String(input.characterLoraId || "").trim();
  const h3LoraEnabled = input.h3LoraEnabled === true;
  const explicitH3Disabled = input.h3LoraEnabled === false && !characterLoraName && !characterLoraId;
  const scripts = normalizeLongScripts(input.scripts);
  const scriptedTimeline = scripts.length ? longScriptsToTimeline(scripts) : null;
  return {
    title: input.title || "Untitled long video",
    inputType: input.inputType,
    inputText: scriptedTimeline ? composeLongScriptText(scripts) : input.inputText,
    ...(scriptedTimeline ? { scripts } : {}),
    inputAsset: input.inputType === "image" ? refs[0] : undefined,
    imagePurpose: input.inputType === "image" ? "first_frame" : undefined,
    referenceMode: input.inputType === "image" ? input.referenceMode : "continuity",
    continuationMode: input.continuationMode || "motion_context",
    ...multishotFields(input),
    motionContextSeconds: 2,
    referenceAssets: input.inputType === "image" && input.referenceMode === "multi_reference" ? refs.slice(1) : [],
    timelineMode: scriptedTimeline ? "manual" : input.timelineMode,
    duration: scriptedTimeline ? scriptedTimeline[scriptedTimeline.length - 1].end : input.timelineMode === "auto" ? input.duration : undefined,
    segmentDurationHint: input.segmentDurationHint,
    ...(scriptedTimeline ? { timeline: scriptedTimeline } : { timelineText: input.timelineMode === "manual" ? input.timelineText : undefined }),
    promptProvider: input.promptProvider,
    ollamaModel: input.ollamaModel,
    codexModel: input.codexModel,
    reasoningEffort: input.reasoningEffort,
    negativePrompt: input.negativePrompt,
    ...(input.plannerImages?.length ? { plannerImages: input.plannerImages } : {}),
    ...(h3LoraEnabled
      ? { h3LoraEnabled: true, h3LoraPreset: H3_REALISM_PEOPLE_PRESET, characterLoraName: H3_REALISM_PEOPLE_PRESET, characterLoraStrength: normalizeCharacterLoraStrength(input.characterLoraStrength, H3_REALISM_PEOPLE_DEFAULT_STRENGTH) ?? H3_REALISM_PEOPLE_DEFAULT_STRENGTH }
      : explicitH3Disabled
        ? { h3LoraEnabled: false, h3LoraPreset: null, characterLoraName: null, characterLoraId: null, characterLoraStrength: null }
        : characterLoraName || characterLoraId
          ? { ...(characterLoraName ? { characterLoraName } : {}), ...(characterLoraId ? { characterLoraId } : {}), characterLoraStrength: normalizeCharacterLoraStrength(input.characterLoraStrength) ?? CHARACTER_LORA_DEFAULT_STRENGTH }
          : {}),
  };
}

export function buildLongSaveRequest(input) {
  const refs = (input.referenceAssets || []).slice(0, MAX_LONG_REFERENCE_IMAGES);
  const characterLoraName = String(input.characterLoraName || "").trim().replaceAll("\\", "/");
  const characterLoraId = String(input.characterLoraId || "").trim();
  const clearCharacterLora = input.clearCharacterLora === true;
  const h3LoraEnabled = input.h3LoraEnabled === true;
  const explicitH3Disabled = input.h3LoraEnabled === false && !characterLoraName && !characterLoraId;
  const scripts = normalizeLongScripts(input.scripts);
  const multishot = multishotFields(input);
  const parsed = multishot.longVideoEnabled
    ? input.plan.segments || []
    : scripts.length
    ? longScriptsToTimeline(scripts).map((segment, index) => ({ ...segment, description: scripts[index].description || scripts[index].content }))
    : parseLongTimelineDraft(input.timelineText, input.plan.segments || []);
  const segments = parsed.map((segment, index) => ({
    ...(input.plan.segments?.[index] || {}),
    ...segment,
    start: segment.start,
    end: segment.end,
    duration: segment.end - segment.start,
    description: segment.description || input.plan.segments?.[index]?.description || `Segment ${index + 1}`,
    negativePrompt: segment.negativePrompt || input.plan.segments?.[index]?.negativePrompt || "",
  }));
  const duration = segments.length ? segments[segments.length - 1].end : input.plan.duration;
  return {
    title: input.title || input.plan.title || "Untitled long video",
    inputType: input.inputType,
    inputText: scripts.length ? composeLongScriptText(scripts) : input.inputText,
    ...(scripts.length ? { scripts } : {}),
    inputAsset: input.inputType === "image" ? refs[0] : undefined,
    imagePurpose: input.inputType === "image" ? "first_frame" : undefined,
    referenceMode: input.inputType === "image" ? input.referenceMode : "continuity",
    continuationMode: input.continuationMode || "motion_context",
    ...multishot,
    ...(multishot.longVideoEnabled ? { continuationMode: multishot.continuityMode } : {}),
    motionContextSeconds: 2,
    referenceAssets: input.inputType === "image" && input.referenceMode === "multi_reference" ? refs.slice(1) : [],
    continuityBible: input.plan.continuityBible,
    planMeta: input.plan.planMeta,
    planningSettings: input.plan.planningSettings,
    segments,
    duration,
    outputFolder: String(input.outputFolder || "").trim(),
    modelProfile: input.modelProfile,
    width: input.width,
    height: input.height,
    steps: input.steps,
    seed: input.seed,
    ollamaModel: input.ollamaModel,
    promptProvider: input.promptProvider,
    codexModel: input.codexModel,
    codexReasoningEffort: input.reasoningEffort,
    negativePrompt: input.negativePrompt,
    seam: input.seam,
    ...(clearCharacterLora || explicitH3Disabled
      ? { h3LoraEnabled: false, h3LoraPreset: null, characterLoraName: null, characterLoraId: null, characterLoraStrength: null }
      : h3LoraEnabled
        ? { h3LoraEnabled: true, h3LoraPreset: H3_REALISM_PEOPLE_PRESET, characterLoraName: H3_REALISM_PEOPLE_PRESET, characterLoraStrength: normalizeCharacterLoraStrength(input.characterLoraStrength, H3_REALISM_PEOPLE_DEFAULT_STRENGTH) ?? H3_REALISM_PEOPLE_DEFAULT_STRENGTH }
        : characterLoraName || characterLoraId
          ? { ...(characterLoraName ? { characterLoraName } : {}), ...(characterLoraId ? { characterLoraId } : {}), characterLoraStrength: normalizeCharacterLoraStrength(input.characterLoraStrength) ?? CHARACTER_LORA_DEFAULT_STRENGTH }
          : {}),
    ...(input.revision !== undefined ? { revision: input.revision } : {}),
  };
}

export function validateLongCreate(input) {
  const issues = [];
  const loraIssue = characterLoraIssue(input);
  if (loraIssue) issues.push(loraIssue);
  const scripts = normalizeLongScripts(input.scripts);
  const multishot = input.longVideoEnabled === true;
  const target = Number(input.targetDurationSeconds);
  const framesPerShot = Number(input.framesPerShot);
  const shotCount = Number.isFinite(target) && MULTISHOT_FRAME_OPTIONS.includes(framesPerShot) ? Math.max(1, Math.ceil(target / (framesPerShot / MULTISHOT_FPS))) : 0;
  if (multishot) {
    issues.push(...numberIssue(input.targetDurationSeconds, "targetDurationSeconds", "目標總長", 1, 600, false));
    if (!MULTISHOT_FRAME_OPTIONS.includes(framesPerShot)) issues.push({ field: "framesPerShot", message: "每段幀數必須是 243 或 362。" });
    if (!["first_frame", "context_pin"].includes(input.continuityMode)) issues.push({ field: "continuityMode", message: "Continuity 必須是 first_frame 或 context_pin。" });
    if (!["manual_shots", "auto_extend"].includes(input.promptMode)) issues.push({ field: "promptMode", message: "Prompt Mode 必須是 manual_shots 或 auto_extend。" });
    if (![5, 22, 39, 56].includes(Number(input.contextFrames))) issues.push({ field: "contextFrames", message: "Context frames 必須是 5、22、39 或 56。" });
    if (!["off", "flatten"].includes(input.chainGainControl)) issues.push({ field: "chainGainControl", message: "Chain gain control 設定無效。" });
    if (!["off", "luma", "luma+contrast"].includes(input.masterNormalize)) issues.push({ field: "masterNormalize", message: "Master normalize 設定無效。" });
    if (input.promptMode === "auto_extend" && !String(input.inputText || "").trim()) issues.push({ field: "inputText", message: "Auto extend 需要一段完整場景描述。" });
    if (input.promptMode === "manual_shots" && scripts.length !== shotCount) issues.push({ field: "scripts", message: `Manual shots 需要 ${shotCount} 個劇本。` });
  }
  if (input.scripts !== undefined && (!multishot || input.promptMode === "manual_shots")) {
    if (scripts.length < (multishot ? 1 : 2)) issues.push({ field: "scripts", message: multishot ? "至少需要一個劇本。" : "長影片至少需要兩個劇本。" });
    scripts.forEach((script, index) => {
      if (!script.name) issues.push({ field: `script-${index}-name`, message: `請輸入劇本 ${index + 1} 的名稱。` });
      if (!script.content) issues.push({ field: `script-${index}-content`, message: `請輸入劇本 ${index + 1} 的內容。` });
      issues.push(...numberIssue(script.duration, `script-${index}-duration`, `劇本 ${index + 1} 長度`, 0.5, 60, false));
      if (script.content.length > 7000) issues.push({ field: `script-${index}-content`, message: `劇本 ${index + 1} 的提示詞不可超過 7000 字元。` });
    });
  } else if (!multishot && !String(input.inputText || "").trim()) issues.push({ field: "inputText", message: "請先輸入長影片的整體提示詞／故事描述。" });
  if (input.continuationMode === "latent_context" && input.inputType !== "image") issues.push({ field: "continuationMode", message: "Latent 影音銜接目前需要選擇「從圖片開始」，讓後續 Ref2VA 保有固定視覺參考。" });
  if (input.inputType === "image" && !(input.referenceAssets || []).length) issues.push({ field: "referenceAssets", message: "從圖片開始時需要至少一張起始參考圖片。" });
  if (multishot) {
    // Multishot windows are derived from targetDurationSeconds.
  } else if (input.scripts !== undefined) {
    // Script cards are the authoritative timeline.
  } else if (input.timelineMode === "manual") {
    if (!String(input.timelineText || "").trim()) issues.push({ field: "timelineText", message: "手動時間軸模式需要至少兩段分鏡。" });
    else if (parseLongTimelineDraft(input.timelineText, []).length < 2) issues.push({ field: "timelineText", message: "手動時間軸至少需要兩段有效時間範圍。" });
  } else {
    issues.push(...numberIssue(input.duration, "duration", "目標總長", 1, 3600, false));
  }
  if (input.scripts === undefined) issues.push(...numberIssue(input.segmentDurationHint, "segmentDurationHint", "目標單段長度", 0.5, 60, false));
  issues.push(...dimensionIssue(input.width, "width", "長影片寬度"));
  issues.push(...dimensionIssue(input.height, "height", "長影片高度"));
  issues.push(...numberIssue(input.steps, "steps", "Steps", 1, 80, true));
  issues.push(...numberIssue(input.seed, "seed", "Seed", 0, 2147483647, true));
  if (input.requireSavedPlan) {
    if (!input.plan) issues.push({ field: "plan", message: "請先產生分鏡與 H3 提示詞。" });
    else if (input.planDirty) issues.push({ field: "plan", message: "規劃輸入已變更，請重新產生分鏡。" });
    if (!String(input.outputFolder || "").trim()) issues.push({ field: "outputFolder", message: "請輸入輸出資料夾。" });
  }
  return issues;
}

export function longJobIsActive(status) {
  return ACTIVE_STATUSES.has(String(status || ""));
}

function dimensionIssue(value, field, label) {
  const issues = numberIssue(value, field, label, 32, 2048, true);
  if (issues.length) return issues;
  return value % 32 === 0 ? [] : [{ field, message: `${label} 必須是 32 的倍數。` }];
}

function numberIssue(value, field, label, min, max, integer) {
  if (value === "") return [{ field, message: `${label} 必須填寫。` }];
  if (!Number.isFinite(value)) return [{ field, message: `${label} 必須是有效數字。` }];
  if (integer && !Number.isInteger(value)) return [{ field, message: `${label} 必須是整數。` }];
  if (value < min || value > max) return [{ field, message: `${label} 必須介於 ${min}–${max}。` }];
  return [];
}
