import { createServer, request as requestHttp } from "node:http";
import { fileURLToPath } from "node:url";

import { startProdServer } from "vinext/server/prod-server";
import { installProcessErrorBoundary } from "./process-error-boundary.mjs";

const processErrorBoundary = installProcessErrorBoundary();
const { route: h3ApiRoute } = await import("../local-bridge.mjs");

const PUBLIC_HOST = "0.0.0.0";
const PUBLIC_PORT = 8787;
const VINEXT_HOST = "127.0.0.1";
const VINEXT_PORT = 8788;
const WEB_BASE_PATH = "/app";

function stripWebBasePath(url = "/") {
  const parsed = new URL(url, "http://localhost");
  while (parsed.pathname === WEB_BASE_PATH || parsed.pathname.startsWith(WEB_BASE_PATH + "/")) {
    parsed.pathname = parsed.pathname.slice(WEB_BASE_PATH.length) || "/";
  }
  return parsed.pathname + parsed.search;
}

function isBridgeRequest(url = "/") {
  const pathname = new URL(stripWebBasePath(url), "http://localhost").pathname;
  return pathname === "/media" || pathname === "/api" || pathname.startsWith("/api/");
}

function proxyToVinext(req, res) {
  const upstream = requestHttp({
    hostname: VINEXT_HOST,
    port: VINEXT_PORT,
    method: req.method,
    path: stripWebBasePath(req.url),
    headers: { ...req.headers, host: `${VINEXT_HOST}:${VINEXT_PORT}` },
  }, (upstreamResponse) => {
    res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.statusMessage, upstreamResponse.headers);
    upstreamResponse.pipe(res);
  });
  upstream.on("error", (error) => {
    console.error("[production-web] Vinext proxy error:", error);
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Production web server is unavailable.");
  });
  req.pipe(upstream);
}

await startProdServer({
  port: VINEXT_PORT,
  host: VINEXT_HOST,
  outDir: fileURLToPath(new URL("../dist", import.meta.url)),
  silent: true,
});

const server = createServer((req, res) => {
  if (!isBridgeRequest(req.url)) {
    proxyToVinext(req, res);
    return;
  }
  req.url = stripWebBasePath(req.url);
  h3ApiRoute(req, res).catch((error) => {
    console.error("[production-web] H3 API error:", error);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : "H3 API request failed." }));
  });
});

server.listen(PUBLIC_PORT, PUBLIC_HOST, () => {
  console.log(`[production-web] H3 Studio production server running at http://${PUBLIC_HOST}:${PUBLIC_PORT}${WEB_BASE_PATH}`);
  console.log(`[production-web] Process error boundary installed at ${processErrorBoundary.snapshot().installedAt}`);
});
