import { PAST_CAP } from "../core/account-refill.ts";
import { messageOf } from "../core/errors.ts";
import type { OutsideChange, OutsideReach } from "../core/frame-types.ts";
import type { AccountThreads, OutsideSource, ThreadRecord } from "./account-threads.ts";
import type { AccountSync } from "./account-watcher.ts";
import type { AccountRecord, Accounts } from "./accounts.ts";
import { JiraError, jiraPersonOf, type JiraClient, type JiraEvent, type JiraEventPage, type JiraEventPageOptions, type JiraTicket } from "./jira.ts";
import { adfText, historyLines } from "./jira-text.ts";
import { log } from "./log.ts";

/** How far before the watermark a tick looks again, since Jira's search can trail a change by minutes. */
const OVERLAP_MS = 10 * 60_000;
const TICKETS_PER_TICK = 40;
const TICKETS_AT_A_TIME = 4;

export type JiraSyncClient = Pick<JiraClient, "searchWatched" | "comments" | "history">;

export interface JiraSyncOptions {
  accounts: Pick<Accounts, "get" | "setBackfill">;
  threads: Pick<AccountThreads, "observe" | "get" | "list"> & Partial<Pick<AccountThreads, "batch">>;
  account: AccountRecord;
  client: JiraSyncClient;
  resting?: (record: ThreadRecord) => boolean;
  now?: () => Date;
}

interface JiraCursor {
  /** ISO time: every watched ticket that changed before this has been handled. */
  watermark: string;
  /** The update time each ticket was last read at, by ticket id, for the tickets the overlap can still return. */
  seen: Record<string, string>;
  /** The past fill's place in the list of watched tickets: the page to read next, and whether the list is all read. */
  past: { page_token: string | null; done: boolean };
}

const NO_ARCHIVE = "a Jira card is not archived: read ends it";
const NO_LABELS = "Jira cards take no labels: labels are for email";

export function jiraOutsideSource(): OutsideSource {
  const answer = (move: "read" | "unread", record: ThreadRecord): Promise<OutsideChange> =>
    Promise.resolve({ move, messages: [], ended: move === "read", was_unread: record.unread_out_there });
  return {
    archive: () => Promise.reject(new Error(NO_ARCHIVE)),
    markRead: (_accountId, record) => answer("read", record),
    markUnread: (_accountId, record) => answer("unread", record),
    addLabels: () => Promise.reject(new Error(NO_LABELS)),
    restore: () => Promise.resolve(),
    labels: () => Promise.reject(new Error(NO_LABELS)),
  };
}

