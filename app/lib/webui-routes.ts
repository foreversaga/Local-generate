export type PrimaryRouteId = "create" | "jobs" | "library" | "tools" | "settings";

export interface WebUiRoute {
    id: PrimaryRouteId;
    label: string;
    href: string;
}

export const WEB_UI_ROUTES: readonly WebUiRoute[] = [
    { id: "create", label: "Create", href: "/app/create" },
    { id: "jobs", label: "Jobs", href: "/app/jobs" },
    { id: "library", label: "Library", href: "/app/library" },
    { id: "tools", label: "Tools", href: "/app/tools/upscale" },
    { id: "settings", label: "Settings", href: "/app/settings" },
] as const;

const PRIMARY_ROUTE_PREFIXES: ReadonlyArray<readonly [PrimaryRouteId, string]> = [
    ["create", "/app/create"],
    ["jobs", "/app/jobs"],
    ["library", "/app/library"],
    ["tools", "/app/tools"],
    ["settings", "/app/settings"],
];

export function primaryRouteForPath(pathname: string): PrimaryRouteId {
    const normalizedPath = normalizePath(pathname);
    const route = PRIMARY_ROUTE_PREFIXES.find(([, prefix]) => (
        normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
    ));

    return route?.[0] ?? "create";
}

export function routeTitle(pathname: string): string {
    const normalizedPath = normalizePath(pathname);

    if (normalizedPath === "/app/create/single") return "Create / Single";
    if (normalizedPath === "/app/create/long") return "Create / Long";
    if (normalizedPath.startsWith("/app/jobs/") && normalizedPath !== "/app/jobs") return "Job Detail";
    if (normalizedPath === "/app/tools/image-to-image") return "Image to Image";
    if (normalizedPath === "/app/tools/upscale") return "Upscale";

    return WEB_UI_ROUTES.find((route) => route.id === primaryRouteForPath(normalizedPath))?.label ?? "Create";
}

function normalizePath(pathname: string): string {
    const pathWithoutQuery = pathname.split(/[?#]/, 1)[0] || "/app";
    const trimmedPath = pathWithoutQuery.length > 1
        ? pathWithoutQuery.replace(/\/+$/, "")
        : pathWithoutQuery;

    return trimmedPath === "/app" ? "/app/create" : trimmedPath;
}
