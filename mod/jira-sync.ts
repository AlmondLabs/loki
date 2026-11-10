import { PAST_CAP } from "../core/account-refill.ts";
import { messageOf } from "../core/errors.ts";
import type { OutsideChange, OutsideReach } from "../core/frame-types.ts";
import type { AccountThreads, OutsideSource, ThreadRecord } from "./account-threads.ts";
import type { AccountSync } from "./account-watcher.ts";
import type { AccountRecord, Accounts } from "./accounts.ts";
import { JiraError, jiraPersonOf, type JiraClient, type JiraEvent, type JiraEventPage, type JiraEventPageOptions, type JiraTicket } from "./jira.ts";
import { adfText, historyLines } from "./jira-text.ts";
import { log } from "./log.ts";

/**
 * Watching one connected Jira site (plan 2026-11-10-1451, U4). A ticket the person watches is one card, its thread id
 * Jira's numeric id, and each comment or history entry by someone else is an event on it (R6, R7, R10). Each tick asks
 * Jira for the watched tickets that changed since the watermark, less an overlap for the time Jira's search can trail
 * a change, and reads the comments and history of each one it has not already read at that update time (KTD6). The
 * person's own events are dropped before anything is recorded (R8, KTD9), and only an event's creation counts, so an
 * edited comment brings nothing though it moves the ticket's update time (R27).
 *
 * Nothing here ends a card: Jira keeps no read state for a ticket, so only the person's read does (R16, R20), and the
 * sync has no call that could change a ticket. While the site has fewer than 20 open cards, the watched tickets from
 * before the connection fill it up to 20, most recently updated first (R11, KTD19); new events come whatever the count.
 */

/** How far before the watermark a tick looks again, since Jira's search can trail a change by minutes. */
const OVERLAP_MS = 10 * 60_000;
/** How many tickets one tick reads at most, so a long gap or a large watch list spreads over ticks. */
const TICKETS_PER_TICK = 40;
/** How many tickets are read at once. */
const TICKETS_AT_A_TIME = 4;
/** Failed ticks in a row before the account says it is failing for now, as Gmail's sync counts them. */
const FAILURES_BEFORE_STATUS = 3;

/** The calls a Jira sync makes; JiraClient has them, and none of them changes a ticket. */
export type JiraSyncClient = Pick<JiraClient, "searchWatched" | "comments" | "history">;

/** What JiraSync is built from: the account it watches, its client, and where cards are kept; the clock is injected so tests own it. */
export interface JiraSyncOptions {
  accounts: Pick<Accounts, "get" | "setBackfill" | "setStatus">;
  threads: Pick<AccountThreads, "observe" | "get" | "list">;
  account: AccountRecord;
  client: JiraSyncClient;
  /** Whether a card rests in the Inbox now, so the past's cap leaves it out (plan 078); none rest when not given. */
  resting?: (record: ThreadRecord) => boolean;
  now?: () => Date;
}

/** Where the watcher stands on a Jira site, kept as the account's backfill cursor. */
interface JiraCursor {
  /** ISO time: every watched ticket that changed before this has been handled. */
  watermark: string;
  /** The update time each ticket was last read at, by ticket id, for the tickets the overlap can still return. */
  seen: Record<string, string>;
  /** The past fill's place in the list of watched tickets: the page to read next, and whether the list is all read. */
  past: { page_token: string | null; done: boolean };
}

/** Why a move Jira has no part in is refused. */
const NO_ARCHIVE = "a Jira card is not archived: read ends it";
const NO_LABELS = "Jira cards take no labels: labels are for email";

/**
 * The Jira write-back, which writes nothing to Jira (KTD10): loki alone keeps a ticket's read mark, since Jira offers
 * none to write to (R20). Read ends the card, later leaves it open and unread, and an undo has nothing to put back.
 * Archive and labels are refused with the reason. It needs no client, so read and undo work while the token is
 * rejected (AE6).
 */
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

