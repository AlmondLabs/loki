import type { AttentionItem, Live, PendingApproval } from "../../../core/attention/model.ts";
import { offersAlways, waitingReplies } from "../../../core/attention/model.ts";
import type { AskQuestion } from "../../../core/attention/content.ts";
import type {
  AccountProvider,
  JiraCardTicket,
  JiraFieldChange,
  MailFile,
  OutsideFacts,
  OutsideMessage,
  ReplyProposal,
  SlackAttachment,
  SlackBlock,
  SlackFile,
  SlackReaction,
  Suggestion,
} from "../../../core/frame-types.ts";
import type { TurnEntry } from "./entries";

/*
 * The chat pane's one shape for every item (plan 097, KTD2): an agent chat, a Slack thread, an email or a Jira ticket
 * becomes an ItemView, and the twelve components in this folder read only that. What differs between sources lives in
 * the builders below. Data loki does not have is left out, never made up (KTD8): no Brief, no starred or watching flag.
 */

/** Where an item comes from: one of loki's own chats, or a thread of a connected account. */
export type ItemSource = "chat" | AccountProvider;

/** A fact about the item shown as a chip in its header; an editable one opens a menu. */
export interface ItemProperty {
  /** What the fact is, so a component can choose its menu: the chat's agent, a Jira field, a mail's sender. */
  key: "agent" | "folder" | "labels" | "replies" | "people" | "sender" | "to_you" | "files" | "status" | "assignee" | "priority";
  label: string;
  editable: boolean;
  /** The colour a state takes: an agent waiting on you, a failed run, a finished one. */
  tone?: "attention" | "negative" | "positive";
}

/** A state of the item that shows only while it holds (R4): unread, a mention of the person, a ticket changed since read. */
export type ItemFlag = "unread" | "mentions_you" | "changed";

/** The item's header: its one-line title, then its facts, then its flags. */
export interface ItemHeaderView {
  title: string;
  properties: ItemProperty[];
  flags: ItemFlag[];
}

/**
 * A move on the whole item; Flow's keys keep their meaning (KTD9). The view lists every move the source has; a surface
 * draws the ones it can make (Flow's card opens a chat, the chat pane does not).
 */
export type ItemVerb = "archive" | "mark_read" | "later" | "label" | "handoff" | "open" | "open_out";

/** The item's verbs: the one that finishes it, named and first in weight; the rest beside it (R13). */
export interface ItemActionsView {
  main: ItemVerb;
  more: ItemVerb[];
}

/** One thing an entry carries (ContentParts): words in one of their forms, files, or what a Slack app attached. */
export type ItemPart =
  | { kind: "text"; text: string }
  | { kind: "blocks"; blocks: SlackBlock[] }
  | { kind: "html"; html: string }
  | { kind: "attachments"; attachments: SlackAttachment[] }
  | { kind: "files"; files: SlackFile[] }
  | { kind: "mail_files"; files: MailFile[] };

/**
 * One entry of the Timeline. A message is someone's or yours (MessageEntry); an agent turn is the chat's own grouping
 * (plan 096's Turns, which AgentTurn draws); an event is a change, not something said (EventEntry); day and new are
 * the chat's markers.
 */
export type ItemEntry =
  | {
      kind: "message";
      key: string;
      from: "person" | "you";
      who: string;
      avatar: string | null;
      /** ISO time, "" when unknown. */
      at: string;
      parts: ItemPart[];
      reactions: SlackReaction[];
      /** Says the message is meant for the person: a Slack message that brought the card, a Jira comment naming them. */
      mentions_you: boolean;
      /** A reply under the thread's first message. */
      in_thread: boolean;
    }
  | { kind: "event"; key: string; who: string | null; text: string; at: string }
  | Extract<TurnEntry, { kind: "turn" | "day" | "new" }>
  | { kind: "chat_message"; key: string; entry: Extract<TurnEntry, { kind: "message" }> };

