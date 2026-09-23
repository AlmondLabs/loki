import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toTranscript } from "../harness.ts";
import { AppServerSocket, type Runtime, type ServerEvent } from "./protocol.ts";
import type { AppliedModel, ModelSelection } from "../models.ts";
import type { ConnectProvider, Personality, ReflectionMerge, ReflectionSettings, ReflectionTrigger } from "./protocol.ts";
import { applyEvent, beginCommand, buildItems, cancelQueued as dropQueued, chatStatusOf, commandRunning, emptyLive, finishCommand, settleCommands, keyOf, takeQueued, type AttentionItem, type ConversationInfo, type Digest, type Live, type PendingApproval, type PendingQuestion } from "./model.ts";
import { buildQuestionAnswer, environmentReminder } from "./content.ts";
import { carryTimes, fromHistory, type TranscriptRow } from "./transcript.ts";
import type { ImageAttachment } from "./content.ts";
import { activeSnooze, nextSnooze, type Snooze } from "./snooze.ts";
import type { SnoozeLadder } from "./ladder.ts";
import { stampOf } from "./queue.ts";
import { allCommands, commandInput, fromAdvertised, type SlashCommand } from "./commands.ts";
import type { MakeTransport } from "./transport.ts";

/**
 * Catch Up, client-side: the list of open conversations and who spoke last in each come from the
 * mod's disk scan (every open conversation, main chats included, however old); the app-server,
 * through the mod's tunnel, supplies the live half — approvals, questions, streaming — for the
 * most recent ones, and the seen markers are the mod's too.
 */
export interface UseAttentionOptions {
  /** The mod says whether an app-server was discovered. */
  enabled: boolean;
  tunnelUrl: string;
  /** How to reach the app-server from here: a WebSocket in a tab or on the phone, the Rust link in the shell. */
  makeTransport: MakeTransport;
  seen: Record<string, string>;
  snooze: Record<string, Snooze>;
  markSeen: (agentId: string, conversationId: string) => void;
  unmarkSeen: (agentId: string, conversationId: string) => void;
  setSnooze: (agentId: string, conversationId: string, rec: Snooze) => void;
  clearSnooze: (agentId: string, conversationId: string) => void;
  /** How long "later" hides a card (the mod's setting; ladder.ts has the defaults). */
  ladder?: SnoozeLadder;
  /** Full transcript from the mod's local log (compaction-proof); may resolve empty. */
  loadLocalHistory?: (agentId: string, conversationId: string) => Promise<Array<{ role: "user" | "assistant" | "tool" | "event"; text: string; summary?: string | null; detail?: string | null; at?: string | null }>>;
  /** Every open conversation with its digest, from the mod (inbox_list). The list is the inbox's; only live events come from the app-server. */
  listConversations: () => Promise<Array<ConversationInfo & Digest>>;
  /** How many of the newest conversations to subscribe to for live events (each costs the app-server a runtime). */
  subscribeLimit?: number;
  /** Analytics (core/analytics.ts): an event this model carried out for the user. */
  capture?: (event: string, properties?: Record<string, unknown>) => void;
}

