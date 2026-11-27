import type { SubagentView } from "../subagents.ts";
import { isMainChat } from "../canvas-core.ts";
import { restState, type Rest } from "./rest.ts";
import { isScheduledPrompt, looksLikeQuestion, stripHarnessMarkup } from "../harness.ts";
import { ThreadModel, type Step } from "./thread.ts";
import type { Runtime } from "./protocol.ts";
import type { Attachment } from "./content.ts";
import type { ChatEngineView } from "../models.ts";
import type { AccountProvider, OutsideFacts, ReplyProposal, Suggestion } from "../frame-types.ts";
import type { ChatLink } from "../chat-links.ts";
import { scored, type AskedBy, type Reason, type Unscored } from "./priority.ts";

export type AttentionStatus = "approval" | "question" | "done" | "failed" | "running" | "idle";

export interface PendingApproval {
  requestId: string;
  toolName: string;
  input: unknown;
  allowAlways?: boolean;
  at: string;
}

export const NEVER_ALWAYS_TOOLS: ReadonlySet<string> = new Set(["codemode"]);

export const offersAlways = (approval: Pick<PendingApproval, "toolName" | "allowAlways">): boolean =>
  approval.allowAlways !== false && !NEVER_ALWAYS_TOOLS.has(approval.toolName);

export interface PendingQuestion {
  requestId: string;
  input: unknown;
  questions: AskQuestion[];
  at: string;
}

export interface ConversationInfo {
  id: string;
  agent_id: string;
  agent_name: string | null;
  title: string | null;
  last_message_at: string | null;
  archived: boolean;
  labels?: string[];
  purpose?: string | null;
  has_draft?: boolean;
  draft_text?: string | null;
  cwd?: string | null;
  reply_proposals?: ReplyProposal[];
  kind?: "outside";
  outside?: OutsideFacts;
  home?: string;
}

export interface Digest {
  last_role: "user" | "assistant" | null;
  last_assistant_text: string | null;
  last_ask: AskedBy | null;
}

export interface QueuedSend {
  text: string;
  images: Attachment[];
  desk?: string | null;
  labels?: readonly string[] | null;
}

export interface Live {
  loop?: "running" | "idle" | "approval";
  pending: PendingApproval | null;
  pendingAsk: PendingQuestion | null;
  error: string | null;
  lastAssistantText: string | null;
  lastRole: "user" | "assistant" | null;
  lastMessageAt: string | null;
  lastAsk: AskedBy | null;
  thread: ThreadModel;
  turns: number;
  inTurn: boolean;
  queued: QueuedSend[];
  mode?: string;
  cwd?: string;
  engine?: ChatEngineView | null;
  suggestions: Suggestion[];
  replyProposals: ReplyProposal[] | null;
  links?: ChatLink[];
  subagents?: SubagentView[];
}

import { askQuestions, type AskQuestion } from "./content.ts";

export interface AttentionItem extends ConversationInfo {
  status: AttentionStatus;
  lastAssistantText: string | null;
  lastRole: "user" | "assistant" | null;
  pendingApproval: PendingApproval | null;
  pendingQuestion: PendingQuestion | null;
  error: string | null;
  seenAt: string | null;
  unread: boolean;
  viewedAt: string | null;
  lastAsk: AskedBy | null;
  score: number;
  reason: Reason;
  focus: number;
  resting?: boolean;
  rung?: number;
  rested?: boolean;
  runtime: Runtime;
}

export const ownerAgentOf = (i: Pick<AttentionItem, "agent_id" | "outside">): string => i.outside?.owner_agent_id ?? i.agent_id;

export const OUTSIDE_ENDS: Record<AccountProvider, { archive: boolean; handoff: boolean }> = {
  gmail: { archive: true, handoff: true },
  slack: { archive: true, handoff: true },
  jira: { archive: false, handoff: false },
};

export const archivable = (item: Pick<AttentionItem, "id" | "outside">): boolean =>
  item.outside ? OUTSIDE_ENDS[item.outside.provider].archive : !isMainChat(item.id);

