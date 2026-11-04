import { messageOf } from "../core/errors.ts";
import type { AccountThreads, ObservedMessage, OutsideSource, ThreadRecord } from "./account-threads.ts";
import type { AccountRecord, Accounts } from "./accounts.ts";
import { log } from "./log.ts";
import { SLACK_ACTIVITY_TYPES, SlackError, type SlackActivityItem, type SlackClient, type SlackCount, type SlackMessage } from "./slack.ts";

/**
 * Watching one connected Slack workspace (plan 067, U7, KTD3, KTD11, KTD13). Each tick reads Slack's own unread
 * state: `client.counts` for DMs and group DMs, and the unread Activity feed for mentions, replies in the person's
 * threads, @channel and @here, and user-group mentions (R6). A DM is one card, its thread id the channel id, and a
 * reply in a thread inside it folds into that card; an Activity item is one card per thread, `<channel>:<thread_ts>`,
 * or per message when it has no thread, `<channel>:<ts>` (R7). What Slack no longer shows unread leaves the Inbox (R13).
 *
 * Archive marks a DM read up to the card's last message and never later; it never moves a channel's read marker (R12).
 * No endpoint for marking one Activity item read is verified yet, so archiving an Activity card closes it in loki only.
 *
 * Items from before the account was connected arrive in batches (R8): up to 20 at a time, each time the account has no
 * open outside cards, stepping back through 3, 7, 14 and 30 days and then older, until none remain.
 */

/** What SlackSync is built from: the account it watches, its client, and where cards are kept. */
export interface SlackSyncOptions {
  accounts: Pick<Accounts, "get" | "setBackfill">;
  threads: AccountThreads;
  account: AccountRecord;
  client: SlackClient;
}

/** How many unread DM messages one read fetches, and how many Activity pages a tick walks at most. */
const DM_MESSAGES = 20;
const FEED_PAGE = 50;
const FEED_PAGES = 20;
/** The refill rule (KTD13): the windows back from the connection, in days, then everything older; and a batch's size. */
const REFILL_DAYS = [3, 7, 14, 30];
const REFILL_BATCH = 20;
const DAY_MS = 86_400_000;
/** Slack errors that are the whole account's, not one item's: the watcher backs off on them. */
const ACCOUNT_ERRORS = ["signed_out", "ratelimited"];

/** One thread a tick found unread: a DM (with any replies folded into it) or an Activity thread. */
interface Candidate {
  thread_id: string;
  /** The newest unread message's ts. */
  ts: string;
  dm: SlackCount | null;
  items: SlackActivityItem[];
}

/** Where the batches of older items stand, kept on the account (`AccountRecord.backfill`). */
interface RefillState {
  step: number;
  exhausted: boolean;
}

/**
 * A Slack ts as a string that sorts in time order: seconds padded, then the six-digit fraction. Comparing ts as numbers
 * loses the last digits of the fraction, which is what tells two messages in one second apart.
 */
const tsKey = (ts: string): string => {
  const [s = "", f = ""] = ts.split(".");
  return `${s.padStart(12, "0")}.${f.padEnd(6, "0")}`;
};
const tsAfter = (a: string, b: string): boolean => tsKey(a) > tsKey(b);

