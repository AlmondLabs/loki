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

export type ItemSource = "chat" | AccountProvider;

export interface ItemProperty {
  key: "agent" | "folder" | "labels" | "replies" | "people" | "sender" | "to_you" | "files" | "status" | "assignee" | "priority";
  label: string;
  editable: boolean;
  tone?: "attention" | "negative" | "positive";
}

export type ItemFlag = "unread" | "starred" | "mentions_you" | "changed";

export interface ItemHeaderView {
  title: string;
  properties: ItemProperty[];
  flags: ItemFlag[];
}

export type ItemVerb = "archive" | "mark_read" | "later" | "label" | "handoff" | "open" | "open_out";

export interface ItemActionsView {
  main: ItemVerb;
  more: ItemVerb[];
}

export type ItemPart =
  | { kind: "text"; text: string }
  | { kind: "blocks"; blocks: SlackBlock[] }
  | { kind: "html"; html: string; inline_images?: Record<string, string> }
  | { kind: "attachments"; attachments: SlackAttachment[] }
  | { kind: "files"; files: SlackFile[] }
  | { kind: "mail_files"; files: MailFile[] };

export type ItemEntry =
  | {
      kind: "message";
      key: string;
      from: "person" | "you";
      who: string;
      avatar: string | null;
      at: string;
      parts: ItemPart[];
      reactions: SlackReaction[];
      mentions_you: boolean;
      in_thread: boolean;
    }
  | { kind: "event"; key: string; who: string | null; text: string; at: string }
  | Extract<TurnEntry, { kind: "turn" | "day" | "new" | "command" }>
  | { kind: "chat_message"; key: string; entry: Extract<TurnEntry, { kind: "message" }> };

export type ProposalView =
  | { kind: "approval"; key: string; request_id: string; tool: string; input: unknown; always: boolean; at: string }
  | { kind: "question"; key: string; request_id: string; questions: AskQuestion[]; at: string }
  | { kind: "reply"; key: string; proposal: ReplyProposal }
  | { kind: "suggestion"; key: string; suggestion: Suggestion };

export type ComposerTarget =
  | { kind: "agent"; label: string }
  | { kind: "thread"; label: string; also_channel: boolean }
  | { kind: "reply" | "reply_all"; label: string }
  | { kind: "comment"; label: string };

export type ComposerVoice = "you" | "agent";

export interface ComposerView {
  targets: ComposerTarget[];
  voices: ComposerVoice[];
  agent: string | null;
  seeds: string[];
}

export interface ItemView {
  source: ItemSource;
  header: ItemHeaderView;
  actions: ItemActionsView;
  entries: ItemEntry[];
  proposals: ProposalView[];
  composer: ComposerView;
}

const STATE: Record<AttentionItem["status"], { word: string | null; tone?: ItemProperty["tone"] }> = {
  approval: { word: "needs you", tone: "attention" },
  question: { word: "asked you", tone: "attention" },
  failed: { word: "failed", tone: "negative" },
  done: { word: "finished", tone: "positive" },
  running: { word: "working" },
  idle: { word: null },
};

const folderName = (cwd: string): string =>
  cwd
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() ?? cwd;

export interface ChatSource {
  item: AttentionItem;
  live: Live | null;
  turns: TurnEntry[];
}

export const chatEntries = (turns: readonly TurnEntry[]): ItemEntry[] =>
  turns.map((t) => (t.kind === "message" ? { kind: "chat_message", key: t.key, entry: t } : t));

export function chatItem({ item, live, turns }: ChatSource): ItemView {
  const agent = item.agent_name ?? "agent";
  const state = STATE[item.status];
  const properties: ItemProperty[] = [
    { key: "agent", label: state.word ? `${agent} · ${state.word}` : agent, editable: false, ...(state.tone ? { tone: state.tone } : {}) },
  ];
  const cwd = live?.cwd ?? item.cwd;
  if (cwd) properties.push({ key: "folder", label: folderName(cwd), editable: true });
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

export interface OutsideSource {
  facts: OutsideFacts;
  messages: OutsideMessage[];
  ticket?: JiraCardTicket | null;
  unread: boolean;
  replies?: readonly ReplyProposal[];
}

const MENTIONS = new Set<OutsideFacts["reach"]>(["mention", "group"]);

function changeText(c: JiraFieldChange): string {
  const name = c.field === "issuetype" ? "type" : c.field.toLowerCase();
  if (c.field === "description" || (c.from === null && c.to === null)) return `edited the ${name}`;
  if (c.from === null) return `set ${name} to ${c.to ?? ""}`;
  if (c.to === null) return `cleared ${name}`;
  return `${name} ${c.from} → ${c.to}`;
}

function partsOf(m: OutsideMessage): ItemPart[] {
  const parts: ItemPart[] = [];
  if (m.html) parts.push({ kind: "html", html: m.html, inline_images: m.inline_images });
  else if (m.body?.length) parts.push({ kind: "blocks", blocks: m.body });
  else if (m.text) parts.push({ kind: "text", text: m.text });
  if (m.attachments?.length) parts.push({ kind: "attachments", attachments: m.attachments });
  if (m.slack_files?.length) parts.push({ kind: "files", files: m.slack_files });
  if (m.files?.length) parts.push({ kind: "mail_files", files: m.files });
  return parts;
}

export function outsideMessageEntry(m: OutsideMessage, provider: AccountProvider): Extract<ItemEntry, { kind: "message" }> {
  return {
    kind: "message",
    key: `m-${m.id}`,
    from: m.mine ? "you" : "person",
    who: m.mine ? "You" : m.sender,
    avatar: m.avatar ?? null,
    at: m.at,
    parts: partsOf(m),
    reactions: provider === "jira" ? [] : (m.reactions ?? []),
    mentions_you: provider === "jira" ? m.mentions_me === true : m.brought === true,
    in_thread: m.in_thread === true,
  };
}

export function outsideItem({ facts, messages, ticket = null, unread, replies = [] }: OutsideSource): ItemView {
  const entries: Array<Extract<ItemEntry, { kind: "message" | "event" }>> = messages.map((m) => outsideMessageEntry(m, facts.provider));
  for (const c of ticket?.changed ?? []) entries.push({ kind: "event", key: `e-${c.field}-${c.at}`, who: c.by, text: changeText(c), at: c.at });
  const time = (e: { at: string }) => (e.at ? Date.parse(e.at) : Number.NaN);
  entries.sort((a, b) => {
    const ta = time(a);
    const tb = time(b);
    return Number.isNaN(ta) || Number.isNaN(tb) ? 0 : ta - tb;
  });

  const flags: ItemFlag[] = [];
  if (unread) flags.push("unread");
  if (facts.starred === true) flags.push("starred");
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
