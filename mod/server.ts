import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { WS_PROTOCOL, tokenFromProtocols } from "../core/ws-auth.ts";
import { WebSocketServer, WebSocket } from "./ws.ts";
import type { Scope } from "../core/desk-core.ts";
import { scopeFor } from "../core/desk-core.ts";
import { uploadRoute } from "./uploads.ts";

/**
 * Transport only. HTTP serves /health, /uploads (files attached to messages), the agents' faces, the WebSocket upgrade,
 * and the routes a caller adds (the MCP sign-in's callback); the canvas itself is the loki app (or, in development, a
 * Vite tab proxying /loki/* here).
 */

/**
 * The loopback desk server once listening: the port it bound (which differs from the one asked for when that was 0),
 * and how to close it.
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
 * closed when the device is forgotten, or a paired Mac's bearer token and names the Mac (mod/peers.ts).
 */
export type Authorize = (req: IncomingMessage, url: URL) => { ok: boolean; deviceId?: string; peerId?: string };

/**
 * The loopback server's Authorize: the desktop token, from the WebSocket subprotocol header or else `?t=`, compared in
 * constant time. With no token every request is refused.
 */
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

/**
 * Starts the loopback desk server on 127.0.0.1: /health, agent faces, uploads when given a folder, then the extra
 * routes in order; anything else is 404. Retries a port still held by the previous server on /reload.
 */
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

/**
 * One open /ws socket as a frame handler sees it: the desk it shows, the paired phone behind it if any, and how to send
 * to it.
 */
export interface Client {
  scope: Scope;
  /** The paired phone behind this socket (LAN listener only); undefined on loopback. */
  deviceId?: string;
  /** The paired Mac behind this socket (LAN listener only, over the tailnet); undefined on loopback and for phones. */
  peerId?: string;
  send(msg: object): void;
}

/** What a listener calls for each socket: once when it opens, and for each JSON object it sends. */
export interface WsHandlers {
  onConnect(client: Client): void;
  onMessage(client: Client, msg: Record<string, unknown>): void;
}

/** The open /ws sockets of one listener, to broadcast to, count, and close. */
export interface WsBridge {
  /** Send to every tab, or only tabs showing `scope`. */
  broadcast(msg: object, scope?: Scope): void;
  clientCount(): number;
  /** Terminate every socket a device holds. Returns how many. */
  closeDevice(deviceId: string): number;
  /** Terminate every socket a paired Mac holds. Returns how many. */
  closePeer(peerId: string): number;
  close(): void;
}

/**
 * WebSocket upgrades on `/ws` (the bridge). `auth` is the desktop
 * token (checked by tokenAuth: the subprotocol header, or `?t=`) or an Authorize callback; the handlers are the same
 * for both listeners.
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
      // Said, not just dropped: another Mac's link tells a refused token (it may have been forgotten) from a network fault.
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
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
      if (who.peerId) client.peerId = who.peerId;
      clients.set(ws, client);
      ws.on("close", () => clients.delete(ws));
      ws.on("message", (raw) => {
        let msg: unknown;
        try {
          msg = JSON.parse(messageText(raw));
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

  /** Terminate the sockets whose client matches. Returns how many. */
  const closeWhere = (match: (c: Client) => boolean): number => {
    let n = 0;
    for (const [ws, c] of clients) {
      if (!match(c)) continue;
      ws.terminate();
      clients.delete(ws);
      n++;
    }
    return n;
  };

  return {
    broadcast(msg, scope) {
      // A paired Mac follows every desk: it passes on the ones it shows of this Mac's (plan 023, U5).
      for (const [ws, c] of clients) if (!scope || c.scope === scope || c.peerId) send(ws, msg);
    },
    clientCount: () => clients.size,
    closeDevice: (deviceId) => closeWhere((c) => c.deviceId === deviceId),
    closePeer: (peerId) => closeWhere((c) => c.peerId === peerId),
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

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
/** A socket message as text: ws hands over a Buffer, an ArrayBuffer, or a message's fragments. */
const messageText = (raw: WebSocket.RawData): string =>
  (Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw)).toString("utf8");

/** The small page the browser shows after an MCP sign-in: signed in or not, and the message, escaped. */
export function oauthPage(ok: boolean, message: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>loki · ${ok ? "signed in" : "sign-in failed"}</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#222;background:#fafafa}@media(prefers-color-scheme:dark){body{color:#eee;background:#1b1b1d}}h1{font-size:18px}</style><h1>${ok ? "Signed in" : "Not signed in"}</h1><p>${escapeHtml(message)}</p>`;
}
