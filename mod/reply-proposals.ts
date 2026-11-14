import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { ChatEvent } from "../core/attention/model.ts";
import { messageOf } from "../core/errors.ts";
import type { ReplyAttachment, ReplyProposal, ReplyProposalStatus } from "../core/frame-types.ts";
import type { ChatState, ReplyAction, ReplyDecideOptions } from "../core/frames.ts";
import { splitMailboxes } from "../core/mail-header.ts";
import { keyedQueue } from "../core/serial.ts";
import type { ModApi } from "../daemon/mods/api.ts";
import type { AccountThreads, ThreadRecord } from "./account-threads.ts";
import { accountLabel, ownedAccount, type AccountRecord, type Accounts } from "./accounts.ts";
import type { ChatBackend } from "./frames/chat.ts";
import { type GmailClient, type GmailMessage } from "./gmail.ts";
import { GoogleError } from "./google-auth.ts";
import { inert } from "./account-ops/fence.ts";
import { inChatFolder, md5 } from "./google-tools/core.ts";
import { causeWords } from "./handoff.ts";
import { readJson, writeJsonAtomic } from "./json-file.ts";
import { log } from "./log.ts";
import type { HeldProposal, HeldReply } from "./mail-outbox.ts";
import type { AgentReplyReports, OutsideThreads, PeopleChanged } from "./outside-threads.ts";
import type { SlackClient } from "./slack.ts";
import type { ChatKey } from "./suggestions.ts";
import { argText, toolRegistrar, type LokiTool } from "./tools.ts";

/**
 * Reply proposals (plan 067, U10, KTD9; plan 071; plan 2026-11-14-1134): a reply the owning agent writes in a thread of
 * its own account reaches the person as a card, in every permission mode, and only their Send sends it: held 10
 * seconds with Undo in the outbox the person's own replies use (mod/outside-threads.ts, KTD1), then sent in that same
 * thread as the person. The agent has no way to send (R14). It names the thread, the text and files from its chat's
 * folder, never who it goes to: a Gmail reply goes to all of the newest message's people but the person, exactly as
 * the card showed them (a change stops it, KTD4), a Slack reply into the same conversation and thread, a Jira comment
 * onto the ticket, so a stranger's mail that asks the agent to send something elsewhere can at most yield a reply to
 * the thread's own people.
 *
 * Each chat's proposals live in `state/reply-proposals.json`, beside the notices its agent has yet to read. A proposal
 * moves from pending to sending, and from there to sent, or back to pending on Undo or a send that did not go; or from
 * pending to rejected or withdrawn. Each step is taken under its chat's lock, so the first action wins and a second is
 * told what already happened, as a suggestion's are (mod/suggestions.ts). Send answers at once; what became of the
 * reply reaches every client as the chat's `reply_proposals` event (KTD3).
 */

/** What reading the thread for a Gmail card needs of the mailbox's client: the thread and the person's own addresses. */
export type ReplyGmail = Pick<GmailClient, "getThread" | "sendAsAddresses">;
/** What naming a Slack card's place needs of the workspace's client: a conversation's name. */
export type ReplySlack = Pick<SlackClient, "conversationsInfo">;
/** An account's client for reading where a reply goes, by its provider. A Jira ticket's place comes from its card's record. */
export type ReplyClient = { provider: "gmail"; client: ReplyGmail } | { provider: "slack"; client: ReplySlack } | { provider: "jira" };

/** What the proposals are built from. `now` and `newId` exist for tests. */
export interface ReplyProposalsOptions {
  /** `state/reply-proposals.json`. */
  file: string;
  accounts: Pick<Accounts, "get" | "onChange">;
  threads: Pick<AccountThreads, "get" | "list">;
  clientFor(account: AccountRecord): ReplyClient;
  /** The person's send path (KTD1): the hold, its undo, and what the outbox still has and whether a reply went. */
  outside: Pick<OutsideThreads, "holdAgentReply" | "unsend" | "holds" | "wentOutIn" | "acknowledge">;
  /** Tell every client following a chat what its open proposals now are. */
  push(agentId: string, conversationId: string, events: ChatEvent[]): void;
  /** The lists should be read again: a chat's card is blocked, or no longer. */
  changed?(): void;
  now?(): Date;
  newId?(): string;
}

