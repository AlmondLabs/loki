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
  /** Directory of runtime-authored widget bundles (served at /widgets/). */
  widgetsRoot?: string;
  /** Stable token (persisted by the mod so URLs survive /reload). Default: random. */
  token?: string;
}

/** Serve the canvas page on 127.0.0.1 with a URL token. No token, no page. */
export async function startServer(opts: StartOptions = {}): Promise<LociServer> {
  const port = opts.port ?? Number(process.env.LOCI_PORT ?? 41414);
  const webRoot = opts.webRoot ?? fileURLToPath(new URL("./web/", import.meta.url));
  const widgetsRoot =
    opts.widgetsRoot ?? fileURLToPath(new URL("../widgets/", import.meta.url));
  const token = opts.token ?? randomBytes(16).toString("hex");

  const server = createServer((req, res) => {
    void handle(req, res, { webRoot, widgetsRoot, token });
  });

  // On /reload the previous activation's server closes asynchronously;
  // retry briefly instead of failing with EADDRINUSE.
  await listenWithRetry(server, port);

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

async function listenWithRetry(server: Server, port: number, tries = 4): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.removeAllListeners("error");
          resolve();
        });
      });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE" || attempt >= tries) throw err;
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { webRoot: string; widgetsRoot: string; token: string },
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

  // Static web assets and vendor shims both live under webRoot.
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/vendor-shims/")) {
    const rel = safeRel(url.pathname);
    if (!rel) return void res.writeHead(400).end();
    await serveFile(res, join(ctx.webRoot, rel));
    return;
  }

  // Runtime-authored widget bundles.
  if (url.pathname.startsWith("/widgets/")) {
    const rel = safeRel(url.pathname.slice("/widgets/".length));
    if (!rel) return void res.writeHead(400).end();
    await serveFile(res, join(ctx.widgetsRoot, rel));
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" }).end("not found");
}

/** Normalize a URL path to a safe relative path, or null if it escapes. */
function safeRel(pathname: string): string | null {
  const rel = normalize(decodeURIComponent(pathname.replace(/^\//, "")));
  return rel.startsWith("..") || rel.includes("../") ? null : rel;
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
