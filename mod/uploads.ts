import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Authorize } from "./server.ts";
import { log } from "./log.ts";

/**
 * Files you attach to a message (anything but an image, which rides inside the message): the app uploads each
 * one here as soon as it is picked, and the message then carries its path in an attachment tag
 * (core/attention/content.ts), the shape Letta's Slack and Telegram channels used to hand files over. The agent
 * reads it with its own tools. Files land in <uploads>/<yyyy-mm-dd>/<name> (the day it was attached), a number added
 * when the name is taken; nothing outside that folder can be written or removed.
 *
 *   POST   /uploads?name=<file>&type=<mime>   the body is the file   → {path, name, size, mime}
 *   DELETE /uploads?path=<path>               a chip taken off before sending
 */

/** 25 MB (Letta's limit for a channel's media, kept): enough for a deck or a report, not a video. */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

export interface Uploaded {
  path: string;
  name: string;
  size: number;
  mime: string;
}

/** A name that stays one file inside its folder: no directories, no leading dots, nothing the shell trips on. */
export function safeName(raw: string): string {
  const base = basename(raw.replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f<>:"|?*]/g, "")
    .replace(/^\.+/, "")
    .trim();
  return base.slice(0, 180) || "file";
}

/** The day's folder name, in the Mac's local time: 2026-09-30. */
export function dayFolder(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The first free path for `name` in `dir`: q3.pdf, then q3 (2).pdf, q3 (3).pdf … */
export function freePath(dir: string, name: string, exists: (p: string) => boolean = existsSync): string {
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let n = 1; ; n++) {
    const p = join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
    if (!exists(p)) return p;
  }
}

/** Whether `p` is a file somewhere under `root` (never root itself, never outside it). */
export function insideDir(root: string, p: string): boolean {
  const rel = relative(resolve(root), resolve(p));
  return !!rel && !rel.startsWith("..") && !rel.startsWith(sep) && rel !== ".";
}

/**
 * The upload route, for both listeners (loopback with the desktop token, the LAN with a paired device). Returns
 * false when the URL is not this route. `guard` refuses cross-site posts where a cookie is the credential.
 */
export function uploadRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  opts: { authorize: Authorize; dir: string; denied: 401 | 403; guard?: (req: IncomingMessage) => { status: number; error: string } | null; maxBytes?: number },
): boolean {
  if (url.pathname !== "/uploads") return false;
  const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, DELETE", "access-control-allow-headers": "content-type" };
  const reply = (status: number, body?: object): true => {
    res.writeHead(status, { ...(body ? { "content-type": "application/json", "cache-control": "no-store" } : {}), ...cors }).end(body ? JSON.stringify(body) : undefined);
    return true;
  };
  if (req.method === "OPTIONS") return reply(204);
  if (!opts.authorize(req, url).ok) return reply(opts.denied);
  const refused = opts.guard?.(req);
  if (refused) return reply(refused.status, { error: refused.error });

  if (req.method === "DELETE") {
    const p = url.searchParams.get("path") ?? "";
    if (!insideDir(opts.dir, p)) return reply(400, { error: "not an upload" });
    rmSync(p, { force: true });
    log("uploads:removed", { path: p });
    return reply(200, { ok: true });
  }
  if (req.method !== "POST") return reply(405, { error: "POST or DELETE" });

  const max = opts.maxBytes ?? UPLOAD_MAX_BYTES;
  const declared = Number(req.headers["content-length"] ?? NaN);
  if (declared > max) return reply(413, { error: `over the ${Math.round(max / 1024 / 1024)} MB limit` });
  const name = safeName(url.searchParams.get("name") ?? "file");
  const mime = (url.searchParams.get("type") || String(req.headers["content-type"] ?? "") || "application/octet-stream").split(";")[0].trim();
  const folder = join(opts.dir, dayFolder());
  mkdirSync(folder, { recursive: true });
  const target = freePath(folder, name);
  const partial = join(dirname(target), `.${basename(target)}.part-${process.pid}-${Date.now()}`);
  const out = createWriteStream(partial);
  let size = 0;
  let failed = false;
  const fail = (status: number, error: string) => {
    if (failed) return;
    failed = true;
    out.destroy();
    rmSync(partial, { force: true });
    if (!res.headersSent) reply(status, { error });
  };
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > max) {
      fail(413, `over the ${Math.round(max / 1024 / 1024)} MB limit`);
      req.destroy();
    }
  });
  req.on("error", () => fail(400, "the upload broke off"));
  out.on("error", (err) => fail(500, err.message));
  req.pipe(out);
  out.on("finish", () => {
    if (failed) return;
    if (req.aborted || !req.complete) return fail(400, "the upload broke off");
    // Taken while this one streamed? Pick the next free name rather than overwrite.
    const final = existsSync(target) ? freePath(folder, name) : target;
    renameSync(partial, final);
    const file: Uploaded = { path: final, name: basename(final), size, mime };
    log("uploads:saved", { path: final, size, mime });
    reply(200, file);
  });
  return true;
}
