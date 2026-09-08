import { looksLikeQuestion, messageText, stripHarnessMarkup } from "../harness.ts";
import type { Runtime, ServerEvent } from "./protocol.ts";
import type { ImageAttachment } from "./content.ts";

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

/** The agent is waiting on answers (AskUserQuestion), not a permission. */
export interface PendingQuestion {
  requestId: string;
  input: unknown;
  questions: AskQuestion[];
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

export interface LiveRow {
  role: "user" | "assistant" | "tool";
  text: string;
  images?: string[];
  /** Typed while the turn ran: shown in the transcript, sent when the turn ends. */
  queued?: boolean;
}

/** A message typed mid-turn, waiting for the conversation to go idle. */
export interface QueuedSend {
  text: string;
  images: ImageAttachment[];
  context?: string;
}

export interface Live {
  loop?: string;
  pending: PendingApproval | null;
  pendingAsk: PendingQuestion | null;
  error: string | null;
  streamingText: string;
  lastAssistantText: string | null;
  lastRole: "user" | "assistant" | null;
  lastMessageAt: string | null;
  /** Rows that arrived live since the transcript was last loaded (the streaming reply is not in here until it ends). */
  tail: LiveRow[];
  /** Tool calls already announced (a call streams as several deltas). */
  toolsSeen: Set<string>;
  /** Messages this tab sent and already showed; their echo as user_message is not shown twice. */
  ownSends: string[];
  /** Turns the agent has completed since this tab connected — a turn is new content even when it ended in a tool call. */
  turns: number;
  inTurn: boolean;
  /** Messages typed while a turn ran, in order; one goes out at each turn end. */
  queued: QueuedSend[];
  /** From update_device_status: the permission mode the harness applies to this conversation right now. */
  mode?: string;
}

import type { Snooze } from "./snooze.ts";
import { askQuestions, type AskQuestion } from "./content.ts";

export interface AttentionItem extends ConversationInfo {
  /** Set by the attention hook: the deferral currently hiding this item, if any. */
  snooze?: Snooze | null;
  status: AttentionStatus;
  lastAssistantText: string | null;
  lastRole: "user" | "assistant" | null;
  pendingApproval: PendingApproval | null;
  pendingQuestion: PendingQuestion | null;
  /** Completed turns seen live; part of what makes a card "new" again. */
  turns: number;
  error: string | null;
  seenAt: string | null;
  unread: boolean;
  runtime: Runtime;
}

export const keyOf = (agentId: string, conversationId: string) => `${agentId}/${conversationId}`;
const TEXT_LIMIT = 700;

export function emptyLive(): Live {
  return { pending: null, pendingAsk: null, error: null, streamingText: "", lastAssistantText: null, lastRole: null, lastMessageAt: null, tail: [], toolsSeen: new Set(), ownSends: [], turns: 0, inTurn: false, queued: [] };
}

/**
 * Close the streaming reply: it becomes a tail row and the conversation's last
 * assistant text. The loop usually reports WAITING_ON_INPUT before stop_reason
 * or turn_finished arrive, so this is where "the agent said something new" has
 * to be recorded — Catch Up re-queues a decided card on exactly that.
 */
function settle(l: Live): void {
  const t = l.streamingText.trim();
  if (t) {
    l.tail.push({ role: "assistant", text: t });
    l.lastAssistantText = t.slice(-TEXT_LIMIT);
  }
  l.streamingText = "";
}

/** "idle" | "thinking" | "streaming" — what a chat box should show for this conversation. */
export function chatStatusOf(l: Live | undefined): "idle" | "thinking" | "streaming" {
  if (!l?.loop || l.loop === "WAITING_ON_INPUT" || l.loop === "WAITING_ON_APPROVAL") return "idle";
  return l.streamingText ? "streaming" : "thinking";
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

/**
 * The next queued message, once the turn has ended: removed from the queue and its transcript row
 * un-flagged, so the caller can send it. Null while the turn runs or when nothing waits.
 */
export function takeQueued(l: Live): QueuedSend | null {
  if (l.inTurn || l.queued.length === 0) return null;
  const next = l.queued.shift()!;
  const row = l.tail.find((r) => r.queued && r.role === "user" && r.text === next.text);
  if (row) delete row.queued;
  return next;
}

/** Drop a queued message (the user thought better of it); true when one matched. */
export function cancelQueued(l: Live, text: string): boolean {
  const i = l.queued.findIndex((q) => q.text === text);
  if (i < 0) return false;
  l.queued.splice(i, 1);
  const r = l.tail.findIndex((row) => row.queued && row.role === "user" && row.text === text);
  if (r >= 0) l.tail.splice(r, 1);
  return true;
}

/** Fold one live event into a conversation's live state. Returns true if anything changed. */
export function applyEvent(l: Live, ev: ServerEvent, now = new Date().toISOString()): { changed: boolean; userSpoke: boolean } {
  switch (ev.type) {
    case "control_request": {
      const req = ev.request as { subtype?: string; tool_name?: string; input?: unknown } | undefined;
      if (req?.subtype !== "can_use_tool") return { changed: false, userSpoke: false };
      if (req.tool_name === "AskUserQuestion") {
        // Not a permission: the agent wants answers. Rendered as a question card, answered with the input filled in.
        const questions = askQuestions(req.input);
        l.pendingAsk = { requestId: String(ev.request_id), input: req.input, questions, at: now };
        l.pending = null;
      } else {
        l.pending = { requestId: String(ev.request_id), toolName: req.tool_name ?? "tool", input: req.input, at: now };
        l.pendingAsk = null;
      }
      l.lastMessageAt = now;
      return { changed: true, userSpoke: false };
    }
    case "update_device_status": {
      const m = (ev.device_status as { current_permission_mode?: string } | undefined)?.current_permission_mode;
      if (m && m !== l.mode) {
        l.mode = m;
        return { changed: true, userSpoke: false };
      }
      return { changed: false, userSpoke: false };
    }
    case "update_loop_status": {
      const status = (ev.loop_status as { status?: string } | undefined)?.status;
      l.loop = status;
      if (status && status !== "WAITING_ON_INPUT" && status !== "WAITING_ON_APPROVAL") l.inTurn = true;
      if (status === "WAITING_ON_INPUT") {
        settle(l);
        if (l.inTurn) {
          l.turns += 1;
          l.inTurn = false;
        }
      }
      if (status && status !== "WAITING_ON_APPROVAL") {
        l.pending = null;
        l.pendingAsk = null;
      }
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
        settle(l);
        const own = l.ownSends.indexOf(text);
        if (own >= 0) l.ownSends.splice(own, 1); // shown when it was sent
        else l.tail.push({ role: "user", text });
        l.lastRole = "user";
        l.lastAssistantText = null;
        return { changed: true, userSpoke: true };
      }
      if (mt === "tool_call_message" || mt === "approval_request_message") {
        const tc = d?.tool_call as { name?: string; tool_call_id?: string } | undefined;
        if (!tc?.name) return { changed: false, userSpoke: false };
        const key = tc.tool_call_id ?? `${tc.name}:${l.tail.length}`;
        if (l.toolsSeen.has(key)) return { changed: false, userSpoke: false };
        l.toolsSeen.add(key);
        // The same call arrives as a tool_call_message and again as an approval_request_message
        // (with its own id, or none): one marker is enough.
        const last = l.tail[l.tail.length - 1];
        if (last?.role === "tool" && last.text === tc.name && !l.streamingText.trim()) return { changed: false, userSpoke: false };
        settle(l); // assistant text may resume after the tool; this closes the current bubble
        l.tail.push({ role: "tool", text: tc.name });
        return { changed: true, userSpoke: false };
      }
      if (mt === "error_message" || mt === "loop_error") {
        l.error = String((d as { message?: string })?.message ?? "the turn failed");
        return { changed: true, userSpoke: false };
      }
      if (mt === "stop_reason") {
        settle(l);
        return { changed: true, userSpoke: false };
      }
      return { changed: false, userSpoke: false };
    }
    case "turn_finished":
      settle(l);
      if (l.inTurn) {
        l.turns += 1;
        l.inTurn = false;
      }
      l.lastMessageAt = now;
      l.pending = null;
      l.pendingAsk = null;
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
    else if (l?.pendingAsk) status = "question";
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
      pendingQuestion: l?.pendingAsk ?? null,
      turns: l?.turns ?? 0,
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
