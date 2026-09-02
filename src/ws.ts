import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import type { DeskStore, Patch } from "./store.js";

/**
 * WS protocol v0.
 * server → client: { type: "state_sync", state } | { type: "patch", patch } | { type: "error", message }
 * client → server: { type: "patch", patch }
 * Patches from one client are applied to the store and broadcast to all others.
 */

export interface WsBridge {
  broadcast(msg: object): void;
  clientCount(): number;
  close(): void;
}

export function attachWs(server: Server, store: DeskStore, token: string): WsBridge {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/ws" || url.searchParams.get("t") !== token) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws) => {
    send(ws, { type: "state_sync", state: store.get() });

    ws.on("message", (raw) => {
      let msg: { type?: string; patch?: Patch };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        send(ws, { type: "error", message: "invalid json" });
        return;
      }
      if (msg.type !== "patch" || !msg.patch) {
        send(ws, { type: "error", message: `unsupported message type: ${msg.type}` });
        return;
      }
      try {
        store.apply(msg.patch);
        // Broadcast to everyone except the sender (sender applied optimistically).
        for (const client of wss.clients) {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            send(client, { type: "patch", patch: msg.patch });
          }
        }
      } catch (err) {
        send(ws, { type: "error", message: err instanceof Error ? err.message : String(err) });
        // Resync the offender so optimistic state doesn't drift.
        send(ws, { type: "state_sync", state: store.get() });
      }
    });
  });

  return {
    broadcast(msg: object) {
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) send(client, msg);
      }
    },
    clientCount: () => wss.clients.size,
    close: () => wss.close(),
  };
}

function send(ws: WebSocket, msg: object): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
