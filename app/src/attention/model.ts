import { looksLikeQuestion, messageText, stripHarnessMarkup } from "../../../shared/harness.ts";
import type { Runtime, ServerEvent } from "./protocol";

/**
 * Attention model: which conversations are waiting on the user, and why.
 *   approval  paused on a can_use_tool control_request
 *   question  the agent's last message asks you something and you have not replied
 *   done      the agent finished a turn after you last looked
 *   failed    the last turn errored
 *   running   a turn is in progress
 *   idle      nothing to see
 * Pure: fed by the conversation list, a message digest per conversation, live
 * events, and the seen markers. No I/O here.
 */
export type AttentionStatus = "approval" | "question" | "done" | "failed" | "running" | "idle";

export interface PendingApproval {
  requestId: string;
  toolName: string;
  input: unknown;
  at: string;
}

export interface ConversationInfo {
  id: string;
  agentId: string;
  agentName: string | null;
  title: string | null;
  lastMessageAt: string | null;
  archived: boolean;
}

/** From the last few protocol messages of a conversation. */
export interface Digest {
  lastRole: "user" | "assistant" | null;
  lastAssistantText: string | null;
}

export interface Live {
  loop?: string;
  pending: PendingApproval | null;
  error: string | null;
  streamingText: string;
  lastAssistantText: string | null;
  lastRole: "user" | "assistant" | null;
  lastMessageAt: string | null;
}

export interface AttentionItem extends ConversationInfo {
  status: AttentionStatus;
  lastAssistantText: string | null;
  lastRole: "user" | "assistant" | null;
  pendingApproval: PendingApproval | null;
  error: string | null;
  seenAt: string | null;
  unread: boolean;
  runtime: Runtime;
}

export const keyOf = (agentId: string, conversationId: string) => `${agentId}/${conversationId}`;
const TEXT_LIMIT = 700;

export function emptyLive(): Live {
  return { pending: null, error: null, streamingText: "", lastAssistantText: null, lastRole: null, lastMessageAt: null };
}

/** Digest a conversation's messages (oldest first). */
export function digest(messages: Array<Record<string, unknown>>): Digest {
  let lastRole: Digest["lastRole"] = null;
  let lastAssistantText: string | null = null;
  for (const m of messages) {
    if (m.message_type === "user_message") {
      if (stripHarnessMarkup(messageText(m.content)).trim()) lastRole = "user";
    } else if (m.message_type === "assistant_message") {
      const t = messageText(m.content).trim();
      if (t) {
        lastRole = "assistant";
        lastAssistantText = t.slice(-TEXT_LIMIT);
      }
    }
  }
  return { lastRole, lastAssistantText };
}

/** Fold one live event into a conversation's live state. Returns true if anything changed. */
export function applyEvent(l: Live, ev: ServerEvent, now = new Date().toISOString()): { changed: boolean; userSpoke: boolean } {
  switch (ev.type) {
    case "control_request": {
      const req = ev.request as { subtype?: string; tool_name?: string; input?: unknown } | undefined;
      if (req?.subtype !== "can_use_tool") return { changed: false, userSpoke: false };
      l.pending = { requestId: String(ev.request_id), toolName: req.tool_name ?? "tool", input: req.input, at: now };
      l.lastMessageAt = now;
      return { changed: true, userSpoke: false };
    }
    case "update_loop_status": {
      const status = (ev.loop_status as { status?: string } | undefined)?.status;
      l.loop = status;
      if (status && status !== "WAITING_ON_APPROVAL") l.pending = null;
      if (status && status !== "WAITING_ON_INPUT" && status !== "WAITING_ON_APPROVAL") l.error = null;
      return { changed: true, userSpoke: false };
    }
    case "stream_delta": {
      const d = ev.delta as Record<string, unknown> | undefined;
      const mt = d?.message_type;
      if (mt === "assistant_message") {
        l.streamingText += messageText(d?.content);
        l.lastRole = "assistant";
        l.lastMessageAt = now;
        return { changed: true, userSpoke: false };
      }
      if (mt === "user_message") {
        const text = stripHarnessMarkup(messageText(d?.content)).trim();
        if (!text) return { changed: false, userSpoke: false };
        l.lastRole = "user";
        l.streamingText = "";
        l.lastAssistantText = null;
        return { changed: true, userSpoke: true };
      }
      if (mt === "error_message" || mt === "loop_error") {
        l.error = String((d as { message?: string })?.message ?? "the turn failed");
        return { changed: true, userSpoke: false };
      }
      if (mt === "stop_reason") {
        if (l.streamingText.trim()) l.lastAssistantText = l.streamingText.trim().slice(-TEXT_LIMIT);
        l.streamingText = "";
        return { changed: true, userSpoke: false };
      }
      return { changed: false, userSpoke: false };
    }
    case "turn_finished":
      if (l.streamingText.trim()) l.lastAssistantText = l.streamingText.trim().slice(-TEXT_LIMIT);
      l.streamingText = "";
      l.lastMessageAt = now;
      l.pending = null;
      return { changed: true, userSpoke: false };
    default:
      return { changed: false, userSpoke: false };
  }
}

