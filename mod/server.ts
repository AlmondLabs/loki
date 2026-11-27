import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { WS_PROTOCOL, tokenFromProtocols } from "../core/ws-auth.ts";
import { WebSocketServer, WebSocket } from "./ws.ts";
import type { Scope } from "../core/chat-scope.ts";
import { scopeFor } from "../core/chat-scope.ts";
import { uploadRoute } from "./uploads.ts";
import { messageOf } from "../core/errors.ts";
import { GOOGLE_OAUTH_CALLBACK } from "./google-signin.ts";

export interface LokiServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export type Authorize = (req: IncomingMessage, url: URL) => { ok: boolean; deviceId?: string; peerId?: string; refusal?: Refusal };

export type Refusal = 401 | 403;

export const tokenAuth =
  (token: string | undefined): Authorize =>
  (req, url) => ({ ok: !!token && sameSecret(tokenFromProtocols(req.headers["sec-websocket-protocol"]) ?? url.searchParams.get("t"), token) });

export function sameSecret(given: string | null | undefined, secret: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type Route = (req: IncomingMessage, res: ServerResponse, url: URL) => boolean;

export async function startServer(opts: {
  port: number;
  health?: () => object;
  token?: string;
  profile?: (agentId: string) => string | null;
  authorize?: Authorize;
  uploads?: string;
  routes?: Route[];
  googleSignIn?: (params: Record<string, string>) => Promise<{ ok: boolean; message: string }>;
}): Promise<LokiServer> {
  const authorize = opts.authorize ?? tokenAuth(opts.token);
  const google = opts.googleSignIn && oauthCallbackRoute(GOOGLE_OAUTH_CALLBACK, opts.googleSignIn);
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
      if (google?.(req, res, url)) return;
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
  deviceId?: string;
  peerId?: string;
  send(msg: object, sent?: () => void): void;
}

export interface WsHandlers {
  onConnect(client: Client): void;
  onMessage(client: Client, msg: Record<string, unknown>): void;
}

export type Audience = "all" | "macs";

export interface WsBridge {
  broadcast(msg: object, scope?: Scope, to?: Audience): void;
  broadcastText?(text: string, scope?: Scope, to?: Audience): void;
  clientCount(): number;
  closeDevice(deviceId: string): number;
  closePeer(peerId: string): number;
  closeDevices(): number;
  close(): void;
}

/**
 * The largest frame a socket may send: room for a message with several pictures, which the page shrinks first. The
 * library's own limit is 100 MB, and one frame that size from a paired device would hold the daemon in JSON.parse.
 */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;
export const HEARTBEAT_MS = 30_000;
/**
 * The most that may wait unsent on one socket. A phone that left the Wi-Fi stays "open" until TCP gives up, minutes
 * later, and every push meanwhile is kept in memory for it; past this the socket is ended, and the device reads what
 * it missed when it connects again.
 */
export const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

export interface WsLimits {
  maxFrameBytes?: number;
  heartbeatMs?: number;
  maxBufferedBytes?: number;
}

export function attachWs(server: Server, auth: string | Authorize, handlers: WsHandlers, limits: WsLimits = {}): WsBridge {
  const authorize: Authorize = typeof auth === "string" ? tokenAuth(auth) : auth;
  const maxBuffered = limits.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: limits.maxFrameBytes ?? MAX_FRAME_BYTES,
    handleProtocols: (protocols) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
  });
  const clients = new Map<WebSocket, Client>();
  const alive = new Set<WebSocket>();
  const send = (ws: WebSocket, text: string, sent?: () => void): void => {
    if (ws.readyState !== WebSocket.OPEN) return sent?.();
    if (ws.bufferedAmount > maxBuffered) {
      ws.terminate();
      clients.delete(ws);
      return sent?.();
    }
    ws.send(text, sent && (() => sent()));
  };
  const heartbeat = setInterval(() => {
    for (const ws of clients.keys()) {
      if (!alive.has(ws)) {
        ws.terminate();
        clients.delete(ws);
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, limits.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref();

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
      const status = who.refusal === 403 ? "403 Forbidden" : "401 Unauthorized";
      // Outside (Node): Node takes its own error listener off a socket it hands to "upgrade", and ws only adds one for an upgrade it
      // takes. A caller that hangs up on the refusal with a reset (another Mac's link drops it at once) is an error on
      // this socket, and an error nobody listens for ends the daemon. The answer is already given, so the socket goes.
      socket.on("error", () => socket.destroy());
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const scope = scopeFor(url.searchParams.get("desk"));
    wss.handleUpgrade(req, socket, head, (ws) => {
      const client: Client = { scope, send: (msg, sent) => send(ws, JSON.stringify(msg), sent) };
      if (who.deviceId) client.deviceId = who.deviceId;
      if (who.peerId) client.peerId = who.peerId;
      clients.set(ws, client);
      alive.add(ws);
      ws.on("pong", () => alive.add(ws));
      ws.on("close", () => {
        clients.delete(ws);
        alive.delete(ws);
      });
      // Outside (Node): ws emits a frame it cannot read (bad UTF-8, too large) as an error before the close, and an
      // error nobody listens for is thrown: one bad client would end the daemon.
      ws.on("error", () => {});
      ws.on("message", (raw) => {
        let msg: unknown;
        try {
          msg = JSON.parse(messageText(raw));
        } catch {
          send(ws, JSON.stringify({ type: "error", message: "invalid json" }));
          return;
        }
        if (typeof msg !== "object" || msg === null) return;
        try {
          handlers.onMessage(client, msg as Record<string, unknown>);
        } catch (err) {
          send(ws, JSON.stringify({ type: "error", message: messageOf(err) }));
        }
      });
      handlers.onConnect(client);
    });
  });

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

  const pushText = (text: string, scope?: Scope, to: Audience = "all") => {
    for (const [ws, c] of clients)
      if ((to === "all" || c.peerId) && (!scope || c.scope === scope || c.peerId) && ws.readyState === WebSocket.OPEN) send(ws, text);
  };

  return {
    broadcast(msg, scope, to = "all") {
      let text: string | undefined;
      for (const [ws, c] of clients)
        if ((to === "all" || c.peerId) && (!scope || c.scope === scope || c.peerId) && ws.readyState === WebSocket.OPEN)
          send(ws, (text ??= JSON.stringify(msg)));
    },
    broadcastText: pushText,
    clientCount: () => clients.size,
    closeDevice: (deviceId) => closeWhere((c) => c.deviceId === deviceId),
    closePeer: (peerId) => closeWhere((c) => c.peerId === peerId),
    closeDevices: () => closeWhere((c) => c.deviceId !== undefined),
    close: () => {
      clearInterval(heartbeat);
      for (const ws of clients.keys()) ws.terminate();
      clients.clear();
      wss.close();
    },
  };
}

/**
 * The browser back from signing in to a remote MCP server or to Google: GET MCP_OAUTH_CALLBACK (or GOOGLE_OAUTH_CALLBACK) with the `code` and
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
      .catch((error: unknown) => ({ ok: false, message: messageOf(error) }))
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

export function oauthPage(ok: boolean, message: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>loki · ${ok ? "signed in" : "sign-in failed"}</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#222;background:#fafafa}@media(prefers-color-scheme:dark){body{color:#eee;background:#1b1b1d}}h1{font-size:18px}</style><h1>${ok ? "Signed in" : "Not signed in"}</h1><p>${escapeHtml(message)}</p>`;
}
