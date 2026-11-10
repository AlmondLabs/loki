import { PAST_CAP } from "../core/account-refill.ts";
import { messageOf } from "../core/errors.ts";
import { addressesIn, mailTraits } from "../core/mail-filter.ts";
import type { OutsideChange, OutsideMessageChange, OutsideWrite } from "../core/frame-types.ts";
import type { AccountThreads, OutsideSource, ThreadRecord } from "./account-threads.ts";
import type { AccountSync } from "./account-watcher.ts";
import type { AccountRecord, Accounts } from "./accounts.ts";
import { GmailError, type GmailClient, type GmailHistoryRecord, type GmailMessage } from "./gmail.ts";
import { log } from "./log.ts";
import { headerPeople } from "../core/mail-header.ts";
import type { MailPeople } from "./mail-people.ts";

/**
 * Watching one Gmail account (plan 067, U5, KTD3, KTD6, KTD11; plan 070, KTD2; plan 088). Gmail's inbox is the list of
 * email cards: every thread in it, read or unread, in every tab, is a card that carries Gmail's read state, and
 * archiving is the only way one is done. The first tick keeps the mailbox's history id; each later tick asks Gmail what
 * changed since that id (2 quota units when nothing did), turns new mail in the inbox into cards, follows mail read or
 * marked unread in Gmail, takes away the cards of threads the person archived there, and brings a card back when its
 * mail is moved back into the inbox (plan 070, KTD4). While the inbox may hold threads loki has not drawn (the first
 * sync, an upgrade, lost history, or a listing that stopped at the cap) the inbox is listed, newest first, and each
 * thread loki has no record of becomes a card, until the account has 20 open cards (PAST_CAP, plan 078).
 */

/** The calls a Gmail sync makes; GmailClient has them. */
export type GmailSyncClient = Pick<GmailClient, "profile" | "sendAsAddresses" | "historySince" | "listInbox" | "getThread">;

/** What GmailSync is built from; the clock is injected so tests own it. */
export interface GmailSyncOptions {
  accounts: Pick<Accounts, "get" | "setBackfill" | "setStatus">;
  threads: Pick<AccountThreads, "observe" | "markGoneOutThere" | "reopen" | "get" | "list">;
  account: AccountRecord;
  client: GmailSyncClient;
  /** Told of the people on each message the watcher reads, for the recipients line's suggestions (plan 076). */
  people?: Pick<MailPeople, "saw">;
  /** Whether a card rests in the Inbox now, so the listing's cap leaves it out (plan 078); none rest when not given. */
  resting?: (record: ThreadRecord) => boolean;
  now?: () => Date;
}

/** Where the watcher stands on a Gmail account, kept as the account's backfill cursor. */
interface GmailCursor {
  history_id: string;
  /**
   * The inbox may hold threads loki has not drawn (plan 088): set by the first sync, an upgrade and lost history, kept
   * while a listing stops at the cap, and cleared by a listing that reaches the inbox's end.
   */
  more: boolean;
  /** Which rule the records were last brought in step with; a cursor from before plan 070 has none and reads as 1. */
  version: number;
}

/** Failed ticks in a row before the account says it is failing for now (R22). */
const FAILURES_BEFORE_STATUS = 3;
/**
 * The cursor's version now. Version 3 (plan 088): the inbox is the list of cards, so a cursor from before lists the
 * inbox once, which brings in the threads an earlier rule passed over.
 */
const CURSOR_VERSION = 3;
/** The reasons Gmail gives, with a 403, for a call that is fine but came too often. */
const RATE_LIMITS = ["rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded"];

/**
 * Gmail's labels no card move puts on or takes off: loki never moves mail to the trash or to spam, and where a message
 * was sent from or drafted is Gmail's own to say. A label picked for a thread and the change an undo carries both come
 * in a frame, from a phone or a paired Mac as well, so they are held to this whatever they name.
 */
const NEVER_MOVED: ReadonlySet<string> = new Set(["TRASH", "SPAM", "SENT", "DRAFT", "CHAT"]);

