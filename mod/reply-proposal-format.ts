import { readFile } from "node:fs/promises";
import type { ReplyAttachment, ReplyHeardBy, ReplyMention, ReplyProposal, ReplyProposalStatus, ReplyTicket } from "../core/frame-types.ts";
import { replyMentionOf } from "../core/frames.ts";
import type { AccountRecord } from "./accounts.ts";
import { inert } from "./account-ops/fence.ts";
import { md5 } from "./google-tools/core.ts";
import type { HeldTarget } from "./mail-outbox.ts";
import { bareAddresses } from "./reply-addressing.ts";
import type { ChatKey } from "./suggestions.ts";

export interface ReplyInput {
  account_id: string;
  thread_id: string;
  text: string;
  attachments?: string[];
  mentions?: string[];
}

export const PICKER_MAX = 8;

export interface TicketInput {
  account_id: string;
  project: string;
  type: string;
  title: string;
  description: string;
  assignee?: string;
  priority?: string;
  labels?: string[];
  parent?: string;
  mentions?: string[];
}

export const MAX_TICKET_TITLE = 255;

export const TICKET_FIELDS = new Set(["project", "issuetype", "summary", "description", "assignee", "priority", "labels", "parent", "reporter"]);

export type NewConversationInput =
  | { kind: "email"; account_id: string; to: string[]; cc?: string[]; subject: string; text: string; attachments?: string[]; mentions?: string[] }
  | { kind: "dm"; account_id: string; people: string[]; text: string; attachments?: string[]; mentions?: string[] };

