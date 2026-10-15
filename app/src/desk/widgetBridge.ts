import type { Platform } from "./env";

/**
 * The wire between the page and an agent-written (module) widget, which runs in a sandboxed iframe
 * (ModuleWidget.tsx, app/src/frame/). `allow-scripts` and nothing else: the frame's origin is opaque, so it
 * cannot read the page's globals, its storage or the daemon token, and the page hears from it only through
 * postMessage, checked here. What a widget may ask for is what it could always do to its own widget: write
 * its data (`set`), come to the front (`focus`), open a web link in the browser (`open`), and say how big it
 * is and whether it broke. Everything else is dropped.
 */

/** The iframe's sandbox flags. Never add allow-same-origin: with it the frame shares the page's origin. */
export const WIDGET_SANDBOX = "allow-scripts";

/** The frame document, served next to the app (Vite in dev, app/dist in a build; see app/src/frame/build.ts). */
export const FRAME_PATH = "/widget-frame.html";

/** Tag on every message both ways, so stray messages (extensions, Vite) are never read as ours. */
export const BRIDGE = "loki-widget";

/** Longest dot-path a widget may write, and the deepest / largest value. */
const MAX_PATH = 256;
const MAX_DEPTH = 32;
const MAX_NODES = 20_000;
/** A frame larger than this is lying; it is drawn no larger. */
const MAX_SIDE = 20_000;

/** Page → frame. */
export type ToFrame =
  | { bridge: typeof BRIDGE; type: "load"; hash: string; url: string }
  | { bridge: typeof BRIDGE; type: "load"; hash: string; code: string }
  | { bridge: typeof BRIDGE; type: "data"; overlay: Record<string, unknown> | null }
  | { bridge: typeof BRIDGE; type: "style"; css: string; theme: string; palette: string }
  | { bridge: typeof BRIDGE; type: "layout"; fill: boolean; maxWidth: number };

/** Frame → page, as read by readFrameMessage. */
export type FromFrame =
  | { type: "ready" }
  | { type: "loaded"; hash: string; data: Record<string, unknown> }
  | { type: "error"; hash: string; message: string }
  | { type: "set"; path: string; value: unknown }
  | { type: "size"; width: number; height: number }
  | { type: "focus" }
  | { type: "open"; url: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Plain JSON data, no deeper or larger than a widget's data has any reason to be. */
export function isJsonValue(value: unknown): boolean {
  let nodes = 0;
  const walk = (v: unknown, depth: number): boolean => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return false;
    if (v === null || typeof v === "string" || typeof v === "boolean") return true;
    if (typeof v === "number") return Number.isFinite(v);
    if (Array.isArray(v)) return v.every((x) => walk(x, depth + 1));
    if (typeof v === "object") {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) return false;
      return Object.values(v as Record<string, unknown>).every((x) => walk(x, depth + 1));
    }
    return false;
  };
  return walk(value, 0);
}

/** A dot-path into the widget's own data; none of the keys that reach an object's prototype. */
export function isDataPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > MAX_PATH) return false;
  return path.split(".").every((k) => k.length > 0 && k !== "__proto__" && k !== "prototype" && k !== "constructor");
}

const isHash = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 128;
const side = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.ceil(v), MAX_SIDE) : null);

/**
 * One message from a widget frame, or null when it is not one we take: from any window but this frame's, not
 * tagged as ours, of an unknown type, or carrying the wrong shape. The frame's own word is all it says; the
 * page decides what a `set` means (which widget, what was there before).
 */
export function readFrameMessage(event: { source: unknown; data: unknown }, frame: Window | null | undefined): FromFrame | null {
  if (!frame || event.source !== frame) return null;
  const m = event.data;
  if (!isRecord(m) || m.bridge !== BRIDGE || typeof m.type !== "string") return null;
  switch (m.type) {
    case "ready":
      return { type: "ready" };
    case "focus":
      return { type: "focus" };
    case "loaded":
      if (!isHash(m.hash)) return null;
      return { type: "loaded", hash: m.hash, data: isRecord(m.data) && isJsonValue(m.data) ? (m.data as Record<string, unknown>) : {} };
    case "error":
      if (!isHash(m.hash) || typeof m.message !== "string") return null;
      return { type: "error", hash: m.hash, message: m.message.slice(0, 4000) };
    case "set":
      if (!isDataPath(m.path) || !("value" in m) || !isJsonValue(m.value)) return null;
      return { type: "set", path: m.path, value: m.value };
    case "size": {
      const width = side(m.width);
      const height = side(m.height);
      if (width === null || height === null) return null;
      return { type: "size", width, height };
    }
    case "open": {
      if (typeof m.url !== "string" || m.url.length > 4096) return null;
      try {
        const url = new URL(m.url);
        if (url.protocol !== "https:" && url.protocol !== "http:") return null;
        return { type: "open", url: url.href };
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}

/**
 * Where a widget's module comes from. In the shell the Rust core serves it transpiled under the `loki` scheme,
 * which WebView2 spells http://loki.localhost; the frame imports it from there. In a Vite tab the page fetches
 * it from the dev server (same origin, see app/vite.config.ts) and hands the frame the code: an opaque-origin
 * frame could not read a dev-server file itself without the server opening its files to every origin.
 */
export function widgetSource(file: string, hash: string, host: { tauri: boolean; os: Platform; dev: boolean }): { url: string } | { fetch: string } | null {
  // Both servers serve the transpiled module under the source's name with .js (widgets.rs; app/vite.config.ts, widgetModule).
  const path = file
    .replace(/\.(tsx|jsx)$/, ".js")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const v = `?v=${encodeURIComponent(hash)}`;
  if (host.tauri) {
    const base = host.os === "windows" ? "http://loki.localhost" : "loki://localhost";
    return { url: `${base}/widgets/${path}${v}` };
  }
  if (host.dev) return { fetch: `/@loki-widget/${path}${v}` };
  return null;
}