/** A ts as ISO time, or null when it is not one. */
function tsIso(ts: string): string | null {
  const [s = "", f = "0"] = ts.split(".");
  const ms = Number(s) * 1000 + Math.floor(Number(f.padEnd(6, "0").slice(0, 6)) / 1000);
  return s && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The first non-empty line of a text. */
const firstLine = (text: string): string =>
  text
    .split("\n")
    .find((l) => l.trim())
    ?.trim() ?? "";

/**
 * Mark one Activity item read in Slack. The Slack desktop app's endpoint for this is not verified yet (plan 067 U7
 * step 6 is a by-hand check on a real workspace that it marks one item and moves no channel marker), so this calls
 * nothing and says so; once that endpoint is confirmed, its call goes here.
 */
const markActivityItemRead = (): "marked" | "not_available" => "not_available";

/** Each AccountThreads' Slack syncs by account: one write-back serves every workspace, since it is registered per provider. */
const syncsByThreads = new WeakMap<AccountThreads, Map<string, SlackSync>>();

/** The one Slack write-back for an AccountThreads, handing each archive to the sync of the card's account. */
function slackSource(syncs: Map<string, SlackSync>): OutsideSource {
  return {
    archive: (accountId, record) => {
      const sync = syncs.get(accountId);
      if (!sync) return Promise.reject(new Error("loki is not watching that Slack workspace right now"));
      return sync.archive(record);
    },
  };
}

/** The watcher of one Slack workspace: its `tick` turns Slack's unread state into cards. */
export class SlackSync {
  private readonly opts: SlackSyncOptions;
  private readonly accountId: string;
  /** People's names by user id, so each is asked for once. */
  private readonly names = new Map<string, string>();
  private toldNoActivityMark = false;

  constructor(opts: SlackSyncOptions) {
    this.opts = opts;
    this.accountId = opts.account.account_id;
    let syncs = syncsByThreads.get(opts.threads);
    if (!syncs) {
      syncs = new Map();
      syncsByThreads.set(opts.threads, syncs);
      opts.threads.register("slack", slackSource(syncs));
    }
    syncs.set(this.accountId, this);
  }

  /** Stop handling this workspace's archives; the watcher calls it when the account goes. */
  stop(): void {
    const syncs = syncsByThreads.get(this.opts.threads);
    if (syncs?.get(this.accountId) === this) syncs.delete(this.accountId);
  }

  /**
   * One poll: new unread items since the connection become or update cards, cards Slack no longer shows unread leave,
   * and when the account has no open cards, the next batch of older items arrives.
   */
  async tick(): Promise<void> {
    const { client, threads } = this.opts;
    const counts = await client.clientCounts();
    const dms = new Map([...counts.ims, ...counts.mpims].filter((c) => c.id).map((c) => [c.id, c]));
    const feed = await this.unreadActivity();

    const candidates = new Map<string, Candidate>();
    const add = (threadId: string, ts: string, dm: SlackCount | null, item: SlackActivityItem | null) => {
      const c = candidates.get(threadId) ?? { thread_id: threadId, ts, dm: null, items: [] };
      if (tsAfter(ts, c.ts)) c.ts = ts;
      if (dm) c.dm = dm;
      if (item) c.items.push(item);
      candidates.set(threadId, c);
    };
    for (const dm of dms.values()) if (dm.has_unreads && dm.latest) add(dm.id, dm.latest, dm, null);
    for (const item of feed.items) {
      if (!item.channel || !item.ts || !tsIso(item.ts)) continue;
      const dm = dms.get(item.channel);
      add(dm ? dm.id : `${item.channel}:${item.thread_ts ?? item.ts}`, item.ts, null, item);
    }

    const connectedAt = this.opts.account.connected_at;
    const older: Candidate[] = [];
    for (const c of candidates.values()) {
      if ((tsIso(c.ts) ?? "") < connectedAt) older.push(c);
      else await this.observe(c, false);
    }

    for (const r of threads.list(this.accountId)) {
      if (r.state !== "open" || candidates.has(r.thread_id)) continue;
      if (r.thread_id.includes(":")) {
        if (feed.complete) threads.markReadOutThere(this.accountId, r.thread_id);
        continue;
      }
      const dm = dms.get(r.thread_id);
      if (dm && (!dm.has_unreads || (dm.last_read !== null && !tsAfter(r.newest_message_id, dm.last_read))))
        threads.markReadOutThere(this.accountId, r.thread_id);
    }

    if (!threads.list(this.accountId).some((r) => r.state === "open")) await this.refill(older, feed.complete);
  }

  /** Write an archive back to Slack (R12): a DM is marked read up to the card's last message; nothing else is marked. */
  async archive(record: ThreadRecord): Promise<void> {
    if (!record.thread_id.includes(":")) return this.opts.client.markDm(record.thread_id, record.newest_message_id);
    if (markActivityItemRead() === "not_available" && !this.toldNoActivityMark) {
      this.toldNoActivityMark = true;
      log("slack:activity-mark-unavailable", { account_id: this.accountId, detail: "Activity cards archive in loki only; Slack still shows them unread" });
    }
  }

  /** Every unread Activity item of a card's kinds, newest first, and whether the walk reached the end of the feed. */
  private async unreadActivity(): Promise<{ items: SlackActivityItem[]; complete: boolean }> {
    const items: SlackActivityItem[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < FEED_PAGES; page++) {
      const p = await this.opts.client.activityFeed({ unreadOnly: true, types: SLACK_ACTIVITY_TYPES, cursor, limit: FEED_PAGE });
      // Slack may send kinds that were not asked for; a reaction or anything else is never a card.
      items.push(...p.items.filter((i) => i.is_unread && (SLACK_ACTIVITY_TYPES as readonly string[]).includes(i.type)));
      if (!p.next_cursor) return { items, complete: true };
      cursor = p.next_cursor;
    }
    return { items, complete: false };
  }

  /**
   * The next batch of older items (KTD13): the newest up to 20 unread items not already shown, within the current
   * window back from the connection; an empty window steps back to the next, and nothing left anywhere ends the refill.
   * The end is recorded only when the whole feed was read, so items past a cut-short walk still come later.
   */
  private async refill(older: Candidate[], complete: boolean): Promise<void> {
    const raw = this.opts.accounts.get(this.accountId)?.backfill ?? {};
    const state: RefillState = { step: typeof raw.step === "number" ? raw.step : 0, exhausted: raw.exhausted === true };
    if (state.exhausted) return;
    const connected = Date.parse(this.opts.account.connected_at);
    const unseen = older
      .filter((c) => {
        const r = this.opts.threads.get(this.accountId, c.thread_id);
        return !r || tsAfter(c.ts, r.newest_message_id);
      })
      .sort((a, b) => tsKey(b.ts).localeCompare(tsKey(a.ts)));
    const start = { ...state };
    for (;;) {
      const days = REFILL_DAYS.at(state.step);
      const cutoff = days === undefined ? "" : new Date(connected - days * DAY_MS).toISOString();
      const batch = unseen.filter((c) => (tsIso(c.ts) ?? "") >= cutoff).slice(0, REFILL_BATCH);
      if (batch.length) {
        for (const c of batch) await this.observe(c, true);
        break;
      }
      if (days !== undefined) state.step++;
      else {
        state.exhausted = complete;
        break;
      }
    }
    if (state.step !== start.step || state.exhausted !== start.exhausted) this.opts.accounts.setBackfill(this.accountId, { ...state });
  }

  /** Read a candidate's messages and show its newest on its card; one that cannot be read is skipped, not the tick. */
  private async observe(c: Candidate, fromBackfill: boolean): Promise<void> {
    const r = this.opts.threads.get(this.accountId, c.thread_id);
    if (r && !tsAfter(c.ts, r.newest_message_id)) return;
    try {
      const m = await this.message(c);
      if (m) this.opts.threads.observe(this.accountId, { ...m, from_backfill: fromBackfill });
    } catch (err) {
      if (err instanceof SlackError && ACCOUNT_ERRORS.includes(err.code)) throw err;
      log("slack:item-unreadable", { account_id: this.accountId, thread_id: c.thread_id, error: messageOf(err) });
    }
  }

  /** A candidate as a card shows it: its unread messages, the newest last, with who wrote it. */
  private async message(c: Candidate): Promise<ObservedMessage | null> {
    const { client } = this.opts;
    const found = new Map<string, SlackMessage>();
    if (c.dm) {
      const page = await client.conversationsHistory({ channel: c.dm.id, oldest: c.dm.last_read ?? undefined, limit: DM_MESSAGES });
      for (const m of page.messages) if (!c.dm.last_read || tsAfter(m.ts, c.dm.last_read)) found.set(m.ts, m);
    }
    for (const item of c.items) {
      const { channel, ts } = item;
      if (!channel || !ts) continue;
      const page = item.thread_ts
        ? await client.conversationsReplies({ channel, ts: item.thread_ts, limit: 200 })
        : await client.conversationsHistory({ channel, latest: ts, inclusive: true, limit: 1 });
      for (const m of page.messages) if (m.ts && !tsAfter(m.ts, ts)) found.set(m.ts, m);
    }
    const list = [...found.values()].filter((m) => tsIso(m.ts)).sort((a, b) => tsKey(a.ts).localeCompare(tsKey(b.ts)));
    const newest = list.at(-1);
    const at = newest ? tsIso(newest.ts) : null;
    if (!newest || !at) return null;
    const lines: string[] = [];
    for (const m of list.slice(-3)) lines.push(await this.plain(m.text));
    return {
      thread_id: c.thread_id,
      message_id: newest.ts,
      at,
      sender: await this.sender(newest),
      subject: firstLine(lines.at(-1) ?? ""),
      lines,
    };
  }

  /** Who wrote a message, by the name Slack shows. */
  private async sender(m: SlackMessage): Promise<string> {
    if (m.user) return this.name(m.user);
    const username = m.raw.username;
    return typeof username === "string" && username ? username : "a Slack app";
  }

  private async name(user: string): Promise<string> {
    const known = this.names.get(user);
    if (known !== undefined) return known;
    const u = await this.opts.client.usersInfo(user);
    const name = u.display_name || u.real_name || u.name || user;
    this.names.set(user, name);
    return name;
  }

  /** Slack's message markup as plain text: links by their label, people by name, broadcasts as @channel, entities decoded. */
  private async plain(text: string): Promise<string> {
    const parts: string[] = [];
    let last = 0;
    for (const match of text.matchAll(/<([^>]*)>/g)) {
      parts.push(text.slice(last, match.index));
      last = match.index + match[0].length;
      const inner = match[1];
      const bar = inner.indexOf("|");
      const target = bar < 0 ? inner : inner.slice(0, bar);
      const label = bar < 0 ? null : inner.slice(bar + 1);
      if (target.startsWith("@")) parts.push(`@${label ?? (await this.name(target.slice(1)))}`);
      else if (target.startsWith("#")) parts.push(`#${label ?? target.slice(1)}`);
      else if (target.startsWith("!subteam^")) parts.push(label ?? "@group");
      else if (target.startsWith("!")) parts.push(label ?? `@${target.slice(1)}`);
      else parts.push(label ?? target);
    }
    parts.push(text.slice(last));
    return parts.join("").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  }
}