/** Where a message was typed, for analytics; the phone's sends carry none (its device type says). */
export type SendOrigin = "desk" | "inbox" | "lesson";

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
  /** Loaded transcripts by key; live rows (Live.tail) are appended on top when read. */
  const [histories, setHistories] = useState<Record<string, TranscriptRow[]>>({});
  const loading = useRef(new Set<string>());
  const socketRef = useRef<AppServerSocket | null>(null);
  const liveRef = useRef(new Map<string, Live>());
  const notifyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Conversations the list knows about; an event from an unknown one means the list is stale (a new desk, an empty conversation that just got its first turn). */
  const knownRef = useRef(new Set<string>());
  const reloadRef = useRef<(() => void) | null>(null);
  const lastReload = useRef(0);
  /** The link dropped since it was last open: when it reopens, commands left running are settled (see settleCommands). */
  const linkDropped = useRef(false);

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
    const sock = new AppServerSocket(opts.tunnelUrl, opts.makeTransport);
    sock.onStatus = (s) => {
      setStatus(s);
      if (s === "closed") linkDropped.current = true;
      else if (s === "open" && linkDropped.current) {
        // Back after a drop (a /reload restarts the mod, which is this link): finish what the old link left running.
        linkDropped.current = false;
        let changed = false;
        for (const l of liveRef.current.values()) if (settleCommands(l)) changed = true;
        if (changed) bump();
      }
    };
    socketRef.current = sock;
    let reloadTimer: ReturnType<typeof setTimeout> | null = null; // a list refresh waiting on this socket
    const off = sock.on((ev: ServerEvent) => {
      const conv = ev.runtime?.conversation_id ?? (typeof ev.conversation_id === "string" ? ev.conversation_id : null);
      const agent = ev.runtime?.agent_id ?? (typeof ev.agent_id === "string" ? ev.agent_id : null);
      if (!conv || !agent) return;
      const key = keyOf(agent, conv);
      let l = liveRef.current.get(key);
      if (!l) {
        l = emptyLive();
        liveRef.current.set(key, l);
      }
      const wasInTurn = l.inTurn;
      const { changed, userSpoke } = applyEvent(l, ev);
      if (userSpoke) opts.markSeen(agent, conv);
      if (changed) bump();
      // The turn just ended and something was typed during it: it goes out now, one per turn end.
      if (wasInTurn && !l.inTurn) {
        const next = takeQueued(l);
        if (next && ev.runtime) {
          const rt = ev.runtime;
          if (next.text.trim()) l.ownSends.push(next.text);
          l.inTurn = true; // until the server says so, so a second queued message waits its turn
          bump();
          void sock.sendUserMessage(rt, next.text, next.images, next.context).catch((err) => console.warn("loki: queued send", err));
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
    const load = async () => {
      try {
        void sock.request("app_server_info").then((info) => {
          if (!cancelled) {
            const ids = Array.isArray(info.supported_commands) ? (info.supported_commands as unknown[]).filter((x): x is string => typeof x === "string") : undefined;
            const mods = Array.isArray(info.mod_commands) ? (info.mod_commands as Array<{ id: string; description?: string; args?: string }>) : undefined;
            setServer({ version: typeof info.letta_code_version === "string" ? info.letta_code_version : null, protocol: typeof info.protocol_version === "number" ? info.protocol_version : null, advertised: fromAdvertised(ids, mods) });
          }
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
        for (const c of convs.slice(0, opts.subscribeLimit ?? 30)) {
          const rt: Runtime = { agent_id: c.agentId, conversation_id: c.id };
          try {
            if (!sock.isSubscribed(rt)) await sock.runtimeStart(rt);
          } catch {
            // a conversation we cannot reach still lists; it just has no live half
          }
          if (cancelled) return;
        }
      } catch (err) {
        console.warn("loki catch up:", err);
      }
    };
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
  }, [opts.enabled, opts.tunnelUrl]);

  // The pending tick, if any, has nothing to render into after unmount.
  useEffect(
    () => () => {
      if (notifyTimer.current) clearTimeout(notifyTimer.current);
      notifyTimer.current = null;
    },
    [],
  );

  // The clock tick: snoozes come due and warmth fades without any other event, so the items are rebuilt twice a minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const items = useMemo(
    () => buildItems(conversations, digests, live, opts.seen, now).map((i) => ({ ...i, snooze: activeSnooze(i, opts.snooze[keyOf(i.agentId, i.id)], now) })),
    [conversations, digests, opts.seen, opts.snooze, live, now],
  );

  // The app-server only lists what is still in the agent's context, so a compacted
  // conversation shows a stub. The mod reads the whole local log; ask it first.
  const loadThread = useCallback(async (rt: Runtime) => {
    const key = keyOf(rt.agent_id, rt.conversation_id);
    if (loading.current.has(key)) return;
    loading.current.add(key);
    try {
      let rows: TranscriptRow[] = ((await opts.loadLocalHistory?.(rt.agent_id, rt.conversation_id)) ?? []).map(fromHistory);
      if (!rows.length && socketRef.current) rows = toTranscript(await socketRef.current.listMessages(rt, 60)).map(fromHistory);
      const l = liveRef.current.get(key);
      const tail = l?.tail ?? [];
      if (l) l.tail = []; // the transcript now covers what streamed in before
      // Live rows were stamped on arrival; history that has no times of its own keeps theirs (and the last load's).
      setHistories((h) => ({ ...h, [key]: carryTimes(rows, [...(h[key] ?? []), ...tail]) }));
    } catch (err) {
      console.warn("loki: thread", err);
    } finally {
      loading.current.delete(key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.loadLocalHistory]);
  const loadHistory = useCallback((item: AttentionItem) => loadThread(item.runtime), [loadThread]);

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
    (agentId: string, conversationId: string): { rows: TranscriptRow[] | undefined; status: "idle" | "thinking" | "streaming"; pending: PendingApproval | null; question: PendingQuestion | null; error: string | null; mode: string | null } => {
      const key = keyOf(agentId, conversationId);
      const l = live.get(key);
      const base = histories[key];
      const liveRows: TranscriptRow[] = l ? [...l.tail, ...(l.streamingText ? [{ role: "assistant" as const, text: l.streamingText, ...(l.streamingAt ? { at: l.streamingAt } : {}) }] : [])] : [];
      return { rows: base === undefined && !liveRows.length ? undefined : [...(base ?? []), ...liveRows], status: chatStatusOf(l), pending: l?.pending ?? null, question: l?.pendingAsk ?? null, error: l?.error ?? null, mode: l?.mode ?? null };
    },
    [histories, live],
  );

  const decide = useCallback((rt: Runtime, requestId: string, behavior: "allow" | "deny") => {
    const l = liveRef.current.get(keyOf(rt.agent_id, rt.conversation_id));
    const was = l?.pending?.requestId === requestId ? l.pending : null;
    if (l && was) l.pending = null; // optimistic: the card clears at once
    opts.markSeen(rt.agent_id, rt.conversation_id);
    opts.capture?.("approval_decided", { behavior });
    bump();
    void socketRef.current?.respondApproval(rt, requestId, behavior).then((ok) => {
      if (ok || !l || !was) return;
      if (!l.pending) l.pending = was; // the server refused: put the request back
      bump();
    });
  }, [opts, bump]);
  const approve = useCallback((item: AttentionItem, requestId: string, behavior: "allow" | "deny") => decide(item.runtime, requestId, behavior), [decide]);

  /** Answer a pending AskUserQuestion; the card clears at once and comes back if the server refuses. */
  const answer = useCallback((rt: Runtime, requestId: string, answers: Record<string, string | string[]>) => {
    const l = liveRef.current.get(keyOf(rt.agent_id, rt.conversation_id));
    const was = l?.pendingAsk?.requestId === requestId ? l.pendingAsk : null;
    if (!l || !was) return;
    l.pendingAsk = null;
    const summary = Object.values(answers).map((a) => (Array.isArray(a) ? a.join(", ") : a)).join(" · ");
    if (summary.trim()) l.tail.push({ role: "user", text: summary, at: new Date().toISOString() });
    opts.markSeen(rt.agent_id, rt.conversation_id);
    opts.capture?.("question_answered");
    bump();
    void socketRef.current?.answerQuestion(rt, requestId, buildQuestionAnswer(was.input, answers)).then((ok) => {
      if (ok) return;
      if (!l.pendingAsk) l.pendingAsk = was;
      bump();
    });
  }, [opts, bump]);

  /** Send a message into a conversation. Shown at once; the server's echo of it is recognised and not shown twice. */
  const send = useCallback((rt: Runtime, text: string, images: ImageAttachment[] = [], env: { folder?: string | null; desk?: string | null; origin?: SendOrigin } = {}) => {
    const key = keyOf(rt.agent_id, rt.conversation_id);
    let l = liveRef.current.get(key);
    if (!l) {
      l = emptyLive();
      liveRef.current.set(key, l);
    }
    const context = environmentReminder({ folder: env.folder, desk: env.desk }); // what Desktop attaches: local time, folder
    opts.capture?.("message_sent", { origin: env.origin ?? null, images: images.length, queued: l.inTurn });
    // Mid-turn: keep it. The transcript shows it as queued; it leaves when the turn ends (see the event loop).
    if (l.inTurn) {
      l.queued.push({ text, images, context });
      l.tail.push({ role: "user", text, images: images.length ? images.map((i) => i.url) : undefined, queued: true, at: new Date().toISOString() });
      bump();
      return;
    }
    l.tail.push({ role: "user", text, images: images.length ? images.map((i) => i.url) : undefined, at: new Date().toISOString() });
    if (text.trim()) l.ownSends.push(text);
    l.lastRole = "user";
    bump();
    void subscribe(rt).then(() => socketRef.current?.sendUserMessage(rt, text, images, context)).catch((err) => console.warn("loki: send", err));
    opts.markSeen(rt.agent_id, rt.conversation_id);
  }, [opts, subscribe, bump]);
  /** Take back a message typed mid-turn before it went out. */
  const cancelQueued = useCallback((rt: Runtime, text: string) => {
    const l = liveRef.current.get(keyOf(rt.agent_id, rt.conversation_id));
    if (l && dropQueued(l, text)) bump();
  }, [bump]);
  const reply = useCallback((item: AttentionItem, text: string, images: ImageAttachment[] = []) => send(item.runtime, text, images, { desk: item.title, origin: "inbox" }), [send]);

  /**
   * A slash command for the harness (/reload, /compact …): execute_command, the path Desktop uses. The
   * transcript row comes from the harness's slash_command_start / _end deltas when the conversation is
   * subscribed; the answer here fills the row in when those never arrived, or when the call failed.
   */
  const execute = useCallback(async (rt: Runtime, commandId: string, args?: string): Promise<{ success: boolean; output: string }> => {
    const key = keyOf(rt.agent_id, rt.conversation_id);
    let l = liveRef.current.get(key);
    if (!l) {
      l = emptyLive();
      liveRef.current.set(key, l);
    }
    const input = commandInput(commandId, args);
    opts.capture?.("command_run", { command: commandId });
    const sock = socketRef.current;
    if (!sock) {
      finishCommand(l, input, false, "not connected to the app-server");
      bump();
      return { success: false, output: "not connected to the app-server" };
    }
    if (!sock.isSubscribed(rt)) beginCommand(l, input); // no deltas will come for this one; show the running row ourselves
    bump();
    try {
      const res = await sock.executeCommand(rt, commandId, args);
      if (commandRunning(l, input)) finishCommand(l, input, res.success, res.output);
      bump();
      return res;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // /reload restarts the mod, and the mod is this link: the answer is lost with it, which is the success case.
      const reloaded = commandId === "reload" && /link closed/i.test(message);
      finishCommand(l, input, reloaded, reloaded ? "reloaded — the mod restarted and the link is back" : message);
      bump();
      return { success: reloaded, output: reloaded ? "reloaded" : message };
    }
  }, [bump, opts]);

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
  const loadProviders = useCallback(async (): Promise<ConnectProvider[]> => {
    const sock = socketRef.current;
    if (!sock) return [];
    try {
      const list = await sock.listConnectProviders();
      setProviders(list);
      return list;
    } catch {
      return providers ?? [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    try {
      const created = await sock.createAgent({ personality: opts.personality, model: opts.model });
      const body: Record<string, unknown> = {};
      if (opts.name.trim() && opts.name.trim() !== created.name) body.name = opts.name.trim();
      if (opts.description?.trim()) body.description = opts.description.trim();
      if (Object.keys(body).length) await sock.updateAgent(created.id, body);
      setAgents((a) => (a.some((x) => x.id === created.id) ? a : [...a, { id: created.id, name: (body.name as string | undefined) ?? created.name }]));
      reloadRef.current?.();
      return { id: created.id };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }, []);
  const deleteAgent = useCallback(async (agentId: string): Promise<string | null> => {
    const sock = socketRef.current;
    if (!sock) return "not connected to the app-server";
    try {
      await sock.deleteAgent(agentId);
      setAgents((a) => a.filter((x) => x.id !== agentId));
      reloadRef.current?.();
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
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
    try {
      return (await socketRef.current?.listModels()) ?? [];
    } catch {
      return [];
    }
  }, []);
  /** Set a conversation's permission mode (runtime_start with `mode`); resolves to an error message or null. */
  const setMode = useCallback(async (rt: Runtime, mode: string): Promise<string | null> => {
    const sock = socketRef.current;
    if (!sock) return "not connected to the app-server";
    try {
      await sock.runtimeStart(rt, { mode });
      const l = liveRef.current.get(keyOf(rt.agent_id, rt.conversation_id));
      if (l) l.mode = mode;
      opts.capture?.("mode_set", { mode });
      bump();
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, [bump, opts]);
  /** Archive or restore a conversation; resolves to an error message or null. Main chats cannot be archived. */
  const archiveConversation = useCallback(async (conversationId: string, archived: boolean): Promise<string | null> => {
    const sock = socketRef.current;
    if (!sock) return "not connected to the app-server";
    if (conversationId === "default") return "a main chat cannot be archived";
    try {
      await sock.updateConversation(conversationId, { archived });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, []);
  /** Switch a conversation's model; returns the applied handle/effort or an error. */
  const updateModel = useCallback(async (rt: Runtime, selection: ModelSelection): Promise<{ applied: AppliedModel | null; error: string | null }> => {
    const sock = socketRef.current;
    if (!sock) return { applied: null, error: "not connected to the app-server" };
    try {
      const applied = await sock.updateModel(rt, selection);
      opts.capture?.("model_switched", { model: applied.handle, effort: applied.reasoningEffort });
      return { applied, error: null };
    } catch (err) {
      return { applied: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [opts]);

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
        try {
          const r = await sock.executeCommand(rt, "reflect");
          return r.output || (r.success ? "started" : "the harness refused");
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      },
    }),
    [],
  );

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
    setMode,
    archiveConversation,
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
    seen: (item: AttentionItem) => opts.markSeen(item.agentId, item.id),
    unread: (item: AttentionItem) => opts.unmarkSeen(item.agentId, item.id),
    /** "Later": defer with backoff; the deferral is void if the card moves on. */
    later: (item: AttentionItem) => opts.setSnooze(item.agentId, item.id, nextSnooze(opts.snooze[keyOf(item.agentId, item.id)], stampOf(item), Date.now(), opts.ladder)),
    unsnooze: (item: AttentionItem) => opts.clearSnooze(item.agentId, item.id),
    snoozes: opts.snooze,
  };
}
