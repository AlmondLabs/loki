import { join } from "node:path";
import type { AccountProvider, InboxRow } from "../core/frame-types.ts";
import { Listeners } from "../core/listeners.ts";
import { keyedQueue } from "../core/serial.ts";
import { accountLabel, type AccountRecord, type Accounts } from "./accounts.ts";
import { readJson, writeJsonAtomic } from "./json-file.ts";

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
  /** It came from a batch of older unread items (KTD13), not from watching. */
  from_backfill: boolean;
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
}

/**
 * A provider's write-back for archive (R12): archive the email in Gmail, mark a Slack item read. It throws why when
 * it could not, and the card stays.
 */
export interface OutsideSource {
  archive(accountId: string, record: ThreadRecord): Promise<void>;
}

/** What AccountThreads is built from. */
export interface AccountThreadsOptions {
  /** `state/account-threads`. */
  dir: string;
  accounts: Pick<Accounts, "get" | "list">;
  /** An agent's name for the card, or null. */
  agentName?: (agentId: string) => string | null;
}

/** How many messages a card shows, and how much of each. */
const LINES = 3;
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
  };
}

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
   * Returns whether anything changed; a message no newer than the recorded one changes nothing.
   */
  observe(accountId: string, m: ObservedMessage): boolean {
    const records = this.records(accountId);
    const prev = records.get(m.thread_id);
    if (prev && !newer(m, prev)) return false;
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
    });
    this.save(accountId);
    return true;
  }

  /** The person read or archived the thread in Gmail or Slack first (R13): its card leaves; nothing is written back. */
  markReadOutThere(accountId: string, threadId: string): boolean {
    const r = this.records(accountId).get(threadId);
    if (r?.state !== "open") return false;
    this.records(accountId).set(threadId, { ...r, state: "archived" });
    this.save(accountId);
    return true;
  }

  /**
   * Archive from the Inbox (R12): written back to the account first, then the card leaves. Throws why when the account
   * refused or cannot be reached, and the card stays. A message that came while the write-back ran keeps the card open.
   */
  archive(accountId: string, threadId: string): Promise<void> {
    return this.serial(`${accountId} ${threadId}`, async () => {
      const r = this.records(accountId).get(threadId);
      if (r?.state !== "open") return;
      const account = this.opts.accounts.get(accountId);
      if (!account) throw new Error("that account is not connected on this Mac");
      const source = this.sources.get(account.provider);
      if (!source) throw new Error(`loki cannot archive in ${account.provider === "gmail" ? "Gmail" : "Slack"} yet`);
      await source.archive(accountId, r);
      const now = this.records(accountId).get(threadId);
      if (now?.state !== "open" || now.newest_message_id !== r.newest_message_id) return;
      this.records(accountId).set(threadId, { ...now, state: "archived" });
      this.save(accountId);
    });
  }

  /** The thread went to its owner's chat (U8): the card leaves, and the chat is named on the next one. */
  handedOff(accountId: string, threadId: string, conversationId: string): boolean {
    const r = this.records(accountId).get(threadId);
    if (!r) return false;
    this.records(accountId).set(threadId, { ...r, state: "handed_off", handoff_conversation_id: conversationId });
    this.save(accountId);
    return true;
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
      },
    };
  }

  private file(accountId: string): string {
    return join(this.opts.dir, fileName(accountId));
  }

  private records(accountId: string): Map<string, ThreadRecord> {
    let records = this.byAccount.get(accountId);
    if (!records) {
      const raw = readJson(this.file(accountId));
      const list = typeof raw === "object" && raw !== null ? (raw as { threads?: unknown }).threads : null;
      const parsed = Array.isArray(list) ? list.map(parseRecord).filter((r): r is ThreadRecord => r !== null) : [];
      records = new Map(parsed.map((r) => [r.thread_id, r]));
      this.byAccount.set(accountId, records);
    }
    return records;
  }

  /** Write an account's file whole, owner-only since it holds message text, then tell the listeners. */
  private save(accountId: string): void {
    writeJsonAtomic(this.file(accountId), { version: 1, threads: [...this.records(accountId).values()] }, { pretty: true, newline: true, mode: 0o600 });
    this.listeners.emit();
  }
}