export const keyOf = (agentId: string, conversationId: string) => `${agentId}/${conversationId}`;

export function senderKeyOf(o: Pick<OutsideFacts, "account_id" | "sender_address">): { agentId: string; conversationId: string } | null {
  return o.sender_address ? { agentId: `account:${o.account_id}`, conversationId: `sender:${o.sender_address.toLowerCase()}` } : null;
}

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
    suggestions: [],
    replyProposals: null,
  };
  return l;
}

export function chatStatusOf(l: Live | undefined): "idle" | "thinking" | "streaming" {
  if (l?.loop !== "running") return "idle";
  return l.thread.streaming ? "streaming" : "thinking";
}

export function faceOf(l: Live): readonly unknown[] {
  return [
    l.loop,
    l.inTurn,
    l.turns,
    l.pending,
    l.pendingAsk,
    l.error,
    l.lastRole,
    l.lastMessageAt,
    l.lastAssistantText,
    l.lastAsk,
    l.mode,
    l.cwd,
    l.engine,
    l.suggestions,
    l.replyProposals,
    l.links,
    l.subagents,
    l.thread.streaming,
  ];
}

export function sendMode(l: Pick<Live, "inTurn" | "engine">): "now" | "steer" | "queue" {
  if (!l.inTurn) return "now";
  return l.engine ? "queue" : "steer";
}

export function takeQueued(l: Live, now = new Date().toISOString()): QueuedSend | null {
  if (l.inTurn) return null;
  const next = l.queued.shift();
  if (!next) return null;
  l.thread.unqueue(next.text, now);
  return next;
}

export function cancelQueued(l: Live, text: string): boolean {
  const i = l.queued.findIndex((q) => q.text === text);
  if (i < 0) return false;
  l.queued.splice(i, 1);
  l.thread.dropQueued(text);
  return true;
}

export type ChatEvent =
  /** The agent asks to run a tool. */
  | { kind: "approval"; request_id: string; tool_name: string; input: unknown; allow_always?: boolean }
  /** The agent asks you questions (a question card), answered with the input filled in. */
  | { kind: "question"; request_id: string; input: unknown }
  /** The chat's permission mode, folder or engine, as the backend has them now. */
  | { kind: "device"; mode?: string; cwd?: string; engine?: ChatEngineView | null }
  /** Whether the chat is running, idle, or waiting on an approval. */
  | { kind: "loop"; state: "running" | "idle" | "approval" }
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
  | { kind: "turn_end" }
  /** The chat's open suggestions (plan 049), whole, on every change to any of them: the screen shows exactly these. */
  | { kind: "suggestions"; suggestions: Suggestion[] }
  /** The chat's open reply proposals (plan 067, KTD9), whole, on every change to any of them. */
  | { kind: "reply_proposals"; proposals: ReplyProposal[] }
  /** The chat's live links to other chats (plan 067), whole, on every change to any of them. */
  | { kind: "links"; links: ChatLink[] }
  /** This chat's helper subagents, whole, on every change. */
  | { kind: "subagents"; subagents: SubagentView[] };

