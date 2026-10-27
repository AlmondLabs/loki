import { useCallback, useEffect, useRef } from "react";
import type { TaskSource } from "../../../core/task-source.ts";
import type { Gesture, Scope } from "../../../core/desk-core.ts";
import { SHARED_SCOPE, applyGesture, emptyDesk, scopeFor, scopeOfId } from "../../../core/desk-core.ts";
import { inTauri } from "./env";
import { PHONE_DEMO, phoneDemo, useDeskSocket, withReasoningEffort } from "./use-desk-socket";
import { FrameChatClient } from "../../../core/attention/chat-client.ts";
import { deskView } from "./view";
import { withHistoryLog } from "./widget-rows";

import type { CardWithSchedule, RecallReply, RecallSnapshot } from "../../../core/recall/model.ts";
import type { UsageReply } from "../../../core/usage.ts";
import type { Grade } from "../../../core/recall/fsrs.ts";
import type { EngageAction } from "../../../core/attention/use-attention.ts";
import type { Rest } from "../../../core/attention/rest.ts";
import type { TranscriptRow } from "../chat/transcript";
import type { ToolStep } from "../../../core/attention/transcript.ts";

import type { ReasoningEffort } from "../../../core/models.ts";
import { requestResult, type InputOf, type Replies, type ReplyOf, type RequestName, type RequestResult } from "../../../core/frames.ts";
import type {
  DeskStatus,
  GlobalSkill,
  InboxRow as InboxConversation,
  LanVia,
  MemoryCommit,
  ReflectionState,
  RefreshOutcome,
  Task,
} from "../../../core/frame-types.ts";

/** The state of the socket to the mod. */
export type Connection = "connecting" | "open" | "closed";

/** A request to move the camera to widgets, as the mod's camera frame asks; the nonce makes a repeat new. */
export interface CameraTarget {
  widgetId: string;
  /** All ids to frame together (first is widgetId). */
  widgetIds: string[];
  nonce: number;
}

export type { VisibleWidget } from "./view";

/** A `recall` reply as the snapshot the view holds, or null when the mod refused or did not answer. */
const recallSnapshot = (r: RequestResult<RecallReply>): RecallSnapshot | null => {
  if (!r.ok) return null;
  const reply = r.reply;
  return {
    cards: reply.cards,
    rejected: reply.rejected,
    worker: reply.worker,
    leads: reply.leads ?? [],
    dismissed_leads: reply.dismissed_leads ?? [],
    lessons: reply.lessons ?? [],
  };
};

/** Captures kept while the socket is closed; the oldest go first. */
const CAPTURES_HELD = 50;
/**
 * How long a page of a chat's history, or one of its steps, may take (plan 041): a chat on another Mac comes over the
 * tailnet from a Mac that may have just woken, which took up to 22 seconds on 2026-10-27; this Mac answers in milliseconds.
 */
const HISTORY_WAIT_MS = 30_000;

