import { createReadStream, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { IMAGE_NAME } from "../daemon/chat-images.ts";
import type { Authorize } from "./server.ts";
import { log } from "./log.ts";

/**
 * The pictures in the person's messages, for the windows (plan 029): `GET <prefix><name>` serves the file the daemon
 * wrote to the folder (daemon/chat-images.ts) as it read the message. The name is the picture's content, so it never
 * changes and is cached for good. A name this Mac does not hold (a picture in a chat that lives on a paired Mac) is
 * asked of the paired Macs (`fetchRemote`), kept here, and served: the window that asks never needs to know where the
 * chat lives.
 */

const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic" };

/** A route over HTTP: true when it answered the request. */
export type ImageRoute = (req: IncomingMessage, res: ServerResponse, url: URL) => boolean;

/**
 * The route for `prefix` (`/chat-images/` for the windows and the phone, `/peer/chat-images/` for paired Macs, which
 * fetch nothing further). `denied` is the status for a failed authorize.
 */
export function chatImageRoute(opts: {
  prefix: string;
  dir: string;
  authorize: Authorize;
  denied: 401 | 403;
  fetchRemote?: (name: string) => Promise<Buffer | null>;
}): ImageRoute {
  return (req, res, url) => {
    if (!url.pathname.startsWith(opts.prefix)) return false;
    const name = url.pathname.slice(opts.prefix.length);
    /** An answer with no body; the route has answered. */
    const end = (status: number): true => {
      res.writeHead(status).end();
      return true;
    };
    if (req.method !== "GET") return end(405);
    if (!opts.authorize(req, url).ok) return end(opts.denied);
    if (!IMAGE_NAME.test(name)) return end(404);
    const file = join(opts.dir, name);
    const send = () => {
      res.writeHead(200, { "content-type": TYPES[name.split(".")[1]] ?? "application/octet-stream", "cache-control": "private, max-age=31536000, immutable" });
      createReadStream(file).pipe(res);
    };
    if (existsSync(file)) {
      send();
      return true;
    }
    if (!opts.fetchRemote) return end(404);
    void opts.fetchRemote(name).then(
      (data) => {
        if (!data) return void end(404);
        try {
          mkdirSync(opts.dir, { recursive: true });
          writeFileSync(`${file}.tmp`, data);
          renameSync(`${file}.tmp`, file);
        } catch (err) {
          log("chat-images:keep-failed", { name, error: err instanceof Error ? err.message : String(err) });
          return void res.writeHead(200, { "content-type": TYPES[name.split(".")[1]] ?? "application/octet-stream" }).end(data);
        }
        send();
      },
      () => void end(502),
    );
    return true;
  };
}
