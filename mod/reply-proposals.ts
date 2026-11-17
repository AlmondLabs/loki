import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { ChatEvent } from "../core/attention/model.ts";
import { messageOf } from "../core/errors.ts";
import type { ReplyAttachment, ReplyHeardBy, ReplyMention, ReplyPersonChoice, ReplyProposal, ReplyProposalStatus, ReplyTicket } from "../core/frame-types.ts";
import { lastByName, liveMentions, mentionSpans, writeMentions } from "../core/mentions.ts";
import { replyMentionOf, type ChatState, type ReplyAction, type ReplyDecideOptions } from "../core/frames.ts";
import { keyedQueue } from "../core/serial.ts";
import type { ModApi } from "../daemon/mods/api.ts";
import type { AccountThreads } from "./account-threads.ts";
import { readReplyDestination, type ReplyReads } from "./account-ops/reply-reader.ts";
import { accountLabel, ownedAccount, type AccountRecord, type Accounts } from "./accounts.ts";
import type { ChatBackend } from "./frames/chat.ts";
import { inert } from "./account-ops/fence.ts";
import { inChatFolder, md5 } from "./google-tools/core.ts";
import { causeWords } from "./handoff.ts";
import { readJson, writeJsonAtomic } from "./json-file.ts";
import { log } from "./log.ts";
import { bareAddresses, slackPlace } from "./reply-addressing.ts";
import { MAX_DM_PEOPLE } from "./slack.ts";
import type { People } from "./people.ts";
import { JiraError, type JiraClient, type JiraUserScope } from "./jira.ts";
import type { HeldProposal, HeldReply, HeldTarget } from "./mail-outbox.ts";
import type { AgentReplyReports, OutsideThreads, PeopleChanged } from "./outside-threads.ts";
import type { ChatKey } from "./suggestions.ts";
import { argText, toolRegistrar, type LokiTool } from "./tools.ts";

export interface ReplyProposalsOptions {
  file: string;
  accounts: Pick<Accounts, "get" | "onChange">;
  threads: Pick<AccountThreads, "get">;
  clientFor(account: AccountRecord): ReplyReads;
  people?: Pick<People, "resolve" | "find">;
  jira?(accountId: string): Pick<JiraClient, "projects" | "priorities" | "formFields" | "ticketFacts">;
  members?(accountId: string, channel: string): Promise<ReadonlySet<string>>;
  outside: Pick<OutsideThreads, "holdAgentReply" | "unsend" | "holds" | "wentOutIn" | "acknowledge">;
  push(agentId: string, conversationId: string, events: ChatEvent[]): void;
  changed?(): void;
  now?(): Date;
  newId?(): string;
}

export interface ReplyDecided {
  proposal: ReplyProposal;
  done: boolean;
  message: string | null;
}

export interface ReplyInput {
  account_id: string;
  thread_id: string;
  text: string;
  attachments?: string[];
  mentions?: string[];
}

const PICKER_MAX = 8;

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

const MAX_TICKET_TITLE = 255;

const TICKET_FIELDS = new Set(["project", "issuetype", "summary", "description", "assignee", "priority", "labels", "parent", "reporter"]);

export type NewConversationInput =
  | { kind: "email"; account_id: string; to: string[]; cc?: string[]; subject: string; text: string; attachments?: string[]; mentions?: string[] }
  | { kind: "dm"; account_id: string; people: string[]; text: string; attachments?: string[]; mentions?: string[] };