/** What an action left: the proposal as it now stands, whether it took, and why not. */
export interface ReplyDecided {
  proposal: ReplyProposal;
  done: boolean;
  message: string | null;
}

/** A reply as the agent proposes it: the account, a thread of that account, and the text. Nothing names a recipient. */
export interface ReplyInput {
  account_id: string;
  thread_id: string;
  text: string;
  /** Full paths of files for the reply to carry, already found inside the chat's folder (R8). */
  attachments?: string[];
}

/** The most files one reply carries (R8). */
export const MAX_REPLY_FILES = 10;
/**
 * The most bytes a reply's files come to together (R8): Gmail's 25 MB counts the encoded message, and files grow about
 * a third when encoded, so 17 MB of files is what fits.
 */
export const MAX_REPLY_BYTES = 17 * 1024 * 1024;

/** A size as the agent and the person read it: "482 KB", "3.1 MB". */
export function bytesWords(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/**
 * A reply's files read once, each checked against the MD5 it had when the reply was proposed (KTD5): the bytes checked
 * are the bytes a send hands on, so a file changed after the check cannot go out. Throws naming the first file that
 * changed or is gone (R10).
 */
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
  /** What the chat's agent is told with the next message in it: replies sent, rejected or withdrawn. */
  notices: string[];
}

/** The statuses a stored proposal may have; a `drafted` one is settled from before replies were sent (KTD3). */
const STATUSES: readonly ReplyProposalStatus[] = ["pending", "sending", "sent", "drafted", "rejected", "withdrawn"];
/** What a reply stored as sending, that the outbox no longer has, says on its card (KTD9, step 4). */
export const MAY_HAVE_GONE = "it may have gone: check the thread before sending again";

/** The statuses that still show on the card: waiting on the person, or held for its undo and being sent. */
const isOpen = (p: ReplyProposal) => p.status === "pending" || p.status === "sending";

/** Who settled a proposal, as a refused action says it. */
const byWords = (by: string | null | undefined) => (by === "phone" || by === "desktop" ? `the ${by}` : by || "another device");

/** What a second action is told: what already happened (R17's rule for suggestions, kept here too). */
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

/** What the agent is told when its reply goes because the account moved to another agent (U10, step 7). */
const movedNotice = (p: ReplyProposal): string =>
  `${p.account_label} moved to another agent, so your reply in thread ${p.thread_id} was withdrawn: nothing was sent.`;
/** What the person is told when they send a reply whose account moved since. */
const MOVED = "that account moved to another agent: this reply was withdrawn";

/** A Gmail message's header by name, any case; "" when it has none. */
export const headerOf = (m: GmailMessage | undefined, name: string): string =>
  m?.payload?.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

/** An address header's people, each as written ("Grace <grace@acme.com>") and by its bare address, lower case. */
function people(header: string): Array<{ text: string; address: string }> {
  return splitMailboxes(header).flatMap((text) => {
    // The address is the last <…>: a display name may hold angle brackets of its own, quoted.
    const address = ([...text.matchAll(/<([^<>]+)>/g)].at(-1)?.[1] ?? text).trim().toLowerCase();
    return address.includes("@") ? [{ text, address }] : [];
  });
}

/**
 * Who a reply to all of a message goes to (KTD9): its sender and everyone it was to, and everyone it copied, never the
 * person's own addresses and nobody twice. A message the person wrote themselves is answered to whom it went.
 */
