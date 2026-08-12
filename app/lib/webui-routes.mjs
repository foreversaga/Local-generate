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
export function routeTitle(pathname) {
  const normalizedPath = normalizePath(pathname);

  if (normalizedPath === "/app/create/single") return "建立 / 單次影片";
  if (normalizedPath === "/app/create/long") return "建立 / 長影片";
  if (normalizedPath.startsWith("/app/jobs/") && normalizedPath !== "/app/jobs") return "工作詳情";
  if (normalizedPath === "/app/tools/upscale") return "工具 / 影片升頻";
  if (normalizedPath === "/app/tools/image-to-image") return "工具 / 以圖生圖";
  if (normalizedPath === "/app/tools/lora-trainer") return "工具 / LoRA 訓練";

  return WEB_UI_ROUTES.find((route) => route.id === primaryRouteForPath(normalizedPath))?.label ?? NAV_LABELS.create;
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
