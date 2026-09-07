import { useCallback, useEffect, useRef, useState } from "react";
import type { DeskState, Gesture, Scope, Size, WidgetLayout, WidgetManifestEntry } from "../../../shared/desk-core.ts";
import { SHARED_SCOPE, applyGesture, autoPlace, emptyDesk, scopeFor } from "../../../shared/desk-core.ts";
import { readSession, rememberDesk } from "./session";
import { inTauri, modWsBase } from "./env";
import type { Task } from "../board/model";
import type { AgentDetails } from "../agents/Agents";
import type { GlobalSkill } from "../../../mod/skills.ts";
import type { MemoryCommit } from "../../../mod/agents.ts";
import type { Snooze } from "../attention/snooze";
import type { TranscriptRow } from "../chat/Transcript";

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
  /** The model the conversation runs on (its override, else the agent's). */
  model: string | null;
  /** The permission mode Letta persisted for the conversation. */
  mode?: string | null;
  pinned?: boolean;
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
  /** Pending request/reply exchanges with the mod, by requestId. */
  const waiters = useRef(new Map<string, (msg: Record<string, unknown>) => void>());

  const wsRef = useRef<WebSocket | null>(null);
  const lastInteractionRef = useRef(0);
  const pendingRef = useRef<Gesture[]>([]);
  /** Latest measured size per widget that could not be sent yet (frames measure before the socket opens). */
  const pendingMeasures = useRef(new Map<string, Size>());

  useEffect(() => {
    let disposed = false;
    let retryMs = 500;
    const token = readSession().token;

    const connect = () => {
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

  /** Show another desk in this tab: URL param + reconnect. */
  const switchDesk = (next: Scope) => {
    if (!next || next === scope) return;
    rememberDesk(next);
    const url = new URL(location.href);
    url.searchParams.set("desk", next);
    history.replaceState(null, "", url);
    setScope(next); // the connection effect re-runs on the new desk
  };

  const requestDesks = () => {
    send({ type: "list_desks" });
  };

  /**
   * Ask the mod something and wait for the reply frame carrying the same requestId (null on timeout).
   * A request made before the socket is open (a view mounting at startup) is sent as soon as it is.
   */
  const request = (type: string, payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown> | null> =>
    new Promise((resolve) => {
      const requestId = `${type}-${Math.random().toString(36).slice(2, 10)}`;
      let retry: number | null = null;
      const done = (m: Record<string, unknown> | null) => {
        window.clearTimeout(timer);
        if (retry !== null) window.clearInterval(retry);
        waiters.current.delete(requestId);
        resolve(m);
      };
      const timer = window.setTimeout(() => done(null), timeoutMs);
      waiters.current.set(requestId, done);
      const frame = { type, requestId, ...payload };
      if (!send(frame)) {
        retry = window.setInterval(() => {
          if (send(frame) && retry !== null) {
            window.clearInterval(retry);
            retry = null;
          }
        }, 250);
      }
    });

  const send = (msg: object): boolean => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  };

  /** Inverse gestures, newest last; ⌘Z on the sheet pops one. Local to this window. */
  const undoStack = useRef<Gesture[]>([]);
  const desksRef = useRef(desks);
  desksRef.current = desks;
  const inverseOf = (g: Gesture): Gesture | null => {
    const s = scopeOfId(g.id);
    const l = desksRef.current[s]?.layout[g.id];
    switch (g.kind) {
      case "move":
        return l ? { kind: "move", id: g.id, position: l.position } : null;
      case "resize":
        return l?.size ? { kind: "resize", id: g.id, size: l.size } : null;
      case "close":
        return { kind: "open", id: g.id };
      case "open":
        return { kind: "close", id: g.id };
      case "set":
        return g.prev === undefined ? null : { kind: "set", id: g.id, path: g.path, value: g.prev, prev: g.value };
      default:
        return null; // focus is not worth undoing
    }
  };
  const apply = (g: Gesture) => {
    lastInteractionRef.current = Date.now();
    const s = scopeOfId(g.id);
    setDesks((d) => ({ ...d, [s]: applyGesture(d[s] ?? emptyDesk(s), g) }));
    if (!send({ type: "gesture", gesture: g })) pendingRef.current.push(g);
  };
  const gesture = (g: Gesture) => {
    const inv = inverseOf(g);
    if (inv) {
      // Drags arrive as a stream of moves; keep one undo step per widget per burst.
      const top = undoStack.current[undoStack.current.length - 1];
      if (!(top && top.kind === inv.kind && top.id === inv.id && Date.now() - lastInteractionRef.current < 400)) undoStack.current.push(inv);
      if (undoStack.current.length > 60) undoStack.current.shift();
    }
    apply(g);
  };
  /** Undo the last widget move, resize, close, open, or data edit. Returns false when there is nothing to undo. */
  const undo = (): boolean => {
    const inv = undoStack.current.pop();
    if (!inv) return false;
    apply(inv);
    return true;
  };

  const reportWidgetError = useCallback((id: string, error: string | null) => {
    send({ type: "widget_status", id, error });
  }, []);

  const measure = useCallback((id: string, size: Size) => {
    if (!send({ type: "measure", id, size })) pendingMeasures.current.set(id, size); // flushed when the desk frame arrives
  }, []);

  const token = readSession().token;
  const tunnelUrl = `${modWsBase()}/appserver?t=${token}`;
  /** The board, through the mod. Every call resolves to tasks or an error message; never throws. */
  const boardCall = (type: string, payload: Record<string, unknown>): Promise<{ ok: true; tasks: Task[] } | { ok: false; message: string }> =>
    request(type, payload, 25_000).then((m) => {
      if (!m) return { ok: false, message: "no answer from the mod" };
      if (m.type === "task_error") return { ok: false, message: String(m.message ?? "the board refused") };
      const tasks = (m.tasks as Task[] | undefined) ?? (m.task ? [m.task as Task] : []);
      return { ok: true, tasks };
    });
  const board = {
    list: (all = true) => boardCall("tasks_list", { all }),
    create: (t: { title: string; description?: string; labels?: string[]; priority?: number; desk?: string | null; agentId?: string | null; agentName?: string | null; conversationId?: string | null }) => boardCall("task_create", t),
    assign: (ids: string[], target: { agentId: string | null; agentName: string | null; conversationId: string; desk: string }, start: boolean) => boardCall("task_assign", { ids, ...target, start }),
    close: (ids: string[], reason?: string) => boardCall("task_close", { ids, reason }),
    setStatus: (ids: string[], status: "open" | "in_progress" | "blocked" | "deferred") => boardCall("task_status", { ids, status }),
  };

  /** The Agents page, through the mod: the local record and the memory filesystem (read-only). */
  const agents = {
    get: (agentId: string) =>
      request("agent_get", { agentId }, 10_000).then((m) => (m && m.type === "agent" ? ({ agent: m.agent, files: m.files, skills: m.skills, hasProfile: m.hasProfile === true, lastCommit: m.lastCommit ?? null } as AgentDetails) : null)),
    read: (agentId: string, path: string) => request("memory_read", { agentId, path }, 10_000).then((m) => (m && m.type === "memory_file" ? ((m.content as string | null) ?? null) : null)),
    log: (agentId: string, path?: string, limit?: number) => request("memory_log", { agentId, path, limit }, 15_000).then((m) => (m && m.type === "memory_commits" ? ((m.commits as MemoryCommit[]) ?? []) : [])),
    diff: (agentId: string, sha: string) => request("memory_diff", { agentId, sha }, 15_000).then((m) => (m && m.type === "memory_diff" ? ((m.diff as string) ?? null) : null)),
    globalSkills: () => request("skills_global", {}, 10_000).then((m) => (m && m.type === "skills_global" ? ((m.skills as GlobalSkill[]) ?? []) : [])),
    /** `letta install <source> --agent <id>` through the mod; resolves to an error message or null. */
    installSkill: (agentId: string, source: string, force = false) =>
      request("skill_install", { agentId, source, force }, 130_000).then((m) => (m && m.type === "skill_installed" ? null : m && m.type === "agent_error" ? String(m.message ?? "install failed") : "install timed out")),
  };

  const attention = {
    available: appServer || inTauri, // the shell holds its own link; the mod's discovery flag only matters in a browser tab
    tunnelUrl,
    seen: seenMap,
    snooze: snoozeMap,
    markSeen: (agentId: string, conversationId: string) => send({ type: "seen_mark", agentId, conversationId }),
    unmarkSeen: (agentId: string, conversationId: string) => send({ type: "seen_unmark", agentId, conversationId }),
    setSnooze: (agentId: string, conversationId: string, rec: Snooze) => send({ type: "snooze_set", agentId, conversationId, ...rec }),
    /** The conversation's transcript from the mod's local log; empty if the mod does not know it (or predates this frame). */
    loadHistory: (agentId: string, conversationId: string): Promise<TranscriptRow[]> =>
      request("history_get", { agentId, conversationId }, 4000).then((m) => ((m?.messages as TranscriptRow[] | undefined) ?? [])),
    /** Working folders for "new desk" — all answered by the mod, which can see the disk. */
    folders: {
      recent: () => request("folders_get", {}, 4000).then((m) => ({ byAgent: ((m?.byAgent as Record<string, string[]>) ?? {}), byConversation: ((m?.byConversation as Record<string, string>) ?? {}) })),
      complete: (prefix: string) => request("folder_complete", { prefix }, 3000).then((m) => ((m?.matches as string[] | undefined) ?? [])),
      check: (path: string) => request("folder_check", { path }, 3000).then((m) => (m ? { ok: m.ok === true, path: String(m.path ?? path), branch: (m.branch as string | null) ?? null, reason: (m.reason as string | undefined) } : { ok: false, path, branch: null, reason: "no answer from the mod" })),
      pick: (defaultPath?: string) => request("folder_pick", { defaultPath }, 180_000).then((m) => ((m?.path as string | null | undefined) ?? null)),
    },
    clearSnooze: (agentId: string, conversationId: string) => send({ type: "snooze_clear", agentId, conversationId }),
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
  /** The desk frame for this scope has arrived; before that ownCount is not meaningful. */
  const loaded = widgets[scope] !== undefined;

  const title = titles[scope] ?? null;
  const status: DeskStatus = statuses[scope] ?? "none";
  const agentName = agentNames[scope] ?? null;
  const model = models[scope] ?? null;
  /** After a switch the mod only re-reads the conversation at the next turn end; remember the new model now. */
  const setDeskModel = (s: Scope, handle: string) => {
    setModels((t) => ({ ...t, [s]: handle }));
    setDeskList((l) => l.map((d) => (d.scope === s ? { ...d, model: handle } : d)));
  };
  const modelOf = (s: Scope): string | null => models[s] ?? deskList.find((d) => d.scope === s)?.model ?? null;
  const mode = modes[scope] ?? null;
  const setDeskMode = (s: Scope, m: string) => {
    setModes((t) => ({ ...t, [s]: m }));
    setDeskList((l) => l.map((d) => (d.scope === s ? { ...d, mode: m } : d)));
  };
  const modeOf = (s: Scope): string | null => modes[s] ?? deskList.find((d) => d.scope === s)?.mode ?? null;
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
    model,
    modelOf,
    setDeskModel,
    mode,
    modeOf,
    setDeskMode,
    connection,
    visible,
    closed,
    ownCount,
    loaded,
    desks: {
      list: deskList,
      request: requestDesks,
      switchTo: switchDesk,
      /** Pin or unpin; the mod rewrites Letta's file and broadcasts the list back. */
      pin: (agentId: string, conversationId: string, pinned: boolean) => send({ type: "pin_set", agentId, conversationId, pinned }),
    },
    attention,
    board,
    tasksVersion,
    undo,
    agents,
    gesture,
    measure,
    arrange,
    trash,
    reportWidgetError,
    cameraTarget,
  };
}
