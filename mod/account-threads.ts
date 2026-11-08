import { chmodSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { AccountLabel, AccountProvider, InboxRow, OutsideChange, OutsideReach } from "../core/frame-types.ts";
import { Listeners } from "../core/listeners.ts";
import { parseMailTraits, type MailTraits } from "../core/mail-filter.ts";
import { REACH_LEVEL, mailReach } from "../core/outside-reach.ts";
import { keyedQueue } from "../core/serial.ts";
import { accountLabel, type AccountRecord, type Accounts } from "./accounts.ts";
import { writeJsonAtomic } from "./json-file.ts";
import { log } from "./log.ts";

/**
 * What loki remembers of each thread in a connected account (plan 067, U3, KTD11), and the outside Inbox cards it
 * yields. A watcher reports each thread it sees with its newest message; a card opens, or the open card updates, only
 * when that message is newer than the one recorded, so a poll, a resync or a restart never brings back a card the
 * person archived or handed off. Records live in `state/account-threads/<account id>.json`, one file per account,
 * written whole after each change.
 */

/** Where a thread stands: a card in the Inbox, archived (here or out there), or handed to its owner's chat. */
export type ThreadState = "open" | "archived" | "handed_off";

/** One thread as its account's file keeps it. */
export interface ThreadRecord {
  thread_id: string;
  state: ThreadState;
  /** The card's generation (KTD1): it rises when a handed-off thread gets a new message, so that card starts clean. */
  generation: number;
  newest_message_id: string;
  /** ISO time of the newest message: what "newer" is judged by. */
  newest_at: string;
  sender: string;
  sender_address: string | null;
  subject_or_first_line: string;
  /** The last few messages as plain text, oldest first, for the card's body. */
  lines: string[];
  handoff_conversation_id: string | null;
  /** It came from a batch of older items (KTD13), not from watching. */
  from_backfill: boolean;
  /** What kind of mail its newest message is (plan 069); null for Slack and for records from before. */
  traits: MailTraits | null;
  /**
   * Whether the thread is unread in its service (plan 070, KTD2): for Gmail, whether any of its messages in the inbox
   * is unread. A record from before this was kept reads as unread, so no card goes quiet on the upgrade.
   */
  unread_out_there: boolean;
  /**
   * The person replied and is waiting for an answer (plan 070, KTD7): set by a reply with "later", cleared when a newer
   * message comes. While it is set, Slack's read marker, which the person's own post moves, does not end the card.
   */
  waiting: boolean;
  /**
   * An undo reopened this card after its read or archive ended it (plan 070, R14). Slack keeps the DM read, since
   * nothing there is put back, so its read marker would end the card again at the next poll; while this is set it does
   * not. A newer message clears it, and from then on the read marker ends the card as usual.
   */
  kept_open: boolean;
  /** How directly a Slack card is meant for the person (plan 073); null for mail, whose traits say it, and from before. */
  reach: OutsideReach | null;
  /** Where a Slack message was posted, `#channel`; null for a DM, for mail and from before. */
  place: string | null;
  /** The sender's Slack photo; null for mail and from before. */
  sender_avatar: string | null;
  /**
   * The newest message when the person last dealt with the card (plan 076, KTD1): archived it, marked it read, replied
   * from it or handed it off. Only what came after it is new on the card; null until the person first acts.
   */
  dealt_message_id: string | null;
  /** The mark before the last move set it, so an undo of that move puts it back. */
  dealt_was: string | null;
  /** The Slack messages that brought the card into the Inbox (plan 076, KTD2), oldest first; empty for mail. */
  brought_ids: string[];
}

/** A thread as a watcher saw it, with its newest message. */
export interface ObservedMessage {
  thread_id: string;
  message_id: string;
  at: string;
  sender: string;
  sender_address?: string | null;
  /** The subject, or a Slack message's first line. */
  subject: string;
  /** The thread's last messages as plain text, oldest first; only the last few are kept. */
  lines: string[];
  from_backfill?: boolean;
  /** What kind of mail it is (plan 069); Slack has none. */
  traits?: MailTraits | null;
  /** Whether the thread is unread out there (plan 070); unread when not said, as every Slack card is. */
  unread_out_there?: boolean;
  /** Slack's facts for the card's header (plan 073); mail has none. */
  reach?: OutsideReach | null;
  place?: string | null;
  sender_avatar?: string | null;
  /** The Slack messages that brought the card, oldest first (plan 076); left as they were when not said. */
  brought_ids?: string[];
}

/**
 * A provider's write-backs (plan 067, R12; plan 070, KTD3): each move on an outside card written to Gmail or Slack.
 * Each write answers what it changed, so `restore` can put back exactly that for an undo (R14). Each throws why when it
 * could not, and the record stays as it was.
 */
export interface OutsideSource {
  /** Archive the email in Gmail; mark a Slack item read. */
  archive(accountId: string, record: ThreadRecord): Promise<OutsideChange>;
  /** Mark the thread read up to the card's newest message; in Slack, reading is the card's end. */
  markRead(accountId: string, record: ThreadRecord): Promise<OutsideChange>;
  /** Leave the thread unread: in Gmail its newest incoming message is marked unread. */
  markUnread(accountId: string, record: ThreadRecord): Promise<OutsideChange>;
  /** Put the account's labels, by id, on the thread; Slack has none. */
  addLabels(accountId: string, record: ThreadRecord, labels: string[]): Promise<OutsideChange>;
  /** Take back what one of the writes above changed. */
  restore(accountId: string, record: ThreadRecord, change: OutsideChange): Promise<void>;
  /** The account's labels, for the picker. */
  labels(accountId: string): Promise<AccountLabel[]>;
}

/** What AccountThreads is built from. */
export interface AccountThreadsOptions {
  /** `state/account-threads`. */
  dir: string;
  accounts: Pick<Accounts, "get" | "list">;
  /** An agent's name for the card, or null. */
  agentName?: (agentId: string) => string | null;
  /** The clock, for the name a damaged file is moved aside under. */
  now?: () => Date;
}

/** How many messages a card shows, and how much of each. */
const LINES = 3;
/** How many of the messages that brought a card it remembers; the newest are kept. */
const BROUGHT_MAX = 50;
const LINE_MAX = 280;
const STATES: readonly ThreadState[] = ["open", "archived", "handed_off"];

/** A file name for an account id on every system: ":" and the like, which Windows refuses, written as %XX. */
function fileName(accountId: string): string {
  return `${accountId.replace(/[^A-Za-z0-9._@-]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)}.json`;
}

/** Whether a message is newer than the one recorded: later, or at the same instant with a later id. */
const newer = (m: { at: string; message_id: string }, r: ThreadRecord): boolean =>
  m.at > r.newest_at || (m.at === r.newest_at && m.message_id !== r.newest_message_id && m.message_id > r.newest_message_id);

const trimLines = (lines: string[]): string[] => lines.slice(-LINES).map((l) => (l.length > LINE_MAX ? `${l.slice(0, LINE_MAX - 1)}…` : l));

/** A record as a file gives it, or null when it is not one. */
function parseRecord(v: unknown): ThreadRecord | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  const s = (k: string) => (typeof r[k] === "string" ? r[k] : null);
  const threadId = s("thread_id"),
    messageId = s("newest_message_id"),
    at = s("newest_at");
  if (!threadId || messageId === null || at === null || !STATES.includes(r.state as ThreadState)) return null;
  return {
    thread_id: threadId,
    state: r.state as ThreadState,
    generation: typeof r.generation === "number" && r.generation >= 1 ? Math.floor(r.generation) : 1,
    newest_message_id: messageId,
    newest_at: at,
    sender: s("sender") ?? "",
    sender_address: s("sender_address"),
    subject_or_first_line: s("subject_or_first_line") ?? "",
    lines: Array.isArray(r.lines) ? r.lines.filter((l): l is string => typeof l === "string") : [],
    handoff_conversation_id: s("handoff_conversation_id"),
    from_backfill: r.from_backfill === true,
    traits: parseMailTraits(r.traits),
    unread_out_there: r.unread_out_there !== false,
    waiting: r.waiting === true,
    kept_open: r.kept_open === true,
    reach: typeof r.reach === "string" && r.reach in REACH_LEVEL ? (r.reach as OutsideReach) : null,
    place: s("place"),
    sender_avatar: s("sender_avatar"),
    dealt_message_id: s("dealt_message_id"),
    dealt_was: s("dealt_was"),
    brought_ids: Array.isArray(r.brought_ids) ? r.brought_ids.filter((l): l is string => typeof l === "string") : [],
  };
}

