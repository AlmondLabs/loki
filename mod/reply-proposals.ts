import { randomUUID } from "node:crypto";
import type { ChatEvent } from "../core/attention/model.ts";
import { messageOf } from "../core/errors.ts";
import type { AccountProvider, ReplyProposal, ReplyProposalStatus } from "../core/frame-types.ts";
import type { ChatState, ReplyAction } from "../core/frames.ts";
import { splitMailboxes } from "../core/mail-header.ts";
import { keyedQueue } from "../core/serial.ts";
import type { ModApi } from "../daemon/mods/api.ts";
import { ownedAccount } from "./account-tools.ts";
import type { AccountThreads, ThreadRecord } from "./account-threads.ts";
import { accountLabel, type AccountRecord, type Accounts } from "./accounts.ts";
import type { ChatBackend } from "./frames/chat.ts";
import { GmailError, type GmailClient, type GmailMessage } from "./gmail.ts";
import { causeWords, inert } from "./handoff.ts";
import { readJson, writeJsonAtomic } from "./json-file.ts";
import { log } from "./log.ts";
import type { SlackClient } from "./slack.ts";
import type { ChatKey } from "./suggestions.ts";
import { argText, toolRegistrar, type LokiTool } from "./tools.ts";

/**
 * Reply proposals (plan 067, U10, KTD9; plan 071): a reply the owning agent writes in a thread of its own account
 * reaches the person as an approval card, in every permission mode, and only their approve makes loki write it as a
 * draft in that same thread, which the person sends from Gmail or Slack; nothing here sends (R18, KTD4). The agent names
 * the thread and the text, never who it goes to: a Gmail draft replies to all of the newest message's people but the
 * person, a Slack draft sits in the same conversation and thread, so a stranger's mail that asks the agent to send
 * something elsewhere can at most yield a reply to the thread's own people.
 *
 * Jira has no drafts (plan 2026-11-10-1451, KTD18): an approved comment waits on the ticket's thread record instead,
 * and the card puts it in its comment box for the person to send from there. Only a ticket that has had a card can take
 * one (R28), and nothing here reaches Jira at all.
 *
 * Each chat's proposals live in `state/reply-proposals.json`, beside the notices its agent has yet to read. A proposal
 * moves from pending to drafting to drafted, rejected or withdrawn in one step under its chat's lock, so the first action
 * wins and a second is told what already happened, as a suggestion's are (mod/suggestions.ts).
 */

/** What a Gmail draft needs of the mailbox's client: the thread, the person's own addresses, and the draft call. */
export type ReplyGmail = Pick<GmailClient, "getThread" | "sendAsAddresses" | "createDraft">;
/** What a Slack draft needs of the workspace's client: the drafts there, a conversation's name, and the draft calls. */
export type ReplySlack = Pick<SlackClient, "draftsList" | "draftsCreate" | "draftsDelete" | "conversationsInfo">;
/**
 * An account's client for drafts, by its provider. A Jira site has none: an approved comment waits on the card's record,
 * so approving cannot reach Jira (KTD18).
 */
export type ReplyClient = { provider: "gmail"; client: ReplyGmail } | { provider: "slack"; client: ReplySlack } | { provider: "jira" };

/** What the proposals are built from. `now` and `newId` exist for tests. */
export interface ReplyProposalsOptions {
  /** `state/reply-proposals.json`. */
  file: string;
  accounts: Pick<Accounts, "get" | "onChange">;
  threads: Pick<AccountThreads, "get" | "list" | "seed" | "dropSeed">;
  clientFor(account: AccountRecord): ReplyClient;
  /** Tell every client following a chat what its open proposals now are. */
  push(agentId: string, conversationId: string, events: ChatEvent[]): void;
  /** The lists should be read again: a chat's card is blocked, or no longer. */
  changed?(): void;
  now?(): Date;
  newId?(): string;
}

