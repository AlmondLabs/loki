import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import { appDistCandidates } from "./paths.ts";

/**
 * The built canvas (app/dist), served to phones by the LAN listener as a single-page app:
 * files under the dist as they are, every extension-less path as index.html with a boot
 * script that tells main.tsx it is in LAN mode. Without a dist there is nothing to serve
 * and `/` says so.
 */
export const LAN_BOOT_SCRIPT = "<script>window.__LOKI__={lan:true}</script>";

/**
 * The build id of a dist: a short hash of its index.html, which Vite rewrites with new asset names on
 * every build. A home-screen web app has no reload button, so the page compares this with what it was
 * served (`window.__LOKI__.build`, `/health`, the `app_build` frame) and offers to reload itself.
 */
export function buildIdOf(dist: string | null): string | null {
  if (!dist) return null;
  try {
    return createHash("sha256").update(readFileSync(join(dist, "index.html"))).digest("hex").slice(0, 12);
  } catch {
    return null;
  }
}

/** The boot script with the build stamped in. */
export function bootScript(build: string | null): string {
  return build ? `<script>window.__LOKI__={lan:true,build:${JSON.stringify(build)}}</script>` : LAN_BOOT_SCRIPT;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/** The first candidate directory that holds an index.html, or null. */
export function resolveAppDist(candidates: string[] = appDistCandidates): string | null {
  for (const dir of candidates) {
    try {
      // A Vite build has index.html and assets/; the source app/ has only index.html and must be skipped.
      if (existsSync(join(dir, "index.html")) && existsSync(join(dir, "assets"))) return resolve(dir);
    } catch {
      // unreadable: next
    }
  }
  return null;
}

export type StaticHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => void;

export function createStaticApp(dist: string | null): StaticHandler {
  if (!dist) return serveMissing;
  const root = resolve(dist);
  return (req, res, url) => {
    if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405, { allow: "GET, HEAD" }).end();
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return void notFound(res);
    }
    const ext = extname(pathname);
    // Routes have no extension; an explicit /index.html is the same page and must carry the boot script too.
    if (!ext || pathname === "/index.html") return void serveIndex(root, res);
    // Resolve inside the dist and refuse anything that escapes it (".." in any encoding).
    const file = resolve(root, `.${pathname}`);
    const rel = relative(root, file);
    if (!rel || rel.startsWith("..") || rel.split(sep).includes("..") || resolve(root, rel) !== file) return void notFound(res);
    let body: Buffer;
    try {
      if (!statSync(file).isFile()) return void notFound(res);
      body = readFileSync(file);
    } catch {
      return void notFound(res);
    }
    const immutable = rel.startsWith(`assets${sep}`); // Vite hashes everything under assets/
    res.writeHead(200, {
      "content-type": TYPES[ext.toLowerCase()] ?? "application/octet-stream",
      "content-length": body.length,
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  };
}

function serveIndex(root: string, res: ServerResponse): void {
  let html: string;
  try {
    html = readFileSync(join(root, "index.html"), "utf8");
  } catch {
    return void serveMissing(undefined, res);
  }
  const boot = bootScript(createHash("sha256").update(html).digest("hex").slice(0, 12));
  const i = html.indexOf("</head>");
  html = i >= 0 ? html.slice(0, i) + boot + html.slice(i) : boot + html;
  res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-cache" });
  res.end(html);
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" }).end("loki: not found");
}

const MISSING_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>loki</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101014;color:#d9d6cf;font:15px/1.5 -apple-system,system-ui,sans-serif}main{max-width:32em;padding:2em}code{color:#c9a86a}</style>
</head><body><main><h1 style="font-size:17px;margin:0 0 .5em">loki is on, but the phone app is not built</h1>
<p>This loki has no <code>app/dist</code> to serve. In the checkout run <code>bun run build:app</code>, then <code>bun run build:mod</code>, and reload the mod.</p>
</main></body></html>
`;

function serveMissing(_req: IncomingMessage | undefined, res: ServerResponse): void {
  res.writeHead(503, { "content-type": TYPES[".html"], "cache-control": "no-cache", "retry-after": "30" });
  res.end(MISSING_PAGE);
}
