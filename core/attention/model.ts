import { extractHarnessEvents, isScheduledPrompt, looksLikeQuestion, messageText, stripHarnessMarkup } from "../harness.ts";
import type { Runtime, ServerEvent } from "./protocol.ts";
import type { ImageAttachment } from "./content.ts";
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

export interface LiveRow {
  /** event: harness machinery folded into a user message (desk activity, a loaded skill, a task result). */
  role: "user" | "assistant" | "tool" | "event";
  text: string;
  summary?: string | null;
  detail?: string | null;
  images?: string[];
  /** Typed while the turn ran: shown in the transcript, sent when the turn ends. */
  queued?: boolean;
  /** When the row arrived (ISO), the same field as TranscriptRow.at. */
  at?: string;
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
  /** When the streaming reply began: the time its row keeps once it settles. */
  streamingAt: string | null;
  lastAssistantText: string | null;
  lastRole: "user" | "assistant" | null;
  lastMessageAt: string | null;
  /** Who sent the last user message seen live: a person, or a schedule. */
  lastAsk: AskedBy | null;
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
  /** Who sent the last message into the conversation (live if seen, else from the log); null when unknown. */
  lastAsk: AskedBy | null;
  /** The card's place in the list, stamped by buildItems at one instant for every item (priority.ts). */
  score: number;
  /** The one word that explains the score: what the card shows after its time. */
  reason: Reason;
  runtime: Runtime;
}

export const keyOf = (agentId: string, conversationId: string) => `${agentId}/${conversationId}`;
const TEXT_LIMIT = 700;

export function emptyLive(): Live {
  return { pending: null, pendingAsk: null, error: null, streamingText: "", streamingAt: null, lastAssistantText: null, lastRole: null, lastMessageAt: null, lastAsk: null, tail: [], toolsSeen: new Set(), ownSends: [], turns: 0, inTurn: false, queued: [] };
}

/**
 * Close the streaming reply: it becomes a tail row and the conversation's last
 * assistant text. The loop usually reports WAITING_ON_INPUT before stop_reason
 * or turn_finished arrive, so this is where "the agent said something new" has
 * to be recorded — Catch Up re-queues a decided card on exactly that.
 */
function settle(l: Live, now = new Date().toISOString()): void {
  const t = l.streamingText.trim();
  if (t) {
    l.tail.push({ role: "assistant", text: t, at: l.streamingAt ?? now });
    l.lastAssistantText = t.slice(-TEXT_LIMIT);
  }
  l.streamingText = "";
  l.streamingAt = null;
}

const RUNNING = "running…";

/** A slash command has started: one quiet row with the command line, marked running until its end arrives. */
export function beginCommand(l: Live, input: string, now = new Date().toISOString()): void {
  settle(l, now);
  l.tail.push({ role: "event", text: input, summary: RUNNING, at: now });
}

