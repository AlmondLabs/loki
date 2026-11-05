import { advanceRefill, firstRefill, parseRefill, refillWindow, type RefillCursor, type RefillResult, type RefillWindow } from "../core/account-refill.ts";
import { messageOf } from "../core/errors.ts";
import { addressesIn, mailTraits } from "../core/mail-filter.ts";
import type { AccountThreads, OutsideSource } from "./account-threads.ts";
import type { AccountSync } from "./account-watcher.ts";
import type { AccountRecord, Accounts } from "./accounts.ts";
import { GmailError, type GmailClient, type GmailHistoryRecord, type GmailMessage } from "./gmail.ts";
import { log } from "./log.ts";

/**
 * Watching one Gmail account (plan 067, U5, KTD3, KTD6, KTD11, KTD13; plan 070, KTD2, KTD5). Every thread in the inbox,
 * read or unread, is a card that carries Gmail's read state. The first tick keeps the mailbox's history id and brings
 * every inbox thread of the last 3 days; each later tick asks Gmail what changed since that id (2 quota units when
 * nothing did), turns new mail in the inbox into cards, follows mail read or marked unread in Gmail, and takes away the
 * cards of threads the person archived there. When Gmail no longer keeps history that far back, the account is read
 * again from a bounded search; the thread records keep archived and handed-off threads from coming back. When the
 * account has no unread cards, the next older batch comes (core/account-refill.ts).
 */

/** The calls a Gmail sync makes; GmailClient has them. */
export type GmailSyncClient = Pick<GmailClient, "profile" | "sendAsAddresses" | "historySince" | "listMessages" | "getThread">;

/** What GmailSync is built from; the clock is injected so tests own it. */
export interface GmailSyncOptions {
  accounts: Pick<Accounts, "get" | "setBackfill" | "setStatus">;
  threads: Pick<AccountThreads, "observe" | "markGoneOutThere" | "reopen" | "get" | "list">;
  account: AccountRecord;
  client: GmailSyncClient;
  now?: () => Date;
}

/** Where the watcher stands on a Gmail account, kept as the account's backfill cursor. */
interface GmailCursor {
  history_id: string;
  refill: RefillCursor;
  /** Which rule the records were last brought in step with; a cursor from before plan 070 has none and reads as 1. */
  version: number;
}

/** Failed ticks in a row before the account says it is failing for now (R22). */
const FAILURES_BEFORE_STATUS = 3;
/** Windows one tick reads at most while they bring nothing, so a mailbox full of old newsletters spreads over ticks. */
const REFILL_STEPS_PER_TICK = 4;
/** How far back a rebuild after lost history reads; mail older than this was there before and was read then. */
const REBUILD_DAYS = 30;
const DAY = 24 * 3600 * 1000;
const IN_INBOX = "in:inbox";
const UNREAD_IN_INBOX = "is:unread in:inbox";
/**
 * The cursor's version now. Version 2 (plan 070): every inbox thread is a card, so the threads the rule before archived
 * only for being read are checked once against the inbox.
 */
const CURSOR_VERSION = 2;
/** The reasons Gmail gives, with a 403, for a call that is fine but came too often. */
const RATE_LIMITS = ["rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded"];

/**
 * Archive in Gmail (R12): the card's messages leave the inbox and are marked read, by the client of the account they
 * are in. Only those up to the card's newest message: mail that came since the last poll stays unread in the inbox,
 * and the next tick makes the card again for it.
 */
export function gmailOutsideSource(clientOf: (accountId: string) => Pick<GmailClient, "getThread" | "batchModify">): OutsideSource {
  return {
    archive: async (accountId, record) => {
      const client = clientOf(accountId);
      const messages = (await client.getThread(record.thread_id, "metadata")).messages.sort((a, b) => timeOf(a) - timeOf(b));
      const newest = messages.findIndex((m) => m.id === record.newest_message_id);
      const seen = newest >= 0 ? messages.slice(0, newest + 1) : messages.filter((m) => timeOf(m) <= Date.parse(record.newest_at));
      await client.batchModify(
        seen.map((m) => m.id),
        { removeLabels: ["INBOX", "UNREAD"] },
      );
    },
  };
}

