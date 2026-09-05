import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toTranscript, type TranscriptMessage } from "../../../shared/harness.ts";
import { AppServerSocket, type Runtime, type ServerEvent } from "./protocol";
import { applyEvent, buildItems, digest, emptyLive, keyOf, toConversations, type AttentionItem, type ConversationInfo, type Digest, type Live } from "./model";

/**
 * Catch Up, browser-side: talks to Letta's app-server through the mod's
 * tunnel, subscribes to recent conversations, folds live events with a
 * per-conversation digest, and reads seen markers the mod keeps on disk.
 */
export interface UseAttentionOptions {
  /** The mod says whether an app-server was discovered. */
  enabled: boolean;
  tunnelUrl: string;
  seen: Record<string, string>;
  markSeen: (agentId: string, conversationId: string) => void;
  unmarkSeen: (agentId: string, conversationId: string) => void;
  subscribeLimit?: number;
}

export function useAttention(opts: UseAttentionOptions) {
  const [conversations, setConversations] = useState<ConversationInfo[]>([]);
  const [digests, setDigests] = useState<Map<string, Digest>>(new Map());
  const [tick, setTick] = useState(0); // bumps when live state changes (live map is mutable by design)
  const [status, setStatus] = useState<"off" | "connecting" | "open" | "closed">("off");
  const [histories, setHistories] = useState<Record<string, TranscriptMessage[]>>({});
  const socketRef = useRef<AppServerSocket | null>(null);
  const liveRef = useRef(new Map<string, Live>());
  const notifyTimer = useRef<number | null>(null);

  const bump = useCallback(() => {
    if (notifyTimer.current) return;
    notifyTimer.current = window.setTimeout(() => {
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
    const sock = new AppServerSocket(opts.tunnelUrl);
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
    });

    let cancelled = false;
    const load = async () => {
      try {
        const agents = await sock.listAgents();
        const names = new Map(agents.filter((a) => a.hidden !== true).map((a) => [a.id, a.name ?? "agent"]));
        const records: Array<Record<string, unknown>> = [];
        for (const id of names.keys()) records.push(...(await sock.listConversations(id, 100)));
        const convs = toConversations(records, names);
        if (cancelled) return;
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
        console.warn("loci catch up:", err);
      }
    };
    void load();
    const refresh = window.setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(refresh);
      off();
      sock.close();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.enabled, opts.tunnelUrl]);

  const items = useMemo(() => buildItems(conversations, digests, liveRef.current, opts.seen), [conversations, digests, opts.seen, tick]);

  const loadHistory = useCallback(async (item: AttentionItem) => {
    const sock = socketRef.current;
    if (!sock) return;
    try {
      const messages = await sock.listMessages(item.runtime, 60);
      setHistories((h) => ({ ...h, [keyOf(item.agentId, item.id)]: toTranscript(messages) }));
    } catch (err) {
      console.warn("loci catch up: history", err);
    }
  }, []);

  const approve = useCallback((item: AttentionItem, requestId: string, behavior: "allow" | "deny") => {
    const l = liveRef.current.get(keyOf(item.agentId, item.id));
    const was = l?.pending?.requestId === requestId ? l.pending : null;
    if (l && was) l.pending = null; // optimistic: the card clears at once
    opts.markSeen(item.agentId, item.id);
    bump();
    void socketRef.current?.respondApproval(item.runtime, requestId, behavior).then((ok) => {
      if (ok || !l || !was) return;
      if (!l.pending) l.pending = was; // the server refused: put the request back
      bump();
    });
  }, [opts, bump]);

  const reply = useCallback((item: AttentionItem, text: string) => {
    void socketRef.current?.sendUserMessage(item.runtime, text);
    opts.markSeen(item.agentId, item.id);
  }, [opts]);

  return {
    status,
    items,
    histories,
    loadHistory,
    approve,
    reply,
    seen: (item: AttentionItem) => opts.markSeen(item.agentId, item.id),
    unread: (item: AttentionItem) => opts.unmarkSeen(item.agentId, item.id),
  };
}
