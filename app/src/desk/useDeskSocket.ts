import { useCallback, useEffect, useRef, useState } from "react";
import type { DeskState, Gesture, Scope, Size, WidgetManifestEntry } from "../../../packages/core/src/desk-core.ts";
import { scopeFor } from "../../../packages/core/src/desk-core.ts";
import { readSession, rememberDesk } from "./session";
import { modWsBase } from "./env";
import type { Snooze } from "../../../packages/core/src/attention/snooze.ts";
import { lanStatusFromFrame, type PairCode, type PairedDevice, type PhoneLanStatus } from "../phone/model";
import type { CameraTarget, Connection, DeskStatus, DeskSummary } from "./useDesk";

const NO_YANK_MS = 2000;

/**
 * Dev only: `?phoneDemo=tailscale` on the Vite tab makes Settings › phone read as if Tailscale were
 * running on this Mac, so the route chooser and the https switch can be seen without a tailnet. The
 * flag is compiled out of production builds; `setVia` / `setServe` then change local state instead of
 * asking the mod. Remove once the mod's `tailscale.ts` is in and a real tailnet is at hand.
 */
export const PHONE_DEMO = import.meta.env.DEV && typeof location !== "undefined" && new URLSearchParams(location.search).get("phoneDemo") === "tailscale";
export function phoneDemo(s: PhoneLanStatus, serve?: boolean): PhoneLanStatus {
  const name = "deepaks-macbook-pro.tail1234.ts.net";
  const on = serve ?? !!s.tailscale?.serveUrl;
  return { ...s, tailscale: { installed: true, running: true, ip: "100.101.102.103", name, serveUrl: on ? `https://${name}` : null, error: null } };
}

/**
 * The WebSocket to the mod and everything its frames feed: which desk this tab shows, the manifests
 * and geometry per scope, the desk list, titles and agents, the seen/snooze maps, the LAN listener's
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
  const [titles, setTitles] = useState<Record<Scope, string>>({});
  const [statuses, setStatuses] = useState<Record<Scope, DeskStatus>>({});
  const [agentNames, setAgentNames] = useState<Record<Scope, string>>({});
  const [agentIds, setAgentIds] = useState<Record<Scope, string>>({});
  const [models, setModels] = useState<Record<Scope, string>>({});
  const [modes, setModes] = useState<Record<Scope, string>>({});
  /** From the mod: is an app-server tunnel available, and which conversations have been seen. */
  const [appServer, setAppServer] = useState(false);
  const [seenMap, setSeenMap] = useState<Record<string, string>>({});
  const [snoozeMap, setSnoozeMap] = useState<Record<string, Snooze>>({});
  /** Bumped when the mod says the board changed (another tab, an agent's loki_task call). */
  const [tasksVersion, setTasksVersion] = useState(0);
  /** The LAN listener (Settings › phone): its status, the paired phones, and the last pairing code minted here. */
  const [lanStatus, setLanStatus] = useState<PhoneLanStatus | null>(null);
  const [devices, setDevices] = useState<PairedDevice[] | null>(null);
  const [pairCode, setPairCode] = useState<PairCode | null>(null);
  /** The canvas build the mod is serving now (`app_build`, broadcast when it changes); the phone reloads on it. */
  const [servedBuild, setServedBuild] = useState<string | null>(null);
  /** Pending request/reply exchanges with the mod, by requestId. */
  const waiters = useRef(new Map<string, (msg: Record<string, unknown>) => void>());

  const wsRef = useRef<WebSocket | null>(null);
  const lastInteractionRef = useRef(0);
  const pendingRef = useRef<Gesture[]>([]);
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
      setScope(next); // the connection effect re-runs on the new desk
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
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${modWsBase()}/ws?t=${token}&desk=${encodeURIComponent(scope)}`);
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
            console.info(`desk frame: ${s} · ${(msg.widgets as unknown[] | undefined)?.length ?? 0} widgets`);
            if (typeof msg.title === "string" && msg.title) setTitles((t) => ({ ...t, [s]: msg.title as string }));
            if (typeof msg.status === "string") setStatuses((t) => ({ ...t, [s]: msg.status as DeskStatus }));
            if (typeof msg.agentName === "string" && msg.agentName) setAgentNames((t) => ({ ...t, [s]: msg.agentName as string }));
            if (typeof msg.agentId === "string" && msg.agentId) setAgentIds((t) => ({ ...t, [s]: msg.agentId as string }));
            if (typeof msg.model === "string" && msg.model) setModels((t) => ({ ...t, [s]: msg.model as string }));
            if (typeof msg.mode === "string" && msg.mode) setModes((t) => ({ ...t, [s]: msg.mode as string }));
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
            setDeskList(msg.desks as DeskSummary[]);
            break;
          case "config":
            setAppServer(msg.appServer === true);
            break;
          case "tasks_changed":
            setTasksVersion((v) => v + 1);
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
          case "agent":
          case "memory_file":
          case "memory_commits":
          case "memory_diff":
          case "agent_error":
          case "tasks":
          case "task_created":
          case "tasks_updated":
          case "task_error":
          case "history":
          case "folders":
          case "folder_matches":
          case "folder_status":
          case "folder_picked":
          case "skills_global":
          case "skill_installed": {
            const w = typeof msg.requestId === "string" ? waiters.current.get(msg.requestId) : undefined;
            if (w) {
              waiters.current.delete(msg.requestId as string);
              w(msg);
            }
            break;
          }
          case "seen":
            setSeenMap((msg.seen as Record<string, string>) ?? {});
            setSnoozeMap((msg.snooze as Record<string, Snooze>) ?? {});
            if (typeof msg.appServer === "boolean") setAppServer(msg.appServer);
            break;
          case "desk_title":
            if (typeof msg.title === "string" && msg.title) setTitles((t) => ({ ...t, [msg.scope as Scope]: msg.title as string }));
            if (typeof msg.status === "string") setStatuses((t) => ({ ...t, [msg.scope as Scope]: msg.status as DeskStatus }));
            if (typeof msg.agentName === "string" && msg.agentName) setAgentNames((t) => ({ ...t, [msg.scope as Scope]: msg.agentName as string }));
            if (typeof msg.model === "string" && msg.model) setModels((t) => ({ ...t, [msg.scope as Scope]: msg.model as string }));
            if (typeof msg.mode === "string" && msg.mode) setModes((t) => ({ ...t, [msg.scope as Scope]: msg.mode as string }));
            break;
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

  return {
    scope,
    switchDesk,
    send,
    desks,
    setDesks,
    widgets,
    connection,
    cameraTarget,
    deskList,
    setDeskList,
    titles,
    statuses,
    agentNames,
    agentIds,
    models,
    setModels,
    modes,
    setModes,
    appServer,
    seenMap,
    snoozeMap,
    tasksVersion,
    lanStatus,
    setLanStatus,
    devices,
    pairCode,
    servedBuild,
    waiters,
    lastInteractionRef,
    pendingRef,
    measure,
    reportWidgetError,
  };
}