/** An event as a card's lines: a comment's text, or a line for each field a history entry changed (KTD15). */
export const eventLines = (event: JiraEvent): string[] => (event.kind === "comment" ? adfText(event.body).lines : historyLines(event.items));

/** One Jira site's watching, ticked by the AccountWatcher. */
export class JiraSync implements AccountSync {
  private readonly opts: JiraSyncOptions;
  private readonly accountId: string;
  /** The person's Atlassian account id: what follows the host in `jira:<host>:<account id>`, colons of its own included. */
  private readonly me: string;
  private failures = 0;

  constructor(opts: JiraSyncOptions) {
    this.opts = opts;
    this.accountId = opts.account.account_id;
    this.me = jiraPersonOf(this.accountId);
  }

  /**
   * Read what changed. A good tick marks an account that was failing for now connected again; the third failure in a
   * row marks it failing for now, unless the client already said the token was rejected. A rate limit ends the tick
   * quietly: it is Jira asking for a wait, not a failure, and the client holds its calls until the wait is over.
   * Throws why otherwise.
   */
  async tick(): Promise<void> {
    try {
      await this.run();
    } catch (error) {
      if (error instanceof JiraError && error.code === "rate_limited") return;
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

  private cursor(): JiraCursor | null {
    const account = this.opts.accounts.get(this.accountId);
    return account ? parseCursor(account.backfill) : null;
  }

  private save(cursor: JiraCursor): void {
    this.opts.accounts.setBackfill(this.accountId, { watermark: cursor.watermark, seen: cursor.seen, past: cursor.past });
  }

  private async run(): Promise<void> {
    const started = this.now();
    const cursor = this.cursor();
    // The first tick watches on from now: what came before is the past fill's to bring.
    if (!cursor) this.save({ watermark: started.toISOString(), seen: {}, past: { page_token: null, done: false } });
    else await this.changed(cursor, started);
    await this.fillPast();
  }

  /**
   * The watched tickets that changed since the watermark less the overlap, oldest change first, at most
   * TICKETS_PER_TICK of them. The watermark moves to the last ticket fully handled, and to the tick's start when the
   * search had nothing more, so a tick that stops part way, for a failure or a rate limit, is taken up from there.
   */
  private async changed(cursor: JiraCursor, started: Date): Promise<void> {
    const floor = new Date(Date.parse(cursor.watermark) - OVERLAP_MS).toISOString();
    const sinceMinutes = (started.getTime() - Date.parse(floor)) / 60_000;
    const due: JiraTicket[] = [];
    let more = false;
    let pageToken: string | null = null;
    do {
      const page = await this.opts.client.searchWatched({ sinceMinutes, pageToken, limit: TICKETS_PER_TICK });
      for (const ticket of page.tickets) {
        // The search asks in whole minutes, so it may return a ticket from before the overlap: nothing on it is new.
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
    // The memo keeps only the tickets the next search can still return, so it never grows without limit.
    const keep = new Date(Date.parse(watermark) - OVERLAP_MS).toISOString();
    this.save({ ...cursor, watermark, seen: Object.fromEntries(Object.entries(seen).filter(([, updated]) => updated >= keep)) });
    if (failure) throw failure.error;
  }

  /**
   * Fill the site up to PAST_CAP open cards with watched tickets from before the connection, most recently updated
   * first (KTD19). A ticket already recorded is passed over, and so is one with no event by someone else, which takes
   * no room. The page being read is kept, so the fill goes on from it when cards are read and there is room again.
   */
  private async fillPast(): Promise<void> {
    let read = 0;
    while (read < TICKETS_PER_TICK) {
      const cursor = this.cursor();
      if (!cursor || cursor.past.done || this.room() <= 0) return;
      const page = await this.opts.client
        .searchWatched({ sinceMinutes: null, pageToken: cursor.past.page_token, limit: TICKETS_PER_TICK })
        .catch((error: unknown) => {
          // Jira's page tokens expire after a week, and a full site may wait longer than that for room: a position
          // Jira refuses is dropped, so the next tick starts again from the top and passes over what is recorded.
          if (cursor.past.page_token && error instanceof JiraError && error.code.startsWith("http_4"))
            this.save({ ...cursor, past: { page_token: null, done: false } });
          throw error;
        });
      const unread = page.tickets.filter((ticket) => !this.opts.threads.get(this.accountId, ticket.id));
      while (unread.length > 0 && this.room() > 0) {
        const batch = unread.splice(0, Math.min(TICKETS_AT_A_TIME, this.room()));
        await Promise.all(batch.map((ticket) => this.read(ticket, null)));
        read += batch.length;
      }
      if (unread.length > 0) return;
      this.save({ ...cursor, past: { page_token: page.next_page_token, done: page.next_page_token === null } });
    }
  }

  /** How many more open cards the past may bring: PAST_CAP less the open cards that are not resting. */
  private room(): number {
    return PAST_CAP - this.opts.threads.list(this.accountId).filter((r) => r.state === "open" && !this.opts.resting?.(r)).length;
  }

  /**
   * Read one ticket's events and record what is new on it. With `floor`, an ISO time, the events made since then;
   * with null, for the past fill, only its newest. A ticket the token can no longer see is logged and passed over,
   * since that says nothing about the account.
   */
  private async read(ticket: JiraTicket, floor: string | null): Promise<void> {
    let events: JiraEvent[];
    try {
      events = await this.events(ticket.id, floor);
    } catch (error) {
      if (!(error instanceof JiraError && error.code === "not_found")) throw error;
      log("jira:ticket-unreadable", { account_id: this.accountId, thread_id: ticket.id, error: messageOf(error) });
      return;
    }
    this.record(ticket, events, floor);
  }

  /**
   * A ticket's comments and history by someone else, oldest first, merged by event id (KTD8). Each list is read from
   * its newest page back until a page starts before `floor`; with null, only the newest page of each.
   */
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
    // The two lists are read together: the client holds every call while Jira limits the rate, so this stays bounded,
    // and either failing still fails the ticket.
    const [comments, history] = await Promise.all([
      back((opts) => this.opts.client.comments(ticketId, opts)),
      back((opts) => this.opts.client.history(ticketId, opts)),
    ]);
    return [...comments, ...history].filter((e) => e.author.account_id !== this.me).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /**
   * Show a ticket's newest event by someone else on its card (KTD9). What is new is every such event made since
   * `floor` that sits after the mark the person's last read left; a ticket with none records nothing, so the person's
   * own comment or an edited old one never opens or changes a card. What brought the card is what brought it before
   * and is still after that mark, then the new events. For the past fill (`floor` null) the newest event alone is
   * new, and it is recorded as from the past.
   */
  private record(ticket: JiraTicket, events: JiraEvent[], floor: string | null): void {
    const prev = this.opts.threads.get(this.accountId, ticket.id);
    const mark = prev?.dealt_message_id ?? null;
    const fresh = floor === null ? events.slice(-1) : events.filter((e) => e.created >= floor && (mark === null || e.id > mark));
    const newest = fresh.at(-1);
    if (!newest) return;
    const kept = (prev?.brought_ids ?? []).filter((id) => mark === null || id > mark);
    // The key and the title are the ticket's as they stand now, so a ticket moved to another project shows its new key (KTD7).
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

  /**
   * Why the card is there (KTD16), the most direct that applies: a comment that brought it mentions the person, the
   * ticket is assigned to them now, or they only watch it. `before` is the reach of the events that brought the card
   * earlier and still count, so a mention is not lost to a later field edit.
   */
  private reach(ticket: JiraTicket, fresh: JiraEvent[], before: OutsideReach | null): OutsideReach {
    if (before === "mention" || fresh.some((e) => e.kind === "comment" && adfText(e.body).mentions.includes(this.me))) return "mention";
    return ticket.assignee_account_id === this.me ? "assigned" : "watching";
  }
}
