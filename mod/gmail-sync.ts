import { PAST_CAP } from "../core/account-refill.ts";
import { messageOf } from "../core/errors.ts";
import { addressesIn, mailTraits } from "../core/mail-filter.ts";
import type { OutsideChange, OutsideMessageChange, OutsideWrite } from "../core/frame-types.ts";
import type { AccountThreads, OutsideSource, ThreadRecord } from "./account-threads.ts";
import type { AccountSync } from "./account-watcher.ts";
import type { AccountRecord, Accounts } from "./accounts.ts";
import { type GmailClient, type GmailHistoryRecord, type GmailMessage } from "./gmail.ts";
import { GoogleError, RATE_LIMITS } from "./google-auth.ts";
import { log } from "./log.ts";
import type { MailReactions } from "./mail-reactions.ts";
import { headerPeople } from "../core/mail-header.ts";
import type { MailPeople } from "./mail-people.ts";

export type GmailSyncClient = Pick<GmailClient, "profile" | "sendAsAddresses" | "historySince" | "listInbox" | "getThread">;

export interface GmailSyncOptions {
  accounts: Pick<Accounts, "get" | "setBackfill">;
  threads: Pick<AccountThreads, "observe" | "markGoneOutThere" | "reopen" | "get" | "list">;
  account: AccountRecord;
  client: GmailSyncClient;
  people?: Pick<MailPeople, "saw">;
  reactions?: Pick<MailReactions, "of" | "known">;
  resting?: (record: ThreadRecord) => boolean;
  now?: () => Date;
}

interface GmailCursor {
  history_id: string;
  more: boolean;
  version: number;
}

const CURSOR_VERSION = 3;
const PREVIEW_LINES = 3;
const WAITS = ["rateLimitExceeded", "userRateLimitExceeded"];

const NEVER_MOVED: ReadonlySet<string> = new Set(["TRASH", "SPAM", "SENT", "DRAFT", "CHAT"]);

export type GmailWriteClient = Pick<GmailClient, "getThread" | "batchModify" | "labels">;

export function gmailOutsideSource(
  clientOf: (accountId: string) => GmailWriteClient,
  reactionsOf?: (accountId: string) => Pick<MailReactions, "of">,
): OutsideSource {
  const thread = async (client: GmailWriteClient, threadId: string) =>
    (await client.getThread(threadId, "metadata")).messages.sort((a, b) => timeOf(a) - timeOf(b));
  const seenOf = (messages: GmailMessage[], record: ThreadRecord) => {
    const newest = messages.findIndex((m) => m.id === record.newest_message_id);
    return newest >= 0 ? messages.slice(0, newest + 1) : messages.filter((m) => timeOf(m) <= Date.parse(record.newest_at));
  };
  const laterReactions = async (accountId: string, messages: GmailMessage[], seen: GmailMessage[]): Promise<GmailMessage[]> => {
    const reactions = reactionsOf?.(accountId);
    if (!reactions) return [];
    const later = messages.filter((m) => !seen.includes(m) && isInInbox(m));
    try {
      const verdicts = await Promise.all(later.map((m) => reactions.of(m)));
      return later.filter((_, i) => verdicts[i] !== null);
    } catch (error) {
      log("gmail:reactions-unread", { account_id: accountId, error: messageOf(error) });
      return [];
    }
  };
  const seenWithReactions = async (accountId: string, messages: GmailMessage[], record: ThreadRecord) => {
    const seen = seenOf(messages, record);
    return [...seen, ...(await laterReactions(accountId, messages, seen))];
  };
  const plan = (messages: GmailMessage[], add: readonly string[], remove: readonly string[]): OutsideMessageChange[] =>
    messages
      .map((m) => ({
        message_id: m.id,
        labels_added: add.filter((l) => !m.labelIds.includes(l)),
        labels_removed: remove.filter((l) => m.labelIds.includes(l)),
      }))
      .filter((c) => c.labels_added.length > 0 || c.labels_removed.length > 0);
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
    pick: (messages: GmailMessage[]) => OutsideMessageChange[] | Promise<OutsideMessageChange[]>,
  ): Promise<OutsideChange> => {
    const client = clientOf(accountId);
    const changes = await pick(await thread(client, record.thread_id));
    await apply(client, changes);
    return { move, messages: changes, ended: move === "archive", was_unread: record.unread_out_there };
  };
  return {
    archive: (accountId, record) =>
      write(accountId, record, "archive", async (messages) => plan(await seenWithReactions(accountId, messages, record), [], ["INBOX", "UNREAD"])),
    markRead: (accountId, record) =>
      write(accountId, record, "read", async (messages) => plan(await seenWithReactions(accountId, messages, record), [], ["UNREAD"])),
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
  const version = typeof v.version === "number" ? v.version : 1;
  if (typeof v.history_id !== "string" || !v.history_id) return null;
  return { history_id: v.history_id, more: v.more === true || version < CURSOR_VERSION, version };
}