/**
 * Something the agent asks the person to decide (Proposal, R9). Moves are not listed: loki has no agent-proposed move
 * yet, so the kind is designed and drawn on the example page but never built from data here.
 */
export type ProposalView =
  | { kind: "approval"; key: string; request_id: string; tool: string; input: unknown; always: boolean; at: string }
  | { kind: "question"; key: string; request_id: string; questions: AskQuestion[]; at: string }
  | { kind: "reply"; key: string; proposal: ReplyProposal }
  | { kind: "suggestion"; key: string; suggestion: Suggestion };

/** Where the Composer's words go (R12). */
export type ComposerTarget =
  | { kind: "agent"; label: string }
  | { kind: "thread"; label: string; also_channel: boolean }
  | { kind: "reply" | "reply_all"; label: string }
  | { kind: "comment"; label: string };

/** Who the words are from: the person ("as you"), or an instruction to the item's agent ("ask <agent>"). */
export type ComposerVoice = "you" | "agent";

/** The Composer for this item: its targets, voices, the agent asked, and text already waiting for the box. */
export interface ComposerView {
  targets: ComposerTarget[];
  voices: ComposerVoice[];
  agent: string | null;
  /** Text that seeds the box: a chat's saved draft, or Jira comments the person approved (plan 2026-11-10-1451). */
  seeds: string[];
}

/** One item, as every component in the chat pane reads it. */
export interface ItemView {
  source: ItemSource;
  header: ItemHeaderView;
  actions: ItemActionsView;
  entries: ItemEntry[];
  proposals: ProposalView[];
  composer: ComposerView;
}

/** What the agent's state reads as in a chat's first chip, with its tone; idle says nothing. */
const STATE: Record<AttentionItem["status"], { word: string | null; tone?: ItemProperty["tone"] }> = {
  approval: { word: "needs you", tone: "attention" },
  question: { word: "asked you", tone: "attention" },
  failed: { word: "failed", tone: "negative" },
  done: { word: "finished", tone: "positive" },
  running: { word: "working" },
  idle: { word: null },
};

/** The last part of a folder path, which is how a chip names it. */
const folderName = (cwd: string): string =>
  cwd
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() ?? cwd;

/** What a chat needs to become an item: its row in the list, what is heard live, and its thread as Turns. */
export interface ChatSource {
  item: AttentionItem;
  live: Live | null;
  /** The thread grouped as Turns (threadTurns), windowed by the caller. */
  turns: TurnEntry[];
}

/** A chat's Turns as the Timeline's entries: your messages stand alone, the agent's turns and the markers pass through. */
export const chatEntries = (turns: readonly TurnEntry[]): ItemEntry[] =>
  turns.map((t) => (t.kind === "message" ? { kind: "chat_message", key: t.key, entry: t } : t));

/** An agent chat as an item: its name, its agent and state, folder and labels; its turns; what it waits on you for. */
export function chatItem({ item, live, turns }: ChatSource): ItemView {
  const agent = item.agent_name ?? "agent";
  const state = STATE[item.status];
  const properties: ItemProperty[] = [
    { key: "agent", label: state.word ? `${agent} · ${state.word}` : agent, editable: false, ...(state.tone ? { tone: state.tone } : {}) },
  ];
  const cwd = live?.cwd ?? item.cwd;
  if (cwd) properties.push({ key: "folder", label: folderName(cwd), editable: true });
  // No chip for no labels: the surface that can add one says so itself (the chat pane's "+ label").
  if (item.labels?.length) properties.push({ key: "labels", label: item.labels.join(", "), editable: true });

  const entries = chatEntries(turns);

  const proposals: ProposalView[] = [];
  const pending: PendingApproval | null = live?.pending ?? item.pendingApproval;
  if (pending)
    proposals.push({
      kind: "approval",
      key: `approval-${pending.requestId}`,
      request_id: pending.requestId,
      tool: pending.toolName,
      input: pending.input,
      always: offersAlways(pending),
      at: pending.at,
    });
  const ask = live?.pendingAsk ?? item.pendingQuestion;
  if (ask) proposals.push({ kind: "question", key: `question-${ask.requestId}`, request_id: ask.requestId, questions: ask.questions, at: ask.at });
  for (const p of waitingReplies(item, live ?? undefined)) proposals.push({ kind: "reply", key: `reply-${p.id}`, proposal: p });
  for (const s of live?.suggestions ?? []) if (s.status === "pending") proposals.push({ kind: "suggestion", key: `suggestion-${s.id}`, suggestion: s });

  return {
    source: "chat",
    header: { title: item.title?.trim() || "new chat", properties, flags: item.unread ? ["unread"] : [] },
    actions: { main: "archive", more: ["open", "later", "mark_read"] },
    entries,
    proposals,
    composer: { targets: [{ kind: "agent", label: agent }], voices: ["you"], agent, seeds: item.draft_text ? [item.draft_text] : [] },
  };
}

