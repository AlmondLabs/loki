import { useCallback, useEffect, useRef, useState } from "react";
import type { DeskState, Gesture, Scope, Size, WidgetManifestEntry } from "../../../core/desk-core.ts";
import { scopeFor } from "../../../core/desk-core.ts";
import { readSession, rememberDesk } from "./session";
import { modWsBase } from "./env";
import type { FocusEntry } from "../../../core/attention/focus.ts";
import { lanStatusFromFrame, type PairCode, type PairedDevice, type PhoneLanStatus } from "../phone/model";
import type { CameraTarget, Connection } from "./useDesk";
import { isReasoningEffort, type ReasoningEffort } from "../../../core/models.ts";
import { parseWidgetEntry, withEntry, type WidgetLogs } from "./widgetRows";
import type { DeskStatus, DeskSummary } from "../../../core/frame-types.ts";

const NO_YANK_MS = 2000;

/**
 * Dev only: `?phoneDemo=tailscale` on the Vite tab makes Settings › phone read as if Tailscale were
 * running on this Mac, so the route chooser and the https switch can be seen without a tailnet. The
 * flag is compiled out of production builds; `setVia` / `setServe` then change local state instead of
 * asking the mod. Remove once the mod's `tailscale.ts` is in and a real tailnet is at hand.
 */
export const PHONE_DEMO = import.meta.env.DEV && typeof location !== "undefined" && new URLSearchParams(location.search).get("phoneDemo") === "tailscale";
export function phoneDemo(s: PhoneLanStatus, serve?: boolean): PhoneLanStatus {
  const name = "my-macbook-pro.tail1234.ts.net";
  const on = serve ?? !!s.tailscale?.serveUrl;
  return { ...s, tailscale: { installed: true, running: true, ip: "100.101.102.103", name, serveUrl: on ? `https://${name}` : null, error: null } };
}

/**
 * The mod's replies to a request (they carry its requestId): each resolves the waiting `request()` and does
 * nothing else. A reply missing here is never resolved, and its request times out as if the mod were silent
 * (test/desk-socket.test.ts checks this list against the replies mod/bridge.ts sends).
 */