/** The calls Gmail's write-backs make; GmailClient has them. */
export type GmailWriteClient = Pick<GmailClient, "getThread" | "batchModify" | "labels">;

/**
 * The write-backs to Gmail (plan 067, R12; plan 070, KTD3), each by the client of the account the thread is in, and
 * each answering, message by message, the labels it actually put on or took off, so an undo puts back just those.
 * Archive and mark read touch only the messages up to the card's newest: mail that came since the last poll stays
 * unread in the inbox, and the next tick makes the card again for it. Mark unread marks the card's newest message,
 * the newest one someone else sent. Labels go on every message of the thread and never move INBOX or UNREAD.
 */
export function gmailOutsideSource(clientOf: (accountId: string) => GmailWriteClient): OutsideSource {
  const thread = async (client: GmailWriteClient, threadId: string) =>
    (await client.getThread(threadId, "metadata")).messages.sort((a, b) => timeOf(a) - timeOf(b));
  /** The messages the card showed: those up to its newest, or up to its time when that message is gone. */
  const seenOf = (messages: GmailMessage[], record: ThreadRecord) => {
    const newest = messages.findIndex((m) => m.id === record.newest_message_id);
    return newest >= 0 ? messages.slice(0, newest + 1) : messages.filter((m) => timeOf(m) <= Date.parse(record.newest_at));
  };
  /** What adding and removing labels would change on each message, leaving out the messages it would not change. */
  const plan = (messages: GmailMessage[], add: readonly string[], remove: readonly string[]): OutsideMessageChange[] =>
    messages
      .map((m) => ({
        message_id: m.id,
        labels_added: add.filter((l) => !m.labelIds.includes(l)),
        labels_removed: remove.filter((l) => m.labelIds.includes(l)),
      }))
      .filter((c) => c.labels_added.length > 0 || c.labels_removed.length > 0);
  /** Write changes, one request for each set of messages that changes alike. */
  const apply = async (client: GmailWriteClient, changes: OutsideMessageChange[]) => {
    const alike = new Map<string, { ids: string[]; add: string[]; remove: string[] }>();
    for (const c of changes) {
      const key = JSON.stringify([c.labels_added, c.labels_removed]);
      const group = alike.get(key) ?? { ids: [], add: c.labels_added, remove: c.labels_removed };
      group.ids.push(c.message_id);
      alike.set(key, group);
    }
    for (const g of alike.values()) await client.batchModify(g.ids, { addLabels: g.add, removeLabels: g.remove });
  };
  const write = async (
    accountId: string,
    record: ThreadRecord,
    move: OutsideWrite,
    pick: (messages: GmailMessage[]) => OutsideMessageChange[],
  ): Promise<OutsideChange> => {
    const client = clientOf(accountId);
    const changes = pick(await thread(client, record.thread_id));
    await apply(client, changes);
    return { move, messages: changes, ended: move === "archive", was_unread: record.unread_out_there };
  };
  return {
    archive: (accountId, record) => write(accountId, record, "archive", (messages) => plan(seenOf(messages, record), [], ["INBOX", "UNREAD"])),
    markRead: (accountId, record) => write(accountId, record, "read", (messages) => plan(seenOf(messages, record), [], ["UNREAD"])),
    markUnread: (accountId, record) =>
      write(accountId, record, "unread", (messages) => {
        const seen = seenOf(messages, record);
        const newest = seen.find((m) => m.id === record.newest_message_id) ?? seen.at(-1);
        return newest ? plan([newest], ["UNREAD"], []) : [];
      }),
    addLabels: (accountId, record, labels) => {
      const wanted = [...new Set(labels)].filter((l) => l && l !== "INBOX" && l !== "UNREAD" && !NEVER_MOVED.has(l));
      if (wanted.length === 0) return Promise.reject(new Error("pick a label to add: read, later and archive move INBOX and UNREAD"));
      return write(accountId, record, "label", (messages) => plan(messages, wanted, []));
    },
    restore: async (accountId, record, change) => {
      const client = clientOf(accountId);
      // Only the thread's own messages, so a change kept for another card never moves mail outside this thread.
      const ids = new Set((await thread(client, record.thread_id)).map((m) => m.id));
      await apply(
        client,
        change.messages
          .filter((c) => ids.has(c.message_id))
          .map((c) => ({
            message_id: c.message_id,
            labels_added: c.labels_removed.filter((l) => !NEVER_MOVED.has(l)),
            labels_removed: c.labels_added.filter((l) => !NEVER_MOVED.has(l)),
          }))
          .filter((c) => c.labels_added.length > 0 || c.labels_removed.length > 0),
      );
    },
    labels: (accountId) => clientOf(accountId).labels(),
  };
}

