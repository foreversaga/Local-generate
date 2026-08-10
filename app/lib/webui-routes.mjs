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

/** @type {readonly WebUiRoute[]} */
export const WEB_UI_ROUTES = Object.freeze([
  Object.freeze({ id: "create", label: "Create", href: "/app/create" }),
  Object.freeze({ id: "jobs", label: "Jobs", href: "/app/jobs" }),
  Object.freeze({ id: "library", label: "Library", href: "/app/library" }),
  Object.freeze({ id: "tools", label: "Tools", href: "/app/tools" }),
  Object.freeze({ id: "settings", label: "Settings", href: "/app/settings" }),
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

  if (normalizedPath === "/app/create/single") return "Create / Single";
  if (normalizedPath === "/app/create/long") return "Create / Long";
  if (normalizedPath.startsWith("/app/jobs/") && normalizedPath !== "/app/jobs") return "Job Detail";
  if (normalizedPath === "/app/tools/upscale") return "Upscale";
  if (normalizedPath === "/app/tools/image-to-image") return "Image to Image";

  return WEB_UI_ROUTES.find((route) => route.id === primaryRouteForPath(normalizedPath))?.label ?? "Create";
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
