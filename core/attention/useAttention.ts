import type { FileRef, ToolStep } from "./transcript.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { historySteps } from "../harness.ts";
import { AppServerSocket, type Runtime } from "./protocol.ts";
import type { ChatClient } from "./chat-client.ts";
import type { AppliedModel, ModelSelection } from "../models.ts";
import type { ConnectProvider, Personality, ReflectionMerge, ReflectionSettings, ReflectionTrigger } from "./protocol.ts";
import { applyChatEvent, folderMoveAnswer, buildItems, cancelQueued as dropQueued, chatStatusOf, emptyLive, keyOf, takeQueued, type AttentionItem, type ConversationInfo, type Digest, type Live, type PendingApproval, type PendingQuestion } from "./model.ts";
import { buildQuestionAnswer, environmentNote, isFileAttachment, withAttachments, type Attachment, type EnvNoteTold } from "./content.ts";
import type { TranscriptRow } from "./transcript.ts";
import { foldSteps, ownSendKey, type HistoryRow } from "./thread.ts";
import type { ImageAttachment } from "./content.ts";
import { idOf, inboxQueue } from "./queue.ts";
import { createActiveClock, type Activity } from "./activeClock.ts";
import { focusShares, type FocusEntry } from "./focus.ts";
import { allCommands, commandInput, fromAdvertised, type SlashCommand } from "./commands.ts";
import type { MakeTransport } from "./transport.ts";
import type { PayloadOf } from "../frames.ts";

/** An engagement only the app sees (core/frames.ts focus_add): the mod counts messages and opens itself. */
export type EngageAction = PayloadOf<"focus_add">["action"];
import { scopeFor } from "../desk-core.ts";

/**
 * Catch Up, client-side: the list of open conversations and who spoke last in each come from the
 * mod's disk scan (every open conversation, main chats included, however old); the app-server,
 * through the mod's tunnel, supplies the live half — approvals, questions, streaming — for the
 * most recent ones, and the seen markers are the mod's too.
 */
/** What you did with an Inbox card: moved on, archived it (done), decided an approval, replied, or answered its question. */
export type CardAction = "next" | "archive" | "approve" | "deny" | "reply" | "answer" | "open";

/**
 * Whether a decision halves the chat's focus: a Next on a card that was on top for its focus, unless it comes
 * straight after acting on that same card (moving on: your reply is what gave it the focus).
 */
export function skipsFocus(prev: { id: string; action: CardAction } | null, id: string, action: CardAction, reason: string): boolean {
  if (action !== "next" || reason !== "focus") return false;
  return !(prev?.id === id && prev.action !== "next");
}
/** How a card was acted on: a key or a click on the Mac, a swipe or a tap on the phone. */
export type CardVia = "key" | "click" | "swipe" | "tap";
/** Where a chat was archived or restored from, for analytics (chat_archived / chat_restored). */
export type ArchiveOrigin = "inbox" | "inbox_undo" | "sidebar" | "chat_header" | "phone_list" | "phone_chat";

/** How long a folder change waits for Letta Code's answer. */
const FOLDER_MOVE_MS = 8000;

/** A chat's id in analytics: its desk scope, as the mod's turn events carry it. */
const deskOf = (agentId: string, conversationId: string) => scopeFor(conversationId, agentId);
const minutesSince = (iso: string | null, now: number): number | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : Math.max(0, Math.round((now - t) / 60_000));
};

export interface UseAttentionOptions {
  /** The mod says whether an app-server was discovered. */
  enabled: boolean;
  tunnelUrl: string;
  /** How to reach the app-server from here: a WebSocket in a tab or on the phone, the Rust link in the shell. */
  makeTransport: MakeTransport;
  seen: Record<string, string>;
  /** When each conversation was last looked at (the mod's viewed markers); a look is not done. */
  viewed?: Record<string, string>;
  /** Each chat's focus weight (the mod's, core/attention/focus.ts): what the inbox ranks by after blocked agents. */
  focus?: Record<string, FocusEntry>;
  /** Tell the mod about an engagement the app-server carries and the mod cannot see (a decision, an answer). */
  engage?: (agentId: string, conversationId: string, action: EngageAction) => void;
  markSeen: (agentId: string, conversationId: string) => void;
  unmarkSeen: (agentId: string, conversationId: string) => void;
  /** Full transcript from the mod's local log (compaction-proof); may resolve empty. */
  loadLocalHistory?: (agentId: string, conversationId: string, limit?: number) => Promise<{ rows: Array<{ role: "user" | "assistant" | "tool" | "event"; text: string; summary?: string | null; detail?: string | null; at?: string | null; tool?: ToolStep; files?: FileRef[] }>; more: boolean }>;
  /** Every open conversation with its digest, from the mod (inbox_list). The list is the inbox's; only live events come from the app-server. */
  listConversations: () => Promise<Array<ConversationInfo & Digest>>;
  /** How many of the newest conversations to subscribe to for live events (each costs the app-server a runtime). */
  subscribeLimit?: number;
  /** Analytics (core/analytics.ts): an event this model carried out for the user. */
  capture?: (event: string, properties?: Record<string, unknown>) => void;
  /** A message went into this conversation (the model picker's recent list moves its model to the front). */
  sent?: (rt: Runtime) => void;
  /** When loki's window is in front of you, so a card's dwell counts only that time; left out, always. */
  activity?: Activity;
  /** Which backend serves chats; a change reconnects. */
  backend?: "letta" | "daemon";
  /** The chat client for loki's daemon (core/attention/chat-client.ts); left out, Letta's app-server. */
  makeClient?: () => ChatClient;
}

