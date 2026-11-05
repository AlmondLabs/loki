import { advanceRefill, firstRefill, parseRefill, refillWindow, type RefillCursor, type RefillResult, type RefillWindow } from "../core/account-refill.ts";
import { messageOf } from "../core/errors.ts";
import { addressesIn, mailTraits } from "../core/mail-filter.ts";
import type { AccountThreads, OutsideSource } from "./account-threads.ts";
import type { AccountSync } from "./account-watcher.ts";
import type { AccountRecord, Accounts } from "./accounts.ts";
import { GmailError, type GmailClient, type GmailHistoryRecord, type GmailMessage } from "./gmail.ts";
import { log } from "./log.ts";

/**
 * Watching one Gmail account (plan 067, U5, KTD3, KTD6, KTD11, KTD13). The first tick keeps the mailbox's history id
 * and brings every unread thread of the last 3 days; each later tick asks Gmail what changed since that id
 * (2 quota units when nothing did), turns new unread mail into cards and takes away the cards of threads the person
 * read or archived in Gmail. When Gmail no longer keeps history that far back, the account is read again from a bounded
 * search; the thread records keep archived and handed-off threads from coming back. When the account has no open
 * outside cards, the next older batch comes (core/account-refill.ts).
 */

/** The calls a Gmail sync makes; GmailClient has them. */
export type GmailSyncClient = Pick<GmailClient, "profile" | "sendAsAddresses" | "historySince" | "listMessages" | "getThread">;

/** What GmailSync is built from; the clock is injected so tests own it. */
export interface GmailSyncOptions {
  accounts: Pick<Accounts, "get" | "setBackfill" | "setStatus">;
  threads: Pick<AccountThreads, "observe" | "markReadOutThere" | "get" | "list">;
  account: AccountRecord;
  client: GmailSyncClient;
  now?: () => Date;
}

/** Where the watcher stands on a Gmail account, kept as the account's backfill cursor. */
interface GmailCursor {
  history_id: string;
  refill: RefillCursor;
}

