import { useCallback, useEffect, useRef } from "react";
import type { Gesture, Scope } from "../../../core/desk-core.ts";
import { SHARED_SCOPE, applyGesture, emptyDesk, scopeFor, scopeOfId } from "../../../core/desk-core.ts";
import { readSession } from "./session";
import { inTauri, modWsBase } from "./env";
import { PHONE_DEMO, phoneDemo, useDeskSocket, withReasoningEffort } from "./useDeskSocket";
import { deskView } from "./view";
import { withHistoryLog } from "./widgetRows";

import type { AgentDetails } from "../agents/Agents";

import type { CardWithSchedule, RecallSnapshot } from "../../../core/recall/model.ts";
import type { Grade } from "../../../core/recall/fsrs.ts";
import type { EngageAction } from "../../../core/attention/useAttention.ts";
import type { TranscriptRow } from "../chat/Transcript";

import type { ReasoningEffort } from "../../../core/models.ts";
import { requestResult, type InputOf, type Replies, type ReplyOf, type RequestName, type RequestResult } from "../../../core/frames.ts";
import type { DeskStatus, GlobalSkill, InboxRow as InboxConversation, LanVia, MemoryCommit, ReflectionState, RefreshOutcome, Task } from "../../../core/frame-types.ts";

export type Connection = "connecting" | "open" | "closed";

export interface CameraTarget {
  widgetId: string;
  /** All ids to frame together (first is widgetId). */
  widgetIds: string[];
  nonce: number;
}

export type { VisibleWidget } from "./view";


/**
 * The tab's view of the desk: manifest + geometry per scope, synced from the
 * mod over WebSocket. Gestures apply optimistically with the same pure
 * reducer the mod uses, then go up the wire.
 */
/** A `recall` reply as the snapshot the view holds, or null when the mod refused or did not answer. */
const recallSnapshot = (r: RequestResult<RecallSnapshot>): RecallSnapshot | null =>
  r.ok ? { cards: r.reply.cards, rejected: r.reply.rejected, worker: r.reply.worker, leads: r.reply.leads ?? [], dismissedLeads: r.reply.dismissedLeads ?? [], lessons: r.reply.lessons ?? [] } : null;

/** Captures kept while the socket is closed; the oldest go first. */
const CAPTURES_HELD = 50;

