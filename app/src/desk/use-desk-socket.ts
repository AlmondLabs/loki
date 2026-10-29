import { useCallback, useEffect, useRef, useState } from "react";
import type { Gesture, Scope, Size } from "../../../core/desk-core.ts";
import { scopeFor } from "../../../core/desk-core.ts";
import { readSession, rememberDesk } from "./session";
import { modWsBase } from "./env";
import { tokenProtocols } from "../../../core/ws-auth.ts";
import type { Connection } from "./use-desk";
import type { InputOf, PushFrame, Pushes, SendName } from "../../../core/frames.ts";
import { Listeners } from "../../../core/listeners.ts";
import { parseWidgetEntry } from "./widget-rows";
import { EMPTY_DESK_SOCKET, PHONE_DEMO, STATE_PUSHES, applyPush, opened, type DeskSocketState } from "./desk-pushes";

/** Hidden at least this long, the page asks for its lists again when it is shown: anything shorter is a glance away. */
const STALE_AFTER_HIDDEN_MS = 5_000;

/** A change to one part of the pushes' state, made here (an optimistic update): the part as it is now, to what it becomes. */
type Update<K extends keyof DeskSocketState> = (fn: (current: DeskSocketState[K]) => DeskSocketState[K]) => void;

/**
 * The WebSocket to the mod and everything its frames feed: which desk this tab shows, the manifests
 * and geometry per scope, the desk list, titles and agents, the seen and focus maps, the LAN listener's
 * status. Reconnects with backoff, and re-opens on the new desk when `switchDesk` changes the scope.
 * Gestures and measures that arrive before the socket is open wait in `pendingRef` / `pendingMeasures`
 * and go out with the next desk frame. `waiters` holds the request/reply exchanges `useDesk` opens.
 * `measure` and `reportWidgetError` are the two frame-level sends, stable so the frames' effects do not re-run.
 */
