import { isScheduledPrompt, looksLikeQuestion, protocolStep, stripHarnessMarkup } from "../harness.ts";
import { ThreadModel } from "./thread.ts";
import type { Runtime, ServerEvent } from "./protocol.ts";
import type { Attachment } from "./content.ts";
import { scored, type AskedBy, type Reason, type Unscored } from "./priority.ts";

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
  /** Who sent the last message into the conversation, so the score can tell a reply to you from a report. */
  lastAsk: AskedBy | null;
}

/** A message typed mid-turn, waiting for the conversation to go idle. */
export interface QueuedSend {
  text: string;
  /** Images and uploaded files; they are split when it goes out. */
  images: Attachment[];
  /** The chat's name when it was typed; its environment note is decided when it goes out. */
  desk?: string | null;
}

export interface Live {
  loop?: string;
  pending: PendingApproval | null;
  pendingAsk: PendingQuestion | null;
  error: string | null;
  lastAssistantText: string | null;
  lastRole: "user" | "assistant" | null;
  lastMessageAt: string | null;
  /** Who sent the last user message seen live: a person, or a schedule. */
  lastAsk: AskedBy | null;
  /** The conversation's thread: its rows, loaded and live (thread.ts). */
  thread: ThreadModel;
  /** Turns the agent has completed since this tab connected — a turn is new content even when it ended in a tool call. */
  turns: number;
  inTurn: boolean;
  /** Messages typed while a turn ran, in order; one goes out at each turn end. */
  queued: QueuedSend[];
  /** From update_device_status: the permission mode the harness applies to this conversation right now. */
  mode?: string;
  /** From update_device_status: the folder the conversation works in right now. */
  cwd?: string;
}

import { askQuestions, type AskQuestion } from "./content.ts";

export interface AttentionItem extends ConversationInfo {
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
  /** When you last looked at it (the mod's viewed marker): a look is not done, so it never clears `unread`. */
  viewedAt: string | null;
  /** Who sent the last message into the conversation (live if seen, else from the log); null when unknown. */
  lastAsk: AskedBy | null;
  /** The card's place in the list, stamped by buildItems at one instant for every item (priority.ts). */
  score: number;
  /** The one word that explains the score: what the card shows after its time. */
  reason: Reason;
  /** The chat's share of your recent engagement, 0 to 1 (focus.ts), as scored. */
  focus: number;
  runtime: Runtime;
}

export const keyOf = (agentId: string, conversationId: string) => `${agentId}/${conversationId}`;

/**
 * Whether an event answers a folder change under way (useAttention changeFolder), read after the event was folded
 * in: "moved" when a device status shows the new folder (or, the folder before being known, any other), the
 * error's words when Letta Code refused it with a loop error, null when the event says nothing about it.
 */
export function folderMoveAnswer(ev: ServerEvent, cwd: string | undefined, move: { from: string | undefined; to: string }): "moved" | { error: string } | null {
  if (ev.type === "update_device_status") return cwd && (cwd === move.to || (move.from !== undefined && cwd !== move.from)) ? "moved" : null;
  const d = ev.type === "stream_delta" ? (ev.delta as { message_type?: string; message?: string } | undefined) : undefined;
  if (d?.message_type === "loop_error" || d?.message_type === "error_message") return { error: String(d.message ?? "the folder did not change") };
  return null;
}
const TEXT_LIMIT = 700;

/**
 * A conversation's live state, its thread inside. A reply settling into the thread is where "the agent said something
 * new" is recorded: the loop usually reports WAITING_ON_INPUT before stop_reason or turn_finished arrive, and Catch Up
 * re-queues a decided card on exactly that.
 */
export function emptyLive(): Live {
  const l: Live = { pending: null, pendingAsk: null, error: null, lastAssistantText: null, lastRole: null, lastMessageAt: null, lastAsk: null, thread: new ThreadModel((text) => (l.lastAssistantText = text.slice(-TEXT_LIMIT))), turns: 0, inTurn: false, queued: [] };
  return l;
}

/** "idle" | "thinking" | "streaming" — what a chat box should show for this conversation. */
export function chatStatusOf(l: Live | undefined): "idle" | "thinking" | "streaming" {
  if (!l?.loop || l.loop === "WAITING_ON_INPUT" || l.loop === "WAITING_ON_APPROVAL") return "idle";
  return l.thread.streaming ? "streaming" : "thinking";
}

/**
 * The next queued message, once the turn has ended: removed from the queue and its transcript row
 * un-flagged, so the caller can send it. Null while the turn runs or when nothing waits.
 */
export function takeQueued(l: Live, now = new Date().toISOString()): QueuedSend | null {
  if (l.inTurn || l.queued.length === 0) return null;
  const next = l.queued.shift()!;
  l.thread.unqueue(next.text, now); // its time is when it went out, not when it was typed
  return next;
}

