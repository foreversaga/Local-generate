const TIMED_HEADING = /^[ \t]*(?:\[)?(\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)[ \t]*(?:–|—|-|~|to)[ \t]*(\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(?:\])?[^\r\n]*$/gmi;
const GLOBAL_REQUIREMENTS = /\n\s*((?:整體|全局|全域)(?:攝影|影片|生成)?要求\s*[:：][\s\S]*|overall\s+(?:camera|video|generation)?\s*requirements?\s*:[\s\S]*)$/i;

function timecodeSeconds(value) {
  const parts = String(value || "").split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function timedSections(value) {
  const source = String(value || "").trim();
  const matches = [...source.matchAll(TIMED_HEADING)];
  if (!matches.length) return null;
  const sections = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = timecodeSeconds(match[1]);
    const end = timecodeSeconds(match[2]);
    if (start === null || end === null || end <= start) continue;
    const bodyStart = Number(match.index) + match[0].length;
    const bodyEnd = index + 1 < matches.length ? Number(matches[index + 1].index) : source.length;
    sections.push({ start, end, label: match[0].trim(), body: source.slice(bodyStart, bodyEnd).trim() });
  }
  if (!sections.length) return null;
  let shared = source.slice(0, Number(matches[0].index)).trim();
  const last = sections.at(-1);
  const global = last?.body.match(GLOBAL_REQUIREMENTS);
  if (global) {
    last.body = last.body.slice(0, Number(global.index)).trim();
    shared = [shared, global[1].trim()].filter(Boolean).join("\n\n");
  }
  return { shared, sections };
}

function narrativeSlices(value, count) {
  let units = String(value || "").split(/\n\s*\n+/).map((part) => part.trim()).filter(Boolean);
  if (units.length < count) {
    const sentences = String(value || "").split(/(?<=[。！？.!?])\s+|(?<=[。！？])(?=[^\s])/u).map((part) => part.trim()).filter(Boolean);
    if (sentences.length > units.length) units = sentences;
  }
  if (!units.length) return Array.from({ length: count }, () => "Continue the current action naturally.");
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor(index * units.length / count);
    const end = Math.max(start + 1, Math.floor((index + 1) * units.length / count));
    return units.slice(start, Math.min(units.length, end)).join("\n\n") || "Continue the current action naturally.";
  });
}

function windowPrompt({ shared, content, window, index }) {
  const continuity = index === 0
    ? "Begin only the first chronological portion of the story."
    : "Continue naturally from the previous moment, preserving the exact identity, clothing state, environment, camera, lighting, action direction, and dialogue continuity.";
  const scope = `This generation window covers only source timeline ${Number(window.start).toFixed(3)}-${Number(window.end).toFixed(3)} seconds. Render only the actions assigned below; do not preview, summarize, montage, or complete later windows.`;
  const boundary = "End this window on a stable readable face and a continuing action. Avoid a fast turn, full face occlusion, back-to-camera pose, heavy motion blur, abrupt camera motion, scene transition, or dialogue cut mid-word.";
  return [shared, continuity, scope, `Window-specific content:\n${content}`, boundary].filter(Boolean).join("\n\n");
}

export function buildWindowedAutoExtendPrompts(value, windows) {
  const source = String(value || "").trim();
  if (!source) throw Object.assign(new Error("auto_extend requires a scene description."), { code: "AUTO_EXTEND_PROMPT_REQUIRED", status: 400 });
  const normalizedWindows = Array.isArray(windows) ? windows : [];
  if (!normalizedWindows.length) return [];
  const parsed = timedSections(source);
  if (parsed) {
    return normalizedWindows.map((window, index) => {
      const assigned = parsed.sections.filter((section) => {
        const midpoint = section.start + (section.end - section.start) / 2;
        return midpoint >= Number(window.start) && (midpoint < Number(window.end) || index === normalizedWindows.length - 1 && midpoint <= Number(window.end));
      });
      const content = assigned.length
        ? assigned.map((section) => `Source ${section.label}\n${section.body}`.trim()).join("\n\n")
        : "Continue the current action naturally without introducing content from a later timeline window.";
      return windowPrompt({ shared: parsed.shared, content, window, index });
    });
  }
  const slices = narrativeSlices(source, normalizedWindows.length);
  return normalizedWindows.map((window, index) => windowPrompt({ shared: "", content: slices[index], window, index }));
}
