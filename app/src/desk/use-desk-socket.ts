import { useCallback, useEffect, useRef, useState } from "react";
import type { DeskState, Gesture, Scope, Size, WidgetManifestEntry } from "../../../core/desk-core.ts";
import { scopeFor } from "../../../core/desk-core.ts";
import { readSession, rememberDesk } from "./session";
import { modWsBase } from "./env";
import { tokenProtocols } from "../../../core/ws-auth.ts";
import type { FocusEntry } from "../../../core/attention/focus.ts";
import type { Rest } from "../../../core/attention/rest.ts";
import { lanStatusFromFrame, type PairCode, type PairedDevice, type PhoneLanStatus } from "../phone/model";
import type { CameraTarget, Connection } from "./use-desk";
import { isReasoningEffort, type ReasoningEffort } from "../../../core/models.ts";
import { parseWidgetEntry, withEntry, type WidgetLogs } from "./widget-rows";
import type { DeskStatus, DeskSummary } from "../../../core/frame-types.ts";
import type { InputOf, PushFrame, Pushes, SendName } from "../../../core/frames.ts";
import { keepSame } from "../../../core/same-data.ts";

/** Hidden at least this long, the page asks for its lists again when it is shown: anything shorter is a glance away. */
const STALE_AFTER_HIDDEN_MS = 5_000;

const NO_YANK_MS = 2000;

/**
 * Dev only: `?phoneDemo=tailscale` on the Vite tab makes Settings › phone read as if Tailscale were
 * running on this Mac, so the route chooser and the https switch can be seen without a tailnet. The
 * flag is compiled out of production builds; `setVia` / `setServe` then change local state instead of
 * asking the mod. Remove once the mod's `tailscale.ts` is in and a real tailnet is at hand.
 */
export const PHONE_DEMO = import.meta.env.DEV && typeof location !== "undefined" && new URLSearchParams(location.search).get("phoneDemo") === "tailscale";
/**
 * The LAN status as it would read with Tailscale running on this Mac (fixed made-up names and address), for the
 * dev-only `PHONE_DEMO`; `serve` overrides whether Tailscale serve is on.
 */