/** Drop a queued message (the user thought better of it); true when one matched. */
export function cancelQueued(l: Live, text: string): boolean {
  const i = l.queued.findIndex((q) => q.text === text);
  if (i < 0) return false;
  l.queued.splice(i, 1);
  l.thread.dropQueued(text);
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
      const status = ev.device_status as { current_permission_mode?: string; current_working_directory?: string } | undefined;
      const m = status?.current_permission_mode;
      const cwd = status?.current_working_directory;
      let changed = false;
      if (m && m !== l.mode) {
        l.mode = m;
        changed = true;
      }
      if (cwd && cwd !== l.cwd) {
        l.cwd = cwd;
        changed = true;
      }
      return { changed, userSpoke: false };
    }
    case "update_loop_status": {
      const status = (ev.loop_status as { status?: string } | undefined)?.status;
      // The harness repeats a status (WAITING_ON_INPUT on every idle conversation, every few seconds): a repeat
      // that moves nothing is no change, so nothing re-renders on it.
      const before = [l.loop, l.inTurn, l.turns, l.pending, l.pendingAsk, l.error, l.thread.revision];
      l.loop = status;
      if (status && status !== "WAITING_ON_INPUT" && status !== "WAITING_ON_APPROVAL") l.inTurn = true;
      if (status === "WAITING_ON_INPUT") {
        l.thread.settle(now);
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
      const after = [l.loop, l.inTurn, l.turns, l.pending, l.pendingAsk, l.error, l.thread.revision];
      return { changed: after.some((v, i) => v !== before[i]), userSpoke: false };
    }
    case "stream_delta": {
      const d = ev.delta as Record<string, unknown> | undefined;
      const mt = d?.message_type;
      const step = protocolStep(d, now, true);
      if (step) {
        const { changed, spoke } = l.thread.apply(step);
        if (step.kind === "assistant") {
          l.lastRole = "assistant";
          l.lastMessageAt = now;
          return { changed: true, userSpoke: false }; // the agent spoke, even with nothing to show yet
        }
        if (spoke === null) return { changed, userSpoke: false };
        l.lastAsk = isScheduledPrompt(spoke) ? "schedule" : "person";
        l.lastRole = "user";
        l.lastAssistantText = null;
        return { changed: true, userSpoke: true };
      }
      if (mt === "error_message" || mt === "loop_error") {
        l.error = String((d as { message?: string })?.message ?? "the turn failed");
        return { changed: true, userSpoke: false };
      }
      if (mt === "slash_command_start" || mt === "slash_command_end") {
        const c = d as { command_id?: string; input?: string; output?: string; success?: boolean };
        const input = typeof c.input === "string" && c.input ? c.input : `/${c.command_id ?? "command"}`;
        if (mt === "slash_command_start") l.thread.beginCommand(input, now);
        else l.thread.finishCommand(input, c.success !== false, typeof c.output === "string" ? c.output : "", now);
        return { changed: true, userSpoke: false };
      }
      if (mt === "stop_reason") {
        l.thread.settle(now);
        return { changed: true, userSpoke: false };
      }
      return { changed: false, userSpoke: false };
    }
    case "turn_finished":
      l.thread.settle(now);
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

const instant = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.NaN);

/**
 * Something came since you last looked: unread (not done) with a last message newer than the last look.
 * With no time to compare, it stays new. The desk sidebar's bold follows this; the Inbox follows `unread`.
 */
export function unviewed(item: Pick<AttentionItem, "unread" | "lastMessageAt" | "viewedAt">): boolean {
  if (!item.unread) return false;
  const last = instant(item.lastMessageAt), looked = instant(item.viewedAt);
  return !(Number.isFinite(last) && Number.isFinite(looked) && looked >= last);
}

/**
 * The look to send while a conversation is open on screen, as a stamp ("<key>@<last message time>") so a
 * host sends one viewed_mark per new last message; null when there is nothing new to look at.
 */
export function viewStamp(item: Pick<AttentionItem, "agentId" | "id" | "unread" | "lastMessageAt" | "viewedAt"> | null | undefined): string | null {
  if (!item?.lastMessageAt || !unviewed(item)) return null;
  return `${keyOf(item.agentId, item.id)}@${item.lastMessageAt}`;
}

/**
 * Combine everything into the item list, each item stamped with its score and reason at `now` and the
 * list ordered highest first (priority.ts): blocked agents, then the chats you have been engaging with
 * (`focus`, each chat's share by "agentId/conversationId"), then the rest by age.
 */
export function buildItems(
  conversations: ConversationInfo[],
  digests: Map<string, Digest>,
  live: Map<string, Live>,
  seen: Record<string, string>,
  now = Date.now(),
  viewed: Record<string, string> = {},
  focus: Record<string, number> = {},
): AttentionItem[] {
  const out: Unscored[] = [];
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
      viewedAt: viewed[key] ?? null,
      lastAsk: l?.lastAsk ?? d?.lastAsk ?? null,
      runtime: { agent_id: c.agentId, conversation_id: c.id },
    });
  }
  return scored(out, now, focus);
}
