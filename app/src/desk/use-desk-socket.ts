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
import { RequestWaiters } from "./request-waiters";

const STALE_AFTER_HIDDEN_MS = 5_000;

type Update<K extends keyof DeskSocketState> = (fn: (current: DeskSocketState[K]) => DeskSocketState[K]) => void;

export function useDeskSocket() {
  const [scope, setScope] = useState<Scope>(() => scopeFor(readSession().desk));
  const [connection, setConnection] = useState<Connection>("connecting");
  const [state, setState] = useState<DeskSocketState>(EMPTY_DESK_SOCKET);
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
  const [chatListeners] = useState(() => new Listeners<[p: Pushes["chat_event"]]>());
  const [reconnectListeners] = useState(() => new Listeners());
  const [staleListeners] = useState(() => new Listeners());
  const listsStale = useCallback(() => {
    staleListeners.emit();
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "list_desks" }));
  }, [staleListeners]);
  const [waiters] = useState(() => new RequestWaiters<WebSocket>());

  const wsRef = useRef<WebSocket | null>(null);
  const lastInteractionRef = useRef(0);
  const pendingRef = useRef<Gesture[]>([]);
  const watchedRef = useRef(new Map<Scope, number>());
  const pendingMeasures = useRef(new Map<string, Size>());

  const switchDesk = useCallback(
    (next: Scope) => {
      if (!next || next === scope) return;
      rememberDesk(next);
      const url = new URL(location.href);
      url.searchParams.set("desk", next);
      history.replaceState(null, "", url);
      setScope(next);
    },
    [scope],
  );

  useEffect(() => {
    let disposed = false;
    let retryMs = 500;
    let retry: ReturnType<typeof setTimeout> | null = null;
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
        for (const s of watchedRef.current.keys()) ws.send(JSON.stringify({ type: "desk_get", scope: s }));
        waiters.flush(ws, (frame) => ws.send(JSON.stringify(frame)));
        if (dropped) {
          reconnectListeners.emit();
          listsStale();
        }
        dropped = false;
      };
      ws.onmessage = (ev) => {
        const raw = JSON.parse(ev.data as string) as Record<string, unknown>;
        if (typeof raw.request_id === "string") {
          waiters.answer(raw.request_id, raw);
          return;
        }
        const msg = raw as PushFrame;
        if (STATE_PUSHES.has(msg.type)) {
          const ctx = { now: Date.now(), lastInteraction: lastInteractionRef.current, phoneDemo: PHONE_DEMO };
          setState((s) => applyPush(s, msg, ctx));
        }
        switch (msg.type) {
          case "desk": {
            console.info(`desk frame: ${msg.scope} · ${(msg.widgets as unknown[] | undefined)?.length ?? 0} widgets`);
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
        waiters.closed(ws);
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
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
    };
  }, [scope, switchDesk, listsStale, chatListeners, reconnectListeners, waiters]);

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

  const sendRaw = useCallback(
    (msg: object): boolean => {
      const ws = wsRef.current;
      if (ws?.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(msg));
      const id = (msg as { request_id?: unknown }).request_id;
      if (typeof id === "string") waiters.sent(id, ws);
      return true;
    },
    [waiters],
  );
  const send = useCallback(<N extends SendName>(frame: { type: N } & InputOf<N>): boolean => sendRaw(frame), [sendRaw]);

  const reportWidgetError = useCallback(
    (id: string, error: string | null) => {
      send({ type: "widget_status", id, error });
    },
    [send],
  );

  const measure = useCallback(
    (id: string, size: Size) => {
      if (!send({ type: "measure", id, size })) pendingMeasures.current.set(id, size);
    },
    [send],
  );

  const watchDesk = (s: Scope): (() => void) => {
    const count = watchedRef.current.get(s) ?? 0;
    watchedRef.current.set(s, count + 1);
    if (count === 0) send({ type: "desk_get", scope: s });
    return () => {
      const next = (watchedRef.current.get(s) ?? 0) - 1;
      if (next > 0) watchedRef.current.set(s, next);
      else watchedRef.current.delete(s);
    };
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
