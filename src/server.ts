import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

export interface LociServer {
  server: Server;
  url: string;
  token: string;
  port: number;
  close(): Promise<void>;
}

export interface StartOptions {
  /** 0 = ephemeral (tests). Default: LOCI_PORT env or 41414. */
  port?: number;
  /** Directory of static web assets. Default: ./web relative to the built mod. */
  webRoot?: string;
}

/** Serve the canvas page on 127.0.0.1 with a URL token. No token, no page. */
export async function startServer(opts: StartOptions = {}): Promise<LociServer> {
  const port = opts.port ?? Number(process.env.LOCI_PORT ?? 41414);
  const webRoot = opts.webRoot ?? fileURLToPath(new URL("./web/", import.meta.url));
  const token = randomBytes(16).toString("hex");

  const server = createServer((req, res) => {
    void handle(req, res, { webRoot, token });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const actualPort = (server.address() as { port: number }).port;
  return {
    server,
    token,
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}/?t=${token}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { webRoot: string; token: string },
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (url.pathname === "/") {
    if (url.searchParams.get("t") !== ctx.token) {
      res.writeHead(403, { "content-type": "text/plain" }).end("loci: bad or missing token");
      return;
    }
    await serveFile(res, join(ctx.webRoot, "index.html"));
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    const rel = normalize(url.pathname.slice(1));
    if (rel.startsWith("..")) {
      res.writeHead(400).end();
      return;
    }
    await serveFile(res, join(ctx.webRoot, rel));
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" }).end("not found");
}

async function serveFile(res: ServerResponse, path: string): Promise<void> {
  try {
    const body = await readFile(path);
    res
      .writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" })
      .end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
}
