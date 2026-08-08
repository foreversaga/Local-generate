import { fail, validateTimeline } from "./schema.mjs";

function parseClock(value) {
  const text = String(value).trim().replace(",", ".");
  const parts = text.split(":").map(Number);
  if (!parts.length || parts.some((part) => !Number.isFinite(part) || part < 0)) return NaN;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return NaN;
}

function parseRange(value) {
  const match = String(value).match(/^\s*\[?\s*([0-9:.]+)\s*(?:-|–|—|to)\s*([0-9:.]+)\s*\]?\s*(?::|：)?\s*(.*)$/i);
  if (!match) return null;
  const start = parseClock(match[1]);
  const end = parseClock(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) fail("TIMELINE_TIME_INVALID", `Invalid time range: ${value}`);
  return { start, end, description: match[3].trim() };
}

function parseDurationLine(value) {
  const match = String(value).match(/^\s*(\d+(?:\.\d+)?)\s*(?:秒|sec(?:ond)?s?|s)\s*(?:-|:|：)?\s*(.*)$/i);
  if (!match) return null;
  const duration = Number(match[1]);
  if (!Number.isFinite(duration) || duration <= 0) fail("TIMELINE_DURATION_INVALID", `Invalid segment duration: ${value}`);
  return { duration, description: match[2].trim() };
}

function normalizeDescriptions(items) {
  const result = [];
  for (const item of items) {
    if (item.description) result.push(item);
    else if (result.length) result[result.length - 1].description += ` ${String(item.raw || "").trim()}`;
    else fail("TIMELINE_DESCRIPTION_REQUIRED", "Every timeline segment needs a description.");
  }
  return result;
}

export function parseTimestampTimeline(source) {
  const lines = String(source ?? "").split(/\r?\n/);
  const items = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const range = parseRange(line);
    if (range) items.push(range);
    else if (items.length) items[items.length - 1].description += ` ${line.trim()}`;
    else fail("TIMELINE_FORMAT_INVALID", "Expected [start - end] timeline entries.");
  }
  return validateTimeline(normalizeDescriptions(items));
}

export function parseDurationTimeline(source) {
  const lines = String(source ?? "").split(/\r?\n/);
  const items = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const duration = parseDurationLine(line);
    if (duration) items.push(duration);
    else if (items.length && !/^\s*\[/.test(line)) items[items.length - 1].description += ` ${line.trim()}`;
    else fail("TIMELINE_FORMAT_INVALID", "Expected N-second timeline entries.");
  }
  let cursor = 0;
  const segments = normalizeDescriptions(items).map((item) => {
    const start = cursor;
    cursor = Number((cursor + item.duration).toFixed(3));
    return { start, end: cursor, description: item.description };
  });
  return validateTimeline(segments);
}

export function parseTimeline(source, options = {}) {
  if (Array.isArray(source)) return validateTimeline(source, options.duration);
  const value = String(source ?? "").trim();
  if (!value) fail("TIMELINE_REQUIRED", "Timeline is required.");
  const first = value.split(/\r?\n/).find((line) => line.trim()) || "";
  const parsed = /^\s*\[?\s*[0-9]+(?::[0-9:.]+)?\s*(?:-|–|—|to)\s*/i.test(first)
    ? parseTimestampTimeline(value)
    : parseDurationTimeline(value);
  if (options.duration !== undefined) validateTimeline(parsed, options.duration);
  return parsed;
}

export const parseShotList = parseTimeline;
export const parseStoryboard = parseTimeline;