/** A record marked as dealt with at its newest message (plan 076, KTD1), keeping the mark it had for an undo. */
const dealt = (r: ThreadRecord): ThreadRecord => ({ ...r, dealt_message_id: r.newest_message_id, dealt_was: r.dealt_message_id });

/** The thread records of every account on this Mac, and the outside cards they make. */
export class AccountThreads {
  private readonly opts: AccountThreadsOptions;
  /** Each account's records by thread id, read from its file on first use. */
  private readonly byAccount = new Map<string, Map<string, ThreadRecord>>();
  private readonly sources = new Map<AccountProvider, OutsideSource>();
  private readonly listeners = new Listeners();
  /** One archive at a time per thread, so a second press never writes back twice. */
  private readonly serial = keyedQueue();

  constructor(opts: AccountThreadsOptions) {
    this.opts = opts;
  }

  /** The write-back a provider's watcher brings (U5, U7); archive on its accounts fails until one is registered. */
  register(provider: AccountProvider, source: OutsideSource): void {
    this.sources.set(provider, source);
  }

  /**
   * A thread a watcher saw, with its newest message (R7, KTD11): a new thread opens a card; a newer message updates the
   * open card, reopens an archived one as the same card, or makes a handed-off one a card of the next generation (R19).
   * Returns whether anything changed. A message no newer than the recorded one changes only an open card's read state
   * out there (plan 070, AE7), so mail read in Gmail keeps its card.
   */
  observe(accountId: string, m: ObservedMessage): boolean {
    const records = this.records(accountId);
    const prev = records.get(m.thread_id);
    const unreadOutThere = m.unread_out_there ?? true;
    if (prev && !newer(m, prev)) {
      if (prev.state !== "open" || prev.unread_out_there === unreadOutThere) return false;
      records.set(m.thread_id, { ...prev, unread_out_there: unreadOutThere });
      this.save(accountId);
      return true;
    }
    const generation = !prev ? 1 : prev.state === "handed_off" ? prev.generation + 1 : prev.generation;
    records.set(m.thread_id, {
      thread_id: m.thread_id,
      state: "open",
      generation,
      newest_message_id: m.message_id,
      newest_at: m.at,
      sender: m.sender,
      sender_address: m.sender_address ?? null,
      subject_or_first_line: m.subject,
      lines: trimLines(m.lines),
      handoff_conversation_id: prev?.handoff_conversation_id ?? null,
      from_backfill: prev ? prev.from_backfill && m.from_backfill === true : m.from_backfill === true,
      traits: m.traits ?? null,
      unread_out_there: unreadOutThere,
      // A newer message is the other side writing, so the person is no longer waiting on them.
      waiting: false,
      // The undo kept the card open for the message it showed; a newer one is a card the read marker may end again.
      kept_open: false,
      reach: m.reach ?? null,
      place: m.place ?? null,
      sender_avatar: m.sender_avatar ?? null,
      dealt_message_id: prev?.dealt_message_id ?? null,
      dealt_was: prev?.dealt_was ?? null,
      brought_ids: (m.brought_ids ?? prev?.brought_ids ?? []).slice(-BROUGHT_MAX),
    });
    this.save(accountId);
    return true;
  }