export const mailboxOf = (m: ReplyMention): string => {
  const name = m.display.replace(/[<>"]/g, "").trim();
  if (!m.address) return name;
  return name && name.toLowerCase() !== m.address.toLowerCase() ? `${name} <${m.address}>` : m.address;
};

export function andList(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

export const MAX_REPLY_FILES = 10;
export const MAX_REPLY_BYTES = 17 * 1024 * 1024;

export function bytesWords(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export async function checkedFiles(files: readonly ReplyAttachment[]): Promise<Array<{ name: string; data: Buffer }>> {
  const entries = await Promise.all(files.map(async (f) => ({ f, data: await readFile(f.path).catch(() => null) })));
  const read: Array<{ name: string; data: Buffer }> = [];
  for (const { f, data } of entries) {
    if (!data) throw new Error(`${f.name} is no longer in the chat's folder: take it off, or reject the reply and ask for it again`);
    if (md5(data) !== f.md5) throw new Error(`${f.name} changed since this reply was proposed: take it off, or reject the reply and ask for it again`);
    read.push({ name: f.name, data });
  }
  return read;
}

export interface ChatRecord extends ChatKey {
  proposals: ReplyProposal[];
  notices: string[];
}

const STATUSES: readonly ReplyProposalStatus[] = ["pending", "sending", "sent", "drafted", "rejected", "withdrawn"];
export const MAY_HAVE_GONE = "it may have gone: check the thread before sending again";

export const isOpen = (p: ReplyProposal): boolean => p.status === "pending" || p.status === "sending";

const byWords = (by: string | null | undefined) => (by === "phone" || by === "desktop" ? `the ${by}` : by || "another device");

export function settledWords(p: ReplyProposal): string {
  switch (p.status) {
    case "sending":
      return "already sending";
    case "sent":
      return `already sent from ${byWords(p.decided_by)}`;
    case "drafted":
      return `already drafted from ${byWords(p.decided_by)}`;
    case "rejected":
      return `already rejected from ${byWords(p.decided_by)}`;
    case "withdrawn":
      return "the agent took this reply back";
    case "pending":
      return "still waiting";
  }
}

export const movedNotice = (p: ReplyProposal): string => `${p.account_label} moved to another agent, so ${whatWords(p)} was withdrawn: nothing was sent.`;

export function whatWords(p: ReplyProposal): string {
  if (p.kind === "email") return `your new email "${inert(p.subject)}"`;
  if (p.kind === "dm") return `your new ${inert((p.place ?? "DM").replace(/^a /, ""))}`;
  if (p.kind === "ticket") return `your new ticket "${inert(p.subject)}"`;
  return `your reply in thread ${p.thread_id}`;
}

export const MOVED = "that account moved to another agent: this reply was withdrawn";

function parseTicket(v: unknown): ReplyTicket | null {
  if (typeof v !== "object" || v === null) return null;
  const t = v as Record<string, unknown>;
  const text = (x: unknown) => (typeof x === "string" ? x : "");
  const priority = typeof t.priority === "object" && t.priority !== null ? (t.priority as Record<string, unknown>) : null;
  if (!text(t.project) || !text(t.type_id)) return null;
  return {
    project: text(t.project),
    project_name: text(t.project_name) || text(t.project),
    type_id: text(t.type_id),
    type_name: text(t.type_name),
    assignee: replyMentionOf(t.assignee),
    priority: priority && text(priority.id) ? { id: text(priority.id), name: text(priority.name) } : null,
    labels: Array.isArray(t.labels) ? t.labels.filter((l): l is string => typeof l === "string" && l !== "") : [],
    parent: text(t.parent) || null,
  };
}

function parseProposal(v: unknown): ReplyProposal | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  const s = (k: string) => (typeof r[k] === "string" ? r[k] : null);
  const id = s("id"),
    account = s("account_id"),
    thread = s("thread_id"),
    text = s("text");
  const status = r.status === "drafting" ? "pending" : STATUSES.find((x) => x === r.status);
  const provider = r.provider === "gmail" || r.provider === "slack" || r.provider === "jira" ? r.provider : null;
  const starts = r.kind === "email" || r.kind === "dm" || r.kind === "ticket";
  if (!id || !account || thread === null || (!thread && !starts) || text === null || !status || !provider) return null;
  const strings = (k: string) => (Array.isArray(r[k]) ? r[k].filter((x): x is string => typeof x === "string") : []);
  const files = Array.isArray(r.attachments) ? r.attachments.map(parseAttachment).filter((a): a is ReplyAttachment => a !== null) : [];
  const added = strings("people_added");
  const removed = strings("people_removed");
  const attached = strings("attached");
  const heardBy = parseHeardBy(r.heard_by);
  const mentions = Array.isArray(r.mentions) ? r.mentions.flatMap((m) => replyMentionOf(m) ?? []) : [];
  const dmPeople = Array.isArray(r.people) ? r.people.flatMap((m) => replyMentionOf(m) ?? []) : [];
  const ticket = parseTicket(r.ticket);
  return {
    id,
    account_id: account,
    provider,
    account_label: s("account_label") ?? account,
    thread_id: thread,
    subject: s("subject") ?? "",
    to: strings("to"),
    cc: strings("cc"),
    place: s("place"),
    text,
    status,
    reason: s("reason"),
    created_at: s("created_at") ?? "",
    decided_by: s("decided_by"),
    decided_at: s("decided_at"),
    ...(files.length ? { attachments: files } : {}),
    ...(s("outbox_id") ? { outbox_id: s("outbox_id") } : {}),
    ...(added.length ? { people_added: added } : {}),
    ...(removed.length ? { people_removed: removed } : {}),
    ...(attached.length ? { attached } : {}),
    ...(typeof r.in_flow === "boolean" ? { in_flow: r.in_flow } : {}),
    ...(r.shared_outside === true ? { shared_outside: true } : {}),
    ...(heardBy ? { heard_by: heardBy } : {}),
    ...(mentions.length ? { mentions } : {}),
    ...(r.kind === "email" || r.kind === "dm" || r.kind === "ticket" ? { kind: r.kind } : {}),
    ...(ticket ? { ticket } : {}),
    ...(dmPeople.length ? { people: dmPeople } : {}),
    ...(s("result") ? { result: s("result") ?? "" } : {}),
  };
}

function parseHeardBy(v: unknown): ReplyHeardBy | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  const name = (x: unknown) => (typeof x === "string" ? x : null);
  return {
    assignee: name(r.assignee),
    reporter: name(r.reporter),
    watchers: typeof r.watchers === "number" ? r.watchers : 0,
    customer_sees: r.customer_sees === true,
  };
}

function parseAttachment(v: unknown): ReplyAttachment | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  const { name, path, size, md5: sum } = r;
  return typeof name === "string" && typeof path === "string" && typeof size === "number" && typeof sum === "string" ? { name, path, size, md5: sum } : null;
}

export function parseChat(v: unknown): ChatRecord | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.agent_id !== "string" || typeof r.conversation_id !== "string") return null;
  return {
    agent_id: r.agent_id,
    conversation_id: r.conversation_id,
    proposals: Array.isArray(r.proposals) ? r.proposals.map(parseProposal).filter((p): p is ReplyProposal => p !== null) : [],
    notices: Array.isArray(r.notices) ? r.notices.filter((n): n is string => typeof n === "string") : [],
  };
}

export const keyOf = (chat: ChatKey): string => `${chat.agent_id}/${chat.conversation_id}`;

export function targetOf(p: ReplyProposal, account: AccountRecord, outboxId: string): HeldTarget | undefined {
  if (p.kind === "email") return { kind: "email", subject: p.subject, message_id: `<${outboxId}@${account.address.split("@").at(1) ?? "loki.local"}>` };
  if (p.kind === "dm") return { kind: "dm", people: (p.people ?? []).flatMap((m) => (m.id ? [m.id] : [])) };
  if (p.kind === "ticket" && p.ticket)
    return {
      kind: "ticket",
      project: p.ticket.project,
      type_id: p.ticket.type_id,
      title: p.subject,
      assignee: p.ticket.assignee?.id ?? null,
      priority_id: p.ticket.priority?.id ?? null,
      labels: p.ticket.labels,
      parent: p.ticket.parent,
    };
  return undefined;
}