/** What an outside thread needs to become an item: its card's facts, the thread as read, and its unread state. */
export interface OutsideSource {
  facts: OutsideFacts;
  /** The messages as read; empty while the thread loads or after it failed. */
  messages: OutsideMessage[];
  /** A Jira card's ticket, from the opening read. */
  ticket?: JiraCardTicket | null;
  unread: boolean;
  /** Every reply proposal the list knows; only this thread's pending ones are kept. */
  replies?: readonly ReplyProposal[];
}

/** Whom a message is meant for, for the mention flag: someone naming the person, or a group they are in. */
const MENTIONS = new Set<OutsideFacts["reach"]>(["mention", "group"]);

/** Words for a Jira field change, as its event line reads: "status To do → In progress". */
function changeText(c: JiraFieldChange): string {
  const name = c.field === "issuetype" ? "type" : c.field.toLowerCase();
  if (c.field === "description" || (c.from === null && c.to === null)) return `edited the ${name}`;
  if (c.from === null) return `set ${name} to ${c.to ?? ""}`;
  if (c.to === null) return `cleared ${name}`;
  return `${name} ${c.from} → ${c.to}`;
}

/** A message's parts in the order a card draws them: its words (Slack's blocks, a mail's HTML, or plain text), then files. */
function partsOf(m: OutsideMessage): ItemPart[] {
  const parts: ItemPart[] = [];
  if (m.html) parts.push({ kind: "html", html: m.html });
  else if (m.body?.length) parts.push({ kind: "blocks", blocks: m.body });
  else if (m.text) parts.push({ kind: "text", text: m.text });
  if (m.attachments?.length) parts.push({ kind: "attachments", attachments: m.attachments });
  if (m.slack_files?.length) parts.push({ kind: "files", files: m.slack_files });
  if (m.files?.length) parts.push({ kind: "mail_files", files: m.files });
  return parts;
}

/** One outside message as a MessageEntry reads it: whose, its parts, its reactions where the source has them, its marks. */
export function outsideMessageEntry(m: OutsideMessage, provider: AccountProvider): Extract<ItemEntry, { kind: "message" }> {
  return {
    kind: "message",
    key: `m-${m.id}`,
    from: m.mine ? "you" : "person",
    who: m.mine ? "You" : m.sender,
    avatar: m.avatar ?? null,
    at: m.at,
    parts: partsOf(m),
    reactions: provider === "slack" ? (m.reactions ?? []) : [],
    mentions_you: provider === "jira" ? m.mentions_me === true : m.brought === true,
    in_thread: m.in_thread === true,
  };
}