function parseCursor(v: Record<string, unknown>): JiraCursor | null {
  if (typeof v.watermark !== "string" || !v.watermark) return null;
  const obj = (x: unknown): Record<string, unknown> => (typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
  const seen: Record<string, string> = {};
  for (const [id, updated] of Object.entries(obj(v.seen))) if (typeof updated === "string") seen[id] = updated;
  const past = obj(v.past);
  return { watermark: v.watermark, seen, past: { page_token: typeof past.page_token === "string" ? past.page_token : null, done: past.done === true } };
}

export const eventLines = (event: JiraEvent): string[] => (event.kind === "comment" ? adfText(event.body).lines : historyLines(event.items));

export class JiraSync implements AccountSync {
  private readonly opts: JiraSyncOptions;
  private readonly accountId: string;
  /** The person's Atlassian account id: what follows the host in `jira:<host>:<account id>`, colons of its own included. */
  private readonly me: string;

  constructor(opts: JiraSyncOptions) {
    this.opts = opts;
    this.accountId = opts.account.account_id;
    this.me = jiraPersonOf(this.accountId);
  }

  askedToWait(error: unknown): boolean {
    return error instanceof JiraError && error.code === "rate_limited";
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private cursor(): JiraCursor | null {
    const account = this.opts.accounts.get(this.accountId);
    return account ? parseCursor(account.backfill) : null;
  }

  private save(cursor: JiraCursor): void {
    this.opts.accounts.setBackfill(this.accountId, { watermark: cursor.watermark, seen: cursor.seen, past: cursor.past });
  }

  async tick(): Promise<void> {
    const started = this.now();
    const runBatch = <T>(fn: () => Promise<T>) => (this.opts.threads.batch ? this.opts.threads.batch(this.accountId, fn) : fn());
    await runBatch(async () => {
      const cursor = this.cursor();
      if (!cursor) this.save({ watermark: started.toISOString(), seen: {}, past: { page_token: null, done: false } });
      else await this.changed(cursor, started);
      await this.fillPast();
    });
  }

  private async changed(cursor: JiraCursor, started: Date): Promise<void> {
    const floor = new Date(Date.parse(cursor.watermark) - OVERLAP_MS).toISOString();
    const sinceMinutes = (started.getTime() - Date.parse(floor)) / 60_000;
    const due: JiraTicket[] = [];
    let more = false;
    let pageToken: string | null = null;
    do {
      const page = await this.opts.client.searchWatched({ sinceMinutes, pageToken, limit: TICKETS_PER_TICK });
      for (const ticket of page.tickets) {
        // Outside (Jira): the search asks in whole minutes, so it may return a ticket from before the overlap: nothing on it is new.
        if (ticket.updated < floor || cursor.seen[ticket.id] === ticket.updated) continue;
        if (due.length >= TICKETS_PER_TICK) {
          more = true;
          break;
        }
        due.push(ticket);
      }
      pageToken = page.next_page_token;
    } while (pageToken && !more);

    let watermark = cursor.watermark;
    const seen = { ...cursor.seen };
    let failure: { error: unknown } | null = null;
    for (let i = 0; i < due.length && !failure; i += TICKETS_AT_A_TIME) {
      const batch = due.slice(i, i + TICKETS_AT_A_TIME);
      const results = await Promise.allSettled(batch.map((ticket) => this.read(ticket, floor)));
      for (const [j, result] of results.entries()) {
        if (result.status === "rejected") {
          failure = { error: result.reason };
          break;
        }
        seen[batch[j].id] = batch[j].updated;
        if (batch[j].updated > watermark) watermark = batch[j].updated;
      }
    }
    if (!failure && !more && started.toISOString() > watermark) watermark = started.toISOString();
    const keep = new Date(Date.parse(watermark) - OVERLAP_MS).toISOString();
    this.save({ ...cursor, watermark, seen: Object.fromEntries(Object.entries(seen).filter(([, updated]) => updated >= keep)) });
    if (failure) throw failure.error;
  }

  private async fillPast(): Promise<void> {
    let read = 0;
    let room = this.room();
    while (read < TICKETS_PER_TICK) {
      const cursor = this.cursor();
      if (!cursor || cursor.past.done || room <= 0) return;
      const page = await this.opts.client
        .searchWatched({ sinceMinutes: null, pageToken: cursor.past.page_token, limit: TICKETS_PER_TICK })
        .catch((error: unknown) => {
          // Outside (Jira): Jira's page tokens expire after a week, and a full site may wait longer than that for room: a position
          // Jira refuses is dropped, so the next tick starts again from the top and passes over what is recorded.
          if (cursor.past.page_token && error instanceof JiraError && error.code.startsWith("http_4"))
            this.save({ ...cursor, past: { page_token: null, done: false } });
          throw error;
        });
      const unread = page.tickets.filter((ticket) => !this.opts.threads.get(this.accountId, ticket.id));
      while (unread.length > 0 && room > 0) {
        const batch = unread.splice(0, Math.min(TICKETS_AT_A_TIME, room));
        await Promise.all(batch.map((ticket) => this.read(ticket, null)));
        read += batch.length;
        room = this.room();
      }
      if (unread.length > 0) return;
      this.save({ ...cursor, past: { page_token: page.next_page_token, done: page.next_page_token === null } });
    }
  }

  private room(): number {
    return PAST_CAP - this.opts.threads.list(this.accountId).filter((r) => r.state === "open" && !this.opts.resting?.(r)).length;
  }

  private async read(ticket: JiraTicket, floor: string | null): Promise<void> {
    let events: JiraEvent[];
    try {
      events = await this.events(ticket.id, floor);
    } catch (error) {
      if (!(error instanceof JiraError && error.code === "not_found")) throw error;
      log.error("jira:ticket-unreadable", { account_id: this.accountId, thread_id: ticket.id, error: messageOf(error) });
      return;
    }
    this.record(ticket, events, floor);
  }

  private async events(ticketId: string, floor: string | null): Promise<JiraEvent[]> {
    const back = async (page: (opts: JiraEventPageOptions) => Promise<JiraEventPage>): Promise<JiraEvent[]> => {
      const out: JiraEvent[] = [];
      let before: number | null = null;
      do {
        const p = await page({ before });
        out.unshift(...p.events);
        before = floor !== null && (p.events.at(0)?.created ?? "") >= floor ? p.earlier : null;
      } while (before !== null);
      return out;
    };
    const [comments, history] = await Promise.all([
      back((opts) => this.opts.client.comments(ticketId, opts)),
      back((opts) => this.opts.client.history(ticketId, opts)),
    ]);
    return [...comments, ...history].filter((e) => e.author.account_id !== this.me).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  private record(ticket: JiraTicket, events: JiraEvent[], floor: string | null): void {
    const prev = this.opts.threads.get(this.accountId, ticket.id);
    const mark = prev?.dealt_message_id ?? null;
    const fresh = floor === null ? events.slice(-1) : events.filter((e) => e.created >= floor && (mark === null || e.id > mark));
    const newest = fresh.at(-1);
    if (!newest) return;
    const kept = (prev?.brought_ids ?? []).filter((id) => mark === null || id > mark);
    this.opts.threads.observe(this.accountId, {
      thread_id: ticket.id,
      message_id: newest.id,
      at: newest.created,
      sender: newest.author.display_name,
      subject: ticket.summary,
      lines: eventLines(newest),
      place: ticket.key,
      reach: this.reach(ticket, fresh, kept.length > 0 ? (prev?.reach ?? null) : null),
      brought_ids: [...new Set([...kept, ...fresh.map((e) => e.id)])].sort(),
      from_backfill: floor === null,
    });
  }

  private reach(ticket: JiraTicket, fresh: JiraEvent[], before: OutsideReach | null): OutsideReach {
    if (before === "mention" || fresh.some((e) => e.kind === "comment" && adfText(e.body).mentions.includes(this.me))) return "mention";
    return ticket.assignee_account_id === this.me ? "assigned" : "watching";
  }
}