export function replyAllOf(message: GmailMessage | undefined, own: readonly string[]): { to: string[]; cc: string[] } {
  const { mine, fromMe, sender } = whoWrote(message, own);
  const seen = new Set<string>();
  const keep = (list: Array<{ text: string; address: string }>) =>
    list.filter((p) => !mine.has(p.address) && !seen.has(p.address) && seen.add(p.address)).map((p) => p.text);
  const to = keep([...(fromMe ? [] : sender), ...people(headerOf(message, "To"))]);
  return { to, cc: keep(people(headerOf(message, "Cc"))) };
}

/**
 * Who a reply to all of `message` would reach now that the proposal did not name, and whom it named that it would no
 * longer reach (KTD4), by bare address in lower case, To and Cc together: a new display name or another order is not a
 * change. Both lists are empty when the people are the same, and the send at the end of the hold goes only then.
 */
export function peopleChange(
  message: GmailMessage | undefined,
  own: readonly string[],
  proposal: { to: readonly string[]; cc: readonly string[] },
): { added: string[]; removed: string[] } {
  const bare = (list: readonly string[]) => new Set(list.flatMap((t) => people(t).map((p) => p.address)));
  const { to, cc } = replyAllOf(message, own);
  const now = bare([...to, ...cc]);
  const was = bare([...proposal.to, ...proposal.cc]);
  return { added: [...now].filter((a) => !was.has(a)), removed: [...was].filter((a) => !now.has(a)) };
}

/**
 * Who a reply to the sender alone goes to (plan 076): whom the message asks replies to go to (Reply-To), else its
 * sender; a message the person wrote themselves is answered to whom it went, as Gmail does.
 */
export function replyOf(message: GmailMessage | undefined, own: readonly string[]): { to: string[]; cc: string[] } {
  const { mine, fromMe, sender } = whoWrote(message, own);
  const seen = new Set<string>();
  const to = (fromMe ? people(headerOf(message, "To")) : sender).filter((p) => !mine.has(p.address) && !seen.has(p.address) && seen.add(p.address));
  return { to: to.map((p) => p.text), cc: [] };
}

/** The person's addresses, whether they wrote the message, and whom a reply to its writer goes to: its Reply-To, else its From. */
function whoWrote(message: GmailMessage | undefined, own: readonly string[]) {
  const mine = new Set(own.map((a) => a.toLowerCase()));
  const from = people(headerOf(message, "From"));
  const fromMe = from.length > 0 && from.every((p) => mine.has(p.address));
  const replyTo = people(headerOf(message, "Reply-To"));
  return { mine, fromMe, sender: replyTo.length ? replyTo : from };
}

/** People as the agent is told of them: bare addresses, since a display name is the sender's own writing. */
const addresses = (list: readonly string[]): string => inert(list.flatMap((t) => people(t).map((p) => p.address)).join(", "));

/**
 * The message a reply answers: the newest in the thread by Gmail's time that is not one of the person's own drafts, so
 * an unsent draft never sets who the reply goes to or what it replies to (KTD9).
 */
export function replyTarget(messages: readonly GmailMessage[]): GmailMessage | undefined {
  return messages
    .filter((m) => !m.labelIds.includes("DRAFT"))
    .sort((a, b) => Number(a.internalDate) - Number(b.internalDate))
    .at(-1);
}