  /**
   * The thread reached its end in its service first (R13, plan 070 R2, R3): it left the Gmail inbox, or the Slack item
   * was read. Its card leaves; nothing is written back.
   */
  markGoneOutThere(accountId: string, threadId: string): boolean {
    const r = this.records(accountId).get(threadId);
    if (r?.state !== "open") return false;
    this.records(accountId).set(threadId, { ...r, state: "archived" });
    this.save(accountId);
    return true;
  }

  /**
   * The person replied on an open card and waits for an answer (plan 070, KTD7): the record is marked waiting until a
   * newer message comes. Returns whether it changed; a card that is not open stays as it is.
   */
  markWaiting(accountId: string, threadId: string): boolean {
    const r = this.records(accountId).get(threadId);
    if (r?.state !== "open" || r.waiting) return false;
    this.records(accountId).set(threadId, { ...r, waiting: true });
    this.save(accountId);
    return true;
  }

  /**
   * The person sent a reply from the card (plan 076, R5): what came before it is dealt with, whatever move follows.
   * Returns whether it changed.
   */
  markDealt(accountId: string, threadId: string): boolean {
    const r = this.records(accountId).get(threadId);
    if (!r || r.dealt_message_id === r.newest_message_id) return false;
    this.records(accountId).set(threadId, dealt(r));
    this.save(accountId);
    return true;
  }