const headerOf = (m: GmailMessage, name: string): string => m.payload?.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
const isInInbox = (m: GmailMessage): boolean => m.labelIds.includes("INBOX");
const fromOwn = (m: GmailMessage, own: readonly string[]): boolean => addressesIn(headerOf(m, "From")).some((a) => own.includes(a));
const timeOf = (m: GmailMessage): number => Number(m.internalDate) || 0;

/** Who a From header names, as a card shows them: the display name, or the address when it has none. */
function senderOf(from: string): { name: string; address: string | null } {
  const address = addressesIn(from)[0] ?? null;
  const name = from
    .replace(/<[^<>]*>\s*$/, "")
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .replace(/\\(.)/g, "$1")
    .trim();
  return { name: name || address || from.trim(), address };
}

/** A snippet as plain text: Gmail escapes it as HTML. */
const plain = (snippet: string): string =>
  snippet
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** The cursor as the account keeps it; one from before this version lists the inbox once (plan 088). */
function parseCursor(v: Record<string, unknown>): GmailCursor | null {
  const version = typeof v.version === "number" ? v.version : 1;
  if (typeof v.history_id !== "string" || !v.history_id) return null;
  return { history_id: v.history_id, more: v.more === true || version < CURSOR_VERSION, version };
}

/** One Gmail account's watching, ticked by the AccountWatcher. */
export class GmailSync implements AccountSync {
  private readonly opts: GmailSyncOptions;
  private readonly accountId: string;
  /** The mailbox's address and send-as aliases, read on the first tick of this sync. */
  private own: string[] | null = null;
  private failures = 0;

  constructor(opts: GmailSyncOptions) {
    this.opts = opts;
    this.accountId = opts.account.account_id;
  }