/** A reply's subject: the message's own, with one "Re:" in front. */
export const replySubject = (subject: string): string => (/^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`.trim());

/** A Slack card's thread id as its place: a DM card's is its channel, an Activity card's `<channel>:<thread ts>`. */
export function slackPlace(threadId: string): { channel: string; ts: string | null } {
  const at = threadId.indexOf(":");
  return at < 0 ? { channel: threadId, ts: null } : { channel: threadId.slice(0, at), ts: threadId.slice(at + 1) };
}

function parseProposal(v: unknown): ReplyProposal | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  const s = (k: string) => (typeof r[k] === "string" ? r[k] : null);
  const id = s("id"),
    account = s("account_id"),
    thread = s("thread_id"),
    text = s("text");
  // One stored while its draft was written, before replies were sent (KTD3), waits on the person again.
  const status = r.status === "drafting" ? "pending" : STATUSES.find((x) => x === r.status);
  const provider = r.provider === "gmail" || r.provider === "slack" || r.provider === "jira" ? r.provider : null;
  if (!id || !account || !thread || text === null || !status || !provider) return null;
  const strings = (k: string) => (Array.isArray(r[k]) ? r[k].filter((x): x is string => typeof x === "string") : []);
  const files = Array.isArray(r.attachments) ? r.attachments.map(parseAttachment).filter((a): a is ReplyAttachment => a !== null) : [];
  const added = strings("people_added");
  const removed = strings("people_removed");
  const attached = strings("attached");
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

/** A proposal with its files as given: the field left out when there are none, as a proposal without files is stored. */
function withFiles(p: ReplyProposal, files: readonly ReplyAttachment[]): ReplyProposal {
  const { attachments: _was, ...rest } = p;
  return files.length ? { ...rest, attachments: [...files] } : rest;
}

/** A proposal without the marks of who joined or left its thread, which a new Send clears. */
function withoutPeopleMarks(p: ReplyProposal): ReplyProposal {
  const { people_added: _added, people_removed: _removed, ...rest } = p;
  return rest;
}

/** The reply proposals of every chat on this Mac, and the person's actions on them. */
export class ReplyProposals implements AgentReplyReports {
  private readonly opts: ReplyProposalsOptions;
  private readonly chats = new Map<string, ChatRecord>();
  /** One change at a time per chat. */
  private readonly locks = keyedQueue();
  private readonly stopMoves: () => void;

  constructor(opts: ReplyProposalsOptions) {
    this.opts = opts;
    const raw = readJson(opts.file);
    const list = typeof raw === "object" && raw !== null ? (raw as { chats?: unknown }).chats : null;
    for (const c of Array.isArray(list) ? list.map(parseChat) : []) if (c) this.chats.set(keyOf(c), c);
    // An account given to another agent takes its threads with it: the old owner's waiting replies go (U10, step 7).
    this.stopMoves = opts.accounts.onChange((change) => {
      if (change.kind === "moved") void this.withdrawMoved(change.account_id, change.from).catch((err: unknown) => log("replies:move-failed", messageOf(err)));
    });
  }

  /** Stop hearing the accounts. */
  stop(): void {
    this.stopMoves();
  }

  /**
   * A new reply, pending, for a thread of one of the chat's agent's accounts (R18, plan 071): handed to this chat, found
   * by search, or read. The account must be the agent's, connected or not; the people it goes to are read from the
   * thread now for the card, and checked again when it goes. A thread the account does not have is refused.
   */
  async propose(chat: ChatKey, input: ReplyInput): Promise<ReplyProposal> {
    if (!input.text.trim()) throw new Error("a reply needs text");
    const account = this.opts.accounts.get(input.account_id);
    if (account?.owner_agent_id !== chat.agent_id) throw new Error("this agent owns no such account");
    // Any thread of the agent's own account will do (plan 071): the person's Send on the card is the gate. A thread
    // found by search has no record here, so its subject comes from the thread itself. A Jira ticket is named by its
    // id or its key, which only a ticket that has had a card can be found by (R28, KTD7).
    const files = await this.files(input.attachments ?? []);
    const record = account.provider === "jira" ? this.ticketRecord(account, input.thread_id) : this.opts.threads.get(input.account_id, input.thread_id);
    const threadId = record?.thread_id ?? input.thread_id;
    const where = await this.where(account, threadId, record?.subject_or_first_line ?? "");
    const proposal: ReplyProposal = {
      id: this.opts.newId?.() ?? `reply-${randomUUID()}`,
      account_id: account.account_id,
      provider: account.provider,
      account_label: accountLabel(account),
      thread_id: threadId,
      subject: where.subject,
      to: where.to,
      cc: where.cc,
      place: where.place,
      text: input.text,
      status: "pending",
      reason: null,
      created_at: this.now(),
      ...(files.length ? { attachments: files } : {}),
    };
    await this.locked(chat, () => {
      const r = this.record(chat);
      this.save(chat, { ...r, proposals: [...r.proposals, proposal] });
      return Promise.resolve();
    });
    return proposal;
  }

  /** A chat's proposals, settled ones included, oldest first. */
  list(chat: ChatKey): ReplyProposal[] {
    return this.record(chat).proposals;
  }

  /** A chat's proposals that still show on its card, as a client opening it and the Inbox list read them. */
  open(chat: ChatKey): ReplyProposal[] {
    return this.list(chat).filter(isOpen);
  }

  /**
   * The person's action (KTD3): reject, and nothing is sent; `approve`, the wire's name for Send, with the text as they
   * edited it and the files they kept, and the reply is held for its undo, then sent (the answer comes at once, as
   * sending); `undo`, while it is held, and it waits on the card again with the edits kept (R5).
   */
  decide(chat: ChatKey, id: string, action: ReplyAction, by: string, opts: ReplyDecideOptions = {}): Promise<ReplyDecided> {
    switch (action) {
      case "reject":
        return this.settle(chat, id, "rejected", by, (p) => `The person rejected your reply in ${p.account_label}, thread ${p.thread_id}: nothing was sent.`);
      case "undo":
        return this.undo(chat, id);
      case "approve":
        return this.send(chat, id, by, opts);
    }
  }

  /**
   * The notices waiting for a chat's agent, taken: each goes with one message only. Read and written in one synchronous
   * step, as every change here is, so no other change can come between.
   */
  takeNotices(chat: ChatKey): string[] {
    const r = this.chats.get(keyOf(chat));
    if (!r?.notices.length) return [];
    this.save(chat, { ...r, notices: [] }, false);
    return r.notices;
  }

  /** The outbox sent a reply (KTD9): the proposal is sent, its agent told once, and only then the outbox lets it go. */
  sent(held: HeldReply): void {
    const proposal = held.proposal;
    if (!proposal) return;
    void this.report(proposal, held.outbox_id, (p) => {
      if (p.status !== "sending" || p.outbox_id !== held.outbox_id) return null;
      const next: ReplyProposal = { ...p, status: "sent", reason: null, decided_at: this.now() };
      log("replies:sent", { provider: next.provider, files: next.attachments?.length ?? 0 });
      return { next, notice: sentNotice(next) };
    });
  }

  /**
   * The outbox did not send a reply (KTD9): it waits on the card again with why, keeping the outbox id, which a later
   * Send of a Gmail reply looks for in the thread first. When the thread's people changed, the card shows the new ones
   * and who joined or left (R7). The agent hears nothing, since nothing went.
   */
  notSent(held: HeldReply, note: { reason: string; at: string }, people: PeopleChanged | null): void {
    const proposal = held.proposal;
    if (!proposal) return;
    void this.report(proposal, held.outbox_id, (p) => {
      if (p.status !== "sending" || p.outbox_id !== held.outbox_id) return null;
      // A comment that failed after its files went leaves them on the ticket, and the card says so (KTD8).
      const onTicket = p.provider === "jira" && p.attached?.length ? `; ${p.attached.join(", ")} already on the ticket` : "";
      const next: ReplyProposal = { ...p, status: "pending", reason: `${note.reason}${onTicket}`, decided_by: null, decided_at: null };
      log("replies:not-sent", { provider: p.provider, people: people !== null });
      return { next: people ? { ...next, to: people.to, cc: people.cc, people_added: people.added, people_removed: people.removed } : next, notice: null };
    });
  }

  /** A Jira ticket took a reply's files (KTD8): recorded at once, so a later Send attaches only the rest. */
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

  /**
   * What the outbox reported, saved under the chat's lock, then acknowledged, so the outbox forgets the entry only once
   * its outcome is kept (KTD9, step 2). A report for a proposal already past it (one a restart reports again) changes
   * nothing and is acknowledged all the same.
   */
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
          // After the save, which writes the record as it was read, so the notice is not written over.
          if (out.notice) this.notify(chat, out.notice);
        }
        return Promise.resolve();
      });
      this.opts.outside.acknowledge(outboxId);
    } catch (err) {
      log("replies:report-failed", messageOf(err));
    }
  }

  /**
   * The person's Send (KTD3): the kept files are checked now (AE3), a Gmail reply whose last send failed is looked for
   * in its thread first (KTD9, step 3), and the reply is handed to the outbox to wait out its undo. A Jira comment
   * attaches only the files no earlier Send attached (KTD8). Refused, nothing is held and the card says why.
   */
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
      // A move this process did not hear (it was down, or the move came between): the reply is no longer this agent's.
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
      // The person's edits and the files they kept are kept whatever happens next, so Undo or a refusal returns them (R5).
      const kept = (p.attachments ?? []).filter((f) => !opts.files || opts.files.includes(f.name));
      const edits = withoutPeopleMarks(withFiles({ ...p, ...(edited ? { text: edited } : {}) }, kept));
      try {
        await checkedFiles(kept);
      } catch (err) {
        return put({ ...edits, reason: messageOf(err) }, false, messageOf(err));
      }
      if (p.provider === "gmail" && p.outbox_id) {
        const went = await this.opts.outside.wentOutIn(p.account_id, p.thread_id, p.outbox_id).catch(() => null);
        if (went === null) {
          const why = "the thread could not be read to check the last send did not go: try again";
          return put({ ...edits, reason: why }, false, why);
        }
        if (went) {
          // The send that seemed to fail went after all: it is sent, and nothing new goes.
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
        });
      } catch (err) {
        return put({ ...edits, reason: messageOf(err) }, false, messageOf(err));
      }
      log("replies:sending", { provider: p.provider, files: kept.length });
      return put({ ...edits, status: "sending", reason: null, outbox_id: outboxId, decided_by: by, decided_at: null }, true, null);
    });
  }

  /** The person's Undo while a reply is held (R5): nothing is posted, and it waits again with their edits and files. */
  private undo(chat: ChatKey, id: string): Promise<ReplyDecided> {
    return this.change(chat, id, (p) => {
      if (p.status === "pending") return { done: false, message: "that reply is not being sent" };
      if (p.status !== "sending") return { done: false, message: settledWords(p) };
      if (!this.opts.outside.unsend(p.account_id, p.outbox_id ?? "")) return { done: false, message: "it is already going, too late to undo" };
      log("replies:undone", { provider: p.provider });
      return { done: true, message: null, next: { ...p, status: "pending", reason: null, outbox_id: null, decided_by: null, decided_at: null } };
    });
  }

  /**
   * The files a reply carries, checked now (R8): at most MAX_REPLY_FILES and MAX_REPLY_BYTES together, each one a file
   * that can be read. Each is kept by its path, size and MD5, never its bytes.
   */
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

  /**
   * Who the card says a reply goes to, read from the thread: Gmail's reply-all, or Slack's conversation and thread; a
   * Jira comment goes on the ticket, named by its key from its card's record.
   */
  private async where(
    account: AccountRecord,
    threadId: string,
    subject: string,
  ): Promise<{ subject: string; to: string[]; cc: string[]; place: string | null }> {
    const reader = this.opts.clientFor(account);
    if (reader.provider === "jira") return { subject, to: [], cc: [], place: this.opts.threads.get(account.account_id, threadId)?.place ?? null };
    if (reader.provider === "gmail") {
      const thread = await reader.client.getThread(threadId, "metadata").catch((err: unknown) => {
        if (err instanceof GoogleError && err.status === 404) throw new Error(`there is no thread ${threadId} in ${account.address}`);
        throw err;
      });
      const newest = replyTarget(thread.messages);
      const own = [account.address, ...(await reader.client.sendAsAddresses().catch(() => []))];
      return { subject: replySubject(headerOf(newest, "Subject") || subject), ...replyAllOf(newest, own), place: null };
    }
    const { channel, ts } = slackPlace(threadId);
    const info = await reader.client.conversationsInfo(channel).catch(() => null);
    const sender = this.opts.threads.get(account.account_id, threadId)?.sender || "them";
    const conversation = info?.is_im ? `your DM with ${sender}` : info?.name ? `#${info.name}` : "that conversation";
    return { subject, to: [], cc: [], place: ts ? `the thread in ${conversation}` : conversation };
  }

  /**
   * The card's record of a Jira ticket named by its id or its key, in any case (KTD7); throws why when the ticket never
   * had a card, since its key is known only from one (R28).
   */
  private ticketRecord(account: AccountRecord, ticket: string): ThreadRecord {
    const wanted = ticket.trim().toLowerCase();
    const found =
      this.opts.threads.get(account.account_id, ticket.trim()) ?? this.opts.threads.list(account.account_id).find((r) => r.place?.toLowerCase() === wanted);
    if (!found) throw new Error(`${ticket} has never had a card in Flow, so loki cannot find it: comment on a ticket flow_list lists`);
    return found;
  }

  /**
   * The old owner's waiting replies for a moved account are withdrawn, each with a notice to its chat. One the person
   * already pressed Send on stays: their Send was for the account as it was.
   */
  private async withdrawMoved(accountId: string, from: string): Promise<void> {
    for (const chat of [...this.chats.values()].filter((c) => c.agent_id === from)) {
      for (const p of this.record(chat).proposals.filter((x) => x.account_id === accountId && x.status === "pending"))
        await this.settle(chat, p.id, "withdrawn", "loki", movedNotice);
    }
  }

  /** Settle a pending proposal as rejected or withdrawn, by whom, telling the agent when `notice` says what. */
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

  /** One proposal changed under its chat's lock: `fn` sees it as stored and says whether the action took and what it becomes. */
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

  /**
   * A chat's record, with any proposal stored as sending that the outbox no longer has read as pending again (KTD9,
   * step 4): loki stopped while it was sent, and nothing saved how that went. It keeps its outbox id, so a Gmail reply's
   * next Send looks for it in the thread first.
   */
  private record(chat: ChatKey): ChatRecord {
    const r = this.chats.get(keyOf(chat)) ?? { agent_id: chat.agent_id, conversation_id: chat.conversation_id, proposals: [], notices: [] };
    const left = (p: ReplyProposal) => p.status === "sending" && !this.opts.outside.holds(p.outbox_id ?? "");
    return { ...r, proposals: r.proposals.map((p) => (left(p) ? { ...p, status: "pending", reason: MAY_HAVE_GONE, decided_by: null } : p)) };
  }

  /** Keep a chat's record and write the file whole, owner-only since it holds reply text; a change to the proposals is told. */
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