export function phoneDemo(s: PhoneLanStatus, serve?: boolean): PhoneLanStatus {
  const name = "my-macbook-pro.tail1234.ts.net";
  const on = serve ?? !!s.tailscale?.serve_url;
  return { ...s, tailscale: { installed: true, running: true, ip: "100.101.102.103", name, serve_url: on ? `https://${name}` : null, error: null } };
}

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
  const [desks, setDesks] = useState<Partial<Record<Scope, DeskState>>>({});
  const [widgets, setWidgets] = useState<Partial<Record<Scope, WidgetManifestEntry[]>>>({});
  const [connection, setConnection] = useState<Connection>("connecting");
  const [cameraTarget, setCameraTarget] = useState<CameraTarget | null>(null);
  const [deskList, setDeskList] = useState<DeskSummary[]>([]);
  /** A desks frame has arrived: an empty list is then "no desks", not "not asked yet" (the phone's Home says which). */
  const [desksLoaded, setDesksLoaded] = useState(false);
  const [titles, setTitles] = useState<Partial<Record<Scope, string>>>({});
  const [statuses, setStatuses] = useState<Partial<Record<Scope, DeskStatus>>>({});
  const [agentNames, setAgentNames] = useState<Partial<Record<Scope, string>>>({});
  const [agentIds, setAgentIds] = useState<Partial<Record<Scope, string>>>({});
  const [models, setModels] = useState<Partial<Record<Scope, string>>>({});
  const [reasoningEfforts, setReasoningEfforts] = useState<Partial<Record<Scope, ReasoningEffort>>>({});
  const [modes, setModes] = useState<Partial<Record<Scope, string>>>({});
  /** Who listens for the chats' events, which loki's daemon sends on this socket. */
  const chatListeners = useRef(new Set<(p: Pushes["chat_event"]) => void>());
  /** Who hears that the socket opened again after it dropped (the daemon may have restarted meanwhile). */
  const reconnectListeners = useRef(new Set<() => void>());
  /**
   * Who hears that the lists a client holds (agents, chats) may be out of date: an agent changed (agents_changed),
   * the socket came back after a drop, or the page came back after being hidden (a phone's home-screen app sleeps in
   * the background, and polls nothing meanwhile). The desk list is asked for again at the same time.
   */
  const staleListeners = useRef(new Set<() => void>());
  const listsStale = useCallback(() => {
    for (const fn of staleListeners.current) fn();
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "list_desks" }));
  }, []);
  const [seenMap, setSeenMap] = useState<Record<string, string>>({});
  /** When each conversation was last looked at: apart from seen, which is "done". */
  const [viewedMap, setViewedMap] = useState<Record<string, string>>({});
  const [focusMap, setFocusMap] = useState<Record<string, FocusEntry>>({});
  const [restMap, setRestMap] = useState<Record<string, Rest>>({});
  /** Bumped when the mod says the task list changed (another tab, an agent's task tool call). */
  const [tasksVersion, setTasksVersion] = useState(0);
  /** Bumped when the mod says the cards changed (a review here, the worker writing, another tab): the Recall view refetches. */
  const [recallVersion, setRecallVersion] = useState(0);
  /** Bumped when the mod says the usage ledger counted more: an open usage page refetches. */
  const [usageVersion, setUsageVersion] = useState(0);
  /** The LAN listener (Settings › phone): its status, the paired phones, and the last pairing code minted here. */
  const [lanStatus, setLanStatus] = useState<PhoneLanStatus | null>(null);
  const [devices, setDevices] = useState<PairedDevice[] | null>(null);
  const [pairCode, setPairCode] = useState<PairCode | null>(null);
  /** Settings › Macs (plan 023): this Mac and the Macs paired with it, and the last Mac pairing code minted here. */
  const [macs, setMacs] = useState<Pushes["peers"] | null>(null);
  /**
   * A daemon restart due after a checkout's code changed (plan 024): the file, and which push said so, so that each
   * change shows the notice again even when it names the same file. A restarted daemon owes none.
   */
  const [restartDue, setRestartDue] = useState<{ file: string; n: number } | null>(null);
  const [macCode, setMacCode] = useState<Pushes["peer_pair_code"] | null>(null);
  /** The canvas build the mod is serving now (`app_build`, broadcast when it changes); the phone reloads on it. */
  const [servedBuild, setServedBuild] = useState<string | null>(null);
  /** The models used lately, latest first (mod/models.ts): sent when the link opens and again after every pick anywhere. */
  const [recentModels, setRecentModels] = useState<string[]>([]);
  /** Each desk's widget change log (desk/widget-rows.ts): from history replies and live `widget_change` frames, for any desk. */
  const [widgetLogs, setWidgetLogs] = useState<WidgetLogs>({});
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
        setRestartDue(null); // a daemon just started owes no restart; one still owing says so in its welcome
        ws.send(JSON.stringify({ type: "seen_list" }));
        for (const s of watchedRef.current) ws.send(JSON.stringify({ type: "desk_get", scope: s }));
        if (dropped) {
          for (const fn of reconnectListeners.current) fn();
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
        // Everything else is a push (core/frames.ts Pushes).
        const msg = raw as PushFrame;
        switch (msg.type) {
          case "desk": {
            const s = msg.scope;
            console.info(`desk frame: ${s} · ${(msg.widgets as unknown[] | undefined)?.length ?? 0} widgets`);
            const { title, status, agent_name: agentName, agent_id: agentId, model, mode } = msg;
            if (typeof title === "string" && title) setTitles((t) => withScope(t, s, title));
            if (typeof status === "string") setStatuses((t) => withScope(t, s, status));
            if (typeof agentName === "string" && agentName) setAgentNames((t) => withScope(t, s, agentName));
            if (typeof agentId === "string" && agentId) setAgentIds((t) => withScope(t, s, agentId));
            if (typeof model === "string" && model) setModels((t) => withScope(t, s, model));
            setReasoningEfforts((current) => withReasoningEffort(current, s, msg.reasoning_effort));
            if (typeof mode === "string" && mode) setModes((t) => withScope(t, s, mode));
            setDesks((d) => ({ ...d, [s]: msg.state }));
            setWidgets((w) => ({ ...w, [s]: msg.widgets }));
            const pending = pendingRef.current;
            pendingRef.current = [];
            for (const g of pending) ws.send(JSON.stringify({ type: "gesture", gesture: g }));
            const measures = pendingMeasures.current;
            pendingMeasures.current = new Map();
            for (const [id, size] of measures) ws.send(JSON.stringify({ type: "measure", id, size }));
            break;
          }
          case "state":
            setDesks((d) => ({ ...d, [msg.scope]: msg.state }));
            break;
          case "widgets":
            setWidgets((w) => ({ ...w, [msg.scope]: msg.widgets }));
            break;
          case "camera":
            if (typeof msg.widget_id === "string" && Date.now() - lastInteractionRef.current > NO_YANK_MS) {
              const widgetId = msg.widget_id;
              const widgetIds = Array.isArray(msg.widget_ids) && msg.widget_ids.length ? msg.widget_ids : [widgetId];
              setCameraTarget((t) => ({ widgetId, widgetIds, nonce: (t?.nonce ?? 0) + 1 }));
            }
            break;
          case "switch_desk": {
            const next = msg.scope;
            if (next && next !== scope) switchDesk(next);
            break;
          }
          case "desks":
            setDeskList((list) => keepSame(list, msg.desks));
            setDesksLoaded(true);
            break;
          case "chat_event":
            for (const listener of chatListeners.current) listener(msg);
            break;
          case "tasks_changed":
            setTasksVersion((v) => v + 1);
            break;
          case "agents_changed":
          case "lists_changed":
            listsStale();
            break;
          case "recall_changed":
            setRecallVersion((v) => v + 1);
            break;
          case "usage_changed":
            setUsageVersion((v) => v + 1);
            break;
          case "lan_status": {
            const st = PHONE_DEMO ? phoneDemo({ ...lanStatusFromFrame({ ...msg }), via: "tailscale" }) : lanStatusFromFrame({ ...msg });
            setLanStatus(st);
            if (!st.enabled) setPairCode(null); // a code is only redeemable while the listener is up
            break;
          }
          case "pair_code":
            if (typeof msg.code === "string" && typeof msg.url === "string" && typeof msg.expires_at === "string")
              setPairCode({ code: msg.code, url: msg.url, expiresAt: msg.expires_at });
            break;
          case "devices":
            setDevices(Array.isArray(msg.devices) ? msg.devices : []);
            break;
          case "peers":
            setMacs(macsFromFrame(msg));
            break;
          case "restart_due":
            setRestartDue((was) => (typeof msg.file === "string" ? { file: msg.file, n: (was?.n ?? 0) + 1 } : null));
            break;
          case "peer_pair_code":
            setMacCode({ code: msg.code, host: msg.host, expires_at: msg.expires_at });
            break;
          case "app_build":
            if (typeof msg.build === "string") setServedBuild(msg.build);
            break;
          case "models_recent":
            if (Array.isArray(msg.recent)) {
              const next = msg.recent.filter((h): h is string => typeof h === "string");
              setRecentModels((cur) => (cur.length === next.length && cur.every((h, i) => h === next[i]) ? cur : next));
            }
            break;
          case "widget_change": {
            // Kept under its own desk, so another desk's thread has it when that desk next opens; the phone ignores it.
            const entry = parseWidgetEntry(msg.entry);
            if (entry) setWidgetLogs((s) => withEntry(s, entry));
            // A desk shown inline elsewhere has a new or changed widget: its manifest comes again.
            if (entry && watchedRef.current.has(entry.scope)) ws.send(JSON.stringify({ type: "desk_get", scope: entry.scope }));
            break;
          }
          case "seen": {
            const { seen, viewed, focus, rests } = msg;
            // Every mark anywhere broadcasts the whole frame: a map it repeats keeps its object, so nothing re-renders on it.
            setSeenMap((m) => keepSame(m, seen));
            // A mod from before the viewed marker sends none: keep what we have rather than forget every look.
            if (viewed && typeof viewed === "object") setViewedMap((m) => keepSame(m, viewed));
            // A mod from before focus sends none: keep what we have.
            if (focus && typeof focus === "object") setFocusMap((m) => keepSame(m, focus));
            // And one from before rests.
            if (rests && typeof rests === "object") setRestMap((m) => keepSame(m, rests));
            break;
          }
          case "desk_title": {
            // Sent again on every title refresh: a repeat keeps each map as it is.
            const s = msg.scope;
            const { title, status, agent_name: agentName, model, mode } = msg;
            if (typeof title === "string" && title) setTitles((t) => withScope(t, s, title));
            if (typeof status === "string") setStatuses((t) => withScope(t, s, status));
            if (typeof agentName === "string" && agentName) setAgentNames((t) => withScope(t, s, agentName));
            if (typeof model === "string" && model) setModels((t) => withScope(t, s, model));
            setReasoningEfforts((current) => withReasoningEffort(current, s, msg.reasoning_effort));
            if (typeof mode === "string" && mode) setModes((t) => withScope(t, s, mode));
            break;
          }
          case "error":
            console.warn("loki:", msg.message);
            break;
          default:
            console.warn("loki ws: unknown frame", msg);
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
  }, [scope, switchDesk, listsStale]);

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
    scope,
    switchDesk,
    watchDesk,
    send,
    sendRaw,
    desks,
    setDesks,
    widgets,
    connection,
    cameraTarget,
    deskList,
    desksLoaded,
    setDeskList,
    titles,
    setTitles,
    statuses,
    agentNames,
    agentIds,
    models,
    setModels,
    reasoningEfforts,
    setReasoningEfforts,
    modes,
    setModes,
    chatListeners,
    reconnectListeners,
    staleListeners,
    seenMap,
    viewedMap,
    focusMap,
    restMap,
    tasksVersion,
    recallVersion,
    usageVersion,
    lanStatus,
    setLanStatus,
    devices,
    pairCode,
    macs,
    restartDue,
    macCode,
    servedBuild,
    recentModels,
    widgetLogs,
    setWidgetLogs,
    waiters,
    lastInteractionRef,
    pendingRef,
    measure,
    reportWidgetError,
  };
}

/** The map with one scope set; the same object when it already holds that value. */
export function withScope<T>(current: Partial<Record<Scope, T>>, scope: Scope, value: T): Partial<Record<Scope, T>> {
  return current[scope] === value ? current : { ...current, [scope]: value };
}

/** Settings › Macs from a `peers` push: this Mac, the Macs paired with it, and the computers on its tailnet (plan 023). */
export function macsFromFrame(msg: Pushes["peers"]): Pushes["peers"] {
  return { me: msg.me, peers: Array.isArray(msg.peers) ? msg.peers : [], tailnet: Array.isArray(msg.tailnet) ? msg.tailnet : [] };
}

/** The efforts map with one scope set, or cleared when the value is not a level. */
export function withReasoningEffort(current: Partial<Record<Scope, ReasoningEffort>>, scope: Scope, value: unknown): Partial<Record<Scope, ReasoningEffort>> {
  if (isReasoningEffort(value)) return current[scope] === value ? current : { ...current, [scope]: value };
  if (!(scope in current)) return current;
  const { [scope]: _cleared, ...next } = current;
  return next;
}