/** create_agent, then agent_update for a name or description it did not take; the new agent's id and name. */
async function createNamedAgent(sock: ChatClient, opts: { personality: Personality; name: string; description?: string; model?: string }): Promise<{ id: string; name: string }> {
  const created = await sock.createAgent({ personality: opts.personality, model: opts.model });
  const body: Record<string, unknown> = {};
  if (opts.name.trim() && opts.name.trim() !== created.name) body.name = opts.name.trim();
  if (opts.description?.trim()) body.description = opts.description.trim();
  if (Object.keys(body).length) await sock.updateAgent(created.id, body);
  return { id: created.id, name: (body.name as string | undefined) ?? created.name };
}

/** Where a message was typed, for analytics; the phone's sends carry none (its device type says). */
export type SendOrigin = "desk" | "inbox" | "lesson";

/**
 * A message as it goes out: images ride inside it, files as their attachment tags after the text; `key` is how
 * its echo is recognised (ownSendKey), empty when there is nothing to recognise.
 */
function outgoing(text: string, attachments: Attachment[]): { text: string; images: ImageAttachment[]; key: string } {
  const files = attachments.filter(isFileAttachment);
  const images = attachments.filter((a): a is ImageAttachment => !isFileAttachment(a));
  return { text: withAttachments(text, files), images, key: ownSendKey(text, files) };
}

/** A message's row as it shows at once: the text, its images, and chips for its files. */
function sentRow(text: string, attachments: Attachment[]): { role: "user"; text: string; images?: string[]; files?: Array<{ path: string; name: string; size: number; mime: string }>; at: string } {
  const files = attachments.filter(isFileAttachment).map(({ path, name, size, mime }) => ({ path, name, size, mime }));
  const images = attachments.filter((a): a is ImageAttachment => !isFileAttachment(a)).map((i) => i.url);
  return { role: "user", text, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}), at: new Date().toISOString() };
}

/** The environment note a message to this chat carries as it goes out (none when nothing changed), remembered. */
function noteFor(told: Map<string, EnvNoteTold>, key: string, desk: string | null | undefined): string | undefined {
  const note = environmentNote(told.get(key), { desk });
  told.set(key, note.told);
  return note.text ?? undefined;
}

/** How many rows of a chat's log a page is (the mod's HISTORY_PAGE): the first load, and each older page after it. */
export const HISTORY_PAGE = 400;

