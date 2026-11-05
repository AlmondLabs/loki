import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AccountProvider, OutsideMove } from "../core/frame-types.ts";
import type { MailTraits } from "../core/mail-filter.ts";
import type { AccountThreads } from "./account-threads.ts";
import type { Accounts } from "./accounts.ts";
import { messageOf } from "../core/errors.ts";
import { log, rotateIfLarge } from "./log.ts";

/**
 * The ledger of the person's moves on outside cards (plan 069): every Next, archive, reply and hand-off on a Gmail or
 * Slack card, with what the thread was (its sender, subject, and for mail what kind it is) and how long the card was
 * on top first. It is the data a later step learns the person's preferences from, and in time acts on them; nothing
 * reads it yet. It lives on the Mac the account lives on, in `state/inbox-ledger.jsonl`, one line a move, and never
 * leaves it: the analytics events stay free of senders and subjects.
 */

/** The size, in bytes, past which the ledger becomes `inbox-ledger.jsonl.1` and a fresh one starts: years of moves. */
export const LEDGER_MAX_BYTES = 20 * 1024 * 1024;

/** One move, as the ledger keeps it. */
export interface LedgerEntry {
  at: string;
  account_id: string;
  provider: AccountProvider;
  /** The agent that owned the account at the time. */
  owner_agent_id: string;
  thread_id: string;
  /** The card's generation: a handed-off thread that is written in again is a new card. */
  generation: number;
  /** The newest message the person saw when they moved. */
  message_id: string;
  action: OutsideMove["action"];
  via: OutsideMove["via"];
  dwell_ms: number | null;
  sender: string;
  sender_address: string | null;
  subject: string;
  /** Mail's kind (core/mail-filter.ts); null for Slack. */
  traits: MailTraits | null;
  /** For Slack, a DM or a thread (an Activity item); null for mail. */
  slack_kind: "dm" | "thread" | null;
  from_backfill: boolean;
}

/** What the ledger is built from; the clock is injected so tests own it. */
export interface InboxLedgerOptions {
  /** The ledger file; null keeps nothing. */
  path: string | null;
  accounts: Pick<Accounts, "get">;
  threads: Pick<AccountThreads, "get">;
  now?: () => Date;
  maxBytes?: number;
}

/** Appends the person's moves to the ledger file. */
export class InboxLedger {
  private readonly opts: InboxLedgerOptions;
  private ready = false;

  constructor(opts: InboxLedgerOptions) {
    this.opts = opts;
  }

  /**
   * Keep one move on a thread this Mac holds, with the thread as its record stands. Returns the entry, or null when
   * there is no ledger, or the account or thread is not here; a failed write is logged, never thrown, since a lost
   * line must not stop the person's move.
   */
  record(accountId: string, threadId: string, move: OutsideMove): LedgerEntry | null {
    const { path } = this.opts;
    const account = this.opts.accounts.get(accountId);
    const r = this.opts.threads.get(accountId, threadId);
    if (!path || !account || !r) return null;
    const entry: LedgerEntry = {
      at: (this.opts.now ?? (() => new Date()))().toISOString(),
      account_id: accountId,
      provider: account.provider,
      owner_agent_id: account.owner_agent_id,
      thread_id: threadId,
      generation: r.generation,
      message_id: r.newest_message_id,
      action: move.action,
      via: move.via,
      dwell_ms: move.dwell_ms,
      sender: r.sender,
      sender_address: r.sender_address,
      subject: r.subject_or_first_line,
      traits: r.traits,
      slack_kind: account.provider === "slack" ? (threadId.includes(":") ? "thread" : "dm") : null,
      from_backfill: r.from_backfill,
    };
    try {
      if (!this.ready) {
        mkdirSync(dirname(path), { recursive: true });
        this.ready = true;
      }
      rotateIfLarge(path, this.opts.maxBytes ?? LEDGER_MAX_BYTES);
      appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch (err) {
      log("inbox-ledger:write-failed", { error: messageOf(err) });
    }
    return entry;
  }
}
