import { createReadStream, existsSync } from "node:fs";
import { pipeline } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { IMAGE_NAME } from "../daemon/chat-images.ts";
import type { Authorize } from "./server.ts";
import { log } from "./log.ts";
import { messageOf } from "../core/errors.ts";
import { writeFileAtomic } from "./json-file.ts";

const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic" };

const typeOf = (name: string) => TYPES[name.split(".")[1]] ?? "application/octet-stream";

export type ImageRoute = (req: IncomingMessage, res: ServerResponse, url: URL) => boolean;

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
    const end = (status: number): true => {
      res.writeHead(status).end();
      return true;
    };
    if (req.method !== "GET") return end(405);
    if (!opts.authorize(req, url).ok) return end(opts.denied);
    if (!IMAGE_NAME.test(name)) return end(404);
    const file = join(opts.dir, name);
    const send = () => {
      res.writeHead(200, { "content-type": typeOf(name), "cache-control": "private, max-age=31536000, immutable", "access-control-allow-origin": "*" });
      // pipeline, not pipe: a read that fails after the check above (the file removed, a disk error) would otherwise be
      // an error event nobody listens for, which ends the daemon. It ends this answer instead, and a client that goes
      // away part-way closes the file.
      pipeline(createReadStream(file), res, (err) => {
        if (err && err.code !== "ERR_STREAM_PREMATURE_CLOSE") log("chat-images:read-failed", { error: err.message });
      });
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
          writeFileAtomic(file, data);
        } catch (err) {
          log("chat-images:keep-failed", { name, error: messageOf(err) });
          return void res.writeHead(200, { "content-type": typeOf(name), "access-control-allow-origin": "*" }).end(data);
        }
        send();
      },
      () => void end(502),
    );
    return true;
  };
}