  /**
   * Read what changed. A good tick marks an account that was failing for now connected again; the third failure in a
   * row marks it failing for now, unless the client already said why it stopped (a sign-in, an admin). Throws why.
   */
  async tick(): Promise<void> {
    try {
      await this.run();
    } catch (error) {
      this.failures++;
      if (this.failures >= FAILURES_BEFORE_STATUS && this.opts.accounts.get(this.accountId)?.status === "connected")
        this.opts.accounts.setStatus(this.accountId, { disconnected: "temporarily_failing" });
      throw error;
    }
    this.failures = 0;
    const status = this.opts.accounts.get(this.accountId)?.status;
    if (typeof status === "object" && status.disconnected === "temporarily_failing") this.opts.accounts.setStatus(this.accountId, "connected");
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private cursor(): GmailCursor | null {
    const account = this.opts.accounts.get(this.accountId);
    return account ? parseCursor(account.backfill) : null;
  }

  private save(cursor: GmailCursor): void {
    this.opts.accounts.setBackfill(this.accountId, { history_id: cursor.history_id, more: cursor.more, version: CURSOR_VERSION });
  }

  private async run(): Promise<void> {
    const own = (this.own ??= [...new Set([...(await this.opts.client.sendAsAddresses()), this.opts.account.address].map((a) => a.trim().toLowerCase()))]);
    const cursor = this.cursor();
    if (!cursor) {
      // The history id first, so mail that comes while the inbox is listed arrives with the next tick.
      const profile = await this.opts.client.profile();
      this.save({ history_id: profile.historyId, more: true, version: CURSOR_VERSION });
    } else {
      const changes = await this.opts.client.historySince(cursor.history_id);
      if (changes.kind === "expired") await this.rebuild(own);
      else {
        const { all, back } = this.touched(changes.history);
        for (const threadId of all) await this.syncThread(threadId, own, false, back.has(threadId));
        this.save({ ...cursor, history_id: changes.history_id });
      }
    }
    await this.listInbox(own);
  }

  /**
   * The threads a tick reads again: those with new mail in the inbox, those moved back into the inbox (plan 070, KTD4:
   * by the person in Gmail, or by an undo), and the open cards' threads that lost UNREAD or INBOX (read or archived in
   * Gmail), gained UNREAD (marked unread there) or lost a message. `back` names the threads moved back into the inbox,
   * whose cards may open again.
   */
  private touched(history: GmailHistoryRecord[]): { all: Set<string>; back: Set<string> } {
    const open = (threadId: string) => this.opts.threads.get(this.accountId, threadId)?.state === "open";
    const all = new Set<string>();
    const back = new Set<string>();
    for (const h of history) {
      for (const m of h.messagesAdded) if (m.labelIds.includes("INBOX")) all.add(m.threadId);
      for (const c of h.labelsRemoved)
        if ((c.labelIds.includes("UNREAD") || c.labelIds.includes("INBOX")) && open(c.message.threadId)) all.add(c.message.threadId);
      for (const c of h.labelsAdded) {
        if (c.labelIds.includes("INBOX")) back.add(c.message.threadId);
        if (c.labelIds.includes("INBOX") || (c.labelIds.includes("UNREAD") && open(c.message.threadId))) all.add(c.message.threadId);
      }
      for (const m of h.messagesDeleted) if (open(m.threadId)) all.add(m.threadId);
    }
    return { all, back };
  }

  /**
   * History lost (KTD3): watch on from the mailbox's history id now, and read again each open card's thread and each
   * thread in the inbox loki has a record of, so mail that came meanwhile in a thread loki had closed shows as it would
   * have. A thread whose newest mail is the one recorded stays as it was, archived or handed off included
   * (AccountThreads.observe). The threads loki has no record of are the listing's, which runs after (plan 088).
   */
  private async rebuild(own: string[]): Promise<void> {
    const profile = await this.opts.client.profile();
    const threadIds = new Set(
      this.opts.threads
        .list(this.accountId)
        .filter((r) => r.state === "open")
        .map((r) => r.thread_id),
    );
    let pageToken: string | undefined;
    do {
      const page = await this.opts.client.listInbox(pageToken);
      for (const threadId of page.threads) if (this.opts.threads.get(this.accountId, threadId)) threadIds.add(threadId);
      pageToken = page.nextPageToken;
    } while (pageToken);
    for (const threadId of threadIds) await this.syncThread(threadId, own, false);
    this.save({ history_id: profile.historyId, more: true, version: CURSOR_VERSION });
  }

  /**
   * Read one thread and bring its record in step (plan 070, KTD2): a card while any of its messages is in the inbox,
   * with Gmail's read state, or the card taken away when none is. The thread's messages are returned, for a batch's
   * place; null when the thread is gone or unreadable. `observed` says whether a card opened or changed, and `unread`
   * whether the thread is unread in Gmail. With `reopen`, the thread was moved back into the inbox, so an archived
   * record with mail in the inbox opens again as the same card (KTD4); a rebuild and a listing never ask this, so they
   * keep archived threads out.
   */
  private async syncThread(
    threadId: string,
    own: string[],
    fromBackfill: boolean,
    reopen = false,
  ): Promise<{ observed: boolean; unread: boolean; messages: GmailMessage[] } | null> {
    const messages = await this.threadOf(threadId);
    if (!messages) return null;
    if (reopen && messages.some(isInInbox)) this.opts.threads.reopen(this.accountId, threadId);
    return { ...this.apply(threadId, messages, own, fromBackfill), messages };
  }

  /**
   * One thread's messages, oldest first. A thread Gmail no longer has ends its card and gives null; one Gmail refuses for
   * good is passed over with null, so the history moves on and other mail keeps coming.
   */
  private async threadOf(threadId: string): Promise<GmailMessage[] | null> {
    try {
      return (await this.opts.client.getThread(threadId, "metadata")).messages.sort((a, b) => timeOf(a) - timeOf(b));
    } catch (error) {
      if (!(error instanceof GmailError)) throw error;
      if (error.status === 404) {
        this.opts.threads.markGoneOutThere(this.accountId, threadId);
        return null;
      }
      if (!this.unreadable(error)) throw error;
      log("gmail:thread-unreadable", { account_id: this.accountId, thread_id: threadId, error: messageOf(error) });
      return null;
    }
  }

  /** Bring a thread's record in step with its messages, as syncThread says. */
  private apply(threadId: string, messages: GmailMessage[], own: string[], fromBackfill: boolean): { observed: boolean; unread: boolean } {
    const people = this.opts.people;
    if (people)
      for (const m of messages)
        people.saw(
          this.accountId,
          ["From", "To", "Cc"].flatMap((h) => headerPeople(headerOf(m, h))),
          timeOf(m),
          own,
        );
    const inbox = messages.filter(isInInbox);
    if (inbox.length === 0) {
      this.opts.threads.markGoneOutThere(this.accountId, threadId);
      return { observed: false, unread: false };
    }
    // The newest mail someone else sent is the card's stamp, so the person's own reply never resets a waiting card; a
    // thread of only their own mail, a note to themselves, is still a card. What kind it is goes with it (plan 069).
    const incoming = inbox.filter((m) => !fromOwn(m, own));
    const newest = (incoming.length > 0 ? incoming : inbox).at(-1);
    if (!newest) return { observed: false, unread: false };
    const unread = inbox.some((m) => m.labelIds.includes("UNREAD"));
    const sender = senderOf(headerOf(newest, "From"));
    const upTo = messages.slice(0, messages.indexOf(newest) + 1);
    const observed = this.opts.threads.observe(this.accountId, {
      thread_id: threadId,
      message_id: newest.id,
      at: new Date(timeOf(newest)).toISOString(),
      sender: sender.name,
      sender_address: sender.address,
      subject: headerOf(newest, "Subject") || "(no subject)",
      lines: upTo
        .slice(-3)
        .map((m) => plain(m.snippet))
        .filter(Boolean),
      from_backfill: fromBackfill,
      traits: mailTraits(newest.payload?.headers ?? [], own, newest.labelIds),
      unread_out_there: unread,
    });
    return { observed, unread };
  }

  /**
   * Whether Gmail refused one thread rather than the account: a client error that is not a sign-in, an admin's block or
   * a rate limit. Those, a server error, and no answer at all fail the tick instead, so the thread is read again.
   */
  private unreadable(error: GmailError): boolean {
    if (error.status < 400 || error.status >= 500 || error.status === 401 || error.status === 429) return false;
    if (error.reason !== null && RATE_LIMITS.includes(error.reason)) return false;
    return this.opts.accounts.get(this.accountId)?.status === "connected";
  }

  /**
   * List the inbox, newest first, while it may hold threads loki has not drawn (plan 088), and make a card of each
   * thread loki has no record of until the account has PAST_CAP open cards; resting cards leave the count (plan 078).
   * A thread with a record is passed over whatever its state, so a listing never brings back what the person archived,
   * even while that archive is still on its way to Gmail. Stopping at the cap keeps `more`, and the next tick with room
   * lists again; reaching the inbox's end clears it.
   */
  private async listInbox(own: string[]): Promise<void> {
    if (!this.cursor()?.more) return;
    let room = PAST_CAP - this.opts.threads.list(this.accountId).filter((r) => r.state === "open" && !this.opts.resting?.(r)).length;
    if (room <= 0) return;
    let pageToken: string | undefined;
    do {
      const page = await this.opts.client.listInbox(pageToken);
      for (const threadId of page.threads) {
        if (this.opts.threads.get(this.accountId, threadId)) continue;
        const synced = await this.syncThread(threadId, own, true);
        if (synced?.observed && --room <= 0) return;
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    const cursor = this.cursor();
    if (cursor) this.save({ ...cursor, more: false });
  }
}
