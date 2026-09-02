import { useEffect, useRef, useState } from "react";

/** Mirror of the mod-side types (src/store.ts). Keep in sync by hand until shared. */
export interface WidgetState {
  id: string;
  type: string;
  title: string;
  position: { x: number; y: number };
  size?: { w: number; h: number };
  z: number;
  data: unknown;
}
export interface DeskState {
  widgets: Record<string, WidgetState>;
  rev: number;
}
export type Patch =
  | { op: "add"; widget: Omit<WidgetState, "z"> }
  | { op: "move"; id: string; position: { x: number; y: number } }
  | { op: "resize"; id: string; size: { w: number; h: number } }
  | { op: "focus"; id: string }
  | { op: "close"; id: string }
  | { op: "set"; id: string; path: string; value: unknown };

export type Connection = "connecting" | "open" | "closed";

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}
export type ChatStatus = "idle" | "thinking" | "streaming";

function applyLocal(state: DeskState, patch: Patch): DeskState {
  const widgets = { ...state.widgets };
  const topZ = Math.max(0, ...Object.values(widgets).map((w) => w.z));
  switch (patch.op) {
    case "add":
      widgets[patch.widget.id] = { ...patch.widget, z: topZ + 1 };
      break;
    case "move":
      if (widgets[patch.id]) widgets[patch.id] = { ...widgets[patch.id], position: patch.position };
      break;
    case "resize":
      if (widgets[patch.id]) widgets[patch.id] = { ...widgets[patch.id], size: patch.size };
      break;
    case "focus":
      if (widgets[patch.id]) widgets[patch.id] = { ...widgets[patch.id], z: topZ + 1 };
      break;
    case "close":
      delete widgets[patch.id];
      break;
    case "set": {
      const w = widgets[patch.id];
      if (w) {
        const data = structuredClone(w.data ?? {}) as Record<string, unknown>;
        let node = data;
        const keys = patch.path.split(".");
        for (const k of keys.slice(0, -1)) {
          if (typeof node[k] !== "object" || node[k] === null) node[k] = {};
          node = node[k] as Record<string, unknown>;
        }
        node[keys[keys.length - 1]] = patch.value;
        widgets[patch.id] = { ...w, data };
      }
      break;
    }
  }
  return { widgets, rev: state.rev + 1 };
}

/** Connects to the mod's WS, holds desk state, applies patches optimistically. */
export function useDesk() {
  const [state, setState] = useState<DeskState>({ widgets: {}, rev: 0 });
  const [connection, setConnection] = useState<Connection>("connecting");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatStatus, setChatStatus] = useState<ChatStatus>("idle");
  const [chatError, setChatError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let disposed = false;
    let retryMs = 500;

    const connect = () => {
      const token = new URLSearchParams(location.search).get("t") ?? "";
      const ws = new WebSocket(`ws://${location.host}/ws?t=${token}`);
      wsRef.current = ws;
      setConnection("connecting");

      ws.onopen = () => {
        retryMs = 500;
        setConnection("open");
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as
          | { type: "state_sync"; state: DeskState }
          | { type: "patch"; patch: Patch }
          | { type: "error"; message: string }
          | { type: "chat_history"; messages: ChatMessage[] }
          | { type: "chat_state"; state: ChatStatus }
          | { type: "chat_delta"; text: string }
          | { type: "chat_done" }
          | { type: "chat_error"; message: string };
        switch (msg.type) {
          case "state_sync":
            setState(msg.state);
            break;
          case "patch":
            setState((s) => applyLocal(s, msg.patch));
            break;
          case "chat_history":
            // Server history is authoritative on (re)connect.
            setChatMessages(msg.messages);
            break;
          case "chat_state":
            setChatStatus(msg.state);
            if (msg.state !== "idle") setChatError(null);
            break;
          case "chat_delta":
            setChatMessages((list) => {
              const last = list[list.length - 1];
              if (last?.role === "assistant") {
                return [...list.slice(0, -1), { role: "assistant", text: last.text + msg.text }];
              }
              return [...list, { role: "assistant", text: msg.text }];
            });
            break;
          case "chat_done":
            break;
          case "chat_error":
            setChatError(msg.message);
            break;
          default:
            console.warn("loci ws:", msg);
        }
      };
      ws.onclose = () => {
        setConnection("closed");
        if (!disposed) {
          setTimeout(connect, retryMs);
          retryMs = Math.min(retryMs * 2, 8000);
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      wsRef.current?.close();
    };
  }, []);

  /** Apply optimistically and send to the store. */
  const patch = (p: Patch) => {
    setState((s) => applyLocal(s, p));
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "patch", patch: p }));
  };

  const sendChat = (text: string) => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) {
      setChatError("not connected");
      return;
    }
    setChatMessages((list) => [...list, { role: "user", text }]);
    setChatError(null);
    ws.send(JSON.stringify({ type: "chat_send", text }));
  };

  return { state, connection, patch, chat: { messages: chatMessages, status: chatStatus, error: chatError, send: sendChat } };
}