export function useAttention(opts: UseAttentionOptions) {
  const [conversations, setConversations] = useState<ConversationInfo[]>([]);
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  /** False until the first agent_list answered: an empty list before that means nothing. */
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [digests, setDigests] = useState<Map<string, Digest>>(new Map());
  /** The live map as render sees it: a fresh copy each time `bump` fires. The handlers mutate `liveRef` in place. */
  const [live, setLive] = useState<Map<string, Live>>(() => new Map());
  const [status, setStatus] = useState<"off" | "connecting" | "open" | "closed">("off");
  /** From the harness's app_server_info reply: which Letta Code this is. */
  const [server, setServer] = useState<{ version: string | null; protocol: number | null; advertised: SlashCommand[] } | null>(null);
  /** Chats whose log holds rows older than the ones loaded; the reader reaching the top asks for the next page. */
  const [older, setOlder] = useState<Record<string, true>>({});
  /** How many rows each chat's history was last asked for (HISTORY_PAGE more per page). */
  const historyLimits = useRef(new Map<string, number>());
  const loading = useRef(new Set<string>());
  const socketRef = useRef<ChatClient | null>(null);
  const liveRef = useRef(new Map<string, Live>());
  /** A conversation's live state, made on first use: its thread holds the chat's rows, loaded and live. */
  const liveOf = useCallback((key: string): Live => {
    let l = liveRef.current.get(key);
    if (!l) {
      l = emptyLive();
      liveRef.current.set(key, l);
    }
    return l;
  }, []);
  /** What each chat's agent was last told of the time and the chat: the note goes again only when that changed. */
  const envNotes = useRef(new Map<string, EnvNoteTold>());
  /** Folder changes waiting on Letta Code's answer, by conversation key (changeFolder). */
  const folderMoves = useRef(new Map<string, { from: string | undefined; to: string; done: (err: string | null) => void }>());
  const notifyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Conversations the list knows about; an event from an unknown one means the list is stale (a new desk, an empty conversation that just got its first turn). */
  const knownRef = useRef(new Set<string>());
  const reloadRef = useRef<(() => void) | null>(null);
  const lastReload = useRef(0);
  /** The link dropped since it was last open: when it reopens, commands left running are settled (see settleCommands). */
  const linkDropped = useRef(false);

  /**
   * The latest options, for the actions below. The host builds `opts` afresh on every render (and the mod's calls
   * in it), so an action that closed over it would be new each time too, and so would everything this hook
   * returns; read at call time instead, the actions stay the same functions.
   */
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  /** Re-read the list now (the sidebar archived or restored something); otherwise it refreshes each minute. Stable, so effects can depend on it. */
  const reload = useCallback(() => reloadRef.current?.(), []);

  const bump = useCallback(() => {
    if (notifyTimer.current) return;
    notifyTimer.current = setTimeout(() => {
      notifyTimer.current = null;
      setLive(new Map(liveRef.current));
    }, 150);
  }, []);

  // Connect / disconnect with `enabled`.
  useEffect(() => {
    if (!opts.enabled) {
      socketRef.current?.close();
      socketRef.current = null;
      setStatus("off");
      return;
    }
    // loki's daemon serves chats through the mod's own frames; Letta through its app-server (plan 017, U5).
    const sock: ChatClient = optsRef.current.makeClient?.() ?? new AppServerSocket(opts.tunnelUrl, opts.makeTransport);
    sock.onStatus = (s) => {
      setStatus(s);
      if (s === "closed") linkDropped.current = true;
      else if (s === "open" && linkDropped.current) {
        // Back after a drop (a /reload restarts the mod, which is this link): finish what the old link left running.
        linkDropped.current = false;
        let changed = false;
        for (const l of liveRef.current.values()) if (l.thread.settleCommands()) changed = true;
        if (changed) bump();
      }
    };
    socketRef.current = sock;
    let reloadTimer: ReturnType<typeof setTimeout> | null = null; // a list refresh waiting on this socket
    const off = sock.onChat((rt, events) => {
      const { conversation_id: conv, agent_id: agent } = rt;
      const key = keyOf(agent, conv);
      const l = liveOf(key);
      const wasInTurn = l.inTurn;
      const asked = { approval: l.pending?.requestId ?? null, question: l.pendingAsk?.requestId ?? null };
      const errorBefore = l.error;
      let changed = false;
      let userSpoke = false;
      for (const e of events) {
        const r = applyChatEvent(l, e);
        changed ||= r.changed;
        userSpoke ||= r.userSpoke;
      }
      // A new permission request or question (approval_requested). Every window and phone sees the same request; the
      // mod keeps the first report of each (`once`).
      const request = l.pending && l.pending.requestId !== asked.approval ? { id: l.pending.requestId, tool: l.pending.toolName, kind: "approval" } : l.pendingAsk && l.pendingAsk.requestId !== asked.question ? { id: l.pendingAsk.requestId, tool: "AskUserQuestion", kind: "question" } : null;
      // A folder change waiting on its answer (changeFolder): the new folder in a device status, or a loop error.
      const move = folderMoves.current.get(key);
      const answer = move ? folderMoveAnswer(events, l.cwd, move) : null;
      if (move && answer === "moved") move.done(null);
      else if (move && answer && answer !== "moved") {
        move.done(answer.error);
        l.error = errorBefore; // the refusal is the folder dialog's to show; the chat did not fail
      }
      if (request) optsRef.current.capture?.("approval_requested", { desk: deskOf(agent, conv), agent, tool: request.tool, kind: request.kind, once: `request:${request.id}` });
      if (userSpoke) opts.markSeen(agent, conv);
      if (changed) bump();
      // The turn just ended and something was typed during it: it goes out now, one per turn end.
      if (wasInTurn && !l.inTurn) {
        const next = takeQueued(l);
        if (next) {
          const out = outgoing(next.text, next.images);
          l.thread.expectEcho(out.key);
          l.inTurn = true; // until the server says so, so a second queued message waits its turn
          bump();
          void sock.sendUserMessage(rt, out.text, out.images, noteFor(envNotes.current, key, next.desk)).catch((err) => console.warn("loki: queued send", err));
        }
      }
      if (changed && !knownRef.current.has(key) && !reloadTimer && Date.now() - lastReload.current > 10_000) {
        // not in the list yet: refresh it soon so the conversation can become a card
        reloadTimer = setTimeout(() => {
          reloadTimer = null;
          reloadRef.current?.();
        }, 1500);
      }
    });

    let cancelled = false;
    const subscribeLimit = opts.subscribeLimit ?? 30;
    // Promise-style error handling here: the React Compiler cannot take a loop or a ?? inside a try block.
    const loadOnce = async () => {
      void sock.serverInfo().then((info) => {
        if (!cancelled) setServer({ version: info.version, protocol: info.protocol, advertised: fromAdvertised(info.commands, info.modCommands) });
      }).catch(() => {});
      const agents = await sock.listAgents();
      const names = new Map(agents.filter((a) => a.hidden !== true).map((a) => [a.id, a.name ?? "agent"]));
      if (!cancelled) {
        setAgents([...names].map(([id, name]) => ({ id, name })));
        setAgentsLoaded(true);
      }
      // The list and the digests are the mod's, read from disk in one answer: nothing is windowed or capped here.
      const rows = await opts.listConversations();
      if (cancelled) return;
      const convs: ConversationInfo[] = rows.map(({ lastRole: _r, lastAssistantText: _t, lastAsk: _a, ...c }) => c).sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
      lastReload.current = Date.now();
      knownRef.current = new Set(convs.map((c) => keyOf(c.agentId, c.id)));
      setConversations(convs);
      setDigests(new Map(rows.map((r) => [keyOf(r.agentId, r.id), { lastRole: r.lastRole, lastAssistantText: r.lastAssistantText, lastAsk: r.lastAsk }])));
      // Live events (approvals, questions, streaming) need a runtime per conversation on the app-server; the newest get one.
      for (const c of convs.slice(0, subscribeLimit)) {
        const rt: Runtime = { agent_id: c.agentId, conversation_id: c.id };
        // a conversation we cannot reach still lists; it just has no live half
        if (!sock.isSubscribed(rt)) await sock.runtimeStart(rt).catch(() => {});
        if (cancelled) return;
      }
    };
    const load = () => loadOnce().catch((err: unknown) => console.warn("loki catch up:", err));
    reloadRef.current = () => void load();
    void load();
    const refresh = setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(refresh);
      if (reloadTimer) clearTimeout(reloadTimer);
      off();
      sock.close();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.enabled, opts.tunnelUrl, opts.backend]);

  // The pending tick, if any, has nothing to render into after unmount.
  useEffect(
    () => () => {
      if (notifyTimer.current) clearTimeout(notifyTimer.current);
      notifyTimer.current = null;
    },
    [],
  );

  // The clock tick: focus fades and cards age without any other event, so the items are rebuilt twice a minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const items = useMemo(
    () => buildItems(conversations, digests, live, opts.seen, now, opts.viewed, focusShares(opts.focus ?? {}, now)),
    [conversations, digests, opts.seen, opts.viewed, opts.focus, live, now],
  );

  /**
   * The Inbox's analytics, for tuning the ranking against what you actually do. Each card event carries where the
   * card stood in the Inbox (rank among `of`), what it scored and why, whether it was new and how long its chat had
   * been quiet, read from the live items at that moment. A card shown (inbox_card_shown) starts its dwell clock; the
   * decision (inbox_card_decided) says how long it was on top before you acted, counting only the time loki was
   * visible and focused (activeClock.ts).
   */
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  });
  const shownAt = useRef(new Map<string, number>());
  const [clock] = useState(() => createActiveClock());
  const activity = opts.activity;
  useEffect(() => activity?.((on) => clock.set(on)), [activity, clock]);
  const cardProps = (item: AttentionItem) => {
    const queue = inboxQueue(itemsRef.current);
    const at = queue.findIndex((i) => idOf(i) === idOf(item));
    const it = queue[at] ?? item;
    return { desk: deskOf(item.agentId, item.id), agent: item.agentId, rank: at >= 0 ? at + 1 : null, of: queue.length, score: Math.round(it.score * 10) / 10, focus: Math.round(it.focus * 100) / 100, reason: it.reason, status: it.status, new: it.unread, idle_min: minutesSince(it.lastMessageAt, Date.now()) };
  };
  const shown = useCallback((item: AttentionItem) => {
    shownAt.current.set(idOf(item), clock.now());
    optsRef.current.capture?.("inbox_card_shown", cardProps(item));
  }, [clock]);
  /** The last decision, so a Next straight after acting on the same card reads as moving on (analytics.ts does the same). */
  const lastDecision = useRef<{ id: string; action: CardAction } | null>(null);
  const decided = useCallback((item: AttentionItem, action: CardAction, via?: CardVia) => {
    const since = shownAt.current.get(idOf(item));
    const props = cardProps(item);
    optsRef.current.capture?.("inbox_card_decided", { action, ...(via ? { via } : {}), ...props, dwell_ms: since === undefined ? null : Math.round(clock.now() - since) });
    // Next on a card that was on top for its focus: not what you are on now, so its focus halves (focus.ts SKIP_FACTOR).
    // Not after you just acted on it: that is moving on, and your reply is what gave it the focus.
    if (skipsFocus(lastDecision.current, idOf(item), action, props.reason)) optsRef.current.engage?.(item.agentId, item.id, "skip");
    lastDecision.current = { id: idOf(item), action };
  }, [clock]);
  /** A Next or an Archive taken back: the ranking's miss, or a slip. */
  const undone = useCallback((item: AttentionItem, action: "next" | "archive") => {
    optsRef.current.capture?.("inbox_card_undone", { action, desk: deskOf(item.agentId, item.id), agent: item.agentId });
  }, []);
  /** An agent pill chosen in the Inbox (null: All). */
  const filtered = useCallback((agent: string | null) => {
    optsRef.current.capture?.("inbox_filtered", { agent });
  }, []);

  // The app-server only lists what is still in the agent's context, so a compacted
  // conversation shows a stub. The mod reads the whole local log; ask it first.
  const loadThread = useCallback(async (rt: Runtime) => {
    const key = keyOf(rt.agent_id, rt.conversation_id);
    if (loading.current.has(key)) return;
    loading.current.add(key);
    const read = async () => {
      const page = await optsRef.current.loadLocalHistory?.(rt.agent_id, rt.conversation_id, historyLimits.current.get(key) ?? HISTORY_PAGE);
      let rows: HistoryRow[] = page?.rows ?? [];
      setOlder((o) => (!!o[key] === !!page?.more ? o : page?.more ? { ...o, [key]: true } : Object.fromEntries(Object.entries(o).filter(([k]) => k !== key))));
      if (!rows.length && socketRef.current) rows = foldSteps(historySteps(await socketRef.current.listMessages(rt, 60)));
      liveOf(key).thread.load(rows);
      setLive(new Map(liveRef.current));
    };
    // A promise's catch, not try/finally (the React Compiler takes neither a finally nor a ?? inside a try): the key frees either way.
    await read().catch((err: unknown) => console.warn("loki: thread", err));
    loading.current.delete(key);
  }, [liveOf]);
  const loadHistory = useCallback((item: AttentionItem) => loadThread(item.runtime), [loadThread]);
  /** The next page of a chat's history, older than what is loaded: asked for when the reader reaches the top. */
  const loadOlder = useCallback((rt: Runtime) => {
    const key = keyOf(rt.agent_id, rt.conversation_id);
    if (loading.current.has(key)) return;
    historyLimits.current.set(key, (historyLimits.current.get(key) ?? HISTORY_PAGE) + HISTORY_PAGE);
    void loadThread(rt);
  }, [loadThread]);

  /** A new conversation under an agent, in a folder: the runtime of the desk it becomes. */
  const createDesk = useCallback(async (agentId: string, cwd: string, name?: string): Promise<Runtime> => {
    const sock = socketRef.current;
    if (!sock) throw new Error("not connected to Letta's app-server");
    const rt = await sock.createConversation(agentId, cwd, name);
    const agentName = agents.find((a) => a.id === agentId)?.name ?? null;
    setConversations((c) => [{ id: rt.conversation_id, agentId: rt.agent_id, agentName, title: name?.trim() || null, lastMessageAt: new Date().toISOString(), archived: false }, ...c]);
    return rt;
  }, [agents]);

  /** Subscribe to a conversation that is not among the recent ones (e.g. the desk's). */
  const subscribe = useCallback(async (rt: Runtime) => {
    const sock = socketRef.current;
    if (!sock || sock.isSubscribed(rt)) return;
    try {
      await sock.runtimeStart(rt);
    } catch (err) {
      console.warn("loki: subscribe", err);
    }
  }, []);

  /**
   * Everything a chat surface needs for one conversation: the transcript with
   * live rows and the streaming reply appended, the box status, and the pending
   * approval. `rows` is undefined until the transcript has been asked for.
   */
  const conversation = useCallback(
    (agentId: string, conversationId: string): { rows: TranscriptRow[] | undefined; status: "idle" | "thinking" | "streaming"; pending: PendingApproval | null; question: PendingQuestion | null; error: string | null; mode: string | null; cwd: string | null; older: (() => void) | null } => {
      const key = keyOf(agentId, conversationId);
      const l = live.get(key);
      // The thread's rows keep their identity from update to update; only what changed is new.
      return { rows: l?.thread.rows(), status: chatStatusOf(l), pending: l?.pending ?? null, question: l?.pendingAsk ?? null, error: l?.error ?? null, mode: l?.mode ?? null, cwd: l?.cwd ?? null, older: older[key] ? () => loadOlder({ agent_id: agentId, conversation_id: conversationId }) : null };
    },
    [live, older, loadOlder],
  );

  const decide = useCallback((rt: Runtime, requestId: string, behavior: "allow" | "deny") => {
    const l = liveRef.current.get(keyOf(rt.agent_id, rt.conversation_id));
    const was = l?.pending?.requestId === requestId ? l.pending : null;
    if (l && was) l.pending = null; // optimistic: the card clears at once
    optsRef.current.markSeen(rt.agent_id, rt.conversation_id);
    optsRef.current.engage?.(rt.agent_id, rt.conversation_id, "decide");
    optsRef.current.capture?.("approval_decided", { desk: deskOf(rt.agent_id, rt.conversation_id), agent: rt.agent_id, behavior, wait_ms: was ? Math.max(0, Date.now() - Date.parse(was.at)) || null : null });
    bump();
    void socketRef.current?.respondApproval(rt, requestId, behavior).then((ok) => {
      if (ok || !l || !was) return;
      if (!l.pending) l.pending = was; // the server refused: put the request back
      bump();
    });
  }, [bump]);
  const approve = useCallback((item: AttentionItem, requestId: string, behavior: "allow" | "deny") => decide(item.runtime, requestId, behavior), [decide]);

  /** Answer a pending AskUserQuestion; the card clears at once and comes back if the server refuses. */
  const answer = useCallback((rt: Runtime, requestId: string, answers: Record<string, string | string[]>) => {
    const l = liveRef.current.get(keyOf(rt.agent_id, rt.conversation_id));
    const was = l?.pendingAsk?.requestId === requestId ? l.pendingAsk : null;
    if (!l || !was) return;
    l.pendingAsk = null;
    const summary = Object.values(answers).map((a) => (Array.isArray(a) ? a.join(", ") : a)).join(" · ");
    if (summary.trim()) l.thread.own({ role: "user", text: summary, at: new Date().toISOString() });
    optsRef.current.markSeen(rt.agent_id, rt.conversation_id);
    optsRef.current.engage?.(rt.agent_id, rt.conversation_id, "answer");
    optsRef.current.capture?.("question_answered", { desk: deskOf(rt.agent_id, rt.conversation_id), agent: rt.agent_id, wait_ms: Math.max(0, Date.now() - Date.parse(was.at)) || null });
    bump();
    void socketRef.current?.answerQuestion(rt, requestId, buildQuestionAnswer(was.input, answers)).then((ok) => {
      if (ok) return;
      if (!l.pendingAsk) l.pendingAsk = was;
      bump();
    });
  }, [bump]);

  /** Send a message into a conversation. Shown at once; the server's echo of it is recognised and not shown twice. */
  const send = useCallback((rt: Runtime, text: string, images: Attachment[] = [], env: { desk?: string | null; origin?: SendOrigin } = {}) => {
    const key = keyOf(rt.agent_id, rt.conversation_id);
    const l = liveOf(key);
    const fileCount = images.filter(isFileAttachment).length;
    optsRef.current.capture?.("message_sent", { desk: deskOf(rt.agent_id, rt.conversation_id), agent: rt.agent_id, origin: env.origin ?? null, images: images.length - fileCount, files: fileCount, queued: l.inTurn });
    optsRef.current.sent?.(rt);
    // Mid-turn: keep it. The transcript shows it as queued; it leaves when the turn ends (see the event loop).
    if (l.inTurn) {
      l.queued.push({ text, images, desk: env.desk });
      l.thread.queue(sentRow(text, images));
      bump();
      return;
    }
    const out = outgoing(text, images);
    l.thread.own(sentRow(text, images), out.key);
    l.lastRole = "user";
    bump();
    void subscribe(rt).then(() => socketRef.current?.sendUserMessage(rt, out.text, out.images, noteFor(envNotes.current, key, env.desk))).catch((err) => console.warn("loki: send", err));
    optsRef.current.markSeen(rt.agent_id, rt.conversation_id);
  }, [subscribe, bump, liveOf]);
  /** Take back a message typed mid-turn before it went out. */
  const cancelQueued = useCallback((rt: Runtime, text: string) => {
    const l = liveRef.current.get(keyOf(rt.agent_id, rt.conversation_id));
    if (l && dropQueued(l, text)) bump();
  }, [bump]);
  const reply = useCallback((item: AttentionItem, text: string, images: Attachment[] = []) => send(item.runtime, text, images, { desk: item.title, origin: "inbox" }), [send]);

  /**
   * A slash command for the harness (/reload, /compact …): execute_command, the path Desktop uses. The
   * transcript row comes from the harness's slash_command_start / _end deltas when the conversation is
   * subscribed; the answer here fills the row in when those never arrived, or when the call failed.
   */
  const execute = useCallback(async (rt: Runtime, commandId: string, args?: string): Promise<{ success: boolean; output: string }> => {
    const l = liveOf(keyOf(rt.agent_id, rt.conversation_id));
    const input = commandInput(commandId, args);
    const now = () => new Date().toISOString();
    optsRef.current.capture?.("command_run", { command: commandId });
    const sock = socketRef.current;
    if (!sock) {
      l.thread.finishCommand(input, false, "not connected to the app-server", now());
      bump();
      return { success: false, output: "not connected to the app-server" };
    }
    if (!sock.isSubscribed(rt)) l.thread.beginCommand(input, now()); // no deltas will come for this one; show the running row ourselves
    bump();
    try {
      const res = await sock.executeCommand(rt, commandId, args);
      if (l.thread.commandRunning(input)) l.thread.finishCommand(input, res.success, res.output, now());
      bump();
      return res;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // /reload restarts the mod, and the mod is this link: the answer is lost with it, which is the success case.
      const reloaded = commandId === "reload" && /link closed/i.test(message);
      l.thread.finishCommand(input, reloaded, reloaded ? "reloaded — the mod restarted and the link is back" : message, now());
      bump();
      return { success: reloaded, output: reloaded ? "reloaded" : message };
    }
  }, [bump, liveOf]);

  const updateAgent = useCallback(async (agentId: string, body: { name?: string; description?: string; model?: string }): Promise<string | null> => {
    const sock = socketRef.current;
    if (!sock) return "not connected to the app-server";
    try {
      await sock.updateAgent(agentId, body);
      if (body.name) setAgents((a) => a.map((x) => (x.id === agentId ? { ...x, name: body.name! } : x)));
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, []);
  /** The provider catalogue, loaded on demand; null until asked. */
  const [providers, setProviders] = useState<ConnectProvider[] | null>(null);
  /** The catalogue as last loaded, for a failed reload to fall back on (read at call time, so loadProviders stays one function). */
  const providersRef = useRef(providers);
  useEffect(() => {
    providersRef.current = providers;
  });
  const loadProviders = useCallback(async (): Promise<ConnectProvider[]> => {
    const sock = socketRef.current;
    if (!sock) return [];
    try {
      const list = await sock.listConnectProviders();
      setProviders(list);
      return list;
    } catch {
      return providersRef.current ?? [];
    }
  }, []);
  const connectProvider = useCallback(async (providerId: string, fields: Record<string, string>, authMethodId?: string): Promise<string | null> => {
    const sock = socketRef.current;
    if (!sock) return "not connected to the app-server";
    try {
      setProviders(await sock.connectProvider(providerId, fields, authMethodId));
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, []);
  const disconnectProvider = useCallback(async (providerId: string): Promise<string | null> => {
    const sock = socketRef.current;
    if (!sock) return "not connected to the app-server";
    try {
      setProviders(await sock.disconnectProvider(providerId));
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, []);
  /** create_agent, then agent_update for the name and description; the agent list reloads. Resolves to the new id. */
  const createAgent = useCallback(async (opts: { personality: Personality; name: string; description?: string; model?: string }): Promise<{ id: string } | { error: string }> => {
    const sock = socketRef.current;
    if (!sock) return { error: "not connected to the app-server" };
    let made: { id: string; name: string };
    try {
      made = await createNamedAgent(sock, opts);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    setAgents((a) => (a.some((x) => x.id === made.id) ? a : [...a, made]));
    reloadRef.current?.();
    return { id: made.id };
  }, []);
  const deleteAgent = useCallback(async (agentId: string): Promise<string | null> => {
    const sock = socketRef.current;
    if (!sock) return "not connected to the app-server";
    try {
      await sock.deleteAgent(agentId);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    setAgents((a) => a.filter((x) => x.id !== agentId));
    reloadRef.current?.();
    return null;
  }, []);
  const memory = useMemo(
    () => ({
      write: async (agentId: string, path: string, content: string, message?: string): Promise<string | null> => {
        const sock = socketRef.current;
        if (!sock) return "not connected to the app-server";
        return sock.writeMemoryFile(agentId, path, content, message).then(() => null, (err: unknown) => (err instanceof Error ? err.message : String(err)));
      },
      remove: async (agentId: string, path: string, message?: string): Promise<string | null> => {
        const sock = socketRef.current;
        if (!sock) return "not connected to the app-server";
        return sock.deleteMemoryFile(agentId, path, message).then(() => null, (err: unknown) => (err instanceof Error ? err.message : String(err)));
      },
    }),
    [],
  );
  const skills = useMemo(
    () => ({
      enable: async (path: string): Promise<string | null> => {
        const sock = socketRef.current;
        if (!sock) return "not connected to the app-server";
        return sock.skillEnable(path).then(() => null, (err: unknown) => (err instanceof Error ? err.message : String(err)));
      },
      disable: async (name: string): Promise<string | null> => {
        const sock = socketRef.current;
        if (!sock) return "not connected to the app-server";
        return sock.skillDisable(name).then(() => null, (err: unknown) => (err instanceof Error ? err.message : String(err)));
      },
    }),
    [],
  );
  const listModels = useCallback(async () => {
    const sock = socketRef.current;
    if (!sock) return [];
    try {
      return await sock.listModels();
    } catch {
      return [];
    }
  }, []);
  /** Set a conversation's permission mode (runtime_start with `mode`); resolves to an error message or null. */
  /**
   * Move a conversation to another folder; resolves to an error or null once Letta Code has answered (a device
   * status with the new folder, or a loop error), or after FOLDER_MOVE_MS with no answer. Letta Code keeps the
   * folder (its cwdMap) and tells the agent on its next turn that the working directory changed.
   */
  const changeFolder = useCallback(async (rt: Runtime, cwd: string): Promise<string | null> => {
    const sock = socketRef.current;
    if (!sock) return "not connected to the app-server";
    const to = cwd.trim().replace(/(.)\/+$/, "$1");
    if (!to) return "no folder";
    if (!sock.isSubscribed(rt)) {
      try {
        await sock.runtimeStart(rt); // its device status and errors come to subscribers
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    }
    const key = keyOf(rt.agent_id, rt.conversation_id);
    const from = liveRef.current.get(key)?.cwd;
    folderMoves.current.get(key)?.done("replaced by a newer change");
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => move.done("Letta Code did not answer; the folder may not have changed"), FOLDER_MOVE_MS);
      const move = {
        from,
        to,
        done: (err: string | null) => {
          clearTimeout(timer);
          if (folderMoves.current.get(key) === move) folderMoves.current.delete(key);
          if (!err) optsRef.current.capture?.("folder_changed", { desk: deskOf(rt.agent_id, rt.conversation_id), agent: rt.agent_id });
          resolve(err);
        },
      };
      folderMoves.current.set(key, move);
      sock.changeFolder(rt, to).catch((err) => move.done(err instanceof Error ? err.message : String(err)));
    });
  }, []);

  const setMode = useCallback(async (rt: Runtime, mode: string): Promise<string | null> => {
    const sock = socketRef.current;
    if (!sock) return "not connected to the app-server";
    try {
      await sock.runtimeStart(rt, { mode });
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    const l = liveRef.current.get(keyOf(rt.agent_id, rt.conversation_id));
    if (l) l.mode = mode;
    optsRef.current.capture?.("mode_set", { mode });
    bump();
    return null;
  }, [bump]);
  /**
   * Archive or restore a conversation; resolves to an error message or null. Main chats cannot be archived.
   * Archiving is how a chat leaves the Inbox, so it goes from the list at once; a restore reads the list again.
   */
  const archiveConversation = useCallback(async (conversationId: string, archived: boolean, origin?: ArchiveOrigin): Promise<string | null> => {
    const sock = socketRef.current;
    if (!sock) return "not connected to the app-server";
    if (conversationId === "default") return "a main chat cannot be archived";
    try {
      await sock.updateConversation(conversationId, { archived });
      if (origin) optsRef.current.capture?.(archived ? "chat_archived" : "chat_restored", { desk: scopeFor(conversationId), origin });
      if (archived) setConversations((c) => c.filter((x) => x.id !== conversationId));
      else reloadRef.current?.();
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, []);
  /** Rename a conversation (a desk); resolves to an error message or null. Main chats are named after their agent and cannot be renamed. */
  const renameConversation = useCallback(async (conversationId: string, name: string): Promise<string | null> => {
    const sock = socketRef.current;
    if (!sock) return "not connected to the app-server";
    if (conversationId === "default") return "a main chat cannot be renamed";
    try {
      await sock.renameConversation(conversationId, name);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, []);
  /** Stop a conversation's turn (the composer's stop button); resolves to an error message or null. */
  const stop = useCallback(async (rt: Runtime): Promise<string | null> => {
    const sock = socketRef.current;
    if (!sock) return "not connected to the app-server";
    try {
      const aborted = await sock.abortTurn(rt);
      optsRef.current.capture?.("turn_stopped", { aborted });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, []);
  /** Switch a conversation's model; returns the applied handle/effort or an error. */
  const updateModel = useCallback(async (rt: Runtime, selection: ModelSelection): Promise<{ applied: AppliedModel | null; error: string | null }> => {
    const sock = socketRef.current;
    if (!sock) return { applied: null, error: "not connected to the app-server" };
    let applied: AppliedModel;
    try {
      applied = await sock.updateModel(rt, selection);
    } catch (err) {
      return { applied: null, error: err instanceof Error ? err.message : String(err) };
    }
    optsRef.current.capture?.("model_switched", { model: applied.handle, effort: applied.reasoningEffort });
    return { applied, error: null };
  }, []);

  /**
   * Letta's sleep-time reflection for an agent: its settings (per agent, though the protocol addresses a
   * conversation), and a pass started by hand — the same as /reflect in that conversation's chat.
   */
  const reflection = useMemo(
    () => ({
      get: async (rt: Runtime): Promise<ReflectionSettings | null> => {
        const sock = socketRef.current;
        if (!sock) return null;
        try {
          return await sock.getReflectionSettings(rt);
        } catch {
          return null;
        }
      },
      set: async (rt: Runtime, s: { trigger: ReflectionTrigger; stepCount: number; merge: ReflectionMerge; mergeInstructions?: string }): Promise<string | null> => {
        const sock = socketRef.current;
        if (!sock) return "not connected to the app-server";
        try {
          await sock.setReflectionSettings(rt, s);
          return null;
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      },
      run: async (rt: Runtime): Promise<string> => {
        const sock = socketRef.current;
        if (!sock) return "not connected to the app-server";
        let r: { success: boolean; output: string };
        try {
          r = await sock.executeCommand(rt, "reflect");
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
        return r.output || (r.success ? "started" : "the harness refused");
      },
    }),
    [],
  );

  const markDone = useCallback((item: AttentionItem) => optsRef.current.markSeen(item.agentId, item.id), []);
  const markNotDone = useCallback((item: AttentionItem) => optsRef.current.unmarkSeen(item.agentId, item.id), []);
  /** Done with a chat: it is archived and leaves the Inbox; resolves to an error or null. */
  const archive = useCallback((item: AttentionItem) => archiveConversation(item.id, true, "inbox"), [archiveConversation]);
  /** Undo of an archive: the chat comes back. */
  const unarchive = useCallback((item: AttentionItem) => archiveConversation(item.id, false, "inbox_undo"), [archiveConversation]);

  // One object while its parts hold (the compiler memoises it): the shell and the phone re-render on a change, not on every render.
  return {
    status,
    server,
    /** Every slash command the box offers: loki's, the harness's, and whatever else this harness advertised. */
    commands: useMemo(() => allCommands(server?.advertised), [server?.advertised]),
    execute,
    agents,
    agentsLoaded,
    providers,
    loadProviders,
    connectProvider,
    disconnectProvider,
    createAgent,
    deleteAgent,
    memory,
    skills,
    updateAgent,
    reflection,
    listModels,
    updateModel,
    stop,
    setMode,
    changeFolder,
    archiveConversation,
    renameConversation,
    createDesk,
    items,
    loadHistory,
    loadThread,
    subscribe,
    conversation,
    approve,
    decide,
    answer,
    reply,
    send,
    cancelQueued,
    reload,
    seen: markDone,
    unread: markNotDone,
    archive,
    unarchive,
    /** Log an Inbox decision (the deck calls it; the same actions elsewhere are not Inbox decisions). */
    decided,
    shown,
    undone,
    filtered,
  };
}
