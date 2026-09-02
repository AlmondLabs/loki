import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import type { DeskStore, Patch } from "./store.js";
import type { ChatBridge } from "./chat.js";

/**
 * WS protocol v0.
 * server → client: { type: "state_sync", state } | { type: "patch", patch } | { type: "error", message }
 *                  | chat frames: chat_state | chat_delta | chat_done | chat_error
 * client → server: { type: "patch", patch } | { type: "chat_send", text }
 * Patches from one client are applied to the store and broadcast to all others.
 * Chat frames broadcast to every client (all tabs share the desk's one chat).
 */

export interface WsBridge {
  broadcast(msg: object): void;
  clientCount(): number;
  close(): void;
}

export function attachWs(
  server: Server,
  store: DeskStore,
  token: string,
  chat?: ChatBridge,
): WsBridge {
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
      let msg: { type?: string; patch?: Patch; text?: string };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        send(ws, { type: "error", message: "invalid json" });
        return;
      }
      if (msg.type === "chat_send" && typeof msg.text === "string" && msg.text.trim()) {
        if (!chat) {
          send(ws, { type: "chat_error", message: "chat not available" });
          return;
        }
        void chat.send(msg.text, (frame) => {
          for (const client of wss.clients) send(client, frame);
        });
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