/** The command a row's text names: "/reload", "reload", "/compact all" → "reload", "reload", "compact". */
export function commandIdOf(input: string): string {
  return input.trim().replace(/^\//, "").split(/\s+/)[0]?.toLowerCase() ?? "";
}

/**
 * The running row a finish belongs to: the newest with the same text, else the newest naming the same
 * command. The harness writes the command line its own way in its start delta ("reload", say) while the
 * app finishes with what it sent ("/reload"); matched by text alone the row would spin forever.
 */
function runningRow(l: Live, input: string): LiveRow | undefined {
  const id = commandIdOf(input);
  let byId: LiveRow | undefined;
  for (let i = l.tail.length - 1; i >= 0; i--) {
    const r = l.tail[i];
    if (r.role !== "event" || r.summary !== RUNNING) continue;
    if (r.text === input) return r;
    if (!byId && commandIdOf(r.text) === id) byId = r;
  }
  return byId;
}

/**
 * A slash command finished: the running row (or a fresh one, if the start was never seen) gets the
 * outcome — a one-line output inline, a longer one behind the disclosure, "failed" when it did not work.
 */
export function finishCommand(l: Live, input: string, success: boolean, output: string, now = new Date().toISOString()): void {
  const text = output.trim();
  const lines = text.split("\n");
  const oneLine = lines.length === 1 && text.length <= 90;
  const summary = !success ? "failed" : oneLine ? text || "done" : "done";
  const detail = !oneLine && text ? text : !success && text && !oneLine ? text : null;
  const row = runningRow(l, input);
  if (row) {
    row.summary = summary;
    row.detail = detail;
  } else l.tail.push({ role: "event", text: input, summary, detail, at: now });
}

/** True while a slash command's row is still waiting for its end. */
export function commandRunning(l: Live, input: string): boolean {
  return runningRow(l, input) !== undefined;
}

/**
 * The link to the app-server came back after dropping: a command still marked running lost its answer
 * with the old link, and nothing else will ever finish it. For /reload that is the success case — the
 * reload is what took the link down. Returns true when a row changed.
 */
export function settleCommands(l: Live): boolean {
  let changed = false;
  for (const r of l.tail) {
    if (r.role !== "event" || r.summary !== RUNNING) continue;
    if (commandIdOf(r.text) === "reload") {
      r.summary = "reloaded — the mod restarted and the link is back";
      r.detail = null;
    } else {
      r.summary = "failed";
      r.detail = "the link to the app-server dropped while this ran; its answer was lost";
    }
    changed = true;
  }
  return changed;
}

/** "idle" | "thinking" | "streaming" — what a chat box should show for this conversation. */
export function chatStatusOf(l: Live | undefined): "idle" | "thinking" | "streaming" {
  if (!l?.loop || l.loop === "WAITING_ON_INPUT" || l.loop === "WAITING_ON_APPROVAL") return "idle";
  return l.streamingText ? "streaming" : "thinking";
}

/**
 * The next queued message, once the turn has ended: removed from the queue and its transcript row
 * un-flagged, so the caller can send it. Null while the turn runs or when nothing waits.
 */
export function takeQueued(l: Live, now = new Date().toISOString()): QueuedSend | null {
  if (l.inTurn || l.queued.length === 0) return null;
  const next = l.queued.shift()!;
  const row = l.tail.find((r) => r.queued && r.role === "user" && r.text === next.text);
  if (row) {
    delete row.queued;
    row.at = now; // its time is when it went out, not when it was typed
  }
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
        settle(l, now);
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
        if (!l.streamingText) l.streamingAt = now;
        l.streamingText += messageText(d?.content);
        l.lastRole = "assistant";
        l.lastMessageAt = now;
        return { changed: true, userSpoke: false };
      }
      if (mt === "user_message") {
        const raw = messageText(d?.content);
        // Harness machinery in the message (desk activity, a loaded skill, a task result) is its own quiet row.
        const events = extractHarnessEvents(raw);
        for (const ev of events) l.tail.push({ role: "event", text: ev.text, summary: ev.summary, detail: ev.detail, at: now });
        const text = stripHarnessMarkup(raw).trim();
        if (!text) return { changed: events.length > 0, userSpoke: false };
        l.lastAsk = isScheduledPrompt(text) ? "schedule" : "person";
        settle(l, now);
        const own = l.ownSends.indexOf(text);
        if (own >= 0) l.ownSends.splice(own, 1); // shown when it was sent
        else l.tail.push({ role: "user", text, at: now });
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
        settle(l, now); // assistant text may resume after the tool; this closes the current bubble
        l.tail.push({ role: "tool", text: tc.name, at: now });
        return { changed: true, userSpoke: false };
      }
      if (mt === "error_message" || mt === "loop_error") {
        l.error = String((d as { message?: string })?.message ?? "the turn failed");
        return { changed: true, userSpoke: false };
      }
      if (mt === "slash_command_start" || mt === "slash_command_end") {
        const c = d as { command_id?: string; input?: string; output?: string; success?: boolean };
        const input = typeof c.input === "string" && c.input ? c.input : `/${c.command_id ?? "command"}`;
        if (mt === "slash_command_start") beginCommand(l, input, now);
        else finishCommand(l, input, c.success !== false, typeof c.output === "string" ? c.output : "", now);
        return { changed: true, userSpoke: false };
      }
      if (mt === "stop_reason") {
        settle(l, now);
        return { changed: true, userSpoke: false };
      }
      return { changed: false, userSpoke: false };
    }
    case "turn_finished":
      settle(l, now);
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

/**
 * Combine everything into the item list, each item stamped with its score and reason at `now` and the
 * list ordered highest first (priority.ts): blocked agents, then warm replies to you, then colder ones,
 * then reports.
 */
export function buildItems(
  conversations: ConversationInfo[],
  digests: Map<string, Digest>,
  live: Map<string, Live>,
  seen: Record<string, string>,
  now = Date.now(),
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
      lastAsk: l?.lastAsk ?? d?.lastAsk ?? null,
      runtime: { agent_id: c.agentId, conversation_id: c.id },
    });
  }
  return scored(out, now);
}
