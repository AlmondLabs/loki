import { restState, type Rest } from "./rest.ts";
import { isScheduledPrompt, looksLikeQuestion, stripHarnessMarkup } from "../harness.ts";
import { ThreadModel, type Step } from "./thread.ts";
import type { Runtime } from "./protocol.ts";
import type { Attachment } from "./content.ts";
import type { ChatEngineView } from "../models.ts";
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

/** A tool call the agent is paused on until you approve or deny it (a can_use_tool request); `at` is when it was asked. */
export interface PendingApproval {
  requestId: string;
  toolName: string;
  input: unknown;
  at: string;
}

/** The agent is waiting on answers (the ask_user tool), not a permission. */
export interface PendingQuestion {
  requestId: string;
  input: unknown;
  questions: AskQuestion[];
  at: string;
}

/** One open conversation as the mod lists it (inbox_list): which agent it belongs to, its title and when it last had a message. */
export interface ConversationInfo {
  id: string;
  agent_id: string;
  agent_name: string | null;
  title: string | null;
  last_message_at: string | null;
  archived: boolean;
  /** The person's labels on the chat (plan 022), as the Inbox list carries them. */
  labels?: string[];
}

/** From the last few protocol messages of a conversation. */
export interface Digest {
  last_role: "user" | "assistant" | null;
  last_assistant_text: string | null;
  /** Who sent the last message into the conversation, so the score can tell a reply to you from a report. */
  last_ask: AskedBy | null;
}

/** A message typed mid-turn, waiting for the conversation to go idle. */
export interface QueuedSend {
  text: string;
  /** Images and uploaded files; they are split when it goes out. */
  images: Attachment[];
  /** The chat's name when it was typed; its environment note is decided when it goes out. */
  desk?: string | null;
  /** The chat's labels when it was typed (plan 022), for the same note. */
  labels?: readonly string[] | null;
}

/** What the live half knows of one conversation beyond its listing, folded from the daemon's chat events while this client is subscribed: its loop, pending approval or question, last words, thread and queued messages. */
export interface Live {
  /** Where the chat's loop is, as loki's daemon says: running a turn, idle, or waiting on an approval. */
  loop?: "running" | "idle" | "approval";
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
  /** The turn running, or the last one that ran, as the daemon names it: what the app's analytics join turns by. */
  turnId?: string;
  /** Messages typed while a turn ran, in order; one goes out at each turn end. */
  queued: QueuedSend[];
  /** From update_device_status: the permission mode the harness applies to this conversation right now. */
  mode?: string;
  /** From update_device_status: the folder the conversation works in right now. */
  cwd?: string;
  /** The ACP agent the chat runs on, with its modes and commands (plan 020); absent on loki's own engine. */
  engine?: ChatEngineView | null;
}

import { askQuestions, type AskQuestion } from "./content.ts";

/** One card of the Inbox: a conversation with its status, what it last said, what it waits on, and its stamped score. */
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
  /** Rested by Next and not due back yet (rest.ts): the Inbox leaves it out until it is, or something new comes. */
  resting?: boolean;
  /** The rung its last rest left it on while nothing new came (rest.ts), for the Inbox's analytics. */
  rung?: number;
  /** Back from a rest that ended with nothing new (rest.ts), for the Inbox's analytics. */
  rested?: boolean;
  runtime: Runtime;
}

/** The key a chat goes by in the maps of live state, seen markers and focus: "agentId/conversationId". */
export const keyOf = (agentId: string, conversationId: string) => `${agentId}/${conversationId}`;

/**
 * Whether an event answers a folder change under way (useAttention changeFolder), read after the event was folded
 * in: "moved" when a device status shows the new folder (or, the folder before being known, any other), the
 * error's words when the daemon refused it, null when the event says nothing about it.
 */
export function folderMoveAnswer(
  events: ChatEvent[],
  cwd: string | undefined,
  move: { from: string | undefined; to: string },
): "moved" | { error: string } | null {
  for (const e of events) {
    if (e.kind === "device") return cwd && (cwd === move.to || (move.from !== undefined && cwd !== move.from)) ? "moved" : null;
    if (e.kind === "error") return { error: e.message || "the folder did not change" };
  }
  return null;
}
const TEXT_LIMIT = 700;

/**
 * A conversation's live state, its thread inside. A reply settling into the thread is where "the agent said something
 * new" is recorded: the loop may report idle before the turn's end arrives, and Catch Up
 * re-queues a decided card on exactly that.
 */
export function emptyLive(): Live {
  const l: Live = {
    pending: null,
    pendingAsk: null,
    error: null,
    lastAssistantText: null,
    lastRole: null,
    lastMessageAt: null,
    lastAsk: null,
    thread: new ThreadModel((text) => (l.lastAssistantText = text.slice(-TEXT_LIMIT))),
    turns: 0,
    inTurn: false,
    queued: [],
  };
  return l;
}