export class GmailSync implements AccountSync {
  private readonly opts: GmailSyncOptions;
  private readonly accountId: string;
  private own: string[] | null = null;

  constructor(opts: GmailSyncOptions) {
    this.opts = opts;
    this.accountId = opts.account.account_id;
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

  askedToWait(error: unknown): boolean {
    if (!(error instanceof GoogleError) || !(error.status === 429 || (error.reason !== null && WAITS.includes(error.reason)))) return false;
    log("gmail:rate-limited", { account_id: this.accountId, status: error.status, reason: error.reason });
    return true;
  }

  async tick(): Promise<void> {
    const own = (this.own ??= [...new Set([...(await this.opts.client.sendAsAddresses()), this.opts.account.address].map((a) => a.trim().toLowerCase()))]);
    const cursor = this.cursor();
    if (!cursor) {
      const profile = await this.opts.client.profile();
      this.save({ history_id: profile.historyId, more: true, version: CURSOR_VERSION });
    } else {
      const changes = await this.opts.client.historySince(cursor.history_id);
      if (changes.kind === "expired") await this.rebuild(own);
      else {
        const { all, back, added } = this.touched(changes.history);
        for (const threadId of all) await this.syncThread(threadId, own, false, back.has(threadId), added.get(threadId));
        this.save({ ...cursor, history_id: changes.history_id });
      }
    }
    await this.listInbox(own);
  }

  private touched(history: GmailHistoryRecord[]): { all: Set<string>; back: Set<string>; added: Map<string, Set<string>> } {
    const open = (threadId: string) => this.opts.threads.get(this.accountId, threadId)?.state === "open";
    const all = new Set<string>();
    const back = new Set<string>();
    const added = new Map<string, Set<string>>();
    for (const h of history) {
      for (const m of h.messagesAdded)
        if (m.labelIds.includes("INBOX")) {
          all.add(m.threadId);
          added.set(m.threadId, (added.get(m.threadId) ?? new Set<string>()).add(m.id));
        }
      for (const c of h.labelsRemoved)
        if ((c.labelIds.includes("UNREAD") || c.labelIds.includes("INBOX") || c.labelIds.includes("STARRED")) && open(c.message.threadId))
          all.add(c.message.threadId);
      for (const c of h.labelsAdded) {
        if (c.labelIds.includes("INBOX")) back.add(c.message.threadId);
        if (c.labelIds.includes("INBOX") || ((c.labelIds.includes("UNREAD") || c.labelIds.includes("STARRED")) && open(c.message.threadId)))
          all.add(c.message.threadId);
      }
      for (const m of h.messagesDeleted) if (open(m.threadId)) all.add(m.threadId);
    }
    return { all, back, added };
  }

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

  private async syncThread(
    threadId: string,
    own: string[],
    fromBackfill: boolean,
    reopen = false,
    added: ReadonlySet<string> = new Set(),
  ): Promise<{ observed: boolean; unread: boolean; messages: GmailMessage[] } | null> {
    const messages = await this.threadOf(threadId);
    if (!messages) return null;
    const arrived = messages.filter((m) => added.has(m.id) && isInInbox(m));
    const reactions = await this.reactionsIn(messages, own, arrived);
    if (reopen && messages.some((m) => isInInbox(m) && !reactions.has(m))) this.opts.threads.reopen(this.accountId, threadId);
    const onlyReactionsArrived = !fromBackfill && arrived.length > 0 && arrived.every((m) => reactions.has(m));
    if (onlyReactionsArrived && !this.opts.threads.get(this.accountId, threadId)) return { observed: false, unread: false, messages };
    return { ...this.apply(threadId, messages, own, fromBackfill, reactions), messages };
  }

  private async threadOf(threadId: string): Promise<GmailMessage[] | null> {
    try {
      return (await this.opts.client.getThread(threadId, "metadata")).messages.sort((a, b) => timeOf(a) - timeOf(b));
    } catch (error) {
      if (!(error instanceof GoogleError)) throw error;
      if (error.status === 404) {
        this.opts.threads.markGoneOutThere(this.accountId, threadId);
        return null;
      }
      if (!this.unreadable(error)) throw error;
      log("gmail:thread-unreadable", { account_id: this.accountId, thread_id: threadId, error: messageOf(error) });
      return null;
    }
  }

  private async reactionsIn(messages: GmailMessage[], own: string[], arrived: readonly GmailMessage[]): Promise<Set<GmailMessage>> {
    const classifier = this.opts.reactions;
    const found = new Set<GmailMessage>();
    if (!classifier) return found;
    const isReaction = async (m: GmailMessage) => {
      const reaction = (await classifier.of(m)) !== null;
      if (reaction) found.add(m);
      return reaction;
    };
    const inbox = messages.filter(isInInbox);
    for (const m of [...inbox].reverse()) if (!(await isReaction(m))) break;
    for (const m of inbox) if (m.labelIds.includes("UNREAD")) await isReaction(m);
    for (const m of arrived) await isReaction(m);
    const mails = inbox.filter((m) => !found.has(m));
    const newest = mails.filter((m) => !fromOwn(m, own)).at(-1) ?? mails.at(-1);
    let lines = 0;
    for (const m of messages.slice(0, newest ? messages.indexOf(newest) + 1 : 0).reverse()) {
      if (lines >= PREVIEW_LINES) break;
      if (!(await isReaction(m))) lines++;
    }
    return found;
  }

  private apply(
    threadId: string,
    messages: GmailMessage[],
    own: string[],
    fromBackfill: boolean,
    reactions: ReadonlySet<GmailMessage>,
  ): { observed: boolean; unread: boolean } {
    const people = this.opts.people;
    if (people)
      for (const m of messages.filter((m) => !this.opts.reactions?.known(m)))
        people.saw(
          this.accountId,
          ["From", "To", "Cc"].flatMap((h) => headerPeople(headerOf(m, h))),
          timeOf(m),
          own,
        );
    const inbox = messages.filter((m) => isInInbox(m) && !reactions.has(m));
    if (inbox.length === 0) {
      this.opts.threads.markGoneOutThere(this.accountId, threadId);
      return { observed: false, unread: false };
    }
    const incoming = inbox.filter((m) => !fromOwn(m, own));
    const newest = (incoming.length > 0 ? incoming : inbox).at(-1);
    if (!newest) return { observed: false, unread: false };
    const unread = inbox.some((m) => m.labelIds.includes("UNREAD"));
    const sender = senderOf(headerOf(newest, "From"));
    const upTo = messages.slice(0, messages.indexOf(newest) + 1).filter((m) => !reactions.has(m));
    const observed = this.opts.threads.observe(this.accountId, {
      thread_id: threadId,
      message_id: newest.id,
      at: new Date(timeOf(newest)).toISOString(),
      sender: sender.name,
      sender_address: sender.address,
      subject: headerOf(newest, "Subject") || "(no subject)",
      lines: upTo
        .slice(-PREVIEW_LINES)
        .map((m) => plain(m.snippet))
        .filter(Boolean),
      from_backfill: fromBackfill,
      traits: mailTraits(newest.payload?.headers ?? [], own, newest.labelIds),
      unread_out_there: unread,
      // Outside (Gmail): a star belongs to a message, not a thread.
      starred: messages.some((m) => m.labelIds.includes("STARRED")),
    });
    return { observed, unread };
  }

  private unreadable(error: GoogleError): boolean {
    if (error.status < 400 || error.status >= 500 || error.status === 401 || error.status === 429) return false;
    if (error.reason !== null && RATE_LIMITS.includes(error.reason)) return false;
    return this.opts.accounts.get(this.accountId)?.status === "connected";
  }

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