/** Where a reply goes, as the agent is told it: Gmail's people, Slack's place, or the Jira ticket. */
function whoWords(p: ReplyProposal): string {
  switch (p.provider) {
    case "gmail":
      return `to ${addresses([...p.to, ...p.cc]) || "no one"}`;
    case "slack":
      return `in ${inert(p.place ?? "that conversation")}`;
    case "jira":
      return `on ${inert(p.place ?? "that ticket")}`;
  }
}

/** A reply's files as the agent is told them: each name and size. */
const filesWords = (files: readonly ReplyAttachment[]): string => files.map((f) => `${inert(f.name)} (${bytesWords(f.size)})`).join(", ");

/**
 * What the agent is told once its reply went (R12): that the person sent it, where, to whom, with which files, and what
 * it says.
 */
function sentNotice(p: ReplyProposal): string {
  const what = p.provider === "jira" ? "posted your comment" : "sent your reply";
  const files = p.attachments?.length ? `, with ${filesWords(p.attachments)}` : "";
  return [
    `The person ${what} in ${p.account_label}, thread ${p.thread_id}, ${whoWords(p)}${files}. It says:`,
    // The notice rides in a system-reminder; text that echoes a stranger's markup must not end it.
    inert(p.text),
  ].join("\n");
}

/** A proposal as a tool result lists it: one line, with its id, where it goes, its files and how it stands. */
function proposalLine(p: ReplyProposal): string {
  const who = whoWords(p);
  const files = p.attachments?.length ? `with ${filesWords(p.attachments)}` : "";
  return [p.id, p.account_label, `thread ${p.thread_id}`, `"${inert(p.subject)}"`, who, files, p.status, p.reason && inert(p.reason)]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Register reply_propose for the agents that own an account, the notices that tell an agent what became of its replies
 * with the next message in its chat, and the prompt line about them; returns the functions that take them back. The
 * notices are how the agent learns each reply's fate, so it has no tool to list or take one back (plan 094). Each call checks again that the account is the calling agent's (R17).
 */
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
      "Send. It goes only to the thread's own people (Gmail: reply-all to the newest message, with the person's signature; " +
      "Slack: the same conversation and thread), so there is no recipient to choose. On a Jira site it is a comment on a " +
      "ticket that has had a card in Flow (by key or id), its files attached to the ticket. " +
      "You hear what became of it with the next message.",
    parameters: {
      type: "object",
      properties: {
        account: { type: "string", description: "The account's id or name, from the prompt's list of your accounts, a script or the hand-off." },
        thread: {
          type: "string",
          description: "The thread id, from the hand-off or a script (flow_list, google_gmail_search, slack_read); for Jira, the ticket's key or id.",
        },
        text: { type: "string", description: "The reply, as plain text." },
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
        // A path is found in the chat's folder, and one that leads out of it is refused, as a script's files are.
        const attachments = named.map((path) => inChatFolder(ctx, path));
        const p = await deps.replies.propose(chatOf(ctx), {
          account_id: account.account_id,
          thread_id: thread,
          text: argText(ctx.args.text),
          ...(attachments.length ? { attachments } : {}),
        });
        log("tool:reply_propose", { agent: ctx.agent.id, provider: p.provider });
        return `Proposed ${p.id}: it waits for the person to review and send it.\n${proposalLine(p)}`;
      } catch (err) {
        return failed(messageOf(err));
      }
    },
  };

  const disposers = [propose].map((tool) => tools.register(tool));
  disposers.push(
    // What became of the agent's replies rides with the next message in its chat, as canvas gestures do.
    api.message.transform((m) => {
      const notices = deps.replies.takeNotices({ agent_id: m.agentId, conversation_id: m.chatId });
      if (notices.length === 0) return undefined;
      const block = notices.map((n) => `<system-reminder>${n}</system-reminder>`).join("\n");
      return typeof m.content === "string" ? `${m.content}\n\n${block}` : [...m.content, { type: "text", text: block }];
    }),
    api.prompt.section("replies", ({ agentId }) =>
      forAgent(agentId)
        ? "To answer a thread in an account you own, handed to you or found with a script, use reply_propose, with `attachments` for its files: the person reviews the reply on a card and sends it from there; you cannot send it. Never send mail, Slack messages or Jira comments any other way."
        : undefined,
    ),
  );
  return disposers;
}

/**
 * The chat backend with each opened chat's open reply proposals in the state it opens with, so a client that opens a
 * chat late sees them as one that was listening does. Every other call goes to the backend as it is.
 */
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
