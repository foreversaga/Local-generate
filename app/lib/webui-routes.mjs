/**
 * @typedef {"create" | "jobs" | "library" | "tools" | "settings"} PrimaryRouteId
 */

/**
 * @typedef {{
 *   id: PrimaryRouteId;
 *   label: string;
 *   href: string;
 * }} WebUiRoute
 */

import { NAV_LABELS } from "./ui-copy.mjs";

/** @type {readonly WebUiRoute[]} */
export const WEB_UI_ROUTES = Object.freeze([
  Object.freeze({ id: "create", label: NAV_LABELS.create, href: "/app/create" }),
  Object.freeze({ id: "jobs", label: NAV_LABELS.jobs, href: "/app/jobs" }),
  Object.freeze({ id: "library", label: NAV_LABELS.library, href: "/app/library" }),
  Object.freeze({ id: "tools", label: NAV_LABELS.tools, href: "/app/tools" }),
  Object.freeze({ id: "settings", label: NAV_LABELS.settings, href: "/app/settings" }),
]);

/** @type {readonly (readonly [PrimaryRouteId, string])[]} */
const PRIMARY_ROUTE_PREFIXES = Object.freeze([
  Object.freeze(["create", "/app/create"]),
  Object.freeze(["jobs", "/app/jobs"]),
  Object.freeze(["library", "/app/library"]),
  Object.freeze(["tools", "/app/tools"]),
  Object.freeze(["settings", "/app/settings"]),
]);

/**
 * @param {string} pathname
 * @returns {PrimaryRouteId}
 */
export function primaryRouteForPath(pathname) {
  const normalizedPath = normalizePath(pathname);
  const route = PRIMARY_ROUTE_PREFIXES.find(([, prefix]) => (
    normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
  ));

  return route?.[0] ?? "create";
}

/**
 * @param {string} pathname
 * @returns {string}
 */
export function routeTitle(pathname, locale = "zh-TW") {
  const normalizedPath = normalizePath(pathname);
  const english = locale === "en";

  if (normalizedPath.startsWith("/app/create/workspace/")) return english ? "Create / Project workspace" : "建立 / 專案工作區";
  if (normalizedPath === "/app/create/single") return english ? "Create / Single video" : "建立 / 單次影片";
  if (normalizedPath === "/app/create/long") return english ? "Create / Long video" : "建立 / 長影片";
  if (normalizedPath.startsWith("/app/jobs/") && normalizedPath !== "/app/jobs") return english ? "Job details" : "工作詳情";
  if (normalizedPath === "/app/tools/upscale") return english ? "Tools / Video upscale" : "工具 / 影片升頻";
  if (normalizedPath === "/app/tools/text-to-image") return english ? "Tools / Text to Image" : "工具 / 文字生圖";
  if (normalizedPath === "/app/tools/image-to-image") return english ? "Tools / Image to Image" : "工具 / 以圖生圖";
  if (normalizedPath === "/app/tools/pose-to-image") return english ? "Tools / OpenPose Pose to Image" : "工具 / OpenPose 骨架生圖";
  if (normalizedPath === "/app/tools/lora-trainer") return english ? "Tools / LoRA training" : "工具 / LoRA 訓練";

  const route = WEB_UI_ROUTES.find((item) => item.id === primaryRouteForPath(normalizedPath));
  if (!english) return route?.label ?? NAV_LABELS.create;
  return ({ create: "Create", jobs: "Jobs", library: "Library", tools: "Tools", settings: "Settings" })[route?.id || "create"];
}

/**
 * @param {string} pathname
 * @returns {string}
 */
function normalizePath(pathname) {
  const pathWithoutQuery = String(pathname || "/app").split(/[?#]/, 1)[0] || "/app";
  const trimmedPath = pathWithoutQuery.length > 1
    ? pathWithoutQuery.replace(/\/+$/, "")
    : pathWithoutQuery;

  if (trimmedPath === "/" || trimmedPath === "/app") return "/app/create";
  if (trimmedPath.startsWith("/app/")) return trimmedPath;
  if (trimmedPath.startsWith("/")) return `/app${trimmedPath}`;
  return `/app/${trimmedPath}`;
}