const mailboxOf = (m: ReplyMention): string => {
  const name = m.display.replace(/[<>"]/g, "").trim();
  if (!m.address) return name;
  return name && name.toLowerCase() !== m.address.toLowerCase() ? `${name} <${m.address}>` : m.address;
};

function andList(names: readonly string[]): string {
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
  const read: Array<{ name: string; data: Buffer }> = [];
  for (const f of files) {
    const data = await readFile(f.path).catch(() => null);
    if (!data) throw new Error(`${f.name} is no longer in the chat's folder: take it off, or reject the reply and ask for it again`);
    if (md5(data) !== f.md5) throw new Error(`${f.name} changed since this reply was proposed: take it off, or reject the reply and ask for it again`);
    read.push({ name: f.name, data });
  }
  return read;
}

interface ChatRecord extends ChatKey {
  proposals: ReplyProposal[];
  notices: string[];
}

const STATUSES: readonly ReplyProposalStatus[] = ["pending", "sending", "sent", "drafted", "rejected", "withdrawn"];
export const MAY_HAVE_GONE = "it may have gone: check the thread before sending again";

const isOpen = (p: ReplyProposal) => p.status === "pending" || p.status === "sending";

const byWords = (by: string | null | undefined) => (by === "phone" || by === "desktop" ? `the ${by}` : by || "another device");

function settledWords(p: ReplyProposal): string {
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

const movedNotice = (p: ReplyProposal): string => `${p.account_label} moved to another agent, so ${whatWords(p)} was withdrawn: nothing was sent.`;

function whatWords(p: ReplyProposal): string {
  if (p.kind === "email") return `your new email "${inert(p.subject)}"`;
  if (p.kind === "dm") return `your new ${inert((p.place ?? "DM").replace(/^a /, ""))}`;
  if (p.kind === "ticket") return `your new ticket "${inert(p.subject)}"`;
  return `your reply in thread ${p.thread_id}`;
}
const MOVED = "that account moved to another agent: this reply was withdrawn";

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

function parseChat(v: unknown): ChatRecord | null {
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

const keyOf = (chat: ChatKey) => `${chat.agent_id}/${chat.conversation_id}`;

function targetOf(p: ReplyProposal, account: AccountRecord, outboxId: string): HeldTarget | undefined {
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

const mayHaveGone = (reason: string): boolean => reason.includes(MAY_HAVE_GONE) || reason.startsWith("loki stopped while sending it: look");

function withFiles(p: ReplyProposal, files: readonly ReplyAttachment[]): ReplyProposal {
  const { attachments: _was, ...rest } = p;
  return files.length ? { ...rest, attachments: [...files] } : rest;
}

function withMentionList(p: ReplyProposal, mentions: readonly ReplyMention[]): ReplyProposal {
  const { mentions: _was, ...rest } = p;
  return mentions.length ? { ...rest, mentions: [...mentions] } : rest;
}

function uniqueMentions(list: readonly ReplyMention[]): ReplyMention[] {
  const seen = new Set<string>();
  return list.filter((m) => {
    const key = `${m.id ?? ""}|${m.address?.toLowerCase() ?? ""}|${m.display}`;
    return !seen.has(key) && seen.add(key);
  });
}

function withoutPeopleMarks(p: ReplyProposal): ReplyProposal {
  const { people_added: _added, people_removed: _removed, ...rest } = p;
  return rest;
}

export class ReplyProposals implements AgentReplyReports {
  private readonly opts: ReplyProposalsOptions;
  private readonly chats = new Map<string, ChatRecord>();
  private readonly locks = keyedQueue();
  private readonly stopMoves: () => void;

  constructor(opts: ReplyProposalsOptions) {
    this.opts = opts;
    const raw = readJson(opts.file);
    const list = typeof raw === "object" && raw !== null ? (raw as { chats?: unknown }).chats : null;
    for (const c of Array.isArray(list) ? list.map(parseChat) : []) if (c) this.chats.set(keyOf(c), c);
    this.stopMoves = opts.accounts.onChange((change) => {
      if (change.kind === "moved") void this.withdrawMoved(change.account_id, change.from).catch((err: unknown) => log("replies:move-failed", messageOf(err)));
    });
  }

  stop(): void {
    this.stopMoves();
  }

  async propose(chat: ChatKey, input: ReplyInput): Promise<ReplyProposal> {
    if (!input.text.trim()) throw new Error("a reply needs text");
    const account = this.opts.accounts.get(input.account_id);
    if (account?.owner_agent_id !== chat.agent_id) throw new Error("this agent owns no such account");
    const files = await this.files(input.attachments ?? []);
    const where = await readReplyDestination(
      account,
      this.opts.clientFor(account),
      input.thread_id,
      (accountId, threadId) => this.opts.threads.get(accountId, threadId) ?? null,
    );
    const { text, mentions } = await this.mentioned(account, where, input.text, input.mentions ?? []);
    const proposal: ReplyProposal = {
      id: this.opts.newId?.() ?? `reply-${randomUUID()}`,
      account_id: account.account_id,
      provider: account.provider,
      account_label: accountLabel(account),
      thread_id: where.thread_id,
      subject: where.subject,
      to: where.to,
      cc: where.cc,
      place: where.place,
      text,
      status: "pending",
      reason: null,
      created_at: this.now(),
      ...(files.length ? { attachments: files } : {}),
      in_flow: where.in_flow,
      ...(where.shared_outside ? { shared_outside: true } : {}),
      ...(where.heard_by ? { heard_by: where.heard_by } : {}),
      ...(mentions.length ? { mentions } : {}),
    };
    await this.locked(chat, () => {
      const r = this.record(chat);
      this.save(chat, { ...r, proposals: [...r.proposals, proposal] });
      return Promise.resolve();
    });
    return proposal;
  }

  async proposeNew(chat: ChatKey, input: NewConversationInput): Promise<ReplyProposal> {
    if (!input.text.trim()) throw new Error("a message needs text");
    const account = this.opts.accounts.get(input.account_id);
    if (account?.owner_agent_id !== chat.agent_id) throw new Error("this agent owns no such account");
    const people = this.opts.people;
    if (!people) throw new Error("people cannot be found on this Mac: name the thread to reply in instead");
    const resolve = async (entry: string): Promise<ReplyMention> => {
      const found = await people.resolve(account.account_id, entry.trim().replace(/^@/, ""));
      if (!found.ok) throw new Error(found.why);
      const p = found.person;
      return p.provider === "gmail" ? { display: p.display, id: null, address: p.address } : { display: p.display, id: p.id, address: null };
    };
    const files = await this.files(input.attachments ?? []);
    const where = { thread_id: "", place: null };
    const { text, mentions } = await this.mentioned(account, where, input.text, input.mentions ?? []);
    const base = {
      id: this.opts.newId?.() ?? `reply-${randomUUID()}`,
      account_id: account.account_id,
      provider: account.provider,
      account_label: accountLabel(account),
      thread_id: "",
      text,
      status: "pending" as const,
      reason: null,
      created_at: this.now(),
      ...(files.length ? { attachments: files } : {}),
      ...(mentions.length ? { mentions } : {}),
    };
    let proposal: ReplyProposal;
    if (input.kind === "email") {
      if (account.provider !== "gmail") throw new Error("a new email goes from a Gmail account");
      const subject = input.subject.replace(/\s+/g, " ").trim();
      if (!subject) throw new Error("a new email needs a subject");
      const named = (list: readonly string[]) => Promise.all(list.filter((e) => e.trim()).map(async (e) => mailboxOf(await resolve(e))));
      const [to, cc] = await Promise.all([named(input.to), named(input.cc ?? [])]);
      if (to.length === 0) throw new Error("a new email needs someone in `to`");
      proposal = { ...base, kind: "email", subject, to: [...new Set(to)], cc: [...new Set(cc)].filter((c) => !to.includes(c)), place: null };
    } else {
      if (account.provider !== "slack") throw new Error("a new DM goes from a Slack account");
      const wanted = [...new Set(input.people.map((e) => e.trim()).filter(Boolean))];
      if (wanted.length === 0) throw new Error("a new DM needs someone in `people`");
      if (wanted.length > MAX_DM_PEOPLE) throw new Error(`a DM is with ${String(MAX_DM_PEOPLE)} people at most`);
      const resolved = await Promise.all(wanted.map(resolve));
      const dm = resolved.filter((m, i) => resolved.findIndex((x) => x.id === m.id) === i);
      if (dm.some((m) => m.id === account.account_id.split(":").at(2))) throw new Error("a DM is with other people: leave yourself out of `people`");
      proposal = { ...base, kind: "dm", people: dm, subject: "", to: [], cc: [], place: `a DM with ${andList(dm.map((m) => m.display))}` };
    }
    await this.locked(chat, () => {
      const r = this.record(chat);
      this.save(chat, { ...r, proposals: [...r.proposals, proposal] });
      return Promise.resolve();
    });
    return proposal;
  }

  async proposeTicket(chat: ChatKey, input: TicketInput): Promise<ReplyProposal> {
    const title = input.title.replace(/\s+/g, " ").trim();
    if (!title) throw new Error("a new ticket needs a title");
    if (title.length > MAX_TICKET_TITLE) throw new Error(`a ticket's title is ${String(MAX_TICKET_TITLE)} characters at most`);
    const account = this.opts.accounts.get(input.account_id);
    if (account?.owner_agent_id !== chat.agent_id) throw new Error("this agent owns no such account");
    if (account.provider !== "jira") throw new Error("a new ticket goes on a Jira site");
    const jira = this.opts.jira?.(account.account_id);
    if (!jira) throw new Error("tickets cannot be created from this Mac");
    const wanted = input.project.trim().toLowerCase();
    const projects = await jira.projects();
    const project = projects.find((p) => p.key.toLowerCase() === wanted || p.name.toLowerCase() === wanted);
    if (!project)
      throw new Error(
        `you cannot create tickets in "${input.project}"; you can in ${projects.map((p) => `${p.key} (${inert(p.name)})`).join(", ") || "no project"}`,
      );
    const type = project.types.find((t) => t.name.toLowerCase() === input.type.trim().toLowerCase());
    if (!type) throw new Error(`${project.key} has no type "${input.type}"; it has ${project.types.map((t) => inert(t.name)).join(", ")}`);
    const parentKey = input.parent?.trim() || null;
    if (type.subtask && !parentKey) throw new Error(`a ${inert(type.name)} goes under a parent ticket: name it in \`parent\``);
    const given = (field: string): boolean => {
      switch (field) {
        case "project":
        case "issuetype":
        case "summary":
        case "reporter":
          return true;
        case "description":
          return !!input.description.trim();
        case "assignee":
          return !!input.assignee?.trim();
        case "priority":
          return !!input.priority?.trim();
        case "labels":
          return (input.labels ?? []).some((l) => l.trim());
        case "parent":
          return !!parentKey;
        default:
          return false;
      }
    };
    const fields = await jira.formFields(project.key, type.id);
    const missing = fields.filter((f) => f.required && !f.has_default && !given(f.id));
    const settable = missing.filter((f) => TICKET_FIELDS.has(f.id));
    if (settable.length) throw new Error(`${project.key} needs ${settable.map((f) => inert(f.name)).join(", ")} on a ${inert(type.name)}: give it`);
    if (missing.length)
      throw new Error(
        `${project.key} needs ${missing.map((f) => inert(f.name)).join(", ")} on a ${inert(type.name)}, which loki cannot set: the person can create that ticket in Jira`,
      );
    const parent = parentKey
      ? (
          await jira.ticketFacts(parentKey).catch((err: unknown) => {
            if (err instanceof JiraError && err.code === "not_found") return null;
            throw err;
          })
        )?.key
      : null;
    if (parentKey && !parent) throw new Error(`there is no ticket ${parentKey} that you can see to put it under`);
    let assignee: ReplyMention | null = null;
    if (input.assignee?.trim()) {
      const people = this.opts.people;
      if (!people) throw new Error("people cannot be found on this Mac: leave out the assignee");
      const found = await people.resolve(account.account_id, input.assignee.trim().replace(/^@/, ""), { jira: { kind: "assignee", project: project.key } });
      if (!found.ok) throw new Error(found.why);
      if (found.person.provider !== "jira") throw new Error("a ticket's assignee is a person of the Jira site");
      assignee = { display: found.person.display, id: found.person.id, address: null };
    }
    let priority: { id: string; name: string } | null = null;
    if (input.priority?.trim()) {
      const priorities = await jira.priorities();
      const p = priorities.find((x) => x.name.toLowerCase() === input.priority?.trim().toLowerCase());
      if (!p) throw new Error(`there is no priority "${input.priority}"; there are ${priorities.map((x) => inert(x.name)).join(", ")}`);
      priority = p;
    }
    const labels = [...new Set((input.labels ?? []).map((l) => l.trim()).filter(Boolean))];
    if (labels.some((l) => /\s/.test(l))) throw new Error("a Jira label has no spaces");
    const { text, mentions } = await this.mentioned(account, { thread_id: "", place: null }, input.description, input.mentions ?? [], {
      kind: "project",
      project: project.key,
    });
    const proposal: ReplyProposal = {
      id: this.opts.newId?.() ?? `reply-${randomUUID()}`,
      account_id: account.account_id,
      provider: "jira",
      account_label: accountLabel(account),
      thread_id: "",
      subject: title,
      to: [],
      cc: [],
      place: `a new ${type.name} in ${project.name}`,
      text,
      status: "pending",
      reason: null,
      created_at: this.now(),
      kind: "ticket",
      ticket: { project: project.key, project_name: project.name, type_id: type.id, type_name: type.name, assignee, priority, labels, parent: parent ?? null },
      ...(mentions.length ? { mentions } : {}),
    };
    await this.locked(chat, () => {
      const r = this.record(chat);
      this.save(chat, { ...r, proposals: [...r.proposals, proposal] });
      return Promise.resolve();
    });
    return proposal;
  }

  private async mentioned(
    account: AccountRecord,
    where: { thread_id: string; place: string | null },
    text: string,
    entries: readonly string[],
    scope?: JiraUserScope,
  ): Promise<{ text: string; mentions: ReplyMention[] }> {
    const wanted = [...new Set(entries.map((e) => e.trim().replace(/^@/, "")).filter(Boolean))];
    if (wanted.length === 0) return { text, mentions: [] };
    const people = this.opts.people;
    if (!people) throw new Error("mentions cannot be resolved on this Mac: write the reply without them");
    const standing = new Set(
      mentionSpans(
        text,
        wanted.map((display) => ({ display })),
      ).map((s) => s.mention.display.toLowerCase()),
    );
    const resolved: Array<{ display: string; mention: ReplyMention }> = [];
    const mentions: ReplyMention[] = [];
    for (const entry of wanted) {
      if (!standing.has(entry.toLowerCase())) throw new Error(`@${entry} is not in the text: write it there as @${entry}, or leave it out of mentions`);
      const jira = account.provider !== "jira" ? {} : scope ? { jira: scope } : where.place ? { jira: { kind: "ticket" as const, ticket: where.place } } : {};
      const found = await people.resolve(account.account_id, entry, jira);
      if (!found.ok) throw new Error(found.why);
      const person = found.person;
      const mention: ReplyMention =
        person.provider === "gmail"
          ? { display: person.display, id: null, address: person.address }
          : { display: person.display, id: person.id, address: null };
      resolved.push({ display: entry, mention });
      if (!mentions.some((m) => m.display === mention.display && m.id === mention.id && m.address === mention.address)) mentions.push(mention);
    }
    const out = writeMentions(
      text,
      resolved,
      (t) => t,
      (r) => `@${r.mention.display}`,
    ).join("");
    if (account.provider === "slack" && this.opts.members && where.thread_id) {
      const members = await this.opts.members(account.account_id, slackPlace(where.thread_id).channel).catch(() => null);
      if (members) return { text: out, mentions: mentions.map((m) => (m.id && !members.has(m.id) ? { ...m, not_member: true } : m)) };
    }
    return { text: out, mentions };
  }

  async findPeople(chat: ChatKey, id: string, query: string): Promise<{ people: ReplyPersonChoice[]; notice: string | null }> {
    const p = this.record(chat).proposals.find((x) => x.id === id);
    if (!p) throw new Error(`no reply ${id} in this chat`);
    const people = this.opts.people;
    if (!people) return { people: [], notice: "people cannot be found on this Mac" };
    const scope =
      p.kind === "ticket" && p.ticket
        ? { jira: { kind: "project" as const, project: p.ticket.project } }
        : p.provider === "jira" && p.place
          ? { jira: { kind: "ticket" as const, ticket: p.place } }
          : {};
    const found = await people.find(p.account_id, query, scope);
    const choices = found.people
      .slice(0, PICKER_MAX)
      .map((f): ReplyPersonChoice =>
        f.provider === "gmail"
          ? { display: f.display, id: null, address: f.address, detail: f.detail }
          : { display: f.display, id: f.id, address: null, detail: f.detail },
      );
    if (p.provider !== "slack" || !this.opts.members || choices.length === 0) return { people: choices, notice: found.notice };
    const members = await this.opts.members(p.account_id, slackPlace(p.thread_id).channel).catch(() => null);
    if (!members) return { people: choices, notice: found.notice };
    return { people: choices.map((c) => (c.id && !members.has(c.id) ? { ...c, not_member: true } : c)), notice: found.notice };
  }

  list(chat: ChatKey): ReplyProposal[] {
    return this.record(chat).proposals;
  }

  open(chat: ChatKey): ReplyProposal[] {
    return this.list(chat).filter(isOpen);
  }

  decide(chat: ChatKey, id: string, action: ReplyAction, by: string, opts: ReplyDecideOptions = {}): Promise<ReplyDecided> {
    switch (action) {
      case "reject":
        return this.settle(chat, id, "rejected", by, (p) => {
          const service = p.kind === "ticket" ? "Jira" : "Slack";
          const maybe = (p.kind === "dm" || p.kind === "ticket") && p.outbox_id ? ` It may have reached ${service} before: the person was asked to look.` : "";
          return `The person rejected ${whatWords(p)} in ${p.account_label}: nothing was sent.${maybe}`;
        });
      case "undo":
        return this.undo(chat, id);
      case "approve":
        return this.send(chat, id, by, opts);
    }
  }

  takeNotices(chat: ChatKey): string[] {
    const r = this.chats.get(keyOf(chat));
    if (!r?.notices.length) return [];
    this.save(chat, { ...r, notices: [] }, false);
    return r.notices;
  }

  sent(held: HeldReply, result: string | null = null): void {
    const proposal = held.proposal;
    if (!proposal) return;
    void this.report(proposal, held.outbox_id, (p) => {
      if (p.status !== "sending" || p.outbox_id !== held.outbox_id) return null;
      const next: ReplyProposal = { ...p, status: "sent", reason: null, decided_at: this.now(), ...(result ? { result } : {}) };
      log("replies:sent", { provider: next.provider, files: next.attachments?.length ?? 0 });
      return { next, notice: sentNotice(next) };
    });
  }

  notSent(held: HeldReply, note: { reason: string; at: string }, people: PeopleChanged | null): void {
    const proposal = held.proposal;
    if (!proposal) return;
    void this.report(proposal, held.outbox_id, (p) => {
      if (p.status !== "sending" || p.outbox_id !== held.outbox_id) return null;
      const onTicket = p.provider === "jira" && p.attached?.length ? `; ${p.attached.join(", ")} already on the ticket` : "";
      const next: ReplyProposal = {
        ...p,
        status: "pending",
        reason: `${note.reason}${onTicket}`,
        decided_by: null,
        decided_at: null,
        ...((p.kind === "dm" || p.kind === "ticket") && !mayHaveGone(note.reason) ? { outbox_id: null } : {}),
      };
      log("replies:not-sent", { provider: p.provider, people: people !== null });
      return { next: people ? { ...next, to: people.to, cc: people.cc, people_added: people.added, people_removed: people.removed } : next, notice: null };
    });
  }

  attached(proposal: HeldProposal, names: string[]): void {
    const chat = { agent_id: proposal.agent_id, conversation_id: proposal.conversation_id };
    void this.locked(chat, () => {
      const r = this.record(chat);
      const p = r.proposals.find((x) => x.id === proposal.proposal_id);
      if (p) {
        const next = { ...p, attached: [...new Set([...(p.attached ?? []), ...names])] };
        this.save(chat, { ...r, proposals: r.proposals.map((x) => (x.id === p.id ? next : x)) });
      }
      return Promise.resolve();
    }).catch((err: unknown) => log("replies:report-failed", messageOf(err)));
  }

  private async report(
    proposal: HeldProposal,
    outboxId: string,
    fn: (p: ReplyProposal) => { next: ReplyProposal; notice: string | null } | null,
  ): Promise<void> {
    const chat = { agent_id: proposal.agent_id, conversation_id: proposal.conversation_id };
    try {
      await this.locked(chat, () => {
        const r = this.record(chat);
        const p = r.proposals.find((x) => x.id === proposal.proposal_id);
        const out = p ? fn(p) : null;
        if (out) {
          this.save(chat, { ...r, proposals: r.proposals.map((x) => (x.id === out.next.id ? out.next : x)) });
          if (out.notice) this.notify(chat, out.notice);
        }
        return Promise.resolve();
      });
      this.opts.outside.acknowledge(outboxId);
    } catch (err) {
      log("replies:report-failed", messageOf(err));
    }
  }

  private send(chat: ChatKey, id: string, by: string, opts: ReplyDecideOptions): Promise<ReplyDecided> {
    const edited = opts.text?.trim() ? (opts.text ?? "") : null;
    return this.locked(chat, async () => {
      const r = this.record(chat);
      const p = r.proposals.find((x) => x.id === id);
      if (!p) throw new Error(`no reply ${id} in this chat`);
      const put = (next: ReplyProposal, done: boolean, message: string | null): ReplyDecided => {
        this.save(chat, { ...r, proposals: r.proposals.map((x) => (x.id === id ? next : x)) });
        return { proposal: next, done, message };
      };
      if (p.status !== "pending") return { proposal: p, done: false, message: settledWords(p) };
      const account = this.opts.accounts.get(p.account_id);
      if (account && account.owner_agent_id !== chat.agent_id) {
        const out = put({ ...p, status: "withdrawn", reason: null, decided_by: "loki", decided_at: this.now() }, false, MOVED);
        this.notify(chat, movedNotice(out.proposal));
        return out;
      }
      const refused = !account
        ? "that account is not connected on this Mac"
        : account.status !== "connected"
          ? causeWords(account.status.disconnected, account.provider)
          : null;
      if (refused || !account) return put({ ...p, reason: refused }, false, refused);
      const kept = (p.attachments ?? []).filter((f) => !opts.files || opts.files.includes(f.name));
      const text = edited ?? p.text;
      const title = p.kind === "ticket" && opts.title?.trim() ? opts.title.replace(/\s+/g, " ").trim() : null;
      const mentions = liveMentions(text, lastByName(uniqueMentions([...(p.mentions ?? []), ...(opts.mentions ?? [])])));
      const edits = withMentionList(
        withoutPeopleMarks(withFiles({ ...p, ...(edited ? { text: edited } : {}), ...(title ? { subject: title } : {}) }, kept)),
        mentions,
      );
      try {
        await checkedFiles(kept);
      } catch (err) {
        return put({ ...edits, reason: messageOf(err) }, false, messageOf(err));
      }
      if ((p.kind === "dm" || p.kind === "ticket") && p.outbox_id) {
        const where = p.kind === "ticket" ? `the ${p.ticket?.project ?? "Jira"} project in Jira` : "Slack";
        const why = `it may have gone: look in ${where}, and reject this and ask again if it did not`;
        return put({ ...edits, reason: why }, false, why);
      }
      if (p.provider === "gmail" && p.outbox_id) {
        const went = await this.opts.outside.wentOutIn(p.account_id, p.thread_id, p.outbox_id, targetOf(p, account, p.outbox_id)).catch(() => null);
        if (went === null) {
          const why = "the thread could not be read to check the last send did not go: try again";
          return put({ ...edits, reason: why }, false, why);
        }
        if (went) {
          const out = put({ ...p, status: "sent", reason: null, decided_by: by, decided_at: this.now() }, true, null);
          this.notify(chat, sentNotice(out.proposal));
          return out;
        }
      }
      const before = p.provider === "jira" ? new Set(p.attached ?? []) : new Set<string>();
      const outboxId = `reply-send-${randomUUID()}`;
      try {
        this.opts.outside.holdAgentReply({
          outbox_id: outboxId,
          account_id: p.account_id,
          thread_id: p.thread_id,
          text: edits.text,
          files: kept.filter((f) => !before.has(f.name)),
          attached: kept.filter((f) => before.has(f.name)).map((f) => f.name),
          people: p.provider === "gmail" ? { to: p.to, cc: p.cc } : null,
          proposal: { agent_id: chat.agent_id, conversation_id: chat.conversation_id, proposal_id: p.id },
          mentions,
          ...(p.kind ? { target: targetOf(edits, account, outboxId) } : {}),
        });
      } catch (err) {
        return put({ ...edits, reason: messageOf(err) }, false, messageOf(err));
      }
      log("replies:sending", { provider: p.provider, files: kept.length });
      return put({ ...edits, status: "sending", reason: null, outbox_id: outboxId, decided_by: by, decided_at: null }, true, null);
    });
  }

  private undo(chat: ChatKey, id: string): Promise<ReplyDecided> {
    return this.change(chat, id, (p) => {
      if (p.status === "pending") return { done: false, message: "that reply is not being sent" };
      if (p.status !== "sending") return { done: false, message: settledWords(p) };
      if (!this.opts.outside.unsend(p.account_id, p.outbox_id ?? "")) return { done: false, message: "it is already going, too late to undo" };
      log("replies:undone", { provider: p.provider });
      return { done: true, message: null, next: { ...p, status: "pending", reason: null, outbox_id: null, decided_by: null, decided_at: null } };
    });
  }

  private async files(paths: readonly string[]): Promise<ReplyAttachment[]> {
    if (paths.length === 0) return [];
    if (paths.length > MAX_REPLY_FILES) throw new Error(`a reply carries ${String(MAX_REPLY_FILES)} files at most`);
    const files = await Promise.all(
      paths.map(async (path) => {
        const data = await readFile(path).catch(() => {
          throw new Error(`there is no file ${basename(path)} in this chat's folder`);
        });
        return { name: basename(path), path, size: data.length, md5: md5(data) };
      }),
    );
    const total = files.reduce((n, f) => n + f.size, 0);
    if (total > MAX_REPLY_BYTES) throw new Error(`the files come to ${bytesWords(total)}, and a reply carries ${bytesWords(MAX_REPLY_BYTES)} at most`);
    return files;
  }

  private async withdrawMoved(accountId: string, from: string): Promise<void> {
    for (const chat of [...this.chats.values()].filter((c) => c.agent_id === from)) {
      for (const p of this.record(chat).proposals.filter((x) => x.account_id === accountId && x.status === "pending"))
        await this.settle(chat, p.id, "withdrawn", "loki", movedNotice);
    }
  }

  private async settle(
    chat: ChatKey,
    id: string,
    status: "rejected" | "withdrawn",
    by: string,
    notice: ((p: ReplyProposal) => string) | null,
  ): Promise<ReplyDecided> {
    const out = await this.change(chat, id, (p) =>
      p.status === "pending"
        ? { done: true, message: null, next: { ...p, status, reason: null, decided_by: by, decided_at: this.now() } }
        : { done: false, message: settledWords(p) },
    );
    if (out.done && notice) this.notify(chat, notice(out.proposal));
    return out;
  }

  private notify(chat: ChatKey, notice: string): void {
    const r = this.chats.get(keyOf(chat)) ?? { ...chat, proposals: [], notices: [] };
    this.save(chat, { ...r, notices: [...r.notices, notice] }, false);
  }

  private change(chat: ChatKey, id: string, fn: (p: ReplyProposal) => { done: boolean; message: string | null; next?: ReplyProposal }): Promise<ReplyDecided> {
    return this.locked(chat, () => {
      const r = this.record(chat);
      const found = r.proposals.find((p) => p.id === id);
      if (!found) throw new Error(`no reply ${id} in this chat`);
      const out = fn(found);
      const next = out.next;
      if (next) this.save(chat, { ...r, proposals: r.proposals.map((p) => (p.id === id ? next : p)) });
      return Promise.resolve({ proposal: next ?? found, done: out.done, message: out.message });
    });
  }

  private record(chat: ChatKey): ChatRecord {
    const r = this.chats.get(keyOf(chat)) ?? { agent_id: chat.agent_id, conversation_id: chat.conversation_id, proposals: [], notices: [] };
    const left = (p: ReplyProposal) => p.status === "sending" && !this.opts.outside.holds(p.outbox_id ?? "");
    return { ...r, proposals: r.proposals.map((p) => (left(p) ? { ...p, status: "pending", reason: MAY_HAVE_GONE, decided_by: null } : p)) };
  }

  private save(chat: ChatKey, record: ChatRecord, told = true): void {
    this.chats.set(keyOf(chat), record);
    writeJsonAtomic(this.opts.file, { version: 1, chats: [...this.chats.values()] }, { pretty: true, newline: true, mode: 0o600 });
    if (!told) return;
    this.opts.push(chat.agent_id, chat.conversation_id, [{ kind: "reply_proposals", proposals: record.proposals.filter(isOpen) }]);
    this.opts.changed?.();
  }

  private locked<T>(chat: ChatKey, work: () => Promise<T>): Promise<T> {
    return this.locks(keyOf(chat), work);
  }

  private now(): string {
    return (this.opts.now?.() ?? new Date()).toISOString();
  }
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

function sentNotice(p: ReplyProposal): string {
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

function proposalLine(p: ReplyProposal): string {
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

export function registerReplyTools(api: ModApi, deps: { accounts: Pick<Accounts, "ownedBy">; replies: ReplyProposals }): Array<() => void> {
  const tools = toolRegistrar(api);
  const failed = (content: string) => ({ status: "error", content });
  const forAgent = (agentId: string) => deps.accounts.ownedBy(agentId).length > 0;
  const chatOf = (ctx: { agent: { id: string }; conversation: { id: string } }): ChatKey => ({ agent_id: ctx.agent.id, conversation_id: ctx.conversation.id });

  const propose: LokiTool = {
    name: "reply_propose",
    forAgent,
    description:
      "Propose a reply in a thread of an account you own: one the person handed to this chat, or one a script found " +
      "(flow_list, google_gmail_search, google_gmail_read, slack_read, jira_read). The person reviews it on a card, may edit " +
      "it or take its files off, and sends it from there as themselves; you cannot send it, and nothing goes before their " +
      "Send. It goes to the thread's own people (Gmail: reply-all to the newest message, with the person's signature; " +
      "Slack: the same conversation and thread; a channel or DM id, or #channel, posts a new message at the top of it, and " +
      "you then hear its `channel:ts` to answer in its thread), and to no one else but " +
      "the people in `mentions`. On a Jira site it is a comment on any ticket you can see, its files attached to the ticket. The thread " +
      "need not be in Flow. " +
      "You hear what became of it with the next message.",
    parameters: {
      type: "object",
      properties: {
        account: { type: "string", description: "The account's id or name, from the prompt's list of your accounts, a script or the hand-off." },
        thread: {
          type: "string",
          description:
            "The thread: Gmail's thread id (from the hand-off or a script); Slack's `channel:ts`, a channel or DM id, a message link or #channel; Jira's ticket key, id or link.",
        },
        text: { type: "string", description: "The reply, as plain text. Write each person in `mentions` into it as @<entry>." },
        mentions: {
          type: "array",
          items: { type: "string" },
          description:
            "People to mention, each as written after its @ in the text: a full name, an address, a Slack handle, or a token a refusal gave; a script's people_find looks them up first. Slack and Jira notify them; Gmail adds them to cc. A name that matches several people or nobody is refused with who matched: ask the person which one they mean. Any other @ in the text stays plain text.",
        },
        attachments: {
          type: "array",
          items: { type: "string" },
          description: `Files for the reply to carry, as paths in this chat's folder; at most ${String(MAX_REPLY_FILES)}, ${bytesWords(MAX_REPLY_BYTES)} together. A file from another mail gets there with google_gmail_attachment first.`,
        },
      },
      required: ["account", "thread", "text"],
      additionalProperties: false,
    },
    async run(ctx) {
      const name = argText(ctx.args.account);
      const account = ownedAccount(deps.accounts, ctx.agent.id, name);
      if (!account) return failed(`this agent owns no account "${name}"`);
      const thread = argText(ctx.args.thread);
      if (!thread) return failed("reply_propose needs thread");
      try {
        const named = Array.isArray(ctx.args.attachments) ? ctx.args.attachments.map(argText).filter(Boolean) : [];
        const attachments = named.map((path) => inChatFolder(ctx, path));
        const p = await deps.replies.propose(chatOf(ctx), {
          account_id: account.account_id,
          thread_id: thread,
          text: argText(ctx.args.text),
          ...(attachments.length ? { attachments } : {}),
          ...(Array.isArray(ctx.args.mentions) ? { mentions: ctx.args.mentions.map(argText).filter(Boolean) } : {}),
        });
        log("tool:reply_propose", { agent: ctx.agent.id, provider: p.provider });
        return `Proposed ${p.id}: it waits for the person to review and send it.\n${proposalLine(p)}`;
      } catch (err) {
        return failed(messageOf(err));
      }
    },
  };

  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(argText).filter(Boolean) : []);
  const startNew: LokiTool = {
    name: "message_propose",
    forAgent,
    description:
      "Propose a new conversation from an account you own: a new email from a Gmail account (`to`, `cc`, `subject`), or a " +
      "new Slack DM (`people`, one to eight). Name each person by full name or address, a Slack handle, or a token a " +
      "refusal or a script's people_find gave; a name that fits several people or nobody is refused with who matched: ask " +
      "the person which one they mean. The person reviews it on a card, may edit its words or take its files off, and " +
      "sends it from there as themselves; you cannot send it, and nothing goes, and no DM is opened, before their Send. " +
      "To answer an existing thread, or post in a channel you are in, use reply_propose. You hear what became of it, and " +
      "the new thread to answer, with the next message.",
    parameters: {
      type: "object",
      properties: {
        account: { type: "string", description: "The account's id or name, from the prompt's list of your accounts." },
        to: { type: "array", items: { type: "string" }, description: "Gmail: whom the email goes to." },
        cc: { type: "array", items: { type: "string" }, description: "Gmail: whom it copies." },
        subject: { type: "string", description: "Gmail: the email's subject." },
        people: { type: "array", items: { type: "string" }, description: "Slack: the people of the new DM, one to eight." },
        text: { type: "string", description: "The message, as plain text. Write each person in `mentions` into it as @<entry>." },
        mentions: {
          type: "array",
          items: { type: "string" },
          description: "People to mention in the text, as for reply_propose: Slack notifies them; Gmail adds them to cc.",
        },
        attachments: {
          type: "array",
          items: { type: "string" },
          description: `Files to carry, as paths in this chat's folder; at most ${String(MAX_REPLY_FILES)}, ${bytesWords(MAX_REPLY_BYTES)} together.`,
        },
      },
      required: ["account", "text"],
      additionalProperties: false,
    },
    async run(ctx) {
      const name = argText(ctx.args.account);
      const account = ownedAccount(deps.accounts, ctx.agent.id, name);
      if (!account) return failed(`this agent owns no account "${name}"`);
      try {
        const attachments = strings(ctx.args.attachments).map((path) => inChatFolder(ctx, path));
        const common = {
          account_id: account.account_id,
          text: argText(ctx.args.text),
          ...(attachments.length ? { attachments } : {}),
          mentions: strings(ctx.args.mentions),
        };
        if (account.provider === "jira") return failed("a Jira site starts no conversation here: comment on a ticket with reply_propose");
        const input: NewConversationInput =
          account.provider === "gmail"
            ? { ...common, kind: "email", to: strings(ctx.args.to), cc: strings(ctx.args.cc), subject: argText(ctx.args.subject) }
            : { ...common, kind: "dm", people: strings(ctx.args.people) };
        const p = await deps.replies.proposeNew(chatOf(ctx), input);
        log("tool:message_propose", { agent: ctx.agent.id, provider: p.provider, kind: p.kind ?? null });
        return `Proposed ${p.id}: it waits for the person to review and send it.\n${proposalLine(p)}`;
      } catch (err) {
        return failed(messageOf(err));
      }
    },
  };

  const newTicket: LokiTool = {
    name: "ticket_propose",
    forAgent: (agentId) => deps.accounts.ownedBy(agentId).some((a) => a.provider === "jira"),
    description:
      "Propose a new Jira ticket on a site you own: `project` (its key or name) and `type` (an issue type of it, as jira_projects lists), a " +
      "`title` and a `description`, and if wanted an `assignee` (a full name or account id), a `priority`, `labels` and a `parent` " +
      "ticket's key (which a sub-task needs). A project that requires another field is refused with the field's name: the person creates " +
      "that ticket in Jira. The person reviews it on a card, may edit its title and description, and creates it from there as " +
      "themselves; you cannot create it, and nothing is made before their Send. You hear the new ticket's key with the next message.",
    parameters: {
      type: "object",
      properties: {
        account: { type: "string", description: "The Jira site's account id or name, from the prompt's list of your accounts." },
        project: { type: "string", description: "The project's key (OPS) or name." },
        type: { type: "string", description: "The issue type's name (Task, Bug, …)." },
        title: { type: "string", description: "The ticket's title." },
        description: { type: "string", description: "The description, as plain text. Write each person in `mentions` into it as @<entry>." },
        assignee: {
          type: "string",
          description: "Whom it is assigned to: a full name or a Jira account id; one who fits several is refused with who matched.",
        },
        priority: { type: "string", description: "A priority's name, as jira_projects lists them." },
        labels: { type: "array", items: { type: "string" }, description: "Labels, each one word." },
        parent: { type: "string", description: "The key of the ticket it goes under, which a sub-task needs." },
        mentions: { type: "array", items: { type: "string" }, description: "People to mention in the description, as for reply_propose: Jira notifies them." },
      },
      required: ["account", "project", "type", "title", "description"],
      additionalProperties: false,
    },
    async run(ctx) {
      const name = argText(ctx.args.account);
      const account = ownedAccount(deps.accounts, ctx.agent.id, name);
      if (!account) return failed(`this agent owns no account "${name}"`);
      try {
        const optional = (key: string) => (argText(ctx.args[key]) ? { [key]: argText(ctx.args[key]) } : {});
        const p = await deps.replies.proposeTicket(chatOf(ctx), {
          account_id: account.account_id,
          project: argText(ctx.args.project),
          type: argText(ctx.args.type),
          title: argText(ctx.args.title),
          description: argText(ctx.args.description),
          ...optional("assignee"),
          ...optional("priority"),
          ...optional("parent"),
          labels: strings(ctx.args.labels),
          mentions: strings(ctx.args.mentions),
        });
        log("tool:ticket_propose", { agent: ctx.agent.id });
        return `Proposed ${p.id}: it waits for the person to review and create it.\n${proposalLine(p)}`;
      } catch (err) {
        return failed(messageOf(err));
      }
    },
  };

  const disposers = [propose, startNew, newTicket].map((tool) => tools.register(tool));
  disposers.push(
    api.message.transform((m) => {
      const notices = deps.replies.takeNotices({ agent_id: m.agentId, conversation_id: m.chatId });
      if (notices.length === 0) return undefined;
      const block = notices.map((n) => `<system-reminder>${n}</system-reminder>`).join("\n");
      return typeof m.content === "string" ? `${m.content}\n\n${block}` : [...m.content, { type: "text", text: block }];
    }),
    api.prompt.section("replies", ({ agentId }) => {
      const owned = new Set(deps.accounts.ownedBy(agentId).map((a) => a.provider));
      if (owned.size === 0) return undefined;
      const start = [
        owned.has("gmail") || owned.has("slack") ? "to start a new email or Slack DM, use message_propose" : "",
        owned.has("jira") ? "to open a new Jira ticket, use ticket_propose" : "",
      ].filter(Boolean);
      return `To answer a thread in an account you own, handed to you, found with a script, or named by the person (an id, a link, a #channel, a Jira key), or to post in a channel you are in, use reply_propose${start.length ? `; ${start.join("; ")}` : ""}. Use \`attachments\` for files and \`mentions\` for the people a message should tell: the person reviews it on a card and sends it from there; you cannot send it. When a name fits several people, ask the person which one they mean. Never send mail, Slack messages or Jira comments any other way.`;
    }),
  );
  return disposers;
}

export function withRepliesOnOpen(backend: ChatBackend, replies: Pick<ReplyProposals, "open">): ChatBackend {
  const open = async (agentId: string, conversationId: string, mode: string | null): Promise<ChatState> => {
    const state = await backend.open(agentId, conversationId, mode);
    return { ...state, reply_proposals: replies.open({ agent_id: agentId, conversation_id: conversationId }) };
  };
  return new Proxy(backend, {
    get: (target, prop, receiver) => {
      if (prop === "open") return open;
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
