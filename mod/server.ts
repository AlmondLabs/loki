import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import { log } from "./log.ts";
import { appServerHeaders } from "./app-server.ts";
import type { Scope } from "../core/desk-core.ts";
import { scopeFor } from "../core/desk-core.ts";

/**
 * Transport only. HTTP exists for /health and the WebSocket upgrade; the
 * canvas itself is the loki app (or, in development, a Vite tab proxying /loki/* here).
 */

export interface LokiServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

/**
 * Who may upgrade to /ws or /appserver, or fetch an agent's face. The loopback server
 * checks `?t=` against the desktop token (tokenAuth); the LAN listener (mod/lan.ts)
 * looks a device cookie or bearer up and names the device, so its sockets can be
 * closed when the device is forgotten.
 */
export type Authorize = (req: IncomingMessage, url: URL) => { ok: boolean; deviceId?: string };

export const tokenAuth =
  (token: string | undefined): Authorize =>
  (_req, url) => ({ ok: !!token && url.searchParams.get("t") === token });

export async function startServer(opts: { port: number; health?: () => object; token?: string; profile?: (agentId: string) => string | null; authorize?: Authorize }): Promise<LokiServer> {
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
export function profileRoute(req: IncomingMessage, res: ServerResponse, url: URL, authorize: Authorize, profile: ((agentId: string) => string | null) | undefined, denied: 401 | 403): boolean {
  const face = url.pathname.match(/^\/agents\/([^/]+)\/profile\.png$/);
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
  /**
   * URL of Letta's app-server, if discovered. Browsers cannot connect to it
   * directly (it refuses upgrades that carry an Origin header), so the mod
   * pipes `/appserver` through: a dumb tunnel, frames untouched both ways.
   */
  appServerUrl?(): string | null;
}

export interface WsBridge {
  /** Send to every tab, or only tabs showing `scope`. */
  broadcast(msg: object, scope?: Scope): void;
  clientCount(): number;
  /** Terminate every socket (/ws and /appserver) a device holds. Returns how many. */
  closeDevice(deviceId: string): number;
  close(): void;
}

/**
 * WebSocket upgrades on `/ws` (the bridge) and `/appserver` (the tunnel). `auth` is the desktop
 * token (checked as `?t=`) or an Authorize callback; the handlers are the same for both listeners.
 */
export function attachWs(server: Server, auth: string | Authorize, handlers: WsHandlers): WsBridge {
  const authorize: Authorize = typeof auth === "string" ? tokenAuth(auth) : auth;
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Map<WebSocket, Client>();
  const tunnels = new Map<WebSocket, string | undefined>(); // /appserver sockets → device

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
    if (url.pathname === "/appserver") {
      const target = handlers.appServerUrl?.() ?? null;
      wss.handleUpgrade(req, socket, head, (ws) => {
        tunnels.set(ws, who.deviceId);
        ws.on("close", () => tunnels.delete(ws));
        tunnel(ws, target);
      });
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
      for (const [ws, d] of tunnels) {
        if (d !== deviceId) continue;
        ws.terminate();
        tunnels.delete(ws);
        n++;
      }
      return n;
    },
    close: () => {
      for (const ws of clients.keys()) ws.terminate(); // tabs reconnect on their own
      for (const ws of tunnels.keys()) ws.terminate();
      clients.clear();
      tunnels.clear();
      wss.close();
    },
  };
}

function send(ws: WebSocket, msg: object): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** Pipe a browser socket to the app-server. Closing either side closes the other. */
export function tunnel(browser: WebSocket, target: string | null): void {
  if (!target) {
    send(browser, { type: "tunnel_error", error: "no app-server discovered" });
    browser.close(1011, "no app-server");
    return;
  }
  const upstream = new WebSocket(target, { headers: appServerHeaders() });
  const queue: string[] = [];
  upstream.on("open", () => {
    for (const q of queue) upstream.send(q);
    queue.length = 0;
  });
  browser.on("message", (raw) => {
    const text = String(raw);
    if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
    else if (upstream.readyState === WebSocket.CONNECTING) queue.push(text);
  });
  upstream.on("message", (raw) => send(browser, JSON.parse(String(raw)) as object));
  upstream.on("close", () => browser.close());
  upstream.on("error", (err) => {
    log("tunnel:upstream-error", err.message);
    send(browser, { type: "tunnel_error", error: err.message });
    browser.close(1011, "upstream error");
  });
  browser.on("close", () => upstream.close());
  browser.on("error", () => upstream.close());
}