  /**
   * An archived thread is back in its service's inbox (plan 070, KTD4): it opens again as the same card, without the
   * check for a newer message. The caller has seen it in the inbox. Returns whether it reopened; an open or handed-off
   * thread stays as it is.
   */
  reopen(accountId: string, threadId: string): boolean {
    const r = this.records(accountId).get(threadId);
    if (r?.state !== "archived") return false;
    this.records(accountId).set(threadId, { ...r, state: "open" });
    this.save(accountId);
    return true;
  }

  /**
   * Archive from the Inbox (R12): written back to the account first, then the card leaves. Throws why when the account
   * refused or cannot be reached, and the card stays. A message that came while the write-back ran keeps the card open.
   * Answers what the write-back changed, for an undo, or null when the card was not open and nothing was written.
   */
  archive(accountId: string, threadId: string): Promise<OutsideChange | null> {
    return this.write(accountId, threadId, "archive", (source, r) => source.archive(accountId, r));
  }

  /**
   * Mark read from the Inbox (plan 070, R5): written back first, then the card shows read and stays; in Slack, where
   * reading ends a card, the card leaves. A message that came while it ran keeps the card as that message left it.
   */
  markRead(accountId: string, threadId: string): Promise<OutsideChange | null> {
    return this.write(accountId, threadId, "mark read", (source, r) => source.markRead(accountId, r));
  }

  /** Leave the card unread (plan 070, R6): written back first, then the card shows unread. */
  markUnread(accountId: string, threadId: string): Promise<OutsideChange | null> {
    return this.write(accountId, threadId, "mark unread", (source, r) => source.markUnread(accountId, r));
  }

  /** Put labels on the card's thread (plan 070, R12); the card stays as it is, waiting for the next move. */
  addLabels(accountId: string, threadId: string, labels: string[]): Promise<OutsideChange | null> {
    return this.write(accountId, threadId, "label", (source, r) => source.addLabels(accountId, r, labels));
  }

  /** The labels of an account, for the picker (plan 070, R12). Throws why when its service has none or cannot answer. */
  async labels(accountId: string): Promise<AccountLabel[]> {
    return this.sourceOf(accountId, "list labels").labels(accountId);
  }

