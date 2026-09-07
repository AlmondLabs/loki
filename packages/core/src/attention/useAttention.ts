import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toTranscript } from "../harness.ts";
import { AppServerSocket, type Runtime, type ServerEvent } from "./protocol.ts";
import type { ConnectProvider, Personality } from "./protocol.ts";
import { applyEvent, buildItems, chatStatusOf, digest, emptyLive, keyOf, toConversations, type AttentionItem, type ConversationInfo, type Digest, type Live, type PendingApproval, type PendingQuestion } from "./model.ts";
import { buildQuestionAnswer, environmentReminder } from "./content.ts";
import type { TranscriptRow } from "./transcript.ts";
import type { ImageAttachment } from "./content.ts";
import { activeSnooze, nextSnooze, type Snooze } from "./snooze.ts";
import { stampOf } from "./queue.ts";
import type { MakeTransport } from "./transport.ts";

/**
 * Catch Up, client-side: talks to Letta's app-server through the mod's
 * tunnel, subscribes to recent conversations, folds live events with a
 * per-conversation digest, and reads seen markers the mod keeps on disk.
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
  /** Full transcript from the mod's local log (compaction-proof); may resolve empty. */
  loadLocalHistory?: (agentId: string, conversationId: string) => Promise<Array<{ role: "user" | "assistant" | "tool" | "event"; text: string; summary?: string | null; detail?: string | null }>>;
  subscribeLimit?: number;
}