const RANK: Record<AttentionStatus, number> = { approval: 0, question: 1, failed: 2, done: 3, running: 4, idle: 5 };

/** Combine everything into the sorted item list. */
export function buildItems(
  conversations: ConversationInfo[],
  digests: Map<string, Digest>,
  live: Map<string, Live>,
  seen: Record<string, string>,
): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const c of conversations) {
    const key = keyOf(c.agentId, c.id);
    const d = digests.get(key);
    const l = live.get(key);
    const lastMessageAt = [c.lastMessageAt, l?.lastMessageAt].filter(Boolean).sort().pop() ?? null;
    const lastRole = l?.lastRole ?? d?.lastRole ?? null;
    const lastAssistantText = l?.lastAssistantText ?? d?.lastAssistantText ?? null;
    const seenAt = seen[key] ?? null;
    const unread = !!lastMessageAt && lastRole === "assistant" && (!seenAt || seenAt < lastMessageAt);
    let status: AttentionStatus = "idle";
    if (l?.pending) status = "approval";
    else if (l?.error && unread) status = "failed";
    else if (l?.loop && l.loop !== "WAITING_ON_INPUT" && l.loop !== "WAITING_ON_APPROVAL") status = "running";
    else if (unread && looksLikeQuestion(lastAssistantText)) status = "question";
    else if (unread) status = "done";
    out.push({
      ...c,
      status,
      lastMessageAt,
      lastAssistantText: lastAssistantText ? stripHarnessMarkup(lastAssistantText).trim().slice(-TEXT_LIMIT) : null,
      lastRole,
      pendingApproval: l?.pending ?? null,
      error: l?.error ?? null,
      seenAt,
      unread,
      runtime: { agent_id: c.agentId, conversation_id: c.id },
    });
  }
  return out.sort((a, b) => RANK[a.status] - RANK[b.status] || (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
}

/** Protocol conversation records → ConversationInfo, dropping archived and stale ones. */
export function toConversations(records: Array<Record<string, unknown>>, agentNames: Map<string, string>, windowDays = 7, now = Date.now()): ConversationInfo[] {
  const cutoff = now - windowDays * 86_400_000;
  const out: ConversationInfo[] = [];
  for (const r of records) {
    const id = typeof r.id === "string" ? r.id : null;
    const agentId = typeof r.agent_id === "string" ? r.agent_id : null;
    if (!id || !agentId || r.archived === true) continue;
    const last = typeof r.last_message_at === "string" ? r.last_message_at : null;
    if (!last || new Date(last).getTime() < cutoff) continue;
    const summary = typeof r.summary === "string" && r.summary.trim() ? r.summary.trim() : null;
    const agentName = agentNames.get(agentId) ?? null;
    out.push({ id, agentId, agentName, title: summary ?? (id === "default" ? `${agentName ?? "agent"} · main chat` : null), lastMessageAt: last, archived: false });
  }
  return out.sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
}