export function useDesk() {
  const {
    scope,
    switchDesk,
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
    watchDesk,
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
   * A request to the mod (core/frames.ts): its reply, typed by the table, or why not. The mod answers a request it
   * cannot serve with `error` at once; only silence waits out `timeoutMs`. Never throws. A request made before the
   * socket is open (a view mounting at startup) is sent as soon as it is.
   */
  const request = <N extends RequestName>(type: N, payload: InputOf<N>, timeoutMs: number): Promise<RequestResult<ReplyOf<N>>> =>
    new Promise((resolve) => {
      const requestId = `${type}-${Math.random().toString(36).slice(2, 10)}`;
      let retry: number | null = null;
      const done = (m: Record<string, unknown> | null) => {
        window.clearTimeout(timer);
        if (retry !== null) window.clearInterval(retry);
        waiters.current.delete(requestId);
        resolve(requestResult<ReplyOf<N>>(m));
      };
      const timer = window.setTimeout(() => done(null), timeoutMs);
      waiters.current.set(requestId, done);
      const frame = { type, requestId, ...payload };
      if (!sendRaw(frame)) {
        retry = window.setInterval(() => {
          if (sendRaw(frame) && retry !== null) {
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
  const boardCall = <N extends "tasks_list" | "task_create" | "task_assign" | "task_close" | "task_status">(type: N, payload: InputOf<N>): Promise<{ ok: true; tasks: Task[] } | { ok: false; message: string }> =>
    request(type, payload, 25_000).then((r) => {
      if (!r.ok) return { ok: false, message: r.error };
      const reply = r.reply as Replies["tasks"] | Replies["task_created"];
      return { ok: true, tasks: "tasks" in reply ? reply.tasks : [reply.task] };
    });
  const board = {
    list: (all = true) => boardCall("tasks_list", { all }),
    create: (t: { title: string; description?: string; labels?: string[]; priority?: number; desk?: string | null; agentId?: string | null; agentName?: string | null; conversationId?: string | null }) => boardCall("task_create", t),
    assign: (ids: string[], target: { agentId: string | null; agentName: string | null; conversationId: string; desk: string }, start: boolean) => boardCall("task_assign", { ids, ...target, start }),
    close: (ids: string[], reason?: string) => boardCall("task_close", { ids, reason }),
    setStatus: (ids: string[], status: "open" | "in_progress" | "blocked" | "deferred") => boardCall("task_status", { ids, status }),
  };

  /** Recall, through the mod (mod/recall.ts): the cards, a review, a delete and its undo, the worker's knobs. */
  const recallCall = <N extends "recall_grade" | "recall_edit" | "recall_reject" | "recall_restore" | "recall_forget">(type: N, payload: InputOf<N>): Promise<{ ok: true; card: CardWithSchedule | null } | { ok: false; message: string }> =>
    request(type, payload, 15_000).then((r) => (r.ok ? { ok: true, card: (r.reply as Replies["recall_card"]).card ?? null } : { ok: false, message: r.error }));
  const recall = {
    list: () => request("recall_list", {}, 15_000).then(recallSnapshot),
    grade: (id: string, grade: Grade) => recallCall("recall_grade", { id, grade }),
    edit: (id: string, text: { front?: string; back?: string; tags?: string[] }) => recallCall("recall_edit", { id, ...text }),
    reject: (id: string) => recallCall("recall_reject", { id }),
    restore: (id: string) => recallCall("recall_restore", { id }),
    forget: (id: string) => recallCall("recall_forget", { id }),
    settings: (s: { enabled?: boolean; model?: string | null; dailyCap?: number; tickMinutes?: number }) => request("recall_settings", s, 15_000).then(recallSnapshot),
    /** Run the worker now; resolves to its one-line note (or the error). */
    run: () => request("recall_run", {}, 240_000).then((r) => (r.ok ? r.reply.note : r.error)),
    /** Anki's plain-text import format, or null. */
    export: () => request("recall_export", {}, 15_000).then((r) => (r.ok ? r.reply.tsv : null)),
    /** Learning leads: dismiss ("not this") and its undo answer with the snapshot; start makes the [Learn] conversation and names it. */
    leadDismiss: (id: string) => request("recall_lead_dismiss", { id }, 15_000).then(recallSnapshot),
    leadRestore: (id: string) => request("recall_lead_restore", { id }, 15_000).then(recallSnapshot),
    leadStart: (id: string): Promise<{ ok: true; agentId: string; conversationId: string } | { ok: false; message: string }> =>
      request("recall_lead_start", { id }, 60_000).then((r) => (r.ok ? { ok: true, agentId: r.reply.agentId, conversationId: r.reply.conversationId } : { ok: false, message: r.timedOut ? "the lesson did not start" : r.error })),
  };

  /** The Agents page, through the mod: the local record and the memory filesystem (read-only). */
  const agents = {
    get: (agentId: string) =>
      request("agent_get", { agentId }, 10_000).then((r) => (r.ok ? ({ agent: r.reply.agent, files: r.reply.files, skills: r.reply.skills, hasProfile: r.reply.hasProfile, lastCommit: r.reply.lastCommit } as AgentDetails) : null)),
    read: (agentId: string, path: string) => request("memory_read", { agentId, path }, 10_000).then((r) => (r.ok ? r.reply.content : null)),
    log: (agentId: string, path?: string, limit?: number) => request("memory_log", { agentId, path, limit }, 15_000).then((r): MemoryCommit[] => (r.ok ? r.reply.commits : [])),
    diff: (agentId: string, sha: string) => request("memory_diff", { agentId, sha }, 15_000).then((r) => (r.ok ? r.reply.diff : null)),
    reflection: (agentId: string) => request("reflection_state", { agentId }, 15_000).then((r): ReflectionState | null => (r.ok ? { conversations: r.reply.conversations, lastCommit: r.reply.lastCommit } : null)),
    globalSkills: () => request("skills_global", {}, 10_000).then((r): GlobalSkill[] => (r.ok ? r.reply.skills : [])),
    /** `letta install <source> --agent <id>` through the mod; resolves to an error message or null. */
    installSkill: (agentId: string, source: string, force = false) =>
      request("skill_install", { agentId, source, force }, 130_000).then((r) => (r.ok ? null : r.timedOut ? "install timed out" : r.error)),
    /** Refresh an installed skill from its upstream (mod/skill-sources.ts); the outcome, or `{ error }`. */
    refreshSkill: (agentId: string, name: string, source?: string) =>
      request("skill_refresh", { agentId, name, source }, 130_000).then((r): RefreshOutcome | { error: string } => (r.ok ? r.reply : { error: r.timedOut ? "refresh timed out" : r.error })),
  };

  // Analytics (core/analytics.ts): best effort, dropped while the socket is down. Stable, so hosts can hang effects on it.
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  });
  // An event captured while the socket is between connections (a chat switch reopens it) waits for it, rather
  // than being lost: desk_switched always fell in that gap.
  const heldCaptures = useRef<Array<{ type: "capture"; event: string; properties?: Record<string, unknown> }>>([]);
  const capture = useCallback((event: string, properties?: Record<string, unknown>) => {
    const frame = { type: "capture" as const, event, ...(properties ? { properties } : {}) };
    if (!sendRef.current(frame)) heldCaptures.current = [...heldCaptures.current, frame].slice(-CAPTURES_HELD);
  }, []);
  useEffect(() => {
    if (connection !== "open") return;
    const held = heldCaptures.current;
    heldCaptures.current = [];
    for (const frame of held) sendRef.current(frame);
  }, [connection]);

  const attention = {
    available: appServer || inTauri, // the shell holds its own link; the mod's discovery flag only matters in a browser tab
    capture,
    tunnelUrl,
    seen: seenMap,
    /** Each chat's engagement weight (the mod's; core/attention/focus.ts), and the report of one the mod cannot see. */
    focus: focusMap,
    engage: (agentId: string, conversationId: string, action: EngageAction) => send({ type: "focus_add", agentId, conversationId, action }),
    markSeen: (agentId: string, conversationId: string) => send({ type: "seen_mark", agentId, conversationId }),
    unmarkSeen: (agentId: string, conversationId: string) => send({ type: "seen_unmark", agentId, conversationId }),
    /** A look, not done: opening a conversation, or a message arriving while it is open (shared/useViewed.ts). */
    viewed: viewedMap,
    markViewed: (agentId: string, conversationId: string) => send({ type: "viewed_mark", agentId, conversationId }),
    /** Every open conversation from the mod's disk scan, with who spoke last; the inbox's list. Empty when the mod does not answer. */
    listInbox: (): Promise<InboxConversation[]> => request("inbox_list", {}, 8000).then((r) => (r.ok ? r.reply.conversations : [])),
    /**
     * The conversation's transcript from the mod's local log; empty if the mod does not know it (or predates this frame).
     * The reply's widget change log lands in that desk's store on the way (the thread's widget rows).
     */
    loadHistory: (agentId: string, conversationId: string, limit?: number): Promise<{ rows: TranscriptRow[]; more: boolean }> =>
      request("history_get", { agentId, conversationId, ...(limit ? { limit } : {}) }, 8000).then((r) => {
        if (!r.ok) return { rows: [], more: false };
        setWidgetLogs((s) => withHistoryLog(s, scopeFor(conversationId, agentId), r.reply.widgetLog));
        return { rows: r.reply.messages, more: r.reply.more };
      }),
    /** Working folders for "new desk" — all answered by the mod, which can see the disk. */
    folders: {
      recent: () => request("folders_get", {}, 4000).then((r) => (r.ok ? { byAgent: r.reply.byAgent, byConversation: r.reply.byConversation } : { byAgent: {}, byConversation: {} })),
      complete: (prefix: string) => request("folder_complete", { prefix }, 3000).then((r) => (r.ok ? r.reply.matches : [])),
      check: (path: string) => request("folder_check", { path }, 3000).then((r) => (r.ok ? { ok: r.reply.ok, path: r.reply.path, branch: r.reply.branch, reason: r.reply.reason } : { ok: false, path, branch: null, reason: r.error })),
      pick: (defaultPath?: string) => request("folder_pick", { defaultPath }, 180_000).then((r) => (r.ok ? r.reply.path : null)),
    },
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
  const reasoningEffort = reasoningEfforts[scope] ?? null;
  /** After a switch the mod only re-reads the conversation at the next turn end; remember the new model now. */
  const setDeskModel = (s: Scope, handle: string, effort: ReasoningEffort | null) => {
    setModels((t) => ({ ...t, [s]: handle }));
    setReasoningEfforts((current) => withReasoningEffort(current, s, effort));
    setDeskList((l) => l.map((d) => (d.scope === s ? { ...d, model: handle, reasoningEffort: effort } : d)));
  };
  const modelOf = (s: Scope): string | null => models[s] ?? deskList.find((d) => d.scope === s)?.model ?? null;
  const reasoningEffortOf = (s: Scope): ReasoningEffort | null => reasoningEfforts[s] ?? deskList.find((d) => d.scope === s)?.reasoningEffort ?? null;
  const mode = modes[scope] ?? null;
  const setDeskMode = (s: Scope, m: string) => {
    setModes((t) => ({ ...t, [s]: m }));
    setDeskList((l) => l.map((d) => (d.scope === s ? { ...d, mode: m } : d)));
  };
  /** After a rename the mod only broadcasts desk_title at the next turn end; show the new name in the header and the list now. */
  const setDeskTitle = (s: Scope, title: string) => {
    setTitles((t) => ({ ...t, [s]: title }));
    setDeskList((l) => l.map((d) => (d.scope === s ? { ...d, title } : d)));
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
    reasoningEffort,
    modelOf,
    reasoningEffortOf,
    setDeskModel,
    mode,
    modeOf,
    setDeskMode,
    setDeskTitle,
    connection,
    visible,
    closed,
    ownCount,
    loaded,
    desks: {
      list: deskList,
      /** False until the mod first answered with the list. */
      loaded: desksLoaded,
      request: requestDesks,
      switchTo: switchDesk,
      /** Pin or unpin; the mod rewrites Letta's file and broadcasts the list back. */
      pin: (agentId: string, conversationId: string, pinned: boolean) => send({ type: "pin_set", agentId, conversationId, pinned }),
    },
    attention,
    phone,
    servedBuild,
    /** The models used lately, for the picker's quick picks; `used` records a pick (the mod keeps the list for every window and phone). */
    models: {
      recent: recentModels,
      used: (handle: string) => void (recentModels[0] !== handle && send({ type: "models_recent_add", handle })),
      /** A message went into a chat: its model moves to the front of the recent list (least recently used). */
      sentIn: (conversationId: string, agentId: string) => {
        const model = modelOf(scopeFor(conversationId, agentId));
        if (model && recentModels[0] !== model) send({ type: "models_recent_add", handle: model });
      },
    },
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
    /** This desk's widget change log, oldest first (desk/widgetRows.ts); undefined before any arrived. */
    widgetLog: widgetLogs[scope],
    /** Any desk's widget change log (a thread elsewhere: the Inbox, the phone). */
    widgetLogOf: (s: Scope) => widgetLogs[s],
    /** Any desk's widgets and the user's edits to them, once watched (watchDesk); undefined until they arrive. */
    widgetsOf: (s: Scope) => (widgets[s] ? { entries: widgets[s], overlay: desks[s]?.overlay ?? {} } : undefined),
    watchDesk,
  };
}