  /**
   * Undo one move (plan 070, R14, KTD4): what the move changed out there is put back first, then the record as the move
   * found it: a card the move ended opens again as the same card, kept open until a newer message comes, and it shows
   * read or unread as it did before. A label's undo leaves the record. Throws why when the account refused, and the
   * record stays.
   */
  restore(accountId: string, threadId: string, change: OutsideChange): Promise<void> {
    return this.serial(`${accountId} ${threadId}`, async () => {
      const r = this.records(accountId).get(threadId);
      if (!r) throw new Error("loki has no record of that thread");
      await this.sourceOf(accountId, "undo").restore(accountId, r, change);
      const now = this.records(accountId).get(threadId);
      if (!now) return;
      const reopened = change.ended && now.state === "archived";
      const state = reopened ? "open" : now.state;
      const unread = change.move === "label" ? now.unread_out_there : change.was_unread;
      const keptOpen = reopened || now.kept_open;
      // The move being undone set the dealt-with mark; it goes back to what it was, so the card's new messages stay new.
      const mark = reopened ? now.dealt_was : now.dealt_message_id;
      if (state === now.state && unread === now.unread_out_there && keptOpen === now.kept_open && mark === now.dealt_message_id) return;
      this.records(accountId).set(threadId, { ...now, state, unread_out_there: unread, kept_open: keptOpen, dealt_message_id: mark });
      this.save(accountId);
    });
  }

  /**
   * One write-back on an open card, one at a time per thread so a second press never writes twice, then the record
   * moved as the change says: ended, read or unread. A message that came while it ran leaves the record as that message
   * made it, since the move was not about that message.
   */
  private write(
    accountId: string,
    threadId: string,
    what: string,
    run: (source: OutsideSource, r: ThreadRecord) => Promise<OutsideChange>,
  ): Promise<OutsideChange | null> {
    return this.serial(`${accountId} ${threadId}`, async () => {
      const r = this.records(accountId).get(threadId);
      if (r?.state !== "open") return null;
      const change = await run(this.sourceOf(accountId, what), r);
      const now = this.records(accountId).get(threadId);
      if (now?.state !== "open" || now.newest_message_id !== r.newest_message_id) return change;
      const next = change.ended
        ? { ...dealt(now), state: "archived" as const }
        : change.move === "read" || change.move === "unread"
          ? { ...now, unread_out_there: change.move === "unread" }
          : now;
      if (next !== now) {
        this.records(accountId).set(threadId, next);
        this.save(accountId);
      }
      return change;
    });
  }

  /** The write-back of an account's provider; throws why when the account is not here or its provider has none yet. */
  private sourceOf(accountId: string, what: string): OutsideSource {
    const account = this.opts.accounts.get(accountId);
    if (!account) throw new Error("that account is not connected on this Mac");
    const source = this.sources.get(account.provider);
    if (!source) throw new Error(`loki cannot ${what} in ${account.provider === "gmail" ? "Gmail" : "Slack"} yet`);
    return source;
  }

  /**
   * The thread went to its owner's chat (U8): the card leaves, and the chat is named on the next one. When the hand-off
   * says which message it sent (`handedMessageId`) and a newer one came while it ran, that message was not sent: the
   * card stays open as the next generation, as observe() makes it after a hand-off, so the person still sees it.
   */
  handedOff(accountId: string, threadId: string, conversationId: string, handedMessageId?: string): boolean {
    const r = this.records(accountId).get(threadId);
    if (!r) return false;
    const missed = handedMessageId !== undefined && handedMessageId !== r.newest_message_id;
    this.records(accountId).set(
      threadId,
      missed
        ? { ...r, state: "open", generation: r.generation + 1, handoff_conversation_id: conversationId }
        : { ...dealt(r), state: "handed_off", handoff_conversation_id: conversationId },
    );
    this.save(accountId);
    return true;
  }

  /**
   * Archive a handed-off thread out there (plan 070, U9, R13): Gmail archives it, Slack marks it read, each up to the
   * newest message the record holds, which is the one handed off. The record stays handed off. A thread that is not
   * handed off, because a newer message came during the hand-off and its card is open again, is left alone and null
   * comes back, so nothing the chat never got is archived. Throws why when the account refused.
   */
  archiveHandedOff(accountId: string, threadId: string): Promise<OutsideChange | null> {
    return this.serial(`${accountId} ${threadId}`, async () => {
      const r = this.records(accountId).get(threadId);
      if (r?.state !== "handed_off") return null;
      return this.sourceOf(accountId, "archive").archive(accountId, r);
    });
  }

