import vinext from "vinext";
import { defineConfig, type Connect, type Plugin, type PreviewServer, type ViteDevServer } from "vite";
import type { ServerResponse } from "node:http";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";
import { route as h3ApiRoute } from "./local-bridge.mjs";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for file watching.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";
// The phone connects through the already-open web port instead of Tailscale Serve.
const listenHost = "0.0.0.0";
const webPort = 8787;
const webBasePath = "/app";
const tailscaleHost = "barry.taile4899e.ts.net";

function stripWebBasePath(url = "/") {
  const parsed = new URL(url, "http://localhost");
  // Flight module references can already contain the base path when Vinext
  // adds it client-side, so accept and remove repeated `/app` prefixes too.
  while (parsed.pathname === webBasePath || parsed.pathname.startsWith(webBasePath + "/")) {
    parsed.pathname = parsed.pathname.slice(webBasePath.length) || "/";
  }
  return parsed.pathname + parsed.search;
}

function isH3ApiRequest(url = "/") {
  const pathname = new URL(stripWebBasePath(url), "http://localhost").pathname;
  return pathname === "/media" || pathname === "/api" || pathname.startsWith("/api/");
}

function normalizeWebRequestUrl(url = "/") {
  const parsed = new URL(stripWebBasePath(url), "http://localhost");
  if (
    ["/globals.css", "/page.tsx", "/layout.tsx"].includes(parsed.pathname) ||
    parsed.pathname.startsWith("/components/") ||
    parsed.pathname.startsWith("/lib/")
  ) {
    parsed.pathname = webBasePath + parsed.pathname;
  }
  return parsed.pathname + parsed.search;
}

function rewriteWebRequestUrl(req: Connect.IncomingMessage, url: string) {
  req.url = url;
  // vite-plugin-rsc restores req.url from originalUrl before handing the
  // request to Vinext, so both values must use the internally normalized URL.
  (req as Connect.IncomingMessage & { originalUrl?: string }).originalUrl = url;
}