const headerOf = (m: GmailMessage, name: string): string => m.payload?.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
const isInInbox = (m: GmailMessage): boolean => m.labelIds.includes("INBOX");
const fromOwn = (m: GmailMessage, own: readonly string[]): boolean => addressesIn(headerOf(m, "From")).some((a) => own.includes(a));
const timeOf = (m: GmailMessage): number => Number(m.internalDate) || 0;
/** Gmail's search takes whole seconds. */
const seconds = (iso: string, round: (n: number) => number): number => round(Date.parse(iso) / 1000);

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

function parseCursor(v: Record<string, unknown>): GmailCursor | null {
  const refill = parseRefill(v.refill);
  const version = typeof v.version === "number" ? v.version : 1;
  return typeof v.history_id === "string" && v.history_id && refill ? { history_id: v.history_id, refill, version } : null;
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
    this.opts.accounts.setBackfill(this.accountId, { history_id: cursor.history_id, refill: cursor.refill, version: cursor.version });
  }

  private async run(): Promise<void> {
    const own = (this.own ??= [...new Set([...(await this.opts.client.sendAsAddresses()), this.opts.account.address].map((a) => a.trim().toLowerCase()))]);
    const cursor = this.cursor();
    if (!cursor) {
      // The history id first, so mail that comes while the first window is read arrives with the next tick.
      const profile = await this.opts.client.profile();
      this.save({ history_id: profile.historyId, refill: firstRefill(this.now()), version: CURSOR_VERSION });
    } else {
      const changes = await this.opts.client.historySince(cursor.history_id);
      if (changes.kind === "expired") await this.rebuild(own, cursor);
      else {
        for (const threadId of this.touched(changes.history)) await this.syncThread(threadId, own, false);
        this.save({ ...cursor, history_id: changes.history_id });
      }
      if (cursor.version < CURSOR_VERSION) await this.reconcile(own);
    }
    await this.refill(own);
  }

  /**
   * Once, on the first tick after the upgrade to plan 070 (KTD5): the rule before archived a thread whose mail was all
   * read although it stayed in the Gmail inbox. Each archived record's thread is read again; one with a message in the
   * inbox opens again as the same card, and one gone from the inbox stays archived. A failure leaves the version as it
   * was, so the next tick checks again; those already reopened are open by then and are not read twice.
   */
  private async reconcile(own: string[]): Promise<void> {
    for (const r of this.opts.threads.list(this.accountId)) {
      if (r.state !== "archived") continue;
      const messages = await this.threadOf(r.thread_id);
      if (!messages?.some(isInInbox)) continue;
      this.opts.threads.reopen(this.accountId, r.thread_id);
      this.apply(r.thread_id, messages, own, r.from_backfill);
    }
    const cursor = this.cursor();
    if (cursor) this.save({ ...cursor, version: CURSOR_VERSION });
  }

  /**
   * The threads a tick reads again: those with new mail in the inbox, and the open cards' threads that lost UNREAD or
   * INBOX (read or archived in Gmail), gained UNREAD (marked unread there) or lost a message.
   */
  private touched(history: GmailHistoryRecord[]): Set<string> {
    const open = (threadId: string) => this.opts.threads.get(this.accountId, threadId)?.state === "open";
    const out = new Set<string>();
    for (const h of history) {
      for (const m of h.messagesAdded) if (m.labelIds.includes("INBOX")) out.add(m.threadId);
      for (const c of h.labelsRemoved)
        if ((c.labelIds.includes("UNREAD") || c.labelIds.includes("INBOX")) && open(c.message.threadId)) out.add(c.message.threadId);
      for (const c of h.labelsAdded) if (c.labelIds.includes("UNREAD") && open(c.message.threadId)) out.add(c.message.threadId);
      for (const m of h.messagesDeleted) if (open(m.threadId)) out.add(m.threadId);
    }
    return out;
  }

  /**
   * History lost (KTD3): watch on from the mailbox's history id now, read again the inbox of the part already covered
   * (at most the last 30 days), and check each open card's thread. A thread whose newest mail is the one recorded stays
   * as it was, archived or handed off included (AccountThreads.observe).
   */
  private async rebuild(own: string[], cursor: GmailCursor): Promise<void> {
    const profile = await this.opts.client.profile();
    const after = Math.max(Date.parse(cursor.refill.before), this.now().getTime() - REBUILD_DAYS * DAY);
    const threadIds = new Set<string>();
    let pageToken: string | undefined;
    do {
      const page = await this.opts.client.listMessages(`${IN_INBOX} after:${String(Math.floor(after / 1000))}`, pageToken);
      for (const m of page.messages) threadIds.add(m.threadId);
      pageToken = page.nextPageToken;
    } while (pageToken);
    for (const r of this.opts.threads.list(this.accountId)) if (r.state === "open") threadIds.add(r.thread_id);
    for (const threadId of threadIds) await this.syncThread(threadId, own, false);
    this.save({ ...cursor, history_id: profile.historyId });
  }

  /**
   * Read one thread and bring its record in step (plan 070, KTD2): a card while any of its messages is in the inbox,
   * with Gmail's read state, or the card taken away when none is. The thread's messages are returned, for a batch's
   * place; null when the thread is gone or unreadable. `observed` says whether a card opened or changed, and `unread`
   * whether the thread is unread in Gmail.
   */
  private async syncThread(
    threadId: string,
    own: string[],
    fromBackfill: boolean,
  ): Promise<{ observed: boolean; unread: boolean; messages: GmailMessage[] } | null> {
    const messages = await this.threadOf(threadId);
    if (!messages) return null;
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

  /** Bring the next batch of older threads when the account has no unread cards (KTD13; plan 070, KTD5). */
  private async refill(own: string[]): Promise<void> {
    for (let step = 0; step < REFILL_STEPS_PER_TICK; step++) {
      const cursor = this.cursor();
      if (!cursor) return;
      const unreadOpen = this.opts.threads.list(this.accountId).filter((r) => r.state === "open" && r.unread_out_there).length;
      const window = refillWindow(cursor.refill, unreadOpen);
      if (!window) return;
      const { result, taken } = await this.readWindow(window, own);
      this.save({ ...cursor, refill: advanceRefill(cursor.refill, window, result) });
      if (taken > 0) return;
    }
  }

  /**
   * Read one window into cards, newest first (KTD5): every unread thread in it, then read ones until the window's
   * limit. Threads already recorded are passed over.
   */
  private async readWindow(window: RefillWindow, own: string[]): Promise<{ result: RefillResult; taken: number }> {
    const span = `after:${String(seconds(window.after, Math.floor))} before:${String(seconds(window.before, Math.ceil))}`;
    const passed = new Set<string>();
    let any = false;
    let taken = 0;
    let read = 0;
    for (const q of [`${UNREAD_IN_INBOX} ${span}`, `${IN_INBOX} ${span}`]) {
      let pageToken: string | undefined;
      do {
        const page = await this.opts.client.listMessages(q, pageToken);
        for (const listed of page.messages) {
          any = true;
          if (passed.has(listed.threadId) || this.opts.threads.get(this.accountId, listed.threadId)) continue;
          passed.add(listed.threadId);
          const synced = await this.syncThread(listed.threadId, own, true);
          if (!synced?.observed) continue;
          taken++;
          if (synced.unread) continue;
          read++;
          if (window.limit !== null && read >= window.limit) {
            const at = synced.messages.find((m) => m.id === listed.id);
            return { result: { kind: "full", oldest_at: new Date(at ? timeOf(at) : Date.parse(window.after)).toISOString() }, taken };
          }
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
    }
    if (any) return { result: { kind: "done" }, taken };
    return { result: { kind: "empty", newest_older_at: await this.newestBefore(window.after) }, taken };
  }

  /** When the newest mail in the inbox older than a time came, or null when there is none. */
  private async newestBefore(iso: string): Promise<string | null> {
    const page = await this.opts.client.listMessages(`${IN_INBOX} before:${String(seconds(iso, Math.floor))}`);
    const first = page.messages.at(0);
    if (!first) return null;
    const thread = await this.opts.client.getThread(first.threadId, "metadata");
    const m = thread.messages.find((x) => x.id === first.id);
    return m ? new Date(timeOf(m)).toISOString() : null;
  }
}
