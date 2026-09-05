import { useCallback, useEffect, useRef, useState } from "react";
import type { DeskState, Gesture, Scope, Size, WidgetLayout, WidgetManifestEntry } from "../../../shared/desk-core.ts";
import { SHARED_SCOPE, applyGesture, autoPlace, emptyDesk, scopeFor } from "../../../shared/desk-core.ts";
import type { ChatMessage, ChatStatus } from "../chat/ChatWindow";
import { readSession, rememberDesk } from "./session";

export type Connection = "connecting" | "open" | "closed";

export interface CameraTarget {
  widgetId: string;
  /** All ids to frame together (first is widgetId). */
  widgetIds: string[];
  nonce: number;
}

export type DeskStatus = "live" | "archived" | "deleted" | "none";

export interface DeskSummary {
  scope: Scope;
  title: string | null;
  status: DeskStatus;
  agentName: string | null;
  agentId: string | null;
  conversationId: string | null;
  widgets: number;
  active: boolean;
  lastActive: string | null;
}

export interface VisibleWidget {
  entry: WidgetManifestEntry;
  layout: WidgetLayout;
  overlay: Record<string, unknown> | undefined;
}

const scopeOfId = (id: string): Scope => id.slice(0, Math.max(0, id.indexOf("/"))) || SHARED_SCOPE;
const NO_YANK_MS = 2000;

/**
 * The tab's view of the desk: manifest + geometry per scope, synced from the
 * mod over WebSocket. Gestures apply optimistically with the same pure
 * reducer the mod uses, then go up the wire.
 */
