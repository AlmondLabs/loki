import { useEffect, useRef } from "react";
import type { Gesture, Scope } from "../../../packages/core/src/desk-core.ts";
import { SHARED_SCOPE, applyGesture, emptyDesk } from "../../../packages/core/src/desk-core.ts";
import { readSession } from "./session";
import { inTauri, modWsBase } from "./env";
import { PHONE_DEMO, phoneDemo, useDeskSocket } from "./useDeskSocket";
import { deskView } from "./view";
import type { Task } from "../board/model";
import type { AgentDetails } from "../agents/Agents";
import type { GlobalSkill } from "../../../mod/skills.ts";
import type { RefreshOutcome } from "../../../mod/skill-sources.ts";
import type { MemoryCommit } from "../../../mod/agents.ts";
import type { InboxRow as InboxConversation } from "../../../mod/desks.ts";
import type { CardWithSchedule, RecallSnapshot } from "../../../packages/core/src/recall/model.ts";
import type { Grade } from "../../../packages/core/src/recall/fsrs.ts";
import type { Snooze } from "../../../packages/core/src/attention/snooze.ts";
import type { TranscriptRow } from "../chat/Transcript";
import type { LanVia } from "../phone/model";

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

export type { VisibleWidget } from "./view";

const scopeOfId = (id: string): Scope => id.slice(0, Math.max(0, id.indexOf("/"))) || SHARED_SCOPE;

/**
 * The tab's view of the desk: manifest + geometry per scope, synced from the
 * mod over WebSocket. Gestures apply optimistically with the same pure
 * reducer the mod uses, then go up the wire.
 */
/** A `recall` reply frame as the snapshot the view holds, or null for anything else. */
const recallSnapshot = (m: Record<string, unknown> | null): RecallSnapshot | null => (m && m.type === "recall" ? ({ cards: m.cards, rejected: m.rejected, worker: m.worker } as RecallSnapshot) : null);

export function useDesk() {
  const {
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
    recallVersion,
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
  } = useDeskSocket();

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

  /** Inverse gestures, newest last; ⌘Z on the sheet pops one. Local to this window. */
  const undoStack = useRef<Gesture[]>([]);
  const desksRef = useRef(desks);
  useEffect(() => {
    desksRef.current = desks;
  });
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

  /** Recall, through the mod (mod/recall.ts): the cards, a review, a delete and its undo, the worker's knobs. */
  const recallCall = (type: string, payload: Record<string, unknown>): Promise<{ ok: true; card: CardWithSchedule | null } | { ok: false; message: string }> =>
    request(type, payload, 15_000).then((m) => {
      if (!m) return { ok: false, message: "no answer from the mod" };
      if (m.type === "recall_error") return { ok: false, message: String(m.message ?? "recall refused") };
      return { ok: true, card: (m.card as CardWithSchedule | null) ?? null };
    });
  const recall = {
    list: () => request("recall_list", {}, 15_000).then(recallSnapshot),
    grade: (id: string, grade: Grade) => recallCall("recall_grade", { id, grade }),
    edit: (id: string, text: { front?: string; back?: string; tags?: string[] }) => recallCall("recall_edit", { id, ...text }),
    reject: (id: string) => recallCall("recall_reject", { id }),
    restore: (id: string) => recallCall("recall_restore", { id }),
    forget: (id: string) => recallCall("recall_forget", { id }),
    settings: (s: { enabled?: boolean; model?: string | null; dailyCap?: number }) => request("recall_settings", s, 15_000).then(recallSnapshot),
    /** Run the worker now; resolves to its one-line note (or the error). */
    run: () => request("recall_run", {}, 240_000).then((m) => (m && m.type === "recall_ran" ? String(m.note) : m && m.type === "recall_error" ? String(m.message) : "no answer from the mod")),
    /** Anki's plain-text import format, or null. */
    export: () => request("recall_export", {}, 15_000).then((m) => (m && m.type === "recall_export" ? String(m.tsv) : null)),
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
    /** Refresh an installed skill from its upstream (mod/skill-sources.ts); the outcome, or `{ error }`. */
    refreshSkill: (agentId: string, name: string, source?: string) =>
      request("skill_refresh", { agentId, name, source }, 130_000).then((m): RefreshOutcome | { error: string } => (m && m.type === "skill_refreshed" ? (m as unknown as RefreshOutcome) : { error: m && m.type === "agent_error" ? String(m.message ?? "refresh failed") : "refresh timed out" })),
  };

  const attention = {
    available: appServer || inTauri, // the shell holds its own link; the mod's discovery flag only matters in a browser tab
    tunnelUrl,
    seen: seenMap,
    snooze: snoozeMap,
    markSeen: (agentId: string, conversationId: string) => send({ type: "seen_mark", agentId, conversationId }),
    unmarkSeen: (agentId: string, conversationId: string) => send({ type: "seen_unmark", agentId, conversationId }),
    setSnooze: (agentId: string, conversationId: string, rec: Snooze) => send({ type: "snooze_set", agentId, conversationId, ...rec }),
    /** Every open conversation from the mod's disk scan, with who spoke last; the inbox's list. Empty when the mod does not answer. */
    listInbox: (): Promise<InboxConversation[]> => request("inbox_list", {}, 8000).then((m) => ((m?.conversations as InboxConversation[] | undefined) ?? [])),
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

  /**
   * Settings › phone: the mod's LAN listener and the phones paired to it. Every action is a frame; the
   * answers (`lan_status`, `pair_code`, `devices`) land in state above, and the first and last are also
   * broadcast whenever they change, so the section reads the same in every window.
   */
  const phone = {
    status: lanStatus,
    devices,
    lastCode: pairCode,
    /** Ask for the status and the device list (the section does this on mount). */
    refresh: () => {
      send({ type: "lan_get" });
      send({ type: "devices_list" });
    },
    setEnabled: (enabled: boolean) => send({ type: "lan_set", enabled }),
    /** Which way the QR sends the phone (addendum 3); the mod persists it and answers with `lan_status`. */
    setVia: (via: LanVia) => (PHONE_DEMO ? setLanStatus((s) => (s ? phoneDemo({ ...s, via }) : s)) : send({ type: "lan_via_set", via })),
    /** Put `tailscale serve` in front of the listener, or take it off; a CLI failure lands in `tailscale.error`. */
    setServe: (enabled: boolean) => (PHONE_DEMO ? setLanStatus((s) => (s ? phoneDemo(s, enabled) : s)) : send({ type: "lan_serve_set", enabled })),
    /** Mint a pairing code; the reply arrives as `lastCode`. */
    beginPair: () => send({ type: "pair_begin" }),
    forget: (id: string) => send({ type: "device_forget", id }),
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

  const { visible, closed, ownCount, loaded } = deskView(scope, desks, widgets);

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
    phone,
    servedBuild,
    board,
    tasksVersion,
    recall,
    recallVersion,
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
