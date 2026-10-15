import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { WS_PROTOCOL, tokenFromProtocols } from "../core/ws-auth.ts";
import { WebSocketServer, WebSocket } from "./ws.ts";
import type { Scope } from "../core/desk-core.ts";
import { scopeFor } from "../core/desk-core.ts";
import { uploadRoute } from "./uploads.ts";

/**
 * Transport only. HTTP exists for /health, /uploads (files attached to messages) and the WebSocket upgrade; the
 * canvas itself is the loki app (or, in development, a Vite tab proxying /loki/* here).
 */

export interface LokiServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

/**
 * Who may upgrade to /ws, or fetch an agent's face. The loopback server
 * checks the desktop token (tokenAuth): from the subprotocol header on /ws (core/ws-auth.ts), from `?t=` on what an
 * <img> fetches, compared in constant time; the LAN listener (mod/lan.ts)
 * looks a device cookie or bearer up and names the device, so its sockets can be
 * closed when the device is forgotten.
 */
export type Authorize = (req: IncomingMessage, url: URL) => { ok: boolean; deviceId?: string };

export const tokenAuth =
  (token: string | undefined): Authorize =>
  (req, url) => ({ ok: !!token && sameSecret(tokenFromProtocols(req.headers["sec-websocket-protocol"]) ?? url.searchParams.get("t"), token) });

/** Whether `given` is `secret`, in time that does not depend on where they first differ. */
export function sameSecret(given: string | null | undefined, secret: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A route of the mod's own beyond the server's: true when it took the request. */
export type Route = (req: IncomingMessage, res: ServerResponse, url: URL) => boolean;

export async function startServer(opts: {
  port: number;
  health?: () => object;
  token?: string;
  profile?: (agentId: string) => string | null;
  authorize?: Authorize;
  uploads?: string;
  routes?: Route[];
}): Promise<LokiServer> {
  const authorize = opts.authorize ?? tokenAuth(opts.token);
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...(opts.health?.() ?? {}) }));
        return;
      }
      if (profileRoute(req, res, url, authorize, opts.profile, 403)) return;
      if (opts.uploads && uploadRoute(req, res, url, { authorize, dir: opts.uploads, denied: 403 })) return;
      if (opts.routes?.some((route) => route(req, res, url))) return;
      res.writeHead(404, { "content-type": "text/plain" }).end("loki: not found");
    } catch {
      res.writeHead(400).end();
    }
  });
  await listenWithRetry(server, opts.port);
  const port = (server.address() as { port: number }).port;
  return { server, port, close: () => closeServer(server) };
}

/**
 * The agent's face: GET /agents/<id>/profile.png, read from its memory filesystem, never cached long.
 * Returns false when the URL is not this route. `denied` is the status for a failed authorize
 * (403 on loopback, where the token is the only credential; 401 on the LAN, where the page can pair).
 */
export function profileRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  authorize: Authorize,
  profile: ((agentId: string) => string | null) | undefined,
  denied: 401 | 403,
): boolean {
  const face = /^\/agents\/([^/]+)\/profile\.png$/.exec(url.pathname);
  if (!face) return false;
  if (!authorize(req, url).ok) {
    res.writeHead(denied).end();
    return true;
  }
  const p = profile?.(decodeURIComponent(face[1])) ?? null;
  if (!p) {
    res.writeHead(404).end();
    return true;
  }
  res.writeHead(200, { "content-type": "image/png", "cache-control": "private, max-age=60", "access-control-allow-origin": "*" });
  res.end(readFileSync(p));
  return true;
}

/** Close, and never wait more than a second: keep-alive and upgraded sockets would otherwise hold /reload open. */
export function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(fallback);
      resolve();
    };
    const fallback = setTimeout(done, 1000);
    server.close(done);
    server.closeAllConnections();
  });
}

/** On /reload the previous server closes asynchronously; retry instead of EADDRINUSE. */
export async function listenWithRetry(server: Server, port: number, tries = 4, host = "127.0.0.1"): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeAllListeners("error");
          resolve();
        });
      });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= tries) throw err;
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
}