/** Failed ticks in a row before the account says it is failing for now (R22). */
const FAILURES_BEFORE_STATUS = 3;
/** Windows one tick reads at most while they bring nothing, so a mailbox full of old newsletters spreads over ticks. */
const REFILL_STEPS_PER_TICK = 4;
/** How far back a rebuild after lost history reads; mail older than this was there before and was read then. */
const REBUILD_DAYS = 30;
const DAY = 24 * 3600 * 1000;
const UNREAD_IN_INBOX = "is:unread in:inbox";
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
const isUnreadInInbox = (m: GmailMessage): boolean => m.labelIds.includes("UNREAD") && m.labelIds.includes("INBOX");
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
  return typeof v.history_id === "string" && v.history_id && refill ? { history_id: v.history_id, refill } : null;
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
    this.opts.accounts.setBackfill(this.accountId, { history_id: cursor.history_id, refill: cursor.refill });
  }

  private async run(): Promise<void> {
    const own = (this.own ??= [...new Set([...(await this.opts.client.sendAsAddresses()), this.opts.account.address])]);
    const cursor = this.cursor();
    if (!cursor) {
      // The history id first, so mail that comes while the first window is read arrives with the next tick.
      const profile = await this.opts.client.profile();
      this.save({ history_id: profile.historyId, refill: firstRefill(this.now()) });
    } else {
      const changes = await this.opts.client.historySince(cursor.history_id);
      if (changes.kind === "expired") await this.rebuild(own, cursor);
      else {
        for (const threadId of this.touched(changes.history)) await this.syncThread(threadId, own, false);
        this.save({ ...cursor, history_id: changes.history_id });
      }
    }
    await this.refill(own);
  }

  /**
   * The threads a tick reads again: those with new mail in the inbox, and the open cards' threads that lost UNREAD or
   * INBOX (read or archived in Gmail) or lost a message.
   */
  private touched(history: GmailHistoryRecord[]): Set<string> {
    const open = (threadId: string) => this.opts.threads.get(this.accountId, threadId)?.state === "open";
    const out = new Set<string>();
    for (const h of history) {
      for (const m of h.messagesAdded) if (m.labelIds.includes("INBOX")) out.add(m.threadId);
      for (const c of h.labelsRemoved)
        if ((c.labelIds.includes("UNREAD") || c.labelIds.includes("INBOX")) && open(c.message.threadId)) out.add(c.message.threadId);
      for (const m of h.messagesDeleted) if (open(m.threadId)) out.add(m.threadId);
    }
    return out;
  }

  /**
   * History lost (KTD3): watch on from the mailbox's history id now, read again the unread mail of the part already
   * covered (at most the last 30 days), and check each open card's thread. A thread whose newest unread mail is the
   * one recorded stays as it was, archived or handed off included (AccountThreads.observe).
   */
  private async rebuild(own: string[], cursor: GmailCursor): Promise<void> {
    const profile = await this.opts.client.profile();
    const after = Math.max(Date.parse(cursor.refill.before), this.now().getTime() - REBUILD_DAYS * DAY);
    const threadIds = new Set<string>();
    let pageToken: string | undefined;
    do {
      const page = await this.opts.client.listMessages(`${UNREAD_IN_INBOX} after:${String(Math.floor(after / 1000))}`, pageToken);
      for (const m of page.messages) threadIds.add(m.threadId);
      pageToken = page.nextPageToken;
    } while (pageToken);
    for (const r of this.opts.threads.list(this.accountId)) if (r.state === "open") threadIds.add(r.thread_id);
    for (const threadId of threadIds) await this.syncThread(threadId, own, false);
    this.save({ ...cursor, history_id: profile.historyId });
  }

  /**
   * Read one thread and bring its record in step: a card for its newest unread mail, or the card taken away
   * when nothing in it is unread in the inbox now. The newest message read is returned, for a batch's place; null when
   * the thread is gone. `observed` says whether a card opened or changed.
   */
  private async syncThread(threadId: string, own: string[], fromBackfill: boolean): Promise<{ observed: boolean; messages: GmailMessage[] } | null> {
    let messages: GmailMessage[];
    try {
      messages = (await this.opts.client.getThread(threadId, "metadata")).messages.sort((a, b) => timeOf(a) - timeOf(b));
    } catch (error) {
      if (!(error instanceof GmailError)) throw error;
      if (error.status === 404) {
        this.opts.threads.markReadOutThere(this.accountId, threadId);
        return null;
      }
      if (!this.unreadable(error)) throw error;
      // Gmail refuses this one thread for good: pass it over so the history moves on and other mail keeps coming.
      log("gmail:thread-unreadable", { account_id: this.accountId, thread_id: threadId, error: messageOf(error) });
      return null;
    }
    const unread = messages.filter(isUnreadInInbox);
    if (unread.length === 0) {
      this.opts.threads.markReadOutThere(this.accountId, threadId);
      return { observed: false, messages };
    }
    // Every unread mail in the inbox is a card (plan 069); what kind it is goes with it, and nothing keeps it out.
    const newest = unread.at(-1);
    if (!newest) return { observed: false, messages };
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
    });
    return { observed, messages };
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

  /** Bring the next batch of older unread threads when the account's cards are cleared (KTD13). */
  private async refill(own: string[]): Promise<void> {
    for (let step = 0; step < REFILL_STEPS_PER_TICK; step++) {
      const cursor = this.cursor();
      if (!cursor) return;
      const open = this.opts.threads.list(this.accountId).filter((r) => r.state === "open").length;
      const window = refillWindow(cursor.refill, open);
      if (!window) return;
      const { result, taken } = await this.readWindow(window, own);
      this.save({ ...cursor, refill: advanceRefill(cursor.refill, window, result) });
      if (taken > 0) return;
    }
  }

  /** Read one window's unread mail, newest first, into cards until its limit; threads already recorded are passed over. */
  private async readWindow(window: RefillWindow, own: string[]): Promise<{ result: RefillResult; taken: number }> {
    const q = `${UNREAD_IN_INBOX} after:${String(seconds(window.after, Math.floor))} before:${String(seconds(window.before, Math.ceil))}`;
    const read = new Set<string>();
    let any = false;
    let taken = 0;
    let pageToken: string | undefined;
    do {
      const page = await this.opts.client.listMessages(q, pageToken);
      for (const listed of page.messages) {
        any = true;
        if (read.has(listed.threadId) || this.opts.threads.get(this.accountId, listed.threadId)) continue;
        read.add(listed.threadId);
        const synced = await this.syncThread(listed.threadId, own, true);
        if (!synced?.observed) continue;
        taken++;
        if (window.limit !== null && taken >= window.limit) {
          const at = synced.messages.find((m) => m.id === listed.id);
          return { result: { kind: "full", oldest_at: new Date(at ? timeOf(at) : Date.parse(window.after)).toISOString() }, taken };
        }
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    if (any) return { result: { kind: "done" }, taken };
    return { result: { kind: "empty", newest_older_at: await this.newestBefore(window.after) }, taken };
  }

  /** When the newest unread mail older than a time came, or null when there is none. */
  private async newestBefore(iso: string): Promise<string | null> {
    const page = await this.opts.client.listMessages(`${UNREAD_IN_INBOX} before:${String(seconds(iso, Math.floor))}`);
    const first = page.messages.at(0);
    if (!first) return null;
    const thread = await this.opts.client.getThread(first.threadId, "metadata");
    const m = thread.messages.find((x) => x.id === first.id);
    return m ? new Date(timeOf(m)).toISOString() : null;
  }
}
