import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { ChatEvent } from "../core/attention/model.ts";
import { messageOf } from "../core/errors.ts";
import type { ReplyAttachment, ReplyMention, ReplyPersonChoice, ReplyProposal } from "../core/frame-types.ts";
import { lastByName, liveMentions, mentionSpans, writeMentions } from "../core/mentions.ts";
import type { ReplyAction, ReplyDecideOptions } from "../core/frames.ts";
import { keyedQueue } from "../core/serial.ts";
import type { AccountThreads } from "./account-threads.ts";
import { readReplyDestination, type ReplyReads } from "./account-ops/reply-reader.ts";
import { accountLabel, type AccountRecord, type Accounts } from "./accounts.ts";
import { inert } from "./account-ops/fence.ts";
import { md5 } from "./google-tools/core.ts";
import { causeWords } from "./handoff.ts";
import { readJson, writeJsonAtomic } from "./json-file.ts";
import { log } from "./log.ts";
import { slackPlace } from "./reply-addressing.ts";
import { MAX_DM_PEOPLE } from "./slack.ts";
import type { People } from "./people.ts";
import { JiraError, type JiraClient, type JiraUserScope } from "./jira.ts";
import type { HeldProposal, HeldReply } from "./mail-outbox.ts";
import type { AgentReplyReports, OutsideThreads, PeopleChanged } from "./outside-threads.ts";
import type { ChatKey } from "./suggestions.ts";
import {
  MAX_REPLY_BYTES,
  MAX_REPLY_FILES,
  MAX_TICKET_TITLE,
  MAY_HAVE_GONE,
  MOVED,
  PICKER_MAX,
  TICKET_FIELDS,
  andList,
  bytesWords,
  checkedFiles,
  isOpen,
  keyOf,
  mailboxOf,
  mayHaveGone,
  movedNotice,
  parseChat,
  sentNotice,
  settledWords,
  targetOf,
  uniqueMentions,
  whatWords,
  withFiles,
  withMentionList,
  withoutPeopleMarks,
  type ChatRecord,
  type NewConversationInput,
  type ReplyInput,
  type TicketInput,
} from "./reply-proposal-format.ts";

export {
  MAX_REPLY_BYTES,
  MAX_REPLY_FILES,
  MAY_HAVE_GONE,
  checkedFiles,
  bytesWords,
  type NewConversationInput,
  type ReplyInput,
  type TicketInput,
} from "./reply-proposal-format.ts";
export { registerReplyTools, withRepliesOnOpen } from "./reply-proposal-tools.ts";

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
      if (change.kind === "moved")
        void this.withdrawMoved(change.account_id, change.from).catch((err: unknown) => log.error("replies:move-failed", messageOf(err)));
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
      log.error("replies:not-sent", { provider: p.provider, people: people !== null });
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
    }).catch((err: unknown) => log.error("replies:report-failed", messageOf(err)));
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
      log.error("replies:report-failed", messageOf(err));
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
      const words = p.kind === "ticket" && opts.text != null ? opts.text : edited;
      const text = words ?? p.text;
      const title = p.kind === "ticket" && opts.title?.trim() ? opts.title.replace(/\s+/g, " ").trim() : null;
      const mentions = liveMentions(text, lastByName(uniqueMentions([...(p.mentions ?? []), ...(opts.mentions ?? [])])));
      const proposedText = words !== null && words !== p.text ? (p.proposed_text ?? p.text) : p.proposed_text;
      const proposedSubject = title !== null && title !== p.subject ? (p.proposed_subject ?? p.subject) : p.proposed_subject;
      const edits = withMentionList(
        withoutPeopleMarks(
          withFiles(
            {
              ...p,
              ...(words !== null ? { text: words } : {}),
              ...(title ? { subject: title } : {}),
              ...(proposedText !== undefined ? { proposed_text: proposedText } : {}),
              ...(proposedSubject !== undefined ? { proposed_subject: proposedSubject } : {}),
            },
            kept,
          ),
        ),
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
