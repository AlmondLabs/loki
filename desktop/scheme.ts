import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { widgetModule } from "../app/src/frame/widget-module.ts";

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
    `frame-src ${APP_ORIGIN}/widget-frame.html`,
    "object-src 'none'",
    "base-uri 'none'",
  ].join("; ");
}

export async function serveApp(root: string, url: URL): Promise<Response> {
  const file = appFile(url.pathname);
  if (!file) return new Response("not found", { status: 404 });
  let body: Buffer;
  try {
    body = await readFile(join(root, file));
  } catch {
    return new Response("not found", { status: 404 });
  }
  const headers: Record<string, string> = { "content-type": contentType(file), "cache-control": "no-cache" };
  if (file.endsWith(".html") && file !== "widget-frame.html") headers["content-security-policy"] = pageCsp(inlineScriptHashes(body.toString("utf8")));
  return new Response(new Uint8Array(body), { headers });
}

export async function serveWidget(widgetsDir: string, url: URL): Promise<Response> {
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname.replace(/^\/widgets\//, ""));
  } catch {
    return new Response("not found", { status: 404 });
  }
  const code = url.pathname.startsWith("/widgets/") ? await widgetModule(widgetsDir, rel) : null;
  if (code === null) return new Response("not found", { status: 404 });
  return new Response(code, {
    headers: { "content-type": "text/javascript; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" },
  });
}
