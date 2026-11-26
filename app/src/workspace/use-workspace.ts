import { useEffect, useRef, useState } from "react";
import type { Gesture, Scope } from "../../../core/canvas-core.ts";
import { applyGesture, MAIN_CHAT_ID, mainChatAgent, emptyCanvas, scopeFor, scopeOfId, SHARED_SCOPE } from "../../../core/canvas-core.ts";
import { openExternal } from "./env";
import { useWorkspaceSocket } from "./use-workspace-socket";
import { PHONE_DEMO, phoneDemo, withReasoningEffort } from "./workspace-pushes";
import { FrameChatClient } from "../../../core/attention/chat-client.ts";
import { daemonCalls } from "../../../core/daemon-calls.ts";
import { canvasView } from "./view";
import { withHistoryLog } from "./widget-rows";

import type { CardWithSchedule, LearnReply, LearnSnapshot } from "../../../core/learn/model.ts";
import type { UsageReply } from "../../../core/usage.ts";
import type { Grade } from "../../../core/learn/fsrs.ts";
import type { EngageAction } from "../../../core/attention/use-attention.ts";
import { RETURN_TIMES_DEFAULT, type Rest, type ReturnTimes } from "../../../core/attention/rest.ts";
import type { Lane } from "../../../core/attention/lanes.ts";
import { moveRestFirst } from "../shared/rest-first";
import type { TranscriptRow } from "../chat/transcript";
import type { WholeRow } from "../../../core/attention/transcript.ts";

import type { ReasoningEffort } from "../../../core/models.ts";
import { requestResult } from "../../../core/frame-client.ts";
import type { InputOf, Replies, ReplyOf, RequestName, RequestResult } from "../../../core/frames.ts";
import type { ChatStatus, GlobalSkill, FlowRow as FlowConversation, LanVia, MemoryCommit, ReflectionState, RefreshOutcome } from "../../../core/frame-types.ts";

export type Connection = "connecting" | "open" | "closed";

export interface CameraTarget {
  widgetId: string;
  widgetIds: string[];
  nonce: number;
}

export type { VisibleWidget } from "./view";