export const REPLY_FRAMES: ReadonlySet<string> = new Set(["agent", "memory_file", "memory_commits", "memory_diff", "reflection_state", "agent_error", "tasks", "task_created", "tasks_updated", "task_error", "history", "folders", "folder_matches", "folder_status", "folder_picked", "skills_global", "skill_installed", "skill_refreshed", "inbox", "recall", "recall_card", "recall_ran", "recall_export", "recall_lesson", "recall_error"]);

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
  const [desks, setDesks] = useState<Record<Scope, DeskState>>({});
  const [widgets, setWidgets] = useState<Record<Scope, WidgetManifestEntry[]>>({});
  const [connection, setConnection] = useState<Connection>("connecting");
  const [cameraTarget, setCameraTarget] = useState<CameraTarget | null>(null);
  const [deskList, setDeskList] = useState<DeskSummary[]>([]);
  /** A desks frame has arrived: an empty list is then "no desks", not "not asked yet" (the phone's Home says which). */
  const [desksLoaded, setDesksLoaded] = useState(false);
  const [titles, setTitles] = useState<Record<Scope, string>>({});
  const [statuses, setStatuses] = useState<Record<Scope, DeskStatus>>({});
  const [agentNames, setAgentNames] = useState<Record<Scope, string>>({});
  const [agentIds, setAgentIds] = useState<Record<Scope, string>>({});
  const [models, setModels] = useState<Record<Scope, string>>({});
  const [reasoningEfforts, setReasoningEfforts] = useState<Record<Scope, ReasoningEffort>>({});
  const [modes, setModes] = useState<Record<Scope, string>>({});
  /** From the mod: is an app-server tunnel available, and which conversations have been seen. */
  const [appServer, setAppServer] = useState(false);
  const [seenMap, setSeenMap] = useState<Record<string, string>>({});
  /** When each conversation was last looked at: apart from seen, which is "done". */
  const [viewedMap, setViewedMap] = useState<Record<string, string>>({});
  const [focusMap, setFocusMap] = useState<Record<string, FocusEntry>>({});
  /** Bumped when the mod says the board changed (another tab, an agent's loki_task call). */
  const [tasksVersion, setTasksVersion] = useState(0);
  /** Bumped when the mod says the cards changed (a review here, the worker writing, another tab): the Recall view refetches. */
  const [recallVersion, setRecallVersion] = useState(0);
  /** The LAN listener (Settings › phone): its status, the paired phones, and the last pairing code minted here. */
  const [lanStatus, setLanStatus] = useState<PhoneLanStatus | null>(null);
  const [devices, setDevices] = useState<PairedDevice[] | null>(null);
  const [pairCode, setPairCode] = useState<PairCode | null>(null);
  /** The canvas build the mod is serving now (`app_build`, broadcast when it changes); the phone reloads on it. */
  const [servedBuild, setServedBuild] = useState<string | null>(null);
  /** The models used lately, latest first (mod/models.ts): sent when the link opens and again after every pick anywhere. */
  const [recentModels, setRecentModels] = useState<string[]>([]);
  /** Each desk's widget change log (desk/widgetRows.ts): from history replies and live `widget_change` frames, for any desk. */
  const [widgetLogs, setWidgetLogs] = useState<WidgetLogs>({});
  /** Pending request/reply exchanges with the mod, by requestId. */
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
    const token = readSession().token;

    const connect = () => {
      if (disposed) return;
      const ws = new WebSocket(`${modWsBase()}/ws?t=${token}&desk=${encodeURIComponent(scope)}`);
      wsRef.current = ws;
      setConnection("connecting");

      ws.onopen = () => {
        retryMs = 500;
        setConnection("open");
        ws.send(JSON.stringify({ type: "seen_list" }));
        for (const s of watchedRef.current) ws.send(JSON.stringify({ type: "desk_get", scope: s }));
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as Record<string, unknown> & { type: string };
        // A reply to a request (a request/reply exchange, by requestId): it goes to whoever asked, nowhere else.
        if (REPLY_FRAMES.has(String(msg.type))) {
          const w = typeof msg.requestId === "string" ? waiters.current.get(msg.requestId) : undefined;
          if (w) {
            waiters.current.delete(msg.requestId as string);
            w(msg);
          }
          return;
        }
        switch (msg.type) {
          case "desk": {
            const s = msg.scope as Scope;
            console.info(`desk frame: ${s} · ${(msg.widgets as unknown[] | undefined)?.length ?? 0} widgets`);
            const { title, status, agentName, agentId, model, mode } = msg;
            if (typeof title === "string" && title) setTitles((t) => withScope(t, s, title));
            if (typeof status === "string") setStatuses((t) => withScope(t, s, status as DeskStatus));
            if (typeof agentName === "string" && agentName) setAgentNames((t) => withScope(t, s, agentName));
            if (typeof agentId === "string" && agentId) setAgentIds((t) => withScope(t, s, agentId));
            if (typeof model === "string" && model) setModels((t) => withScope(t, s, model));
            setReasoningEfforts((current) => withReasoningEffort(current, s, msg.reasoningEffort));
            if (typeof mode === "string" && mode) setModes((t) => withScope(t, s, mode));
            setDesks((d) => ({ ...d, [s]: msg.state as DeskState }));
            setWidgets((w) => ({ ...w, [s]: msg.widgets as WidgetManifestEntry[] }));
            const pending = pendingRef.current;
            pendingRef.current = [];
            for (const g of pending) ws.send(JSON.stringify({ type: "gesture", gesture: g }));
            const measures = pendingMeasures.current;
            pendingMeasures.current = new Map();
            for (const [id, size] of measures) ws.send(JSON.stringify({ type: "measure", id, size }));
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
            setDeskList((list) => keepSame(list, msg.desks as DeskSummary[]));
            setDesksLoaded(true);
            break;
          case "config":
            setAppServer(msg.appServer === true);
            break;
          case "tasks_changed":
            setTasksVersion((v) => v + 1);
            break;
          case "recall_changed":
            setRecallVersion((v) => v + 1);
            break;
          case "lan_status": {
            const st = PHONE_DEMO ? phoneDemo({ ...lanStatusFromFrame(msg), via: "tailscale" }) : lanStatusFromFrame(msg);
            setLanStatus(st);
            if (!st.enabled) setPairCode(null); // a code is only redeemable while the listener is up
            break;
          }
          case "pair_code":
            if (typeof msg.code === "string" && typeof msg.url === "string" && typeof msg.expiresAt === "string") setPairCode({ code: msg.code, url: msg.url, expiresAt: msg.expiresAt });
            break;
          case "devices":
            setDevices(Array.isArray(msg.devices) ? (msg.devices as PairedDevice[]) : []);
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
          case "seen":
            // Every mark anywhere broadcasts the whole frame: a map it repeats keeps its object, so nothing re-renders on it.
            setSeenMap((m) => keepSame(m, (msg.seen as Record<string, string>) ?? {}));
            // A mod from before the viewed marker sends none: keep what we have rather than forget every look.
            if (msg.viewed && typeof msg.viewed === "object") setViewedMap((m) => keepSame(m, msg.viewed as Record<string, string>));
            // A mod from before focus sends none: keep what we have.
            if (msg.focus && typeof msg.focus === "object") setFocusMap((m) => keepSame(m, msg.focus as Record<string, FocusEntry>));
            if (typeof msg.appServer === "boolean") setAppServer(msg.appServer);
            break;
          case "desk_title": {
            // Sent again on every title refresh: a repeat keeps each map as it is.
            const s = msg.scope as Scope;
            const { title, status, agentName, model, mode } = msg;
            if (typeof title === "string" && title) setTitles((t) => withScope(t, s, title));
            if (typeof status === "string") setStatuses((t) => withScope(t, s, status as DeskStatus));
            if (typeof agentName === "string" && agentName) setAgentNames((t) => withScope(t, s, agentName));
            if (typeof model === "string" && model) setModels((t) => withScope(t, s, model));
            setReasoningEfforts((current) => withReasoningEffort(current, s, msg.reasoningEffort));
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
  }, [scope, switchDesk]);

  const send = (msg: object): boolean => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  };

  const reportWidgetError = useCallback((id: string, error: string | null) => {
    send({ type: "widget_status", id, error });
  }, []);

  const measure = useCallback((id: string, size: Size) => {
    if (!send({ type: "measure", id, size })) pendingMeasures.current.set(id, size); // flushed when the desk frame arrives
  }, []);

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
    appServer,
    seenMap,
    viewedMap,
    focusMap,
    tasksVersion,
    recallVersion,
    lanStatus,
    setLanStatus,
    devices,
    pairCode,
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
export function withScope<T>(current: Record<Scope, T>, scope: Scope, value: T): Record<Scope, T> {
  return current[scope] === value ? current : { ...current, [scope]: value };
}

/** Plain frame data (maps, lists, strings, numbers) compared by content. */
function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameData((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** `next`, unless it holds what `prev` holds: then `prev`, so a repeated frame changes no reference. */
export function keepSame<T>(prev: T, next: T): T {
  return sameData(prev, next) ? prev : next;
}

/** The efforts map with one scope set, or cleared when the value is not a level. */
export function withReasoningEffort(current: Record<Scope, ReasoningEffort>, scope: Scope, value: unknown): Record<Scope, ReasoningEffort> {
  if (isReasoningEffort(value)) return current[scope] === value ? current : { ...current, [scope]: value };
  if (!(scope in current)) return current;
  const next = { ...current };
  delete next[scope];
  return next;
}