export function useDesk() {
  const [scope, setScope] = useState<Scope>(() => scopeFor(readSession().desk));
  const [desks, setDesks] = useState<Record<Scope, DeskState>>({});
  const [widgets, setWidgets] = useState<Record<Scope, WidgetManifestEntry[]>>({});
  const [connection, setConnection] = useState<Connection>("connecting");
  const [cameraTarget, setCameraTarget] = useState<CameraTarget | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatStatus, setChatStatus] = useState<ChatStatus>("idle");
  const [chatError, setChatError] = useState<string | null>(null);
  const [deskList, setDeskList] = useState<DeskSummary[]>([]);
  const [titles, setTitles] = useState<Record<Scope, string>>({});
  const [statuses, setStatuses] = useState<Record<Scope, DeskStatus>>({});
  const [agentNames, setAgentNames] = useState<Record<Scope, string>>({});
  const [agentIds, setAgentIds] = useState<Record<Scope, string>>({});
  /** From the mod: is an app-server tunnel available, and which conversations have been seen. */
  const [appServer, setAppServer] = useState(false);
  const [seenMap, setSeenMap] = useState<Record<string, string>>({});

  const wsRef = useRef<WebSocket | null>(null);
  const lastInteractionRef = useRef(0);
  const pendingRef = useRef<Gesture[]>([]);

  useEffect(() => {
    let disposed = false;
    let retryMs = 500;
    const token = readSession().token;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/loci/ws?t=${token}&desk=${encodeURIComponent(scope)}`);
      wsRef.current = ws;
      setConnection("connecting");

      ws.onopen = () => {
        retryMs = 500;
        setConnection("open");
        ws.send(JSON.stringify({ type: "seen_list" }));
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as Record<string, unknown> & { type: string };
        switch (msg.type) {
          case "desk": {
            const s = msg.scope as Scope;
            if (typeof msg.title === "string" && msg.title) setTitles((t) => ({ ...t, [s]: msg.title as string }));
            if (typeof msg.status === "string") setStatuses((t) => ({ ...t, [s]: msg.status as DeskStatus }));
            if (typeof msg.agentName === "string" && msg.agentName) setAgentNames((t) => ({ ...t, [s]: msg.agentName as string }));
            if (typeof msg.agentId === "string" && msg.agentId) setAgentIds((t) => ({ ...t, [s]: msg.agentId as string }));
            setDesks((d) => ({ ...d, [s]: msg.state as DeskState }));
            setWidgets((w) => ({ ...w, [s]: msg.widgets as WidgetManifestEntry[] }));
            const pending = pendingRef.current;
            pendingRef.current = [];
            for (const g of pending) ws.send(JSON.stringify({ type: "gesture", gesture: g }));
            break;
          }
          case "state":
            setDesks((d) => ({ ...d, [msg.scope as Scope]: msg.state as DeskState }));
            break;
          case "widgets":
            setWidgets((w) => ({ ...w, [msg.scope as Scope]: msg.widgets as WidgetManifestEntry[] }));
            break;
          case "camera":
            if (typeof msg.widgetId === "string" && Date.now() - lastInteractionRef.current > NO_YANK_MS) {
              const widgetId = msg.widgetId;
              const widgetIds = Array.isArray(msg.widgetIds) && msg.widgetIds.length ? (msg.widgetIds as string[]) : [widgetId];
              setCameraTarget((t) => ({ widgetId, widgetIds, nonce: (t?.nonce ?? 0) + 1 }));
            }
            break;
          case "switch_desk": {
            const next = msg.scope as Scope;
            if (next && next !== scope) switchDesk(next);
            break;
          }
          case "desks":
            setDeskList(msg.desks as DeskSummary[]);
            break;
          case "config":
            setAppServer(msg.appServer === true);
            break;
          case "seen":
            setSeenMap((msg.seen as Record<string, string>) ?? {});
            if (typeof msg.appServer === "boolean") setAppServer(msg.appServer);
            break;
          case "desk_title":
            if (typeof msg.title === "string" && msg.title) setTitles((t) => ({ ...t, [msg.scope as Scope]: msg.title as string }));
            if (typeof msg.status === "string") setStatuses((t) => ({ ...t, [msg.scope as Scope]: msg.status as DeskStatus }));
            if (typeof msg.agentName === "string" && msg.agentName) setAgentNames((t) => ({ ...t, [msg.scope as Scope]: msg.agentName as string }));
            break;
          case "chat_history":
            setChatMessages(msg.messages as ChatMessage[]);
            break;
          case "chat_user":
            // A user message on this desk's conversation: from this tab, another tab, or typed in Desktop.
            setChatMessages((list) => [...list, { role: "user", text: msg.text as string }]);
            break;
          case "chat_tool":
            setChatMessages((list) => [...list, { role: "tool", text: msg.text as string }]);
            break;
          case "chat_state":
            setChatStatus(msg.state as ChatStatus);
            if (msg.state !== "idle") setChatError(null);
            break;
          case "chat_delta":
            setChatMessages((list) => {
              const last = list[list.length - 1];
              if (last?.role === "assistant") {
                return [...list.slice(0, -1), { role: "assistant", text: last.text + (msg.text as string) }];
              }
              return [...list, { role: "assistant", text: msg.text as string }];
            });
            break;
          case "chat_done":
            break;
          case "chat_error":
            setChatError(msg.message as string);
            break;
          case "error":
            console.warn("loci:", msg.message);
            break;
          default:
            console.warn("loci ws: unknown frame", msg);
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
  }, [scope]);

  // Vite compile errors for widget files → tell the mod, so the agent hears about them.
  useEffect(() => {
    const hot = import.meta.hot;
    if (!hot) return;
    // Optional param: Vite types this callback loosely; the payload is an ErrorPayload at runtime.
    const onError = (payload?: { err?: { message?: string; id?: string; loc?: { file?: string } } }) => {
      const err = payload?.err;
      if (!err) return;
      const file = err.id ?? err.loc?.file ?? "";
      const m = /\/widgets\/([^/]+)\/([^/.]+)\.(tsx|jsx)/.exec(file);
      if (m) reportWidgetError(`${m[1]}/${m[2]}`, err.message ?? "compile error");
    };
    hot.on("vite:error", onError);
    return () => hot.off("vite:error", onError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Show another desk in this tab: URL param + reconnect; chat re-attaches to that conversation. */
  const switchDesk = (next: Scope) => {
    if (!next || next === scope) return;
    rememberDesk(next);
    const url = new URL(location.href);
    url.searchParams.set("desk", next);
    history.replaceState(null, "", url);
    setChatMessages([]);
    setChatStatus("idle");
    setChatError(null);
    setScope(next); // the connection effect re-runs on the new desk
  };

  const requestDesks = () => {
    send({ type: "list_desks" });
  };

  const send = (msg: object): boolean => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  };

  const gesture = (g: Gesture) => {
    lastInteractionRef.current = Date.now();
    const s = scopeOfId(g.id);
    setDesks((d) => ({ ...d, [s]: applyGesture(d[s] ?? emptyDesk(s), g) }));
    if (!send({ type: "gesture", gesture: g })) pendingRef.current.push(g);
  };

  const reportWidgetError = useCallback((id: string, error: string | null) => {
    send({ type: "widget_status", id, error });
  }, []);

  const measure = useCallback((id: string, size: Size) => {
    send({ type: "measure", id, size });
  }, []);

  const token = readSession().token;
  const tunnelUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/loci/appserver?t=${token}`;
  const attention = {
    available: appServer,
    tunnelUrl,
    seen: seenMap,
    markSeen: (agentId: string, conversationId: string) => send({ type: "seen_mark", agentId, conversationId }),
    unmarkSeen: (agentId: string, conversationId: string) => send({ type: "seen_unmark", agentId, conversationId }),
  };

  /** Delete a widget's file for good. The mod removes it; the watcher takes it off every tab. */
  const trash = (id: string) => {
    lastInteractionRef.current = Date.now();
    send({ type: "trash", id });
  };

  /** Tidy this desk into a grid; the mod re-places widgets and glides the camera to fit them. */
  const arrange = () => {
    lastInteractionRef.current = 0; // let the fit-all glide through
    send({ type: "arrange" });
  };

  const sendChat = (text: string) => {
    if (!send({ type: "chat_send", text })) {
      setChatError("not connected");
      return;
    }
    // The mod echoes it back as chat_user to every tab on this desk, including this one.
    setChatError(null);
  };

  /** Shared widgets under this desk's widgets; closed ones go to the tray; layout falls back to a cascade until the mod assigns one. */
  const visible: VisibleWidget[] = [];
  const closed: WidgetManifestEntry[] = [];
  const scopes = scope === SHARED_SCOPE ? [SHARED_SCOPE] : [SHARED_SCOPE, scope];
  for (const s of scopes) {
    const desk = desks[s];
    (widgets[s] ?? []).forEach((entry, i) => {
      const layout = desk?.layout[entry.id];
      if (layout?.hidden) {
        closed.push(entry);
        return;
      }
      visible.push({ entry, layout: layout ?? { position: autoPlace(i), z: 0 }, overlay: desk?.overlay[entry.id] });
    });
  }

  /** Widgets this desk owns (shared ones excluded), minimised included. Zero → first-run hint. */
  const ownCount = scope === SHARED_SCOPE ? (widgets[SHARED_SCOPE] ?? []).length : (widgets[scope] ?? []).length;

  const title = titles[scope] ?? null;
  const status: DeskStatus = statuses[scope] ?? "none";
  const agentName = agentNames[scope] ?? null;
  const agentId = agentIds[scope] ?? null;
  /** The conversation behind this desk, as the app-server names it. */
  const conversationId = scope === SHARED_SCOPE ? null : scope.startsWith("default-") ? "default" : scope;

  return {
    scope,
    title,
    status,
    agentName,
    agentId,
    conversationId,
    connection,
    visible,
    closed,
    ownCount,
    desks: { list: deskList, request: requestDesks, switchTo: switchDesk },
    attention,
    gesture,
    measure,
    arrange,
    trash,
    reportWidgetError,
    cameraTarget,
    chat: { messages: chatMessages, status: chatStatus, error: chatError, send: sendChat },
  };
}