export function useAttention(opts: UseAttentionOptions) {
  const [conversations, setConversations] = useState<ConversationInfo[]>([]);
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  /** False until the first agent_list answered: an empty list before that means nothing. */
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [digests, setDigests] = useState<Map<string, Digest>>(new Map());
  const [tick, setTick] = useState(0); // bumps when live state changes (live map is mutable by design)
  const [status, setStatus] = useState<"off" | "connecting" | "open" | "closed">("off");
  /** From the harness's app_server_info reply: which Letta Code this is. */
  const [server, setServer] = useState<{ version: string | null; protocol: number | null } | null>(null);
  /** Loaded transcripts by key; live rows (Live.tail) are appended on top when read. */
  const [histories, setHistories] = useState<Record<string, TranscriptRow[]>>({});
  const loading = useRef(new Set<string>());
  const socketRef = useRef<AppServerSocket | null>(null);
  const liveRef = useRef(new Map<string, Live>());
  const notifyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Conversations the list knows about; an event from an unknown one means the list is stale (a new desk, an empty conversation that just got its first turn). */
  const knownRef = useRef(new Set<string>());
  const reloadRef = useRef<(() => void) | null>(null);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastReload = useRef(0);

  const bump = useCallback(() => {
    if (notifyTimer.current) return;
    notifyTimer.current = setTimeout(() => {
      notifyTimer.current = null;
      setTick((t) => t + 1);
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
    sock.onStatus = setStatus;
    socketRef.current = sock;
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
      const { changed, userSpoke } = applyEvent(l, ev);
      if (userSpoke) opts.markSeen(agent, conv);
      if (changed) bump();
      if (changed && !knownRef.current.has(key) && !reloadTimer.current && Date.now() - lastReload.current > 10_000) {
        // not in the list yet: refresh it soon so the conversation can become a card
        reloadTimer.current = setTimeout(() => {
          reloadTimer.current = null;
          reloadRef.current?.();
        }, 1500);
      }
    });

    let cancelled = false;
    const load = async () => {
      try {
        void sock.request("app_server_info").then((info) => {
          if (!cancelled) setServer({ version: typeof info.letta_code_version === "string" ? info.letta_code_version : null, protocol: typeof info.protocol_version === "number" ? info.protocol_version : null });
        }).catch(() => {});
        const agents = await sock.listAgents();
        const names = new Map(agents.filter((a) => a.hidden !== true).map((a) => [a.id, a.name ?? "agent"]));
        if (!cancelled) {
          setAgents([...names].map(([id, name]) => ({ id, name })));
          setAgentsLoaded(true);
        }
        const records: Array<Record<string, unknown>> = [];
        for (const id of names.keys()) records.push(...(await sock.listConversations(id, 100)));
        const convs = toConversations(records, names);
        if (cancelled) return;
        lastReload.current = Date.now();
        knownRef.current = new Set(convs.map((c) => keyOf(c.agentId, c.id)));
        setConversations(convs);
        const recent = convs.slice(0, opts.subscribeLimit ?? 30);
        const next = new Map<string, Digest>();
        for (const c of recent) {
          const rt: Runtime = { agent_id: c.agentId, conversation_id: c.id };
          try {
            if (!sock.isSubscribed(rt)) await sock.runtimeStart(rt);
            next.set(keyOf(c.agentId, c.id), digest(await sock.listMessages(rt, 12)));
          } catch {
            // a conversation we cannot reach is left out of the digest; it still lists
          }
          if (cancelled) return;
          setDigests(new Map(next)); // progressive: items firm up as digests arrive
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
      off();
      sock.close();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.enabled, opts.tunnelUrl]);

  // Snoozes expire on their own; re-evaluate twice a minute so cards come due without any event.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const items = useMemo(
    () => buildItems(conversations, digests, liveRef.current, opts.seen).map((i) => ({ ...i, snooze: activeSnooze(i, opts.snooze[keyOf(i.agentId, i.id)], now) })),
    [conversations, digests, opts.seen, opts.snooze, tick, now],
  );

  // The app-server only lists what is still in the agent's context, so a compacted
  // conversation shows a stub. The mod reads the whole local log; ask it first.
  const loadThread = useCallback(async (rt: Runtime) => {
    const key = keyOf(rt.agent_id, rt.conversation_id);
    if (loading.current.has(key)) return;
    loading.current.add(key);
    try {
      let rows: TranscriptRow[] = ((await opts.loadLocalHistory?.(rt.agent_id, rt.conversation_id)) ?? []).map((m) => ({ ...m }));
      if (!rows.length && socketRef.current) rows = toTranscript(await socketRef.current.listMessages(rt, 60)).map((m) => ({ role: m.role, text: m.text, summary: m.summary, detail: m.detail }));
      const l = liveRef.current.get(key);
      if (l) l.tail = []; // the transcript now covers what streamed in before
      setHistories((h) => ({ ...h, [key]: rows }));
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
      const l = liveRef.current.get(key);
      const base = histories[key];
      const live: TranscriptRow[] = l ? [...l.tail, ...(l.streamingText ? [{ role: "assistant" as const, text: l.streamingText }] : [])] : [];
      return { rows: base === undefined && !live.length ? undefined : [...(base ?? []), ...live], status: chatStatusOf(l), pending: l?.pending ?? null, question: l?.pendingAsk ?? null, error: l?.error ?? null, mode: l?.mode ?? null };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [histories, tick],
  );

  const decide = useCallback((rt: Runtime, requestId: string, behavior: "allow" | "deny") => {
    const l = liveRef.current.get(keyOf(rt.agent_id, rt.conversation_id));
    const was = l?.pending?.requestId === requestId ? l.pending : null;
    if (l && was) l.pending = null; // optimistic: the card clears at once
    opts.markSeen(rt.agent_id, rt.conversation_id);
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
    if (summary.trim()) l.tail.push({ role: "user", text: summary });
    opts.markSeen(rt.agent_id, rt.conversation_id);
    bump();
    void socketRef.current?.answerQuestion(rt, requestId, buildQuestionAnswer(was.input, answers)).then((ok) => {
      if (ok) return;
      if (!l.pendingAsk) l.pendingAsk = was;
      bump();
    });
  }, [opts, bump]);

  /** Send a message into a conversation. Shown at once; the server's echo of it is recognised and not shown twice. */
  const send = useCallback((rt: Runtime, text: string, images: ImageAttachment[] = [], env: { folder?: string | null; desk?: string | null } = {}) => {
    const key = keyOf(rt.agent_id, rt.conversation_id);
    let l = liveRef.current.get(key);
    if (!l) {
      l = emptyLive();
      liveRef.current.set(key, l);
    }
    l.tail.push({ role: "user", text, images: images.length ? images.map((i) => i.url) : undefined });
    if (text.trim()) l.ownSends.push(text);
    l.lastRole = "user";
    bump();
    const context = environmentReminder({ folder: env.folder, desk: env.desk }); // what Desktop attaches: local time, folder
    void subscribe(rt).then(() => socketRef.current?.sendUserMessage(rt, text, images, context)).catch((err) => console.warn("loki: send", err));
    opts.markSeen(rt.agent_id, rt.conversation_id);
  }, [opts, subscribe, bump]);
  const reply = useCallback((item: AttentionItem, text: string, images: ImageAttachment[] = []) => send(item.runtime, text, images, { desk: item.title }), [send]);

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
      bump();
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, [bump]);
  /** Switch a conversation's model; resolves to an error message or null. */
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
  const updateModel = useCallback(async (rt: Runtime, handle: string): Promise<string | null> => {
    const sock = socketRef.current;
    if (!sock) return "not connected to the app-server";
    try {
      await sock.updateModel(rt, handle);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, []);

  return {
    status,
    server,
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
    seen: (item: AttentionItem) => opts.markSeen(item.agentId, item.id),
    unread: (item: AttentionItem) => opts.unmarkSeen(item.agentId, item.id),
    /** "Later": defer with backoff; the deferral is void if the card moves on. */
    later: (item: AttentionItem) => opts.setSnooze(item.agentId, item.id, nextSnooze(opts.snooze[keyOf(item.agentId, item.id)], stampOf(item))),
    unsnooze: (item: AttentionItem) => opts.clearSnooze(item.agentId, item.id),
    snoozes: opts.snooze,
  };
}