function prefixWebAssetPaths(html: string) {
  return html.replace(
    /((?:href|src|data-rsc-css-href)=["'])\/(?!app(?:\/|["']))/g,
    "$1" + webBasePath + "/",
  ).replace(
    /(["'])\/(?!app(?:\/|["']))(?=(?:@id|node_modules|@vite|@react-refresh)(?:\/|["']))/g,
    "$1" + webBasePath + "/",
  );
}

function prefixWebModulePaths(source: string) {
  return source
    .replace(/(\bfrom\s*["'])\/(?!app(?:\/|["']))/g, "$1" + webBasePath + "/")
    .replace(/(\bimport\s*(?:\(\s*)?["'])\/(?!app(?:\/|["']))/g, "$1" + webBasePath + "/")
    .replace(/(\bexport\s+(?:\{[^}]*\}\s*)?from\s*["'])\/(?!app(?:\/|["']))/g, "$1" + webBasePath + "/")
    .replace(
      /createHotContext\("\/(?!app(?:\/|"))/g,
      `createHotContext("${webBasePath}/`,
    )
    // Keep Vite's root BASE_URL: the dev RSC loader prepends it to client
    // reference IDs that already include /app via the router base path.
    .replace(
      /process\.env\.__NEXT_ROUTER_BASEPATH \?\? ""/g,
      JSON.stringify(webBasePath),
    );
}

function webResponseKind(contentType: string): "html" | "javascript" | null {
  if (contentType.includes("text/html")) return "html";
  if (contentType.includes("javascript")) return "javascript";
  return null;
}

function disableRemoteDevHmr(): Plugin {
  const disabledHmrContext = `const __vinextDisabledHmr = {
  data: {},
  on() {},
  off() {},
  dispose() {},
};
`;

  return {
    name: "disable-remote-dev-hmr",
    enforce: "pre",
    transform(code, id) {
      const normalizedId = id.replaceAll("\\\\", "/");
      if (!code.includes("import.meta.hot")) return null;

      if (normalizedId.includes("virtual:vite-rsc/entry-browser")) {
        return {
          code: disabledHmrContext + code.replaceAll("import.meta.hot", "__vinextDisabledHmr"),
          map: null,
        };
      }

      if (normalizedId.includes("/node_modules/vinext/dist/server/app-browser-entry.js")) {
        return {
          code: code.replaceAll("import.meta.hot", "null"),
          map: null,
        };
      }

      return null;
    },
  };
}

function disableWebCache(res: ServerResponse) {
  if (res.headersSent) return;
  res.setHeader("Cache-Control", "no-store");
  res.removeHeader("ETag");
}

type WriteCallback = (error: Error | null | undefined) => void;
type EndCallback = () => void;
type ResponseChunk = string | Uint8Array;

function isWriteCallback(value: unknown): value is WriteCallback {
  return typeof value === "function";
}

function isEndCallback(value: unknown): value is EndCallback {
  return typeof value === "function";
}

function responseChunkToString(chunk: ResponseChunk): string {
  return typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
}

function h3ApiPlugin(): Plugin {
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const normalizedUrl = normalizeWebRequestUrl(req.url);
    const responseChunks: string[] = [];
    let capturedKind: "html" | "javascript" | null = null;
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    const captureWrite: typeof res.write = (...args) => {
      const contentType = String(res.getHeader("content-type") || "");
      const kind = webResponseKind(contentType);
      if (!kind) {
        const [chunk, encoding, callback] = args;
        if (typeof encoding === "string") {
          return originalWrite(chunk, encoding, isWriteCallback(callback) ? callback : undefined);
        }
        if (isWriteCallback(encoding)) return originalWrite(chunk, encoding);
        if (isWriteCallback(callback)) return originalWrite(chunk, callback);
        return originalWrite(chunk);
      }
      disableWebCache(res);
      capturedKind = kind;
      const [chunk] = args;
      if (chunk !== undefined && chunk !== null) {
        responseChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      }
      return true;
    };
    function captureEnd(callback?: EndCallback): ServerResponse;
    function captureEnd(chunk: ResponseChunk, callback?: EndCallback): ServerResponse;
    function captureEnd(chunk: ResponseChunk, encoding: BufferEncoding, callback?: EndCallback): ServerResponse;
    function captureEnd(
      chunk?: ResponseChunk | EndCallback,
      encodingOrCallback?: BufferEncoding | EndCallback,
      callback?: EndCallback,
    ): ServerResponse {
      const contentType = String(res.getHeader("content-type") || "");
      const kind = capturedKind || webResponseKind(contentType);
      if (!kind) {
        if (typeof encodingOrCallback === "string") {
          return originalEnd(chunk, encodingOrCallback, callback);
        }
        if (isEndCallback(encodingOrCallback)) return originalEnd(chunk, encodingOrCallback);
        if (isEndCallback(callback)) return originalEnd(chunk, callback);
        if (isEndCallback(chunk)) return originalEnd(chunk);
        if (chunk === undefined) return originalEnd();
        return originalEnd(chunk);
      }
      disableWebCache(res);
      if (chunk !== undefined && !isEndCallback(chunk)) {
        responseChunks.push(responseChunkToString(chunk));
      }
      const source = responseChunks.join("");
      const body = kind === "html" ? prefixWebAssetPaths(source) : prefixWebModulePaths(source);
      if (typeof encodingOrCallback === "string") {
        return originalEnd(body, encodingOrCallback, callback);
      }
      if (isEndCallback(encodingOrCallback)) return originalEnd(body, encodingOrCallback);
      if (isEndCallback(callback)) return originalEnd(body, callback);
      if (isEndCallback(chunk)) return originalEnd(body, chunk);
      return originalEnd(body);
    }
    res.write = captureWrite;
    res.end = captureEnd;
    if (!isH3ApiRequest(req.url)) {
      disableWebCache(res);
      rewriteWebRequestUrl(req, normalizedUrl);
      next();
      return;
    }
    rewriteWebRequestUrl(req, normalizedUrl);
    h3ApiRoute(req, res).catch((error: unknown) => {
      console.error("[h3-api]", error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : "H3 API request failed." }));
      } else {
        res.end();
      }
    });
  };

  return {
    name: "h3-local-api",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server: PreviewServer) {
      server.middlewares.use(middleware);
    },
  };
}


const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: {
      host: listenHost,
      port: webPort,
      strictPort: true,
      allowedHosts: [tailscaleHost],
      hmr: false,
      ws: false as const,
      forwardConsole: false,
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
    },
    plugins: [
      disableRemoteDevHmr(),
      h3ApiPlugin(),
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