/** What an action left: the proposal as it now stands, whether it took, why not, and whether to ask about replacing. */
export interface ReplyDecided {
  proposal: ReplyProposal;
  done: boolean;
  message: string | null;
  /** A Slack draft already sits where this one goes: the person is asked before it is replaced. */
  replace: boolean;
}

/** A reply as the agent proposes it: the account, a thread of that account, and the text. Nothing names a recipient. */
export interface ReplyInput {
  account_id: string;
  thread_id: string;
  text: string;
}

interface ChatRecord extends ChatKey {
  proposals: ReplyProposal[];
  /** What the chat's agent is told with the next message in it: drafts written, replies rejected or withdrawn. */
  notices: string[];
}

const SERVICE: Record<AccountProvider, string> = { gmail: "Gmail", slack: "Slack", jira: "Jira" };
const STATUSES: readonly ReplyProposalStatus[] = ["pending", "drafting", "drafted", "rejected", "withdrawn"];
/** What a draft that threw on the way leaves on the card; the proposal waits again. */
const UNFINISHED = "the draft was not written: try again";
const INTERRUPTED = "interrupted: try again";
/** What the person is asked when a Slack draft already waits in that place. */
export const DRAFT_THERE = "a draft is already there: replace it?";

/** The statuses that still show on the card: waiting on the person, or being drafted. */
const isOpen = (p: ReplyProposal) => p.status === "pending" || p.status === "drafting";

/** Who settled a proposal, as a refused action says it. */
const byWords = (by: string | null | undefined) => (by === "phone" || by === "desktop" ? `the ${by}` : by || "another device");