export const mayHaveGone = (reason: string): boolean => reason.includes(MAY_HAVE_GONE) || reason.startsWith("loki stopped while sending it: look");

export function withFiles(p: ReplyProposal, files: readonly ReplyAttachment[]): ReplyProposal {
  const { attachments: _was, ...rest } = p;
  return files.length ? { ...rest, attachments: [...files] } : rest;
}

export function withMentionList(p: ReplyProposal, mentions: readonly ReplyMention[]): ReplyProposal {
  const { mentions: _was, ...rest } = p;
  return mentions.length ? { ...rest, mentions: [...mentions] } : rest;
}

export function uniqueMentions(list: readonly ReplyMention[]): ReplyMention[] {
  const seen = new Set<string>();
  return list.filter((m) => {
    const key = `${m.id ?? ""}|${m.address?.toLowerCase() ?? ""}|${m.display}`;
    return !seen.has(key) && seen.add(key);
  });
}

export function withoutPeopleMarks(p: ReplyProposal): ReplyProposal {
  const { people_added: _added, people_removed: _removed, ...rest } = p;
  return rest;
}

function whoWords(p: ReplyProposal): string {
  switch (p.provider) {
    case "gmail":
      return `to ${inert(bareAddresses([...p.to, ...p.cc]).join(", ")) || "no one"}`;
    case "slack":
      return `in ${inert(p.place ?? "that conversation")}`;
    case "jira":
      if (p.kind === "ticket" && p.ticket) {
        const t = p.ticket;
        return [
          `in ${inert(t.project_name)} (${t.project}) as a ${inert(t.type_name)}`,
          t.parent ? `under ${t.parent}` : "",
          t.assignee ? `assigned to ${inert(t.assignee.display)}` : "",
          t.priority ? `priority ${inert(t.priority.name)}` : "",
          t.labels.length ? `labels ${inert(t.labels.join(", "))}` : "",
        ]
          .filter(Boolean)
          .join(", ");
      }
      return `on ${inert(p.place ?? "that ticket")}`;
  }
}

const filesWords = (files: readonly ReplyAttachment[]): string => files.map((f) => `${inert(f.name)} (${bytesWords(f.size)})`).join(", ");

export function sentNotice(p: ReplyProposal): string {
  const what =
    p.kind === "email"
      ? "sent your new email"
      : p.kind === "dm"
        ? "sent your new DM"
        : p.kind === "ticket"
          ? `created your new ticket "${inert(p.subject)}"`
          : p.provider === "jira"
            ? "posted your comment"
            : "sent your reply";
  const files = p.attachments?.length ? `, with ${filesWords(p.attachments)}` : "";
  const named = (p.mentions ?? []).map((m) => (m.address ? `${m.display} <${m.address}>` : m.display));
  const mentioned = named.length ? `, ${p.provider === "gmail" ? "copying" : "mentioning"} ${inert(named.join(", "))}` : "";
  const thread =
    p.kind === "ticket"
      ? p.result
        ? `as ${inert(p.result)}`
        : "under a key Jira did not give back"
      : p.result
        ? `thread ${inert(p.result)}`
        : p.thread_id
          ? `thread ${p.thread_id}`
          : "a new conversation";
  return [`The person ${what} in ${p.account_label}, ${thread}, ${whoWords(p)}${files}${mentioned}. It says:`, inert(p.text)].join("\n");
}

export function proposalLine(p: ReplyProposal): string {
  const who = whoWords(p);
  const files = p.attachments?.length ? `with ${filesWords(p.attachments)}` : "";
  const what =
    p.kind === "email"
      ? `new email "${inert(p.subject)}"`
      : p.kind === "dm"
        ? "new DM"
        : p.kind === "ticket"
          ? `new ticket "${inert(p.subject)}"`
          : `thread ${p.thread_id} · "${inert(p.subject)}"`;
  const line = [p.id, p.account_label, what, who, files, p.status, p.reason && inert(p.reason)].filter(Boolean).join(" · ");
  return p.mentions?.length ? `${line}\nMentions: ${inert(p.mentions.map(mentionWords).join("; "))}` : line;
}

const mentionWords = (m: ReplyMention): string =>
  m.address
    ? `${m.display} <${m.address}> (copied on the mail)`
    : m.not_member
      ? `${m.display} (not in this conversation: will not be notified)`
      : `${m.display} (notified)`;