const learnSnapshot = (r: RequestResult<LearnReply>): LearnSnapshot | null => {
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

const HISTORY_WAIT_MS = 30_000;

export function useWorkspace() {
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
    returnTimes,
    lanes,
    learnVersion,
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
    usualModels,
    widgetLogs,
    setWidgetLogs,
    watchDesk,
    waiters,
    lastInteractionRef,
    pendingRef,
    measure,
    reportWidgetError,
  } = useWorkspaceSocket();

  useEffect(() => {
    const hot = import.meta.hot;
    if (!hot) return;
    // Outside (Vite): it types this callback loosely; the payload is an ErrorPayload at runtime.
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
    send({ type: "chats_list" });
  };

  const request = <N extends RequestName>(type: N, payload: InputOf<N>, timeoutMs: number): Promise<RequestResult<ReplyOf<N>>> =>
    new Promise((resolve) => {
      const requestId = `${type}-${Math.random().toString(36).slice(2, 10)}`;
      const done = (m: Record<string, unknown> | null) => {
        window.clearTimeout(timer);
        waiters.drop(requestId);
        resolve(requestResult<ReplyOf<N>>(m));
      };
      const timer = window.setTimeout(() => done(null), timeoutMs);
      waiters.wait(requestId, done);
      const frame = { type, request_id: requestId, ...payload };
      if (!sendRaw(frame)) waiters.hold(requestId, frame);
    });

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
        return null;
    }
  };
  const apply = (g: Gesture) => {
    lastInteractionRef.current = Date.now();
    const s = scopeOfId(g.id);
    setDesks((d) => ({ ...d, [s]: applyGesture(d[s] ?? emptyCanvas(s), g) }));
    if (!send({ type: "gesture", gesture: g })) pendingRef.current.push(g);
  };
  const gesture = (g: Gesture) => {
    const inv = inverseOf(g);
    if (inv) {
      const top = undoStack.current.at(-1);
      if (!(top?.kind === inv.kind && top.id === inv.id && Date.now() - lastInteractionRef.current < 400)) undoStack.current.push(inv);
      if (undoStack.current.length > 60) undoStack.current.shift();
    }
    apply(g);
  };
  const undo = (): boolean => {
    const inv = takeUndo(undoStack.current, scope);
    if (!inv) return false;
    apply(inv);
    return true;
  };

  const recallCall = <N extends "learn_grade" | "learn_edit" | "learn_reject" | "learn_restore" | "learn_forget">(
    type: N,
    payload: InputOf<N>,
  ): Promise<{ ok: true; card: CardWithSchedule | null } | { ok: false; message: string }> =>
    request(type, payload, 15_000).then((r) => (r.ok ? { ok: true, card: (r.reply as Replies["learn_card"]).card ?? null } : { ok: false, message: r.error }));
  const learn = {
    list: () => request("learn_list", {}, 15_000).then(learnSnapshot),
    grade: (id: string, grade: Grade) => recallCall("learn_grade", { id, grade }),
    edit: (id: string, text: { front?: string; back?: string; tags?: string[] }) => recallCall("learn_edit", { id, ...text }),
    reject: (id: string) => recallCall("learn_reject", { id }),
    restore: (id: string) => recallCall("learn_restore", { id }),
    forget: (id: string) => recallCall("learn_forget", { id }),
    settings: (s: { enabled?: boolean; daily_cap?: number }) => request("learn_settings", s, 15_000).then(learnSnapshot),
    run: () => request("learn_run", {}, 240_000).then((r) => (r.ok ? r.reply.note : r.error)),
    export: () => request("learn_export", {}, 15_000).then((r) => (r.ok ? r.reply.tsv : null)),
    leadDismiss: (id: string) => request("learn_lead_dismiss", { id }, 15_000).then(learnSnapshot),
    leadRestore: (id: string) => request("learn_lead_restore", { id }, 15_000).then(learnSnapshot),
    leadStart: (id: string): Promise<{ ok: true; agentId: string; conversationId: string } | { ok: false; message: string }> =>
      request("learn_lead_start", { id }, 60_000).then((r) =>
        r.ok
          ? { ok: true, agentId: r.reply.agent_id, conversationId: r.reply.conversation_id }
          : { ok: false, message: r.timed_out ? "the lesson did not start" : r.error },
      ),
  };

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
    installSkill: (agentId: string, source: string, force = false) =>
      request("skill_install", { agent_id: agentId, source, force }, 130_000).then((r) => (r.ok ? null : r.timed_out ? "install timed out" : r.error)),
    refreshSkill: (agentId: string, name: string, source?: string) =>
      request("skill_refresh", { agent_id: agentId, name, source }, 130_000).then((r): RefreshOutcome | { error: string } =>
        r.ok ? r.reply : { error: r.timed_out ? "refresh timed out" : r.error },
      ),
  };

  const [calls] = useState(() => daemonCalls(request));

  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  });
  const deskListRef = useRef(deskList);
  useEffect(() => {
    deskListRef.current = deskList;
  });
  useEffect(() => {
    moveRestFirst(returnTimes, (times) => sendRef.current({ type: "return_times_set", return_times: times }));
  }, [returnTimes]);

  const attention = {
    available: true,
    makeClient: () =>
      new FrameChatClient({
        request,
        onChatEvent: (fn) => {
          return chatListeners.add(fn);
        },
        onReconnect: (fn) => {
          return reconnectListeners.add(fn);
        },
        onListsStale: (fn) => {
          return staleListeners.add(fn);
        },
        agentOf: (conversationId) => deskListRef.current.find((d) => d.conversation_id === conversationId)?.agent_id ?? null,
        openUrl: openExternal,
      }),
    seen: seenMap,
    focus: focusMap,
    engage: (agentId: string, conversationId: string, action: EngageAction) =>
      send({ type: "focus_add", agent_id: agentId, conversation_id: conversationId, action }),
    rests: restMap,
    rest: (agentId: string, conversationId: string, rest: Rest) => send({ type: "card_rest", agent_id: agentId, conversation_id: conversationId, rest }),
    returnTimes: returnTimes ?? RETURN_TIMES_DEFAULT,
    setReturnTimes: (times: ReturnTimes) => send({ type: "return_times_set", return_times: times }),
    lanes,
    setLanes: (next: Lane[]) => send({ type: "lanes_set", lanes: next }),
    markSeen: (agentId: string, conversationId: string) => send({ type: "seen_mark", agent_id: agentId, conversation_id: conversationId }),
    unmarkSeen: (agentId: string, conversationId: string) => send({ type: "seen_unmark", agent_id: agentId, conversation_id: conversationId }),
    viewed: viewedMap,
    markViewed: (agentId: string, conversationId: string) => send({ type: "viewed_mark", agent_id: agentId, conversation_id: conversationId }),
    listFlow: (): Promise<FlowConversation[] | null> => request("flow_get", {}, 8000).then((r) => (r.ok ? r.reply.conversations : null)),
    loadHistory: (
      agentId: string,
      conversationId: string,
      limit?: number,
      before?: number,
    ): Promise<{ rows: TranscriptRow[]; more: boolean; start: number } | null> =>
      request(
        "history_get",
        { agent_id: agentId, conversation_id: conversationId, ...(limit ? { limit } : {}), ...(before !== undefined ? { before } : {}) },
        HISTORY_WAIT_MS,
      ).then((r) => {
        if (!r.ok) return null;
        setWidgetLogs((s) => withHistoryLog(s, scopeFor(conversationId, agentId), r.reply.widget_log));
        return { rows: r.reply.messages, more: r.reply.more, start: r.reply.start };
      }),
    loadStep: (agentId: string, conversationId: string, row: number): Promise<WholeRow | null> =>
      request("history_step_get", { agent_id: agentId, conversation_id: conversationId, row }, HISTORY_WAIT_MS).then((r) =>
        r.ok ? { step: r.reply.step, detail: r.reply.detail ?? null } : null,
      ),
    requirements: (agentId: string, home?: string): Promise<string[]> =>
      request("chat_requirements", { agent_id: agentId, ...(home ? { home } : {}) }, 8000).then((r) => (r.ok ? r.reply.missing : [])),
    folders: {
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

  const phone = {
    status: lanStatus,
    devices,
    lastCode: pairCode,
    refresh: () => {
      send({ type: "lan_get" });
      send({ type: "devices_list" });
    },
    setEnabled: (enabled: boolean) => send({ type: "lan_set", enabled }),
    setVia: (via: LanVia) => (PHONE_DEMO ? setLanStatus((s) => (s ? phoneDemo({ ...s, via }) : s)) : send({ type: "lan_via_set", via })),
    setServe: (enabled: boolean) => (PHONE_DEMO ? setLanStatus((s) => (s ? phoneDemo(s, enabled) : s)) : send({ type: "lan_serve_set", enabled })),
    beginPair: () => send({ type: "pair_begin" }),
    forget: (id: string) => send({ type: "device_forget", id }),
  };

  const daemon = {
    restartDue,
    restart: (anyway: boolean): Promise<string | null> =>
      request("daemon_restart", { anyway }, 120_000).then((r) => (r.ok ? null : r.timed_out ? "loki did not answer" : r.error)),
  };

  const macs = {
    view: macsView,
    lastCode: macCode,
    refresh: () => send({ type: "peers_get" }),
    beginPair: () => send({ type: "peer_pair_begin" }),
    join: (host: string, code: string): Promise<string | null> =>
      request("peer_pair_join", { host, code }, 30_000).then((r) => (r.ok ? null : r.timed_out ? "the other Mac did not answer in time" : r.error)),
    forget: (macId: string) => send({ type: "peer_forget", mac_id: macId }),
    move: (agentId: string, conversationId: string, to: string): Promise<string | null> =>
      request("chat_move", { agent_id: agentId, conversation_id: conversationId, to }, 200_000).then((r) =>
        r.ok ? null : r.timed_out ? "the move did not finish in time" : r.error,
      ),
  };

  const trash = (id: string) => {
    lastInteractionRef.current = Date.now();
    send({ type: "trash", id });
  };

  const arrange = () => {
    lastInteractionRef.current = 0;
    send({ type: "arrange" });
  };

  const { visible, closed, ownCount, loaded } = canvasView(scope, desks, widgets);

  const listed = deskList.find((d) => d.scope === scope);
  const title = titles[scope] ?? listed?.title ?? null;
  const status: ChatStatus = statuses[scope] ?? "none";
  const agentName = agentNames[scope] ?? listed?.agent_name ?? null;
  const model = models[scope] ?? null;
  const reasoningEffort = reasoningEfforts[scope] ?? null;
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
  const setDeskTitle = (s: Scope, title: string) => {
    setTitles((t) => ({ ...t, [s]: title }));
    setDeskList((l) => l.map((d) => (d.scope === s ? { ...d, title } : d)));
  };
  const modeOf = (s: Scope): string | null => modes[s] ?? deskList.find((d) => d.scope === s)?.mode ?? null;
  const agentId = agentIds[scope] ?? listed?.agent_id ?? null;
  const conversationId = scope === SHARED_SCOPE ? null : mainChatAgent(scope) !== null ? MAIN_CHAT_ID : scope;

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
      loaded: desksLoaded,
      request: requestDesks,
      switchTo: switchDesk,
      pin: (agentId: string, conversationId: string, pinned: boolean) => {
        const s = scopeFor(conversationId, agentId);
        setDeskList((l) => l.map((d) => (d.scope === s ? { ...d, pinned } : d)));
        send({ type: "pin_set", agent_id: agentId, conversation_id: conversationId, pinned });
      },
    },
    attention,
    phone,
    macs,
    daemon,
    servedBuild,
    models: {
      recent: recentModels,
      usual: usualModels,
      used: (handle: string) => {
        if (recentModels[0] !== handle) send({ type: "models_recent_add", handle });
      },
      sentIn: (conversationId: string, agentId: string) => {
        const model = modelOf(scopeFor(conversationId, agentId));
        if (model && recentModels[0] !== model) send({ type: "models_recent_add", handle: model });
      },
    },
    learn,
    learnVersion,
    usage: {
      get: (since: string, until: string) => request("usage_get", { since, until }, 15_000).then((r): UsageReply | null => (r.ok ? r.reply : null)),
      version: usageVersion,
    },
    undo,
    agents,
    calls,
    gesture,
    measure,
    arrange,
    trash,
    reportWidgetError,
    cameraTarget,
    widgetLog: widgetLogs[scope],
    widgetLogOf: (s: Scope) => widgetLogs[s],
    widgetsOf: (s: Scope) => (widgets[s] ? { entries: widgets[s], overlay: desks[s]?.overlay ?? {} } : undefined),
    watchDesk,
  };
}

export function takeUndo(stack: Gesture[], scope: Scope): Gesture | null {
  for (let at = stack.length - 1; at >= 0; at--) {
    const s = scopeOfId(stack[at].id);
    if (s === scope || s === SHARED_SCOPE) return stack.splice(at, 1)[0];
  }
  return null;
}