/** A Slack thread, an email or a Jira ticket as an item (R2–R4). */
export function outsideItem({ facts, messages, ticket = null, unread, replies = [] }: OutsideSource): ItemView {
  const entries: Array<Extract<ItemEntry, { kind: "message" | "event" }>> = messages.map((m) => outsideMessageEntry(m, facts.provider));
  for (const c of ticket?.changed ?? []) entries.push({ kind: "event", key: `e-${c.field}-${c.at}`, who: c.by, text: changeText(c), at: c.at });
  // In time order; an entry with no time keeps its place after those before it (a stable sort on a missing time).
  const time = (e: { at: string }) => (e.at ? Date.parse(e.at) : Number.NaN);
  entries.sort((a, b) => {
    const ta = time(a);
    const tb = time(b);
    return Number.isNaN(ta) || Number.isNaN(tb) ? 0 : ta - tb;
  });

  const flags: ItemFlag[] = [];
  if (unread) flags.push("unread");
  if (MENTIONS.has(facts.reach ?? null) || entries.some((e) => e.kind === "message" && e.mentions_you)) flags.push("mentions_you");
  if (ticket && ticket.changed.length > 0) flags.push("changed");

  const proposals: ProposalView[] = replies
    .filter((p) => p.status === "pending" && p.thread_id === facts.thread_id && p.account_id === facts.account_id)
    .map((p) => ({ kind: "reply", key: `reply-${p.id}`, proposal: p }));
  const composer: ComposerView = { targets: [], voices: ["you", "agent"], agent: facts.owner_name, seeds: (facts.seeds ?? []).map((s) => s.text) };

  switch (facts.provider) {
    case "slack": {
      const people = new Set(messages.map((m) => m.sender)).size;
      const said = messages.filter((m) => m.in_thread).length;
      const properties: ItemProperty[] = [];
      if (said) properties.push({ key: "replies", label: said === 1 ? "1 reply" : `${said} replies`, editable: false });
      if (people > 1) properties.push({ key: "people", label: `${people} people`, editable: false });
      composer.targets.push({ kind: "thread", label: facts.place ? `in thread · ${facts.place}` : `to ${facts.sender}`, also_channel: facts.place != null });
      return {
        source: "slack",
        header: { title: facts.place ?? facts.sender, properties, flags },
        actions: { main: "mark_read", more: ["handoff", "archive", "later"] },
        entries,
        proposals,
        composer,
      };
    }
    case "gmail": {
      const properties: ItemProperty[] = [{ key: "sender", label: facts.sender, editable: false }];
      if (facts.reach === "to_you" || facts.reach === "dm") properties.push({ key: "to_you", label: "to you", editable: false });
      const files = messages.reduce((n, m) => n + (m.files?.length ?? 0), 0);
      if (files) properties.push({ key: "files", label: files === 1 ? "1 file" : `${files} files`, editable: false });
      composer.targets.push({ kind: "reply", label: `reply to ${facts.sender_address ?? facts.sender}` }, { kind: "reply_all", label: "reply all" });
      return {
        source: "gmail",
        header: { title: facts.subject || "(no subject)", properties, flags },
        actions: { main: "archive", more: ["handoff", "label", "later", "mark_read"] },
        entries,
        proposals,
        composer,
      };
    }
    case "jira": {
      const f = ticket?.fields;
      const properties: ItemProperty[] = [];
      if (f?.status) properties.push({ key: "status", label: f.status, editable: true });
      properties.push({ key: "assignee", label: f?.assignee ?? "unassigned", editable: true });
      if (f?.priority) properties.push({ key: "priority", label: f.priority, editable: true });
      if (f?.labels.length) properties.push({ key: "labels", label: f.labels.join(", "), editable: true });
      composer.targets.push({ kind: "comment", label: `comment on ${ticket?.key ?? facts.subject}` });
      return {
        source: "jira",
        header: { title: ticket ? `${ticket.key} · ${ticket.summary}` : facts.subject, properties, flags },
        actions: { main: "mark_read", more: ["open_out", "handoff", "later"] },
        entries,
        proposals,
        composer,
      };
    }
  }
}