export interface Client {
  scope: Scope;
  /** The paired phone behind this socket (LAN listener only); undefined on loopback. */
  deviceId?: string;
  send(msg: object): void;
}

export interface WsHandlers {
  onConnect(client: Client): void;
  onMessage(client: Client, msg: Record<string, unknown>): void;
}

export interface WsBridge {
  /** Send to every tab, or only tabs showing `scope`. */
  broadcast(msg: object, scope?: Scope): void;
  clientCount(): number;
  /** Terminate every socket a device holds. Returns how many. */
  closeDevice(deviceId: string): number;
  close(): void;
}

/**
 * WebSocket upgrades on `/ws` (the bridge). `auth` is the desktop
 * token (checked as `?t=`) or an Authorize callback; the handlers are the same for both listeners.
 */
export function attachWs(server: Server, auth: string | Authorize, handlers: WsHandlers): WsBridge {
  const authorize: Authorize = typeof auth === "string" ? tokenAuth(auth) : auth;
  // A tab that sent its token in the subprotocol header is answered `loki`; one that sent none is asked nothing.
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false) });
  const clients = new Map<WebSocket, Client>();

  server.on("upgrade", (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      socket.destroy();
      return;
    }
    const who = authorize(req, url);
    if (!who.ok) {
      socket.destroy();
      return;
    }
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const scope = scopeFor(url.searchParams.get("desk"));
    wss.handleUpgrade(req, socket, head, (ws) => {
      const client: Client = { scope, send: (msg) => send(ws, msg) };
      if (who.deviceId) client.deviceId = who.deviceId;
      clients.set(ws, client);
      ws.on("close", () => clients.delete(ws));
      ws.on("message", (raw) => {
        let msg: unknown;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          send(ws, { type: "error", message: "invalid json" });
          return;
        }
        if (typeof msg !== "object" || msg === null) return;
        try {
          handlers.onMessage(client, msg as Record<string, unknown>);
        } catch (err) {
          send(ws, { type: "error", message: err instanceof Error ? err.message : String(err) });
        }
      });
      handlers.onConnect(client);
    });
  });

  return {
    broadcast(msg, scope) {
      for (const [ws, c] of clients) if (!scope || c.scope === scope) send(ws, msg);
    },
    clientCount: () => clients.size,
    closeDevice(deviceId) {
      let n = 0;
      for (const [ws, c] of clients) {
        if (c.deviceId !== deviceId) continue;
        ws.terminate();
        clients.delete(ws);
        n++;
      }
      return n;
    },
    close: () => {
      for (const ws of clients.keys()) ws.terminate(); // tabs reconnect on their own
      clients.clear();
      wss.close();
    },
  };
}

function send(ws: WebSocket, msg: object): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/**
 * The browser back from signing in to a remote MCP server: GET MCP_OAUTH_CALLBACK with the server's `code` and
 * loki's one-time `state`. No token, since a browser redirect carries none: the state is the credential (unknown or
 * used, nothing happens), and the route is on the loopback server only, never the LAN's. Answers with a page to close.
 */
export function oauthCallbackRoute(path: string, finish: (params: Record<string, string>) => Promise<{ ok: boolean; message: string }>): Route {
  return (req, res, url) => {
    if (url.pathname !== path) return false;
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return true;
    }
    void finish(Object.fromEntries(url.searchParams))
      .catch((error: unknown) => ({ ok: false, message: error instanceof Error ? error.message : String(error) }))
      .then((r) => {
        res.writeHead(r.ok ? 200 : 400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" });
        res.end(oauthPage(r.ok, r.message));
      });
    return true;
  };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function oauthPage(ok: boolean, message: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>loki · ${ok ? "signed in" : "sign-in failed"}</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#222;background:#fafafa}@media(prefers-color-scheme:dark){body{color:#eee;background:#1b1b1d}}h1{font-size:18px}</style><h1>${ok ? "Signed in" : "Not signed in"}</h1><p>${escapeHtml(message)}</p>`;
}