/** What a second action is told: what already happened (R17's rule for suggestions, kept here too). */
function settledWords(p: ReplyProposal): string {
  switch (p.status) {
    case "drafting":
      return "already being drafted";
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
  `${p.account_label} moved to another agent, so your reply in thread ${p.thread_id} was withdrawn: nothing was written.`;
/** What the person is told when they approve a reply whose account moved since. */
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
  const status = STATUSES.find((x) => x === r.status);
  const provider = r.provider === "gmail" || r.provider === "slack" || r.provider === "jira" ? r.provider : null;
  if (!id || !account || !thread || text === null || !status || !provider) return null;
  const strings = (k: string) => (Array.isArray(r[k]) ? r[k].filter((x): x is string => typeof x === "string") : []);
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
    draft_url: s("draft_url"),
  };
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

/** The reply proposals of every chat on this Mac, and the person's actions on them. */
export class ReplyProposals {
  private readonly opts: ReplyProposalsOptions;
  private readonly chats = new Map<string, ChatRecord>();
  /** One change at a time per chat. */
  private readonly locks = keyedQueue();
  /** Proposals this process is drafting now; one stored as drafting that is not here was left by a daemon that stopped. */
  private readonly inFlight = new Set<string>();
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
   * thread now for the card, and again when it is drafted. A thread the account does not have is refused.
   */
  async propose(chat: ChatKey, input: ReplyInput): Promise<ReplyProposal> {
    if (!input.text.trim()) throw new Error("a reply needs text");
    const account = this.opts.accounts.get(input.account_id);
    if (account?.owner_agent_id !== chat.agent_id) throw new Error("this agent owns no such account");
    // Any thread of the agent's own account will do (plan 071): the person's approval on the card is the gate. A thread
    // found by search has no record here, so its subject comes from the thread itself. A Jira comment waits on its
    // ticket's card, so the ticket must have one, named by its id or its key (R28, KTD7).
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
   * The agent takes back a reply the person has not acted on (reply_withdraw). Nothing is written. An approved Jira
   * comment the person has not sent yet can be taken back too: it leaves the card's record, and whatever the card's box
   * already holds stays as the person has it.
   */
  withdraw(chat: ChatKey, id: string): Promise<ReplyDecided> {
    return this.change(chat, id, (p) => {
      const waiting = p.provider === "jira" && p.status === "drafted" && this.opts.threads.dropSeed(p.account_id, p.thread_id, p.id);
      if (p.status !== "pending" && !waiting) return { done: false, message: settledWords(p) };
      return { done: true, message: null, next: { ...p, status: "withdrawn", reason: null, decided_by: "agent", decided_at: this.now() } };
    });
  }

  /**
   * The person's action (KTD9): reject, and nothing is written; approve, with the text as they edited it, and loki writes
   * the draft in the thread, then tells the agent what it drafted. A Slack draft already in that place is replaced only
   * on `replace`. A disconnected account refuses, with why.
   */
  async decide(chat: ChatKey, id: string, action: ReplyAction, by: string, opts: { text?: string | null; replace?: boolean } = {}): Promise<ReplyDecided> {
    if (action === "reject")
      return this.settle(chat, id, "rejected", by, (p) => `The person rejected your reply in ${p.account_label}, thread ${p.thread_id}: nothing was written.`);
    const flight = `${keyOf(chat)}/${id}`;
    const edited = opts.text?.trim() ? (opts.text ?? "") : null;
    const claim = await this.change(chat, id, (p) => {
      if (p.status !== "pending") return { done: false, message: settledWords(p) };
      const account = this.opts.accounts.get(p.account_id);
      // A move this process did not hear (it was down, or the move came between): the reply is no longer this agent's.
      if (account && account.owner_agent_id !== chat.agent_id) {
        return { done: false, message: MOVED, next: { ...p, status: "withdrawn", reason: null, decided_by: "loki", decided_at: this.now() } };
      }
      const refused = !account
        ? "that account is not connected on this Mac"
        : account.status !== "connected"
          ? causeWords(account.status.disconnected, account.provider)
          : null;
      if (refused) return { done: false, message: refused, next: { ...p, reason: refused } };
      this.inFlight.add(flight);
      return { done: true, message: null, next: { ...p, status: "drafting", reason: null, ...(edited ? { text: edited } : {}) } };
    });
    // Only this claim answers MOVED, and only as it withdraws the reply, so the agent is told once.
    if (claim.message === MOVED) this.notify(chat, movedNotice(claim.proposal));
    if (!claim.done) return claim;
    try {
      const written = await this.write(claim.proposal, opts.replace === true).catch((err: unknown) => ({
        ok: false as const,
        message: `${UNFINISHED} (${messageOf(err)})`,
      }));
      if (!written.ok) {
        const ask = written.message === DRAFT_THERE;
        const out = await this.change(chat, id, (p) => ({ done: false, message: written.message, next: { ...p, status: "pending", reason: written.message } }));
        return { ...out, replace: ask };
      }
      const out = await this.change(chat, id, (p) => ({
        done: true,
        message: null,
        next: { ...p, ...written.drafted, status: "drafted", reason: null, decided_by: by, decided_at: this.now(), draft_url: written.url },
      }));
      this.notify(chat, draftedNotice(out.proposal));
      log("replies:drafted", { provider: out.proposal.provider });
      return out;
    } finally {
      this.inFlight.delete(flight);
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

  /**
   * Write the draft out there, reading the thread again so it answers the newest message (KTD9). Slack's place is
   * checked for a draft already waiting first, which is replaced only when the person said so.
   */
  private async write(
    p: ReplyProposal,
    replace: boolean,
  ): Promise<{ ok: true; drafted: Partial<ReplyProposal>; url: string | null } | { ok: false; message: string }> {
    const account = this.opts.accounts.get(p.account_id);
    if (!account) return { ok: false, message: "that account is not connected on this Mac" };
    const reader = this.opts.clientFor(account);
    if (reader.provider === "jira") {
      // Jira has no drafts: the comment waits on the ticket's card, which opens again if it had ended, for the person
      // to send from its box (KTD18). Nothing reaches Jira.
      const seeded = this.opts.threads.seed(p.account_id, p.thread_id, { id: p.id, text: p.text, at: this.now() });
      return seeded ? { ok: true, drafted: {}, url: null } : { ok: false, message: "loki has no card for that ticket now" };
    }
    if (reader.provider === "gmail") {
      const thread = await reader.client.getThread(p.thread_id, "metadata");
      const newest = replyTarget(thread.messages);
      if (!newest) return { ok: false, message: "that thread is empty in Gmail now" };
      const own = [account.address, ...(await reader.client.sendAsAddresses())];
      const { to, cc } = replyAllOf(newest, own);
      if (to.length === 0 && cc.length === 0) return { ok: false, message: "no one in that thread to reply to" };
      const subject = replySubject(headerOf(newest, "Subject") || headerOf(thread.messages.at(0), "Subject"));
      const draft = await reader.client.createDraft({
        threadId: p.thread_id,
        inReplyTo: headerOf(newest, "Message-ID"),
        references: headerOf(newest, "References").split(/\s+/).filter(Boolean),
        to,
        cc,
        subject,
        body: p.text,
      });
      const url = `https://mail.google.com/mail/u/${encodeURIComponent(account.address)}/#drafts?compose=${encodeURIComponent(draft.messageId)}`;
      return { ok: true, drafted: { to, cc, subject }, url };
    }
    const { channel, ts } = slackPlace(p.thread_id);
    const there = (await reader.client.draftsList()).filter((d) => d.destinations.some((x) => x.channel_id === channel && (x.thread_ts ?? null) === ts));
    if (there.length > 0 && !replace) return { ok: false, message: DRAFT_THERE };
    // Replacing takes the old draft away first, so the place holds one draft, the new one.
    for (const d of there) await reader.client.draftsDelete(d.id);
    await reader.client.draftsCreate({ channel, ...(ts ? { thread_ts: ts } : {}), text: p.text });
    return { ok: true, drafted: {}, url: null };
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
        if (err instanceof GmailError && err.status === 404) throw new Error(`there is no thread ${threadId} in ${account.address}`);
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
   * had a card, since an approved comment waits in the card's box and there would be none (R28).
   */
  private ticketRecord(account: AccountRecord, ticket: string): ThreadRecord {
    const wanted = ticket.trim().toLowerCase();
    const found =
      this.opts.threads.get(account.account_id, ticket.trim()) ?? this.opts.threads.list(account.account_id).find((r) => r.place?.toLowerCase() === wanted);
    if (!found)
      throw new Error(
        `${ticket} has never had a card in the Inbox, so there is no comment box for a comment to wait in: comment on a ticket from account_list`,
      );
    return found;
  }

  /**
   * The old owner's waiting replies for a moved account are withdrawn, each with a notice to its chat. Read through
   * `record`, so one a stopped daemon left drafting counts as waiting and goes too; one being drafted right now is
   * refused by its own claim's owner check if it comes back to wait.
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
      return Promise.resolve({ proposal: next ?? found, done: out.done, message: out.message, replace: false });
    });
  }

  /** A chat's record, with any proposal a stopped daemon left drafting read as pending again. */
  private record(chat: ChatKey): ChatRecord {
    const r = this.chats.get(keyOf(chat)) ?? { agent_id: chat.agent_id, conversation_id: chat.conversation_id, proposals: [], notices: [] };
    const left = (p: ReplyProposal) => p.status === "drafting" && !this.inFlight.has(`${keyOf(chat)}/${p.id}`);
    return { ...r, proposals: r.proposals.map((p) => (left(p) ? { ...p, status: "pending", reason: INTERRUPTED } : p)) };
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

/** What the agent is told once its reply is a draft: where, to whom, and what it says, and that nothing was sent. */
function draftedNotice(p: ReplyProposal): string {
  if (p.provider === "jira")
    return [
      `The person approved your comment ${whoWords(p)} in ${p.account_label}, and loki put it in the comment box of the ticket's card in the Inbox, waiting on the card for the person to send.`,
      "Nothing was posted: only the person posts it, from the card. The comment says:",
      inert(p.text),
    ].join("\n");
  const who = whoWords(p);
  return [
    `The person approved your reply in ${p.account_label}, thread ${p.thread_id}, and loki saved it as a ${SERVICE[p.provider]} draft ${who}${p.draft_url ? ` (${p.draft_url})` : ""}.`,
    `Nothing was sent: the person sends it from ${SERVICE[p.provider]}. The draft says:`,
    // The notice rides in a system-reminder; text that echoes a stranger's markup must not end it.
    inert(p.text),
  ].join("\n");
}

/** A proposal as a tool result lists it: one line, with its id, where it goes and how it stands. */
function proposalLine(p: ReplyProposal): string {
  const who = whoWords(p);
  return [p.id, p.account_label, `thread ${p.thread_id}`, `"${inert(p.subject)}"`, who, p.status, p.reason && inert(p.reason)].filter(Boolean).join(" · ");
}

/**
 * Register reply_propose, reply_list and reply_withdraw for the agents that own an account, the notices that tell an
 * agent what became of its replies with the next message in its chat, and the prompt line about them; returns the
 * functions that take them back. Each call checks again that the account is the calling agent's (R17).
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
      "Propose a reply in a thread of an account you own: one the person handed to this chat, or one you found with " +
      "account_search or read with account_read. The person sees it as a card, may edit it, and on " +
      "approve loki saves it as a draft in that same thread, which they send from Gmail or Slack; nothing is ever sent " +
      "by you or loki. It goes only to the thread's own people (Gmail: reply-all to the newest message; Slack: the same " +
      "conversation and thread), so there is no recipient to choose. On a Jira site it is a comment on a ticket that has " +
      "had a card in the Inbox (by key or id): approved, it waits in that card's comment box for the person to post. " +
      "You hear what became of it with the next message.",
    parameters: {
      type: "object",
      properties: {
        account: { type: "string", description: "The account's id or name, from account_list, account_search or the hand-off." },
        thread: { type: "string", description: "The thread id, from the hand-off, account_search or account_read; for Jira, the ticket's key or id." },
        text: { type: "string", description: "The reply, as plain text." },
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
        const p = await deps.replies.propose(chatOf(ctx), { account_id: account.account_id, thread_id: thread, text: argText(ctx.args.text) });
        log("tool:reply_propose", { agent: ctx.agent.id, provider: p.provider });
        return `Proposed ${p.id}: it waits for the person's approval.\n${proposalLine(p)}`;
      } catch (err) {
        return failed(messageOf(err));
      }
    },
  };

  const list: LokiTool = {
    name: "reply_list",
    annotations: { readOnly: true },
    forAgent,
    description: "List the replies you proposed in this chat: id, account, thread, who it goes to, and whether it waits, was drafted, rejected or withdrawn.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    run(ctx) {
      const all = deps.replies.list(chatOf(ctx));
      return all.length ? all.map(proposalLine).join("\n") : "no replies proposed in this chat";
    },
  };

  const withdraw: LokiTool = {
    name: "reply_withdraw",
    forAgent,
    description:
      "Take back a reply you proposed in this chat that the person has not acted on yet, or a Jira comment they approved " +
      "that still waits in the card's box unsent. Nothing is written.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "The reply's id, from reply_propose or reply_list." } },
      required: ["id"],
      additionalProperties: false,
    },
    async run(ctx) {
      try {
        const out = await deps.replies.withdraw(chatOf(ctx), argText(ctx.args.id));
        return out.done ? `Withdrew ${out.proposal.id}.` : failed(out.message ?? "it could not be withdrawn");
      } catch (err) {
        return failed(messageOf(err));
      }
    },
  };

  const disposers = [propose, list, withdraw].map((tool) => tools.register(tool));
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
        ? "To answer a thread in an account you own, handed to you or found with account_search, use reply_propose: the person approves it and loki saves it as a draft there, or for a Jira ticket puts the comment in its card's box for the person to post. Never send mail, Slack messages or Jira comments any other way."
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