export function applyChatEvent(l: Live, e: ChatEvent, now = new Date().toISOString()): { changed: boolean; userSpoke: boolean } {
  switch (e.kind) {
    case "approval":
      l.pending = {
        requestId: e.request_id,
        toolName: e.tool_name,
        input: e.input,
        ...(e.allow_always !== undefined ? { allowAlways: e.allow_always } : {}),
        at: now,
      };
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
      const before = [l.loop, l.inTurn, l.turns, l.pending, l.pendingAsk, l.error, l.thread.revision];
      l.loop = e.state;
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
      const starts = e.step.kind === "assistant" && (!e.step.chunk || !l.thread.streaming);
      const { changed, spoke } = l.thread.apply(e.step);
      if (e.step.kind === "assistant") {
        l.lastRole = "assistant";
        if (starts) l.lastMessageAt = now;
        return { changed: true, userSpoke: false };
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
    case "suggestions":
      l.suggestions = e.suggestions;
      return { changed: true, userSpoke: false };
    case "reply_proposals":
      l.replyProposals = e.proposals;
      return { changed: true, userSpoke: false };
    case "links":
      l.links = e.links;
      return { changed: true, userSpoke: false };
    case "subagents":
      l.subagents = e.subagents;
      return { changed: true, userSpoke: false };
    case "turn_end":
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

export function unviewed(item: Pick<AttentionItem, "unread" | "last_message_at" | "viewedAt">): boolean {
  if (!item.unread) return false;
  const last = instant(item.last_message_at),
    looked = instant(item.viewedAt);
  return !(Number.isFinite(last) && Number.isFinite(looked) && looked >= last);
}

export function viewStamp(item: Pick<AttentionItem, "agent_id" | "id" | "unread" | "last_message_at" | "viewedAt"> | null | undefined): string | null {
  if (!item?.last_message_at || !unviewed(item)) return null;
  return `${keyOf(item.agent_id, item.id)}@${item.last_message_at}`;
}

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
  const shares = { ...focus };
  for (const c of conversations) {
    const key = keyOf(c.agent_id, c.id);
    if (c.outside) {
      out.push(outsideItem(c, c.outside, seen[key] ?? null, viewed[key] ?? null));
      const sender = senderKeyOf(c.outside);
      const senderShare = sender ? (focus[keyOf(sender.agentId, sender.conversationId)] ?? 0) : 0;
      if (senderShare) shares[key] = Math.min(1, (focus[key] ?? 0) + senderShare);
      continue;
    }
    const d = digests.get(key);
    const l = live.get(key);
    const lastMessageAt = [c.last_message_at, l?.lastMessageAt].filter(Boolean).sort().pop() ?? null;
    const lastRole = l?.lastRole ?? d?.last_role ?? null;
    const lastAssistantText = l?.lastAssistantText ?? d?.last_assistant_text ?? null;
    const seenAt = seen[key] ?? null;
    const unread = !!lastMessageAt && lastRole === "assistant" && (!seenAt || seenAt < lastMessageAt);
    let status: AttentionStatus = "idle";
    if (l?.pending || waitingReplies(c, l).length > 0) status = "approval";
    else if (l?.pendingAsk) status = "question";
    else if (l?.error && unread) status = "failed";
    else if (l?.loop === "running") status = "running";
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
      error: l?.error ?? null,
      seenAt,
      unread,
      viewedAt: viewed[key] ?? null,
      lastAsk: l?.lastAsk ?? d?.last_ask ?? null,
      runtime: { agent_id: c.agent_id, conversation_id: c.id },
    });
  }
  return scored(out, now, shares).map((i) => {
    const key = keyOf(i.agent_id, i.id);
    return key in rests ? { ...i, ...restState(i, rests[key], now) } : i;
  });
}

export function waitingReplies(c: Pick<ConversationInfo, "reply_proposals">, l: Pick<Live, "replyProposals"> | undefined): ReplyProposal[] {
  return (l?.replyProposals ?? c.reply_proposals ?? []).filter((p) => p.status === "pending");
}

function outsideUnread(o: OutsideFacts, seenAt: string | null): boolean {
  switch (o.provider) {
    case "gmail":
      return o.unread_out_there !== false;
    case "slack":
      return !seenAt || seenAt < o.newest_at;
    case "jira":
      return !seenAt || seenAt < o.newest_at || (o.seeds ?? []).some((s) => seenAt < s.at);
  }
}

function outsideItem(c: ConversationInfo, o: OutsideFacts, seenAt: string | null, viewedAt: string | null): Unscored {
  const unread = outsideUnread(o, seenAt);
  return {
    ...c,
    status: unread ? "done" : "idle",
    last_message_at: o.newest_at,
    lastAssistantText: o.lines.at(-1) ?? null,
    lastRole: null,
    pendingApproval: null,
    pendingQuestion: null,
    error: null,
    seenAt,
    unread,
    viewedAt,
    lastAsk: null,
    runtime: { agent_id: c.agent_id, conversation_id: c.id },
  };
}