/**
 * The tab's view of the desk: manifest + geometry per scope, synced from the
 * mod over WebSocket. Gestures apply optimistically with the same pure
 * reducer the mod uses, then go up the wire.
 */
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
    macs: macsView,
    restartDue,
    macCode,
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
  }, [reportWidgetError]);

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
      const frame = { type, request_id: requestId, ...payload };
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
      const top = undoStack.current.at(-1);
      if (!(top?.kind === inv.kind && top.id === inv.id && Date.now() - lastInteractionRef.current < 400)) undoStack.current.push(inv);
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

  /** The task list, through the mod. Every call resolves to tasks or an error message; never throws. */
  const taskCall = <N extends "tasks_list" | "task_create" | "task_assign" | "task_close" | "task_reopen" | "task_status">(
    type: N,
    payload: InputOf<N>,
  ): Promise<{ ok: true; tasks: Task[] } | { ok: false; message: string }> =>
    request(type, payload, 25_000).then((r) => {
      if (!r.ok) return { ok: false, message: r.error };
      const reply = r.reply as Replies["tasks"] | Replies["task_created"];
      return { ok: true, tasks: "tasks" in reply ? reply.tasks : [reply.task] };
    });
  const tasks = {
    list: (all = true) => taskCall("tasks_list", { all }),
    create: (t: {
      title: string;
      description?: string;
      labels?: string[];
      priority?: number;
      desk?: string | null;
      agent_id?: string | null;
      agent_name?: string | null;
      conversation_id?: string | null;
      source?: TaskSource;
    }) => taskCall("task_create", t),
    assign: (ids: string[], target: { agent_id: string | null; agent_name: string | null; conversation_id: string; desk: string }, start: boolean) =>
      taskCall("task_assign", { ids, ...target, start }),
    close: (ids: string[], reason?: string) => taskCall("task_close", { ids, reason }),
    reopen: (ids: string[]) => taskCall("task_reopen", { ids }),
    setStatus: (ids: string[], status: "open" | "in_progress" | "blocked" | "deferred") => taskCall("task_status", { ids, status }),
  };

  /** Recall, through the mod (mod/recall.ts): the cards, a review, a delete and its undo, the worker's knobs. */
  const recallCall = <N extends "recall_grade" | "recall_edit" | "recall_reject" | "recall_restore" | "recall_forget">(
    type: N,
    payload: InputOf<N>,
  ): Promise<{ ok: true; card: CardWithSchedule | null } | { ok: false; message: string }> =>
    request(type, payload, 15_000).then((r) => (r.ok ? { ok: true, card: (r.reply as Replies["recall_card"]).card ?? null } : { ok: false, message: r.error }));
  const recall = {
    list: () => request("recall_list", {}, 15_000).then(recallSnapshot),
    grade: (id: string, grade: Grade) => recallCall("recall_grade", { id, grade }),
    edit: (id: string, text: { front?: string; back?: string; tags?: string[] }) => recallCall("recall_edit", { id, ...text }),
    reject: (id: string) => recallCall("recall_reject", { id }),
    restore: (id: string) => recallCall("recall_restore", { id }),
    forget: (id: string) => recallCall("recall_forget", { id }),
    settings: (s: { enabled?: boolean; daily_cap?: number }) => request("recall_settings", s, 15_000).then(recallSnapshot),
    /** Run the worker now; resolves to its one-line note (or the error). */
    run: () => request("recall_run", {}, 240_000).then((r) => (r.ok ? r.reply.note : r.error)),
    /** Anki's plain-text import format, or null. */
    export: () => request("recall_export", {}, 15_000).then((r) => (r.ok ? r.reply.tsv : null)),
    /** Learning leads: dismiss ("not this") and its undo answer with the snapshot; start makes the [Learn] conversation and names it. */
    leadDismiss: (id: string) => request("recall_lead_dismiss", { id }, 15_000).then(recallSnapshot),
    leadRestore: (id: string) => request("recall_lead_restore", { id }, 15_000).then(recallSnapshot),
    leadStart: (id: string): Promise<{ ok: true; agentId: string; conversationId: string } | { ok: false; message: string }> =>
      request("recall_lead_start", { id }, 60_000).then((r) =>
        r.ok
          ? { ok: true, agentId: r.reply.agent_id, conversationId: r.reply.conversation_id }
          : { ok: false, message: r.timed_out ? "the lesson did not start" : r.error },
      ),
  };

  /** The Agents page, through the mod: the local record and the memory filesystem (read-only). */
  const agents = {
    get: (agentId: string) =>
      request("agent_get", { agent_id: agentId }, 10_000).then((r) =>
        r.ok
          ? {
              agent: r.reply.agent,
              files: r.reply.files,
              skills: r.reply.skills,
              hasProfile: r.reply.has_profile,
              lastCommit: r.reply.last_commit,
            }
          : null,
      ),
    read: (agentId: string, path: string) => request("memory_read", { agent_id: agentId, path }, 10_000).then((r) => (r.ok ? r.reply.content : null)),
    log: (agentId: string, path?: string, limit?: number) =>
      request("memory_log", { agent_id: agentId, path, limit }, 15_000).then((r): MemoryCommit[] => (r.ok ? r.reply.commits : [])),
    diff: (agentId: string, sha: string) => request("memory_diff", { agent_id: agentId, sha }, 15_000).then((r) => (r.ok ? r.reply.diff : null)),
    reflection: (agentId: string) =>
      request("reflection_state", { agent_id: agentId }, 15_000).then((r): ReflectionState | null => (r.ok ? { last_commit: r.reply.last_commit } : null)),
    globalSkills: () => request("skills_global", {}, 10_000).then((r): GlobalSkill[] => (r.ok ? r.reply.skills : [])),
    /** Install a skill from a source into the agent's memory, through the mod (mod/skills.ts); resolves to an error message or null. */
    installSkill: (agentId: string, source: string, force = false) =>
      request("skill_install", { agent_id: agentId, source, force }, 130_000).then((r) => (r.ok ? null : r.timed_out ? "install timed out" : r.error)),
    /** Refresh an installed skill from its upstream (mod/skill-sources.ts); the outcome, or `{ error }`. */
    refreshSkill: (agentId: string, name: string, source?: string) =>
      request("skill_refresh", { agent_id: agentId, name, source }, 130_000).then((r): RefreshOutcome | { error: string } =>
        r.ok ? r.reply : { error: r.timed_out ? "refresh timed out" : r.error },
      ),
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
    // loki's daemon serves chats on this socket, wherever the page runs; a request made before it opens waits for it.
    available: true,
    /** The one-time import from Letta (daemon/import/letta.ts); it may take a minute. */
    importLetta: () => request("chat_import", {}, 600_000),
    /** Whether Letta is here and how its last import went, at start or from Settings. */
    importStatus: () => request("chat_import_status", {}, 10_000),
    /** The daemon's chat client, over this socket's frames (core/attention/chat-client.ts). */
    makeClient: () =>
      new FrameChatClient({
        request,
        onChatEvent: (fn) => {
          chatListeners.current.add(fn);
          return () => chatListeners.current.delete(fn);
        },
        onReconnect: (fn) => {
          reconnectListeners.current.add(fn);
          return () => reconnectListeners.current.delete(fn);
        },
        onListsStale: (fn) => {
          staleListeners.current.add(fn);
          return () => staleListeners.current.delete(fn);
        },
        agentOf: (conversationId) => deskList.find((d) => d.conversation_id === conversationId)?.agent_id ?? null,
        // A sign-in page opens in the browser: the shell's opener in the app, a new tab in a browser.
        openUrl: (url) => {
          if (inTauri)
            void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(url)).catch((err: unknown) => console.warn("loki: open sign-in", err));
          else window.open(url, "_blank", "noopener,noreferrer");
        },
      }),
    capture,
    seen: seenMap,
    /** Each chat's engagement weight (the mod's; core/attention/focus.ts), and the report of one the mod cannot see. */
    focus: focusMap,
    engage: (agentId: string, conversationId: string, action: EngageAction) =>
      send({ type: "focus_add", agent_id: agentId, conversation_id: conversationId, action }),
    /** Each chat's Inbox rest (the mod's; core/attention/rest.ts), and a Next's new one. */
    rests: restMap,
    rest: (agentId: string, conversationId: string, rest: Rest) => send({ type: "card_rest", agent_id: agentId, conversation_id: conversationId, rest }),
    markSeen: (agentId: string, conversationId: string) => send({ type: "seen_mark", agent_id: agentId, conversation_id: conversationId }),
    unmarkSeen: (agentId: string, conversationId: string) => send({ type: "seen_unmark", agent_id: agentId, conversation_id: conversationId }),
    /** A look, not done: opening a conversation, or a message arriving while it is open (shared/use-viewed.ts). */
    viewed: viewedMap,
    markViewed: (agentId: string, conversationId: string) => send({ type: "viewed_mark", agent_id: agentId, conversation_id: conversationId }),
    /** Every open conversation the mod knows from the daemon, with who spoke last; the inbox's list. Empty when the mod does not answer. */
    listInbox: (): Promise<InboxConversation[]> => request("inbox_list", {}, 8000).then((r) => (r.ok ? r.reply.conversations : [])),
    /**
     * The conversation's transcript from the daemon's store, through the mod; empty if the mod does not know it.
     * The reply's widget change log lands in that desk's store on the way (the thread's widget rows).
     */
    loadHistory: (
      agentId: string,
      conversationId: string,
      limit?: number,
      before?: number,
    ): Promise<{ rows: TranscriptRow[]; more: boolean; start?: number } | null> =>
      request(
        "history_get",
        { agent_id: agentId, conversation_id: conversationId, ...(limit ? { limit } : {}), ...(before !== undefined ? { before } : {}) },
        HISTORY_WAIT_MS,
      ).then((r) => {
        // Null, not empty: a page that did not come is a chat not loaded, which the thread says (plan 041).
        if (!r.ok) return null;
        setWidgetLogs((s) => withHistoryLog(s, scopeFor(conversationId, agentId), r.reply.widget_log));
        return { rows: r.reply.messages, more: r.reply.more, start: r.reply.start };
      }),
    /** The whole step of a lean tool row (plan 041), from the Mac the chat lives on; null when it did not come. */
    loadStep: (agentId: string, conversationId: string, row: number): Promise<ToolStep | null> =>
      request("history_step_get", { agent_id: agentId, conversation_id: conversationId, row }, HISTORY_WAIT_MS).then((r) => (r.ok ? r.reply.step : null)),
    /** What the Mac a new chat would live on lacks for its agent (plan 023, U10): lines for the person, none when nothing. */
    requirements: (agentId: string, home?: string): Promise<string[]> =>
      request("chat_requirements", { agent_id: agentId, ...(home ? { home } : {}) }, 8000).then((r) => (r.ok ? r.reply.missing : [])),
    /** Working folders for "new desk" — all answered by the mod, which can see the disk. */
    folders: {
      // `home` asks the Mac a new chat will live on (plan 023): its folders, not this Mac's.
      recent: (home?: string) =>
        request("folders_get", home ? { home } : {}, 4000).then((r) =>
          r.ok ? { byAgent: r.reply.by_agent, byConversation: r.reply.by_conversation } : { byAgent: {}, byConversation: {} },
        ),
      complete: (prefix: string, home?: string) =>
        request("folder_complete", { prefix, ...(home ? { home } : {}) }, 3000).then((r) => (r.ok ? r.reply.matches : [])),
      check: (path: string, home?: string) =>
        request("folder_check", { path, ...(home ? { home } : {}) }, 3000).then((r) =>
          r.ok ? { ok: r.reply.ok, path: r.reply.path, branch: r.reply.branch, reason: r.reply.reason } : { ok: false, path, branch: null, reason: r.error },
        ),
      pick: (defaultPath?: string) => request("folder_pick", { default_path: defaultPath }, 180_000).then((r) => (r.ok ? r.reply.path : null)),
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

  /**
   * Settings › Macs (plan 023): this Mac, the Macs paired with it, and pairing. `peers` and `peer_pair_code` land in
   * state above; a join answers with the reply or the reason it failed, in words for the person.
   */
  /**
   * Restarting loki's daemon (plan 024): the change that made a restart due (its file, and a count that goes up with
   * each change), and restarting now. Null once under way, else why not; `anyway` cuts off a chat that is working.
   */
  const daemon = {
    restartDue,
    restart: (anyway: boolean): Promise<string | null> =>
      request("daemon_restart", { anyway }, 10_000).then((r) => (r.ok ? null : r.timed_out ? "loki did not answer" : r.error)),
  };

  const macs = {
    view: macsView,
    lastCode: macCode,
    refresh: () => send({ type: "peers_get" }),
    beginPair: () => send({ type: "peer_pair_begin" }),
    join: (host: string, code: string): Promise<string | null> =>
      request("peer_pair_join", { host, code }, 30_000).then((r) => (r.ok ? null : r.timed_out ? "the other Mac did not answer in time" : r.error)),
    forget: (macId: string) => send({ type: "peer_forget", mac_id: macId }),
    /** Move a chat to another Mac (addendum A1): null once it moved, else why not. A long chat takes a while to cross. */
    move: (agentId: string, conversationId: string, to: string): Promise<string | null> =>
      request("chat_move", { agent_id: agentId, conversation_id: conversationId, to }, 200_000).then((r) =>
        r.ok ? null : r.timed_out ? "the move did not finish in time" : r.error,
      ),
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

  // Until the desk itself arrives (another Mac's chat waits on that Mac), its row in the list names it.
  const listed = deskList.find((d) => d.scope === scope);
  const title = titles[scope] ?? listed?.title ?? null;
  const status: DeskStatus = statuses[scope] ?? "none";
  const agentName = agentNames[scope] ?? listed?.agent_name ?? null;
  const model = models[scope] ?? null;
  const reasoningEffort = reasoningEfforts[scope] ?? null;
  /** After a switch the mod only re-reads the conversation at the next turn end; remember the new model now. */
  const setDeskModel = (s: Scope, handle: string, effort: ReasoningEffort | null) => {
    setModels((t) => ({ ...t, [s]: handle }));
    setReasoningEfforts((current) => withReasoningEffort(current, s, effort));
    setDeskList((l) => l.map((d) => (d.scope === s ? { ...d, model: handle, reasoning_effort: effort } : d)));
  };
  const modelOf = (s: Scope): string | null => models[s] ?? deskList.find((d) => d.scope === s)?.model ?? null;
  const reasoningEffortOf = (s: Scope): ReasoningEffort | null => reasoningEfforts[s] ?? deskList.find((d) => d.scope === s)?.reasoning_effort ?? null;
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
  const agentId = agentIds[scope] ?? listed?.agent_id ?? null;
  /** The conversation behind this desk, as loki's daemon names it. */
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
      /** Pin or unpin; the mod rewrites its pins file (mod/pins.ts) and broadcasts the list back. */
      pin: (agentId: string, conversationId: string, pinned: boolean) => send({ type: "pin_set", agent_id: agentId, conversation_id: conversationId, pinned }),
    },
    attention,
    phone,
    /** Settings › Macs: the Macs paired with this one, and pairing another. */
    macs,
    daemon,
    servedBuild,
    /** The models used lately, for the picker's quick picks; `used` records a pick (the mod keeps the list for every window and phone). */
    models: {
      recent: recentModels,
      used: (handle: string) => {
        if (recentModels[0] !== handle) send({ type: "models_recent_add", handle });
      },
      /** A message went into a chat: its model moves to the front of the recent list (least recently used). */
      sentIn: (conversationId: string, agentId: string) => {
        const model = modelOf(scopeFor(conversationId, agentId));
        if (model && recentModels[0] !== model) send({ type: "models_recent_add", handle: model });
      },
    },
    tasks,
    tasksVersion,
    recall,
    recallVersion,
    /** What the agents spent (Settings › usage): the ledger's rows for a period, and a count bumped as it grows. */
    usage: {
      get: (since: string, until: string) => request("usage_get", { since, until }, 15_000).then((r): UsageReply | null => (r.ok ? r.reply : null)),
      version: usageVersion,
    },
    undo,
    agents,
    gesture,
    measure,
    arrange,
    trash,
    reportWidgetError,
    cameraTarget,
    /** This desk's widget change log, oldest first (desk/widget-rows.ts); undefined before any arrived. */
    widgetLog: widgetLogs[scope],
    /** Any desk's widget change log (a thread elsewhere: the Inbox, the phone). */
    widgetLogOf: (s: Scope) => widgetLogs[s],
    /** Any desk's widgets and the user's edits to them, once watched (watchDesk); undefined until they arrive. */
    widgetsOf: (s: Scope) => (widgets[s] ? { entries: widgets[s], overlay: desks[s]?.overlay ?? {} } : undefined),
    watchDesk,
  };
}