  /** One thread's record, or null. */
  get(accountId: string, threadId: string): ThreadRecord | null {
    const r = this.records(accountId).get(threadId);
    return r ? { ...r } : null;
  }

  /** Every record of an account, open or not. */
  list(accountId: string): ThreadRecord[] {
    return [...this.records(accountId).values()].map((r) => ({ ...r }));
  }

  /** The open threads of every account here, as Inbox rows (KTD1), newest first. */
  rows(): InboxRow[] {
    const out: InboxRow[] = [];
    for (const account of this.opts.accounts.list())
      for (const r of this.records(account.account_id).values()) if (r.state === "open") out.push(this.row(account, r));
    return out.sort((a, b) => (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""));
  }

  /** Hear every change to the records; returns the unsubscribe. */
  onChange(listener: () => void): () => void {
    return this.listeners.add(listener);
  }

  private row(account: AccountRecord, r: ThreadRecord): InboxRow {
    const label = accountLabel(account);
    return {
      kind: "outside",
      id: `${r.thread_id}#${String(r.generation)}`,
      agent_id: `account:${account.account_id}`,
      agent_name: label,
      title: r.subject_or_first_line,
      last_message_at: r.newest_at,
      archived: false,
      last_role: null,
      last_assistant_text: null,
      last_ask: null,
      outside: {
        account_id: account.account_id,
        provider: account.provider,
        account_label: account.address,
        thread_id: r.thread_id,
        generation: r.generation,
        owner_agent_id: account.owner_agent_id,
        owner_name: this.opts.agentName?.(account.owner_agent_id) ?? null,
        sender: r.sender,
        sender_address: account.provider === "gmail" ? r.sender_address : null,
        subject: r.subject_or_first_line,
        lines: [...r.lines],
        newest_message_id: r.newest_message_id,
        newest_at: r.newest_at,
        handoff_conversation_id: r.handoff_conversation_id,
        disconnected: account.status === "connected" ? null : account.status.disconnected,
        unread_out_there: r.unread_out_there,
        reach: r.reach ?? (account.provider === "gmail" ? mailReach(r.traits) : null),
        place: r.place,
        sender_avatar: r.sender_avatar,
        only_account: this.opts.accounts.list().filter((a) => a.provider === account.provider).length <= 1,
      },
    };
  }

  private file(accountId: string): string {
    return join(this.opts.dir, fileName(accountId));
  }

  private records(accountId: string): Map<string, ThreadRecord> {
    let records = this.byAccount.get(accountId);
    if (!records) {
      const list = this.read(accountId);
      const parsed = list.map(parseRecord).filter((r): r is ThreadRecord => r !== null);
      records = new Map(parsed.map((r) => [r.thread_id, r]));
      this.byAccount.set(accountId, records);
    }
    return records;
  }

  /**
   * An account's records as its file holds them, empty when there is no file. A file that is not a list of threads is
   * moved aside first, so the next save does not write over the archived and handed-off records a person could recover.
   */
  private read(accountId: string): unknown[] {
    const file = this.file(accountId);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    let raw: unknown = null;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      // Not JSON: handled below with any other shape that is not a list of threads.
    }
    const list = typeof raw === "object" && raw !== null ? (raw as { threads?: unknown }).threads : null;
    if (Array.isArray(list)) return list as unknown[];
    // A colon is not allowed in a Windows file name, so the time is written without them.
    const stamp = (this.opts.now?.() ?? new Date())
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z");
    const aside = `${file}.bad-${stamp}`;
    renameSync(file, aside);
    chmodSync(aside, 0o600);
    log("account-threads:file-unreadable", { account_id: accountId, moved_to: aside });
    return [];
  }

  /** Write an account's file whole, owner-only since it holds message text, then tell the listeners. */
  private save(accountId: string): void {
    writeJsonAtomic(this.file(accountId), { version: 1, threads: [...this.records(accountId).values()] }, { pretty: true, newline: true, mode: 0o600 });
    this.listeners.emit();
  }
}
