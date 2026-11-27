import { useCallback, useEffect, useRef, useState } from "react";
import type { Scope } from "../../../core/chat-scope.ts";
import { scopeFor } from "../../../core/chat-scope.ts";
import { readSession, rememberDesk } from "./session";
import { modWsBase } from "./env";
import { tokenProtocols } from "../../../core/ws-auth.ts";
import type { Connection } from "./use-workspace";
import type { InputOf, PushFrame, Pushes, SendName } from "../../../core/frames.ts";
import { Listeners } from "../../../core/listeners.ts";
import { EMPTY_DESK_SOCKET, PHONE_DEMO, STATE_PUSHES, applyPush, opened, type DeskSocketState } from "./workspace-pushes";
import { RequestWaiters } from "./request-waiters";
import { inDesktop, listen } from "../shell/desktop";
import { readCachedDesks, writeCachedDesks } from "./boot-cache";

const STALE_AFTER_HIDDEN_MS = 5_000;

type Update<K extends keyof DeskSocketState> = (fn: (current: DeskSocketState[K]) => DeskSocketState[K]) => void;

export function useWorkspaceSocket() {
  const [scope, setScope] = useState<Scope>(() => scopeFor(readSession().desk));
  const [connection, setConnection] = useState<Connection>("connecting");
  const [state, setState] = useState<DeskSocketState>(() => {
    const cachedDesks = readCachedDesks();
    return cachedDesks ? { ...EMPTY_DESK_SOCKET, deskList: cachedDesks } : EMPTY_DESK_SOCKET;
  });
  const [updates] = useState(() => {
    const part =
      <K extends keyof DeskSocketState>(key: K): Update<K> =>
      (fn) =>
        setState((s) => {
          const next = fn(s[key]);
          return next === s[key] ? s : { ...s, [key]: next };
        });
    return {
      setDeskList: part("deskList"),
      setTitles: part("titles"),
      setModels: part("models"),
      setReasoningEfforts: part("reasoningEfforts"),
      setModes: part("modes"),
      setLanStatus: part("lanStatus"),
    };
  });
  const [chatListeners] = useState(() => new Listeners<[p: Pushes["chat_event"]]>());
  const [reconnectListeners] = useState(() => new Listeners());
  const [staleListeners] = useState(() => new Listeners());
  const listsStale = useCallback(() => {
    staleListeners.emit();
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "chats_list" }));
  }, [staleListeners]);
  const [waiters] = useState(() => new RequestWaiters<WebSocket>());

  const wsRef = useRef<WebSocket | null>(null);

  const switchDesk = useCallback(
    (next: Scope) => {
      if (!next || next === scope) return;
      rememberDesk(next);
      const url = new URL(location.href);
      url.searchParams.set("canvas", next);
      history.replaceState(null, "", url);
      setScope(next);
    },
    [scope],
  );

  useEffect(() => {
    let disposed = false;
    let everOpened = false;
    let retryMs = 150;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let dropped = false;
    const token = readSession().token;

    const connect = () => {
      if (disposed) return;
      const ws = new WebSocket(`${modWsBase()}/ws?desk=${encodeURIComponent(scope)}`, tokenProtocols(token));
      wsRef.current = ws;
      setConnection("connecting");

      ws.onopen = () => {
        if (wsRef.current !== ws || disposed) return;
        everOpened = true;
        retryMs = 500;
        setConnection("open");
        setState(opened);
        ws.send(JSON.stringify({ type: "seen_list" }));
        waiters.flush(ws, (frame) => ws.send(JSON.stringify(frame)));
        if (dropped) {
          reconnectListeners.emit();
          listsStale();
        }
        dropped = false;
      };
      ws.onmessage = (ev) => {
        if (wsRef.current !== ws || disposed) return;
        const raw = JSON.parse(ev.data as string) as Record<string, unknown>;
        if (typeof raw.request_id === "string") {
          waiters.answer(raw.request_id, raw);
          return;
        }
        const msg = raw as PushFrame;
        if (STATE_PUSHES.has(msg.type)) {
          const ctx = { now: Date.now(), lastInteraction: 0, phoneDemo: PHONE_DEMO };
          setState((s) => applyPush(s, msg, ctx));
          if (msg.type === "chats") writeCachedDesks(msg.chats);
        }
        switch (msg.type) {
          case "switch_chat": {
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
          case "error":
            console.warn("loki:", msg.message);
            break;
          default:
            if (!STATE_PUSHES.has(msg.type)) console.warn("loki ws: unknown frame", msg);
        }
      };
      ws.onclose = () => {
        waiters.closed(ws);
        if (wsRef.current !== ws) return;
        setConnection("closed");
        if (!disposed) {
          dropped = true;
          const cap = everOpened ? 8000 : 1000;
          retry = setTimeout(connect, retryMs);
          retryMs = Math.min(retryMs * 2, cap);
        }
      };
    };

    let unlistenReady: (() => void) | null = null;
    if (inDesktop) {
      void listen("loki:daemon-ready", () => {
        if (disposed) return;
        const current = wsRef.current;
        if (current?.readyState === WebSocket.OPEN) return;
        if (current) {
          wsRef.current = null;
          current.close();
        }
        if (retry) {
          clearTimeout(retry);
          retry = null;
        }
        retryMs = 150;
        connect();
      })
        .then((fn) => {
          if (!disposed) unlistenReady = fn;
          else fn();
        })
        .catch(() => {});
    }

    connect();
    return () => {
      disposed = true;
      unlistenReady?.();
      if (retry) clearTimeout(retry);
      const current = wsRef.current;
      wsRef.current = null;
      current?.close();
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

  return {
    ...state,
    ...updates,
    scope,
    switchDesk,
    send,
    sendRaw,
    connection,
    chatListeners,
    reconnectListeners,
    staleListeners,
    waiters,
  };
}
