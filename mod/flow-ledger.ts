import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AccountProvider, OutsideMove } from "../core/frame-types.ts";
import type { MailTraits } from "../core/mail-filter.ts";
import type { AccountThreads } from "./account-threads.ts";
import type { Accounts } from "./accounts.ts";
import { messageOf } from "../core/errors.ts";
import { log, rotateIfLarge } from "./log.ts";

export const LEDGER_MAX_BYTES = 20 * 1024 * 1024;

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
  traits: MailTraits | null;
  /** For Slack, a DM or a thread (an Activity item); null for mail and Jira. */
  slack_kind: "dm" | "thread" | null;
  from_backfill: boolean;
  return_at?: string | null;
  /** The Gmail label ids a label move put on. */
  labels?: string[] | null;
  /** Whether the person chose the return time at the second ⌘[. */
  picked?: boolean;
  /** For a reply, the key that followed it. */
  after_reply?: OutsideMove["after_reply"];
}

export interface FlowLedgerOptions {
  path: string | null;
  accounts: Pick<Accounts, "get">;
  threads: Pick<AccountThreads, "get">;
  now?: () => Date;
  maxBytes?: number;
}

const CHECK_ROTATE_EVERY = 50;

export class FlowLedger {
  private readonly opts: FlowLedgerOptions;
  private ready = false;
  private writes = 0;

  constructor(opts: FlowLedgerOptions) {
    this.opts = opts;
  }

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
      return_at: move.return_at ?? null,
      labels: move.labels ?? null,
      picked: move.picked ?? false,
      after_reply: move.after_reply ?? null,
    };
    try {
      if (!this.ready) {
        mkdirSync(dirname(path), { recursive: true });
        this.ready = true;
      }
      if (this.writes++ % CHECK_ROTATE_EVERY === 0) rotateIfLarge(path, this.opts.maxBytes ?? LEDGER_MAX_BYTES);
      appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch (err) {
      log.error("flow-ledger:write-failed", { error: messageOf(err) });
    }
    return entry;
  }
}
