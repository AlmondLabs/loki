import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";

export const SCHEME = "loki";
export const APP_ORIGIN = `${SCHEME}://app`;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

export function contentType(file: string): string {
  return TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
}

export function appFile(pathname: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname.replace(/^\/+/, ""));
  } catch {
    return null;
  }
  if (rel === "") return "index.html";
  if (rel.split("/").some((part) => part === ".." || part === ".") || rel.includes("\\") || rel.includes(":") || rel.startsWith("/")) return null;
  return rel;
}

export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const match of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    if (/\ssrc\s*=/i.test(match.at(1) ?? "")) continue;
    hashes.push(
      `'sha256-${createHash("sha256")
        .update(match.at(2) ?? "")
        .digest("base64")}'`,
    );
  }
  return hashes;
}

export function pageCsp(scriptHashes: string[]): string {
  return [
    "default-src 'self'",
    ["script-src 'self'", ...scriptHashes].join(" "),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: http://127.0.0.1:* https:",
    "font-src 'self' data:",
    "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* https: wss:",
    "media-src 'self' blob: data:",
    "object-src 'none'",
    "base-uri 'none'",
  ].join("; ");
}

const cspCache = new Map<string, { mtimeMs: number; size: number; csp: string }>();

export async function serveApp(root: string, url: URL): Promise<Response> {
  const file = appFile(url.pathname);
  if (!file) return new Response("not found", { status: 404 });
  const full = join(root, file);
  let body: Buffer;
  try {
    body = await readFile(full);
  } catch {
    return new Response("not found", { status: 404 });
  }
  const cacheControl = file.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache";
  const headers: Record<string, string> = { "content-type": contentType(file), "cache-control": cacheControl };
  if (file.endsWith(".html")) {
    let csp: string | null = null;
    try {
      const st = await stat(full);
      const hit = cspCache.get(full);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) csp = hit.csp;
      else {
        csp = pageCsp(inlineScriptHashes(body.toString("utf8")));
        cspCache.set(full, { mtimeMs: st.mtimeMs, size: st.size, csp });
      }
    } catch {
      csp = pageCsp(inlineScriptHashes(body.toString("utf8")));
    }
    headers["content-security-policy"] = csp;
  }
  return new Response(new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength), { headers });
}