export function useDeskSocket() {
  const [scope, setScope] = useState<Scope>(() => scopeFor(readSession().desk));
  const [connection, setConnection] = useState<Connection>("connecting");
  /** Everything the pushes leave in this tab (desk-pushes.ts), one object whose parts keep their identity until changed. */
  const [state, setState] = useState<DeskSocketState>(EMPTY_DESK_SOCKET);
  /** The parts this hook's callers change themselves, ahead of the mod's push (stable: made once). */
  const [updates] = useState(() => {
    const part =
      <K extends keyof DeskSocketState>(key: K): Update<K> =>
      (fn) =>
        setState((s) => {
          const next = fn(s[key]);
          return next === s[key] ? s : { ...s, [key]: next };
        });
    return {
      setDesks: part("desks"),
      setDeskList: part("deskList"),
      setTitles: part("titles"),
      setModels: part("models"),
      setReasoningEfforts: part("reasoningEfforts"),
      setModes: part("modes"),
      setLanStatus: part("lanStatus"),
      setWidgetLogs: part("widgetLogs"),
    };
  });
  /** Who listens for the chats' events, which loki's daemon sends on this socket. */
  const [chatListeners] = useState(() => new Listeners<[p: Pushes["chat_event"]]>());
  /** Who hears that the socket opened again after it dropped (the daemon may have restarted meanwhile). */
  const [reconnectListeners] = useState(() => new Listeners());
  /**
   * Who hears that the lists a client holds (agents, chats) may be out of date: an agent changed (agents_changed),
   * the socket came back after a drop, or the page came back after being hidden (a phone's home-screen app sleeps in
   * the background, and polls nothing meanwhile). The desk list is asked for again at the same time.
   */
  const [staleListeners] = useState(() => new Listeners());
  const listsStale = useCallback(() => {
    staleListeners.emit();
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "list_desks" }));
  }, [staleListeners]);
  /** Pending request/reply exchanges with the mod, by request_id. */
  const waiters = useRef(new Map<string, (msg: Record<string, unknown>) => void>());

  const wsRef = useRef<WebSocket | null>(null);
  const lastInteractionRef = useRef(0);
  const pendingRef = useRef<Gesture[]>([]);
  /** Other desks whose widgets a thread shows inline: asked for once, and again whenever one of their widgets changes. */
  const watchedRef = useRef(new Set<Scope>());
  /** Latest measured size per widget that could not be sent yet (frames measure before the socket opens). */
  const pendingMeasures = useRef(new Map<string, Size>());

  /** Show another desk in this tab: URL param + reconnect. */
  const switchDesk = useCallback(
    (next: Scope) => {
      if (!next || next === scope) return;
      rememberDesk(next);
      const url = new URL(location.href);
      url.searchParams.set("desk", next);
      history.replaceState(null, "", url);
      setScope(next); // the connection effect re-runs on the new chat
    },
    [scope],
  );

  useEffect(() => {
    let disposed = false;
    let retryMs = 500;
    let retry: ReturnType<typeof setTimeout> | null = null;
    // A drop, not a chat switch (that opens a socket of its own): the next open is a reconnect.
    let dropped = false;
    const token = readSession().token;

    const connect = () => {
      if (disposed) return;
      const ws = new WebSocket(`${modWsBase()}/ws?desk=${encodeURIComponent(scope)}`, tokenProtocols(token));
      wsRef.current = ws;
      setConnection("connecting");

      ws.onopen = () => {
        retryMs = 500;
        setConnection("open");
        setState(opened);
        ws.send(JSON.stringify({ type: "seen_list" }));
        for (const s of watchedRef.current) ws.send(JSON.stringify({ type: "desk_get", scope: s }));
        if (dropped) {
          reconnectListeners.emit();
          listsStale();
        }
        dropped = false;
      };
      ws.onmessage = (ev) => {
        const raw = JSON.parse(ev.data as string) as Record<string, unknown>;
        // A request's answer (its reply, or `error`), by request_id: it goes to whoever asked, nowhere else.
        if (typeof raw.request_id === "string") {
          const w = waiters.current.get(raw.request_id);
          waiters.current.delete(raw.request_id);
          w?.(raw); // none: its request already timed out, and the answer has no one left to tell
          return;
        }
        // Everything else is a push (core/frames.ts Pushes). What it leaves in the tab is desk-pushes.ts's to fold in; what
        // it asks to be done is here.
        const msg = raw as PushFrame;
        if (STATE_PUSHES.has(msg.type)) {
          const ctx = { now: Date.now(), lastInteraction: lastInteractionRef.current, phoneDemo: PHONE_DEMO };
          setState((s) => applyPush(s, msg, ctx));
        }
        switch (msg.type) {
          case "desk": {
            console.info(`desk frame: ${msg.scope} · ${(msg.widgets as unknown[] | undefined)?.length ?? 0} widgets`);
            // Gestures and measures made before this desk came go out now.
            const pending = pendingRef.current;
            pendingRef.current = [];
            for (const g of pending) ws.send(JSON.stringify({ type: "gesture", gesture: g }));
            const measures = pendingMeasures.current;
            pendingMeasures.current = new Map();
            for (const [id, size] of measures) ws.send(JSON.stringify({ type: "measure", id, size }));
            break;
          }
          case "switch_desk": {
            const next = msg.scope;
            if (next && next !== scope) switchDesk(next);
            break;
          }
          case "chat_event":
            chatListeners.emit(msg);
            break;
          case "agents_changed":
          case "lists_changed":
          case "chat_changed":
            listsStale();
            break;
          case "widget_change": {
            // A desk shown inline elsewhere has a new or changed widget: its manifest comes again.
            const entry = parseWidgetEntry(msg.entry);
            if (entry && watchedRef.current.has(entry.scope)) ws.send(JSON.stringify({ type: "desk_get", scope: entry.scope }));
            break;
          }
          case "error":
            console.warn("loki:", msg.message);
            break;
          default:
            if (!STATE_PUSHES.has(msg.type)) console.warn("loki ws: unknown frame", msg);
        }
      };
      ws.onclose = () => {
        setConnection("closed");
        if (!disposed) {
          dropped = true;
          retry = setTimeout(connect, retryMs);
          retryMs = Math.min(retryMs * 2, 8000);
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry); // a reconnect scheduled for the old desk must not open a socket after the switch
      wsRef.current?.close();
    };
  }, [scope, switchDesk, listsStale, chatListeners, reconnectListeners]);

  // Back from the background (a phone's home-screen app, a hidden tab): what changed meanwhile was never polled.
  useEffect(() => {
    let hiddenAt: number | null = null;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") hiddenAt = Date.now();
      else if (hiddenAt !== null && Date.now() - hiddenAt >= STALE_AFTER_HIDDEN_MS) {
        hiddenAt = null;
        listsStale();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [listsStale]);

  /** Any frame as it is: `request()`'s, which carry a request_id. False while the socket is not open. */
  const sendRaw = useCallback((msg: object): boolean => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }, []);
  /** A send (core/frames.ts), typed by its name. False while the socket is not open. */
  const send = useCallback(<N extends SendName>(frame: { type: N } & InputOf<N>): boolean => sendRaw(frame), [sendRaw]);

  const reportWidgetError = useCallback(
    (id: string, error: string | null) => {
      send({ type: "widget_status", id, error });
    },
    [send],
  );

  const measure = useCallback(
    (id: string, size: Size) => {
      if (!send({ type: "measure", id, size })) pendingMeasures.current.set(id, size); // flushed when the desk frame arrives
    },
    [send],
  );

  /** Keep another desk's widgets and state at hand (a thread shows them inline); asked for at once the first time. */
  const watchDesk = (s: Scope) => {
    if (watchedRef.current.has(s)) return;
    watchedRef.current.add(s);
    send({ type: "desk_get", scope: s });
  };

  return {
    ...state,
    ...updates,
    scope,
    switchDesk,
    watchDesk,
    send,
    sendRaw,
    connection,
    chatListeners,
    reconnectListeners,
    staleListeners,
    waiters,
    lastInteractionRef,
    pendingRef,
    measure,
    reportWidgetError,
  };
}
