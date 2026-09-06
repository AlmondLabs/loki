import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { log } from "./log.ts";
import { appServerHeaders } from "./app-server.ts";
import type { Scope } from "../shared/desk-core.ts";
import { scopeFor } from "../shared/desk-core.ts";

/**
 * Transport only. HTTP exists for /health and the WebSocket upgrade; the
 * canvas itself is the loki app (or, in development, a Vite tab proxying /loki/* here).
 */

export interface LokiServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export async function startServer(opts: { port: number; health?: () => object }): Promise<LokiServer> {
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...(opts.health?.() ?? {}) }));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" }).end("loki: not found");
    } catch {
      res.writeHead(400).end();
    }
  });
  await listenWithRetry(server, opts.port);
  const port = (server.address() as { port: number }).port;
  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(fallback);
          resolve();
        };
        // Keep-alive and upgraded sockets would otherwise hold close() open; never block /reload on them.
        const fallback = setTimeout(done, 1000);
        server.close(done);
        server.closeAllConnections();
      }),
  };
}

/** On /reload the previous server closes asynchronously; retry instead of EADDRINUSE. */
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
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= tries) throw err;
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
}

export interface Client {
  scope: Scope;
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
  close(): void;
}

export function attachWs(server: Server, token: string, handlers: WsHandlers): WsBridge {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Map<WebSocket, Client>();

  server.on("upgrade", (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      socket.destroy();
      return;
    }
    if (url.searchParams.get("t") !== token) {
      socket.destroy();
      return;
    }
    if (url.pathname === "/appserver") {
      const target = handlers.appServerUrl?.() ?? null;
      wss.handleUpgrade(req, socket, head, (ws) => tunnel(ws, target));
      return;
    }
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const scope = scopeFor(url.searchParams.get("desk"));
    wss.handleUpgrade(req, socket, head, (ws) => {
      const client: Client = { scope, send: (msg) => send(ws, msg) };
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