/** "idle" | "thinking" | "streaming" — what a chat box should show for this conversation. */
export function chatStatusOf(l: Live | undefined): "idle" | "thinking" | "streaming" {
  if (l?.loop !== "running") return "idle";
  return l.thread.streaming ? "streaming" : "thinking";
}

/**
 * How a message the person sends now leaves (plan 025): at once to an idle chat; at once into the running turn on
 * loki's own engine, which places it after the current tool round; or, on an agent (ACP), which takes one prompt at a
 * time, queued until the turn ends.
 */
export function sendMode(l: Pick<Live, "inTurn" | "engine">): "now" | "steer" | "queue" {
  if (!l.inTurn) return "now";
  return l.engine ? "queue" : "steer";
}

/**
 * The next queued message, once the turn has ended: removed from the queue and its transcript row
 * un-flagged, so the caller can send it. Null while the turn runs or when nothing waits.
 */
export function takeQueued(l: Live, now = new Date().toISOString()): QueuedSend | null {
  if (l.inTurn) return null;
  const next = l.queued.shift();
  if (!next) return null;
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

/**
 * What happens in a chat while it runs, in loki's own words (plan 017, U5): the daemon pushes these over the mod's
 * socket, and one function folds them into a chat's live state. (The tests write Letta's events in this shape too,
 * test/fixtures/letta-events.ts.)
 */
export type ChatEvent =
  /** The agent asks to run a tool. */
  | { kind: "approval"; request_id: string; tool_name: string; input: unknown }
  /** The agent asks you questions (a question card), answered with the input filled in. */
  | { kind: "question"; request_id: string; input: unknown }
  /** The chat's permission mode, folder or engine, as the backend has them now. */
  | { kind: "device"; mode?: string; cwd?: string; engine?: ChatEngineView | null }
  /** Whether the chat is running, idle, or waiting on an approval; `detail` is the backend's own word for it. */
  | { kind: "loop"; state: "running" | "idle" | "approval"; detail?: string; turn_id?: string }
  /** A piece of the thread: a message, a streamed piece of the reply, a call, an approval, a result. */
  | { kind: "step"; step: Step }
  /** The turn failed. */
  | { kind: "error"; message: string }
  /** A slash command started or answered. */
  | { kind: "command"; phase: "start" | "end"; input: string; output?: string; success?: boolean }
  /** The reply in progress is complete. */
  | { kind: "settle" }
  /** The answer in flight as written so far, for a client that starts listening mid-answer: the stream starts from it. */
  | { kind: "streaming"; text: string; at: string | null }
  /** The turn ended. */
  | { kind: "turn_end"; turn_id?: string };

/** Fold one chat event into a conversation's live state. Returns whether anything changed, and whether you spoke. */
export function applyChatEvent(l: Live, e: ChatEvent, now = new Date().toISOString()): { changed: boolean; userSpoke: boolean } {
  switch (e.kind) {
    case "approval":
      l.pending = { requestId: e.request_id, toolName: e.tool_name, input: e.input, at: now };
      l.pendingAsk = null;
      l.lastMessageAt = now;
      return { changed: true, userSpoke: false };
    case "question":
      l.pendingAsk = { requestId: e.request_id, input: e.input, questions: askQuestions(e.input), at: now };
      l.pending = null;
      l.lastMessageAt = now;
      return { changed: true, userSpoke: false };
    case "device": {
      let changed = false;
      if (e.mode && e.mode !== l.mode) {
        l.mode = e.mode;
        changed = true;
      }
      if (e.cwd && e.cwd !== l.cwd) {
        l.cwd = e.cwd;
        changed = true;
      }
      if (e.engine !== undefined && JSON.stringify(e.engine) !== JSON.stringify(l.engine ?? null)) {
        l.engine = e.engine;
        changed = true;
      }
      return { changed, userSpoke: false };
    }
    case "loop": {
      // A backend may repeat a status (Letta said WAITING_ON_INPUT for every idle conversation every few seconds): a
      // repeat that moves nothing is no change, so nothing re-renders on it.
      const before = [l.loop, l.inTurn, l.turns, l.pending, l.pendingAsk, l.error, l.thread.revision];
      l.loop = e.state;
      if (e.turn_id) l.turnId = e.turn_id;
      if (e.state === "running") l.inTurn = true;
      if (e.state === "idle") {
        l.thread.settle(now);
        if (l.inTurn) {
          l.turns += 1;
          l.inTurn = false;
        }
      }
      if (e.state !== "approval") {
        l.pending = null;
        l.pendingAsk = null;
      }
      if (e.state === "running") l.error = null;
      const after = [l.loop, l.inTurn, l.turns, l.pending, l.pendingAsk, l.error, l.thread.revision];
      return { changed: after.some((v, i) => v !== before[i]), userSpoke: false };
    }
    case "step": {
      const { changed, spoke } = l.thread.apply(e.step);
      if (e.step.kind === "assistant") {
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
    case "error":
      l.error = e.message;
      return { changed: true, userSpoke: false };
    case "command":
      if (e.phase === "start") l.thread.beginCommand(e.input, now);
      else l.thread.finishCommand(e.input, e.success !== false, e.output ?? "", now);
      return { changed: true, userSpoke: false };
    case "settle":
      l.thread.settle(now);
      return { changed: true, userSpoke: false };
    case "streaming":
      return { changed: l.thread.resume(e.text, e.at), userSpoke: false };
    case "turn_end":
      if (e.turn_id) l.turnId = e.turn_id;
      l.thread.settle(now);
      if (l.inTurn) {
        l.turns += 1;
        l.inTurn = false;
      }
      l.lastMessageAt = now;
      l.pending = null;
      l.pendingAsk = null;
      return { changed: true, userSpoke: false };
  }
}

const instant = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.NaN);

/**
 * Something came since you last looked: unread (not done) with a last message newer than the last look.
 * With no time to compare, it stays new. The desk sidebar's bold follows this; the Inbox follows `unread`.
 */
export function unviewed(item: Pick<AttentionItem, "unread" | "last_message_at" | "viewedAt">): boolean {
  if (!item.unread) return false;
  const last = instant(item.last_message_at),
    looked = instant(item.viewedAt);
  return !(Number.isFinite(last) && Number.isFinite(looked) && looked >= last);
}

/**
 * The look to send while a conversation is open on screen, as a stamp ("<key>@<last message time>") so a
 * host sends one viewed_mark per new last message; null when there is nothing new to look at.
 */
export function viewStamp(item: Pick<AttentionItem, "agent_id" | "id" | "unread" | "last_message_at" | "viewedAt"> | null | undefined): string | null {
  if (!item?.last_message_at || !unviewed(item)) return null;
  return `${keyOf(item.agent_id, item.id)}@${item.last_message_at}`;
}

/**
 * Combine everything into the item list, each item stamped with its score and reason at `now` and the
 * list ordered highest first (priority.ts): blocked agents, then the chats you have been engaging with
 * (`focus`, each chat's share by "agentId/conversationId"), then the rest by age. `rests` (rest.ts) marks the
 * cards Next has rested, which the Inbox leaves out until they are due.
 */
export function buildItems(
  conversations: ConversationInfo[],
  digests: Map<string, Digest>,
  live: Map<string, Live>,
  seen: Record<string, string>,
  now = Date.now(),
  viewed: Record<string, string> = {},
  focus: Record<string, number> = {},
  rests: Record<string, Rest> = {},
): AttentionItem[] {
  const out: Unscored[] = [];
  for (const c of conversations) {
    const key = keyOf(c.agent_id, c.id);
    const d = digests.get(key);
    const l = live.get(key);
    const lastMessageAt = [c.last_message_at, l?.lastMessageAt].filter(Boolean).sort().pop() ?? null;
    const lastRole = l?.lastRole ?? d?.last_role ?? null;
    const lastAssistantText = l?.lastAssistantText ?? d?.last_assistant_text ?? null;
    const seenAt = seen[key] ?? null;
    const unread = !!lastMessageAt && lastRole === "assistant" && (!seenAt || seenAt < lastMessageAt);
    let status: AttentionStatus = "idle";
    if (l?.pending) status = "approval";
    else if (l?.pendingAsk) status = "question";
    else if (l?.error && unread) status = "failed";
    else if (l?.loop === "running") status = "running";
    // A reply that only reads like a question waits on you until you have looked at it; a real ask (above) until answered.
    else if (unread && looksLikeQuestion(lastAssistantText) && unviewed({ unread, last_message_at: lastMessageAt, viewedAt: viewed[key] ?? null }))
      status = "question";
    else if (unread) status = "done";
    out.push({
      ...c,
      status,
      last_message_at: lastMessageAt,
      lastAssistantText: lastAssistantText ? stripHarnessMarkup(lastAssistantText).trim().slice(-TEXT_LIMIT) : null,
      lastRole,
      pendingApproval: l?.pending ?? null,
      pendingQuestion: l?.pendingAsk ?? null,
      turns: l?.turns ?? 0,
      error: l?.error ?? null,
      seenAt,
      unread,
      viewedAt: viewed[key] ?? null,
      lastAsk: l?.lastAsk ?? d?.last_ask ?? null,
      runtime: { agent_id: c.agent_id, conversation_id: c.id },
    });
  }
  return scored(out, now, focus).map((i) => {
    const key = keyOf(i.agent_id, i.id);
    return key in rests ? { ...i, ...restState(i, rests[key], now) } : i;
  });
}
