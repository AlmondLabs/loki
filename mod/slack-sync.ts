import { PAST_CAP } from "../core/account-refill.ts";
import { messageOf } from "../core/errors.ts";
import type { OutsideChange } from "../core/frame-types.ts";
import type { AccountThreads, ObservedMessage, OutsideSource, ThreadRecord } from "./account-threads.ts";
import type { AccountSync } from "./account-watcher.ts";
import type { AccountRecord, Accounts } from "./accounts.ts";
import { log } from "./log.ts";
import { filePlain, slackFiles } from "./slack-markup.ts";
import { slackReach } from "../core/outside-reach.ts";
import {
  SLACK_ACTIVITY_TYPES,
  SLACK_RELATED_ACTIVITY_TYPES,
  SlackError,
  tsAfter,
  tsKey,
  type SlackActivityItem,
  type SlackClient,
  type SlackCount,
  type SlackMessage,
} from "./slack.ts";

export interface SlackSyncOptions {
  accounts: Pick<Accounts, "get" | "setBackfill">;
  threads: Pick<AccountThreads, "observe" | "describe" | "markGoneOutThere" | "get" | "list"> & Partial<Pick<AccountThreads, "batch">>;
  account: AccountRecord;
  client: SlackClient;
  resting?: (record: ThreadRecord) => boolean;
  now?: () => Date;
}

const DM_MESSAGES = 20;
const FEED_PAGE = 50;
const FEED_PAGES = 200;
/** A thread is read 200 replies a page, up to 10,000, so a cursor that never ends cannot loop forever. */
const THREAD_PAGE = 200;
const THREAD_PAGES = 50;
const FULL_WALK_MS = 15 * 60_000;
const REFILL_DAYS = [3, 7, 14, 30];
const DAY_MS = 86_400_000;
const ACCOUNT_ERRORS = ["signed_out", "ratelimited"];
const PASSING_ERRORS = ["internal_error", "fatal_error", "service_unavailable", "request_timeout"];

const SYNC_CONCURRENCY = 4;

async function runPool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
    }),
  );
}

type Observed = "card" | "nothing" | "failed";
type Refilled = "filled" | "short" | "stopped";

interface Candidate {
  thread_id: string;
  ts: string;
  dm: SlackCount | null;
  items: SlackActivityItem[];
}

interface SlackThread {
  channel: string;
  thread_ts: string;
}

type MarkedThread = SlackThread & { last_read: string; marked_to: string };

interface RefillState {
  step: number;
  exhausted: boolean;
}

interface Where {
  channel: string;
  root: string | null;
}

interface Seen {
  upTo: string;
  othersAfter: boolean;
  followed: boolean;
  threadRead: string | null;
  dmRead: string | null;
  newest: string;
}

const NEW_MESSAGE = "a new message came in on Slack, so the card stays to show it";

function whereOf(threadId: string): Where {
  const colon = threadId.indexOf(":");
  return colon < 0 ? { channel: threadId, root: null } : { channel: threadId.slice(0, colon), root: threadId.slice(colon + 1) };
}

const makesCards = (i: SlackActivityItem): boolean => (SLACK_ACTIVITY_TYPES as readonly string[]).includes(i.type);

function tsIso(ts: string): string | null {
  const [s = "", f = "0"] = ts.split(".");
  const ms = Number(s) * 1000 + Math.floor(Number(f.padEnd(6, "0").slice(0, 6)) / 1000);
  return s && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const firstLine = (text: string): string =>
  text
    .split("\n")
    .find((l) => l.trim())
    ?.trim() ?? "";

const NO_LABELS = "Slack has no labels: labels are for email";

/** Slack's write-backs: archive and read mark the activity the sync last saw for the card, so they go through the account's live sync. */
export function slackOutsideSource(syncOf: (accountId: string) => SlackSync | null): OutsideSource {
  const mark = async (accountId: string, record: ThreadRecord, move: "archive" | "read"): Promise<OutsideChange> => {
    const sync = syncOf(accountId);
    if (!sync) throw new Error("loki is not watching that Slack workspace right now");
    await sync.archive(record);
    return { move, messages: [], ended: true, was_unread: record.unread_out_there };
  };
  return {
    archive: (accountId, record) => mark(accountId, record, "archive"),
    markRead: (accountId, record) => mark(accountId, record, "read"),
    markUnread: (_accountId, record) => Promise.resolve({ move: "unread", messages: [], ended: false, was_unread: record.unread_out_there }),
    addLabels: () => Promise.reject(new Error(NO_LABELS)),
    restore: async (accountId, record, change) => {
      if (change.ended) await syncOf(accountId)?.restore(record);
    },
    labels: () => Promise.reject(new Error(NO_LABELS)),
  };
}

export class SlackSync implements AccountSync {
  private readonly opts: SlackSyncOptions;
  private readonly accountId: string;
  private readonly me: string;
  private readonly names = new Map<string, { name: string; image: string | null }>();
  private readonly places = new Map<string, string | null>();
  private activity = new Map<string, SlackActivityItem[]>();
  private readonly marked = new Map<string, SlackActivityItem[]>();
  private readonly threadsMarked = new Map<string, MarkedThread[]>();
  private readonly nothingAt = new Map<string, string>();
  private nextFullWalk = 0;
  private backlogLeft = true;
  private walk: { cursor: string; items: SlackActivityItem[]; pages: number } | null = null;

  constructor(opts: SlackSyncOptions) {
    this.opts = opts;
    this.accountId = opts.account.account_id;
    this.me = this.accountId.split(":").at(2) ?? "";
  }

  askedToWait(error: unknown): boolean {
    return error instanceof SlackError && error.code === "ratelimited";
  }

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

    this.remember(candidates, feed.complete);

    const runBatch = <T>(fn: () => Promise<T>) => (threads.batch ? threads.batch(this.accountId, fn) : fn());
    await runBatch(async () => {
      const connectedAt = this.opts.account.connected_at;
      const older: Candidate[] = [];
      const current: Candidate[] = [];
      for (const c of candidates.values()) {
        if ((tsIso(c.ts) ?? "") < connectedAt) older.push(c);
        else current.push(c);
      }
      await runPool(current, SYNC_CONCURRENCY, async (c) => {
        await this.observe(c, false);
      });

      const dmChecks: ThreadRecord[] = [];
      for (const r of threads.list(this.accountId)) {
        if (r.state !== "open" || r.waiting || r.kept_open || candidates.has(r.thread_id)) continue;
        if (r.thread_id.includes(":")) {
          if (feed.complete) threads.markGoneOutThere(this.accountId, r.thread_id);
          continue;
        }
        const dm = dms.get(r.thread_id);
        // Outside (Slack): a DM closed in Slack drops out of client.counts, so Slack is asked about it alone, else its card never ends.
        if (dm) {
          if (!dm.has_unreads || (dm.last_read !== null && !tsAfter(r.newest_message_id, dm.last_read))) {
            threads.markGoneOutThere(this.accountId, r.thread_id);
          }
        } else dmChecks.push(r);
      }
      await runPool(dmChecks, SYNC_CONCURRENCY, async (r) => {
        if (await this.closedDmEnded(r)) threads.markGoneOutThere(this.accountId, r.thread_id);
      });

      const open = threads.list(this.accountId).filter((r) => r.state === "open" && !this.opts.resting?.(r)).length;
      if (open >= PAST_CAP) {
        if (feed.walked) this.backlogLeft = true;
        return;
      }
      if (feed.walked) this.backlogLeft = false;
      const refilled = await this.refill(older, feed.complete, PAST_CAP - open);
      if (feed.walked) this.backlogLeft = refilled === "filled";
      else if (refilled === "short" && this.backlogLeft) this.nextFullWalk = 0;
    });
  }

  async archive(record: ThreadRecord): Promise<void> {
    const handOff = record.state === "handed_off";
    const where = whereOf(record.thread_id);
    const seen = await this.seen(record, where);
    if (seen?.othersAfter && seen.followed && !handOff) {
      await this.bringOnto(record, where, seen);
      throw new Error(NEW_MESSAGE);
    }
    const upTo = seen?.upTo ?? record.newest_message_id;
    const items = await this.itemsToMark(record, where, upTo);
    if (!handOff) this.refuseIfMoved(record);
    if (!where.root) await this.opts.client.markDm(where.channel, upTo);
    await this.markThreads(record, upTo);
    const marked = [...(await this.markItems(record, items.card, true)), ...(await this.markItems(record, items.related, true))];
    const keys = new Set(marked.map((i) => i.key));
    const left = (this.activity.get(record.thread_id) ?? []).filter((i) => !keys.has(i.key));
    if (left.length > 0) this.activity.set(record.thread_id, left);
    else this.activity.delete(record.thread_id);
    this.marked.set(record.thread_id, marked);
    if (!handOff) this.refuseIfMoved(record);
  }

  async restore(record: ThreadRecord): Promise<void> {
    const moved = this.threadsMarked.get(record.thread_id) ?? [];
    this.threadsMarked.delete(record.thread_id);
    for (const t of moved) {
      try {
        const now = await this.opts.client.followedThreadLastRead(t.channel, t.thread_ts);
        if (now === null || tsKey(now) !== tsKey(t.marked_to)) continue;
        await this.opts.client.markThread(t.channel, t.thread_ts, t.last_read);
      } catch (err) {
        log.error("slack:thread-mark-failed", {
          account_id: this.accountId,
          thread_id: record.thread_id,
          thread_ts: t.thread_ts,
          read: false,
          error: messageOf(err),
        });
      }
    }
    const items = this.marked.get(record.thread_id);
    if (!items) return;
    this.marked.delete(record.thread_id);
    const back = [
      ...(await this.markItems(record, items.filter(makesCards), false)),
      ...(await this.markItems(
        record,
        items.filter((i) => !makesCards(i)),
        false,
      )),
    ];
    const keys = new Set(back.map((i) => i.key));
    this.activity.set(record.thread_id, [...(this.activity.get(record.thread_id) ?? []).filter((i) => !keys.has(i.key)), ...back]);
  }

  private async seen(record: ThreadRecord, where: Where): Promise<Seen | null> {
    try {
      let messages: SlackMessage[];
      let more = false;
      let threadRead: string | null = null;
      let dmRead: string | null = null;
      if (where.root) {
        const all = await this.threadUpTo(where.channel, where.root, null);
        const root = all.find((m) => m.ts === where.root)?.raw;
        threadRead = root?.subscribed === true && typeof root.last_read === "string" && root.last_read ? root.last_read : null;
        messages = all.filter((m) => m.ts !== where.root);
      } else {
        dmRead = (await this.opts.client.conversationsInfo(where.channel)).last_read;
        const page = await this.opts.client.conversationsHistory({ channel: where.channel, oldest: record.newest_message_id, limit: DM_MESSAGES });
        messages = page.messages;
        more = page.has_more;
      }
      const after = messages.filter((m) => tsAfter(m.ts, record.newest_message_id)).sort((a, b) => tsKey(a.ts).localeCompare(tsKey(b.ts)));
      const readInSlack = where.root ? threadRead : dmRead;
      const firstUnseen = after.findIndex((m) => m.user !== this.me && (readInSlack === null || tsAfter(m.ts, readInSlack)));
      const seenRun = firstUnseen < 0 ? after : after.slice(0, firstUnseen);
      return {
        upTo: seenRun.at(-1)?.ts ?? record.newest_message_id,
        othersAfter: firstUnseen >= 0 || more,
        followed: !where.root || threadRead !== null,
        threadRead,
        dmRead,
        newest: after.at(-1)?.ts ?? record.newest_message_id,
      };
    } catch (err) {
      if (err instanceof SlackError && err.code === "signed_out") throw err;
      log.error("slack:thread-unreadable", { account_id: this.accountId, thread_id: record.thread_id, error: messageOf(err) });
      return null;
    }
  }

  private async bringOnto(record: ThreadRecord, where: Where, seen: Seen): Promise<void> {
    const c: Candidate = where.root
      ? {
          thread_id: record.thread_id,
          ts: seen.newest,
          dm: null,
          items: [
            {
              key: "",
              feed_ts: "",
              is_unread: true,
              type: "thread_v2",
              channel: where.channel,
              ts: seen.newest,
              thread_ts: where.root,
              author_user_id: null,
              item: {},
            },
          ],
        }
      : {
          thread_id: record.thread_id,
          ts: seen.newest,
          dm: { id: where.channel, has_unreads: true, mention_count: 0, latest: seen.newest, last_read: seen.dmRead },
          items: [],
        };
    try {
      const m = await this.message(c);
      if (m) this.opts.threads.observe(this.accountId, { ...m, reach: record.reach ?? m.reach, place: record.place ?? m.place, from_backfill: false });
    } catch (err) {
      if (err instanceof SlackError && err.code === "signed_out") throw err;
      log.error("slack:item-unreadable", { account_id: this.accountId, thread_id: record.thread_id, error: messageOf(err) });
    }
  }

  private async itemsToMark(record: ThreadRecord, where: Where, upTo: string): Promise<{ card: SlackActivityItem[]; related: SlackActivityItem[] }> {
    const seenBy = (i: SlackActivityItem) => !i.ts || !tsAfter(i.ts, upTo);
    const about = (i: SlackActivityItem) => i.channel === where.channel && (!where.root || (i.thread_ts ?? i.ts) === where.root);
    const byKey = new Map((this.activity.get(record.thread_id) ?? []).filter(seenBy).map((i) => [i.key, i]));
    try {
      const page = await this.opts.client.activityFeed({
        unreadOnly: true,
        types: [...SLACK_ACTIVITY_TYPES, ...SLACK_RELATED_ACTIVITY_TYPES],
        channels: [where.channel],
        limit: FEED_PAGE,
      });
      for (const i of page.items) {
        if (!i.is_unread || !about(i)) continue;
        if (seenBy(i)) byKey.set(i.key, i);
        else byKey.delete(i.key);
      }
    } catch (err) {
      if (err instanceof SlackError && err.code === "signed_out") throw err;
      log.warning("slack:activity-read-held", { account_id: this.accountId, thread_id: record.thread_id, error: messageOf(err) });
    }
    const all = [...byKey.values()];
    return { card: all.filter(makesCards), related: all.filter((i) => !makesCards(i)) };
  }

  private refuseIfMoved(record: ThreadRecord): void {
    const now = this.opts.threads.get(this.accountId, record.thread_id);
    if (now && now.newest_message_id !== record.newest_message_id) throw new Error(NEW_MESSAGE);
  }

  private async markItems(record: ThreadRecord, items: SlackActivityItem[], read: boolean): Promise<SlackActivityItem[]> {
    if (items.length === 0) return [];
    try {
      await this.opts.client.markActivity(items, read);
      return items;
    } catch (err) {
      log.error("slack:activity-mark-failed", { account_id: this.accountId, thread_id: record.thread_id, read, error: messageOf(err) });
      return [];
    }
  }

  private threadsOf(record: ThreadRecord): SlackThread[] {
    const at = record.thread_id.indexOf(":");
    if (at >= 0) return [{ channel: record.thread_id.slice(0, at), thread_ts: record.thread_id.slice(at + 1) }];
    const found = new Map<string, SlackThread>();
    for (const { channel, thread_ts } of this.activity.get(record.thread_id) ?? []) {
      if (channel && thread_ts) found.set(`${channel}:${thread_ts}`, { channel, thread_ts });
    }
    return [...found.values()];
  }

  private async markThreads(record: ThreadRecord, upTo: string): Promise<void> {
    const moved: MarkedThread[] = [];
    for (const t of this.threadsOf(record)) {
      try {
        const read = await this.opts.client.followedThreadLastRead(t.channel, t.thread_ts);
        if (read === null || !tsAfter(upTo, read)) continue;
        await this.opts.client.markThread(t.channel, t.thread_ts, upTo);
        moved.push({ ...t, last_read: read, marked_to: upTo });
      } catch (err) {
        log.error("slack:thread-mark-failed", {
          account_id: this.accountId,
          thread_id: record.thread_id,
          thread_ts: t.thread_ts,
          read: true,
          error: messageOf(err),
        });
      }
    }
    if (moved.length > 0) this.threadsMarked.set(record.thread_id, moved);
    else this.threadsMarked.delete(record.thread_id);
  }

  private remember(candidates: ReadonlyMap<string, Candidate>, complete: boolean): void {
    const next = complete ? new Map<string, SlackActivityItem[]>() : new Map(this.activity);
    for (const c of candidates.values()) {
      if (c.items.length === 0) continue;
      const keys = new Set(c.items.map((i) => i.key));
      next.set(c.thread_id, [...(next.get(c.thread_id) ?? []).filter((i) => !keys.has(i.key)), ...c.items]);
    }
    this.activity = next;
  }

  private async unreadActivity(): Promise<{ items: SlackActivityItem[]; complete: boolean; walked: boolean }> {
    const now = (this.opts.now?.() ?? new Date()).getTime();
    const page = async (cursor: string | undefined) => {
      const p = await this.opts.client.activityFeed({ unreadOnly: true, types: SLACK_ACTIVITY_TYPES, cursor, limit: FEED_PAGE });
      // Outside (Slack): Slack may send kinds that were not asked for; a reaction or anything else is never a card.
      return { items: p.items.filter((i) => i.is_unread && (SLACK_ACTIVITY_TYPES as readonly string[]).includes(i.type)), next: p.next_cursor };
    };
    if (!this.walk && now < this.nextFullWalk) {
      const first = await page(undefined);
      return { items: first.items, complete: !first.next, walked: false };
    }
    const walk = this.walk ?? { cursor: "", items: [], pages: 0 };
    this.walk = null;
    try {
      while (walk.pages < FEED_PAGES) {
        const p = await page(walk.cursor || undefined);
        walk.pages++;
        walk.items.push(...p.items);
        if (!p.next) {
          this.nextFullWalk = now + FULL_WALK_MS;
          return { items: walk.items, complete: true, walked: true };
        }
        walk.cursor = p.next;
      }
      this.nextFullWalk = now + FULL_WALK_MS;
      return { items: walk.items, complete: false, walked: true };
    } catch (err) {
      if (!(err instanceof SlackError && err.code === "ratelimited") || walk.pages === 0) throw err;
      this.walk = walk;
      return { items: walk.items, complete: false, walked: false };
    }
  }

  private async refill(older: Candidate[], complete: boolean, room: number): Promise<Refilled> {
    const raw = this.opts.accounts.get(this.accountId)?.backfill ?? {};
    const state: RefillState = { step: typeof raw.step === "number" ? raw.step : 0, exhausted: raw.exhausted === true };
    if (state.exhausted) return "stopped";
    const connected = Date.parse(this.opts.account.connected_at);
    const unseen = older
      .filter((c) => {
        const r = this.opts.threads.get(this.accountId, c.thread_id);
        return !r || tsAfter(c.ts, r.newest_message_id);
      })
      .sort((a, b) => tsKey(b.ts).localeCompare(tsKey(a.ts)));
    const start = { ...state };
    const tried = new Set<string>();
    let made = 0;
    for (;;) {
      const days = REFILL_DAYS.at(state.step);
      const cutoff = days === undefined ? "" : new Date(connected - days * DAY_MS).toISOString();
      for (const c of unseen) {
        if (made >= room) break;
        if (tried.has(c.thread_id) || (tsIso(c.ts) ?? "") < cutoff) continue;
        tried.add(c.thread_id);
        const observed = await this.observe(c, true);
        if (observed === "failed") return "stopped";
        if (observed === "card") made++;
      }
      if (made >= room) break;
      if (days !== undefined) state.step++;
      else {
        state.exhausted = complete;
        break;
      }
    }
    if (state.step !== start.step || state.exhausted !== start.exhausted) this.opts.accounts.setBackfill(this.accountId, { ...state });
    return made >= room ? "filled" : state.exhausted ? "stopped" : "short";
  }

  private async observe(c: Candidate, fromBackfill: boolean): Promise<Observed> {
    const r = this.opts.threads.get(this.accountId, c.thread_id);
    if (r && !tsAfter(c.ts, r.newest_message_id)) {
      if (r.reach === null || (r.place === null && !c.dm)) {
        const reach = slackReach(
          c.dm !== null,
          c.items.map((i) => i.type),
        );
        const place = c.dm ? null : await this.place(c.thread_id.slice(0, c.thread_id.indexOf(":")));
        this.opts.threads.describe(this.accountId, c.thread_id, { reach, place });
      }
      return r.state === "open" ? "card" : "nothing";
    }
    const nothing = this.nothingAt.get(c.thread_id);
    if (nothing !== undefined && !tsAfter(c.ts, nothing)) return "nothing";
    try {
      const m = await this.message(c);
      if (m) this.opts.threads.observe(this.accountId, { ...m, from_backfill: fromBackfill });
    } catch (err) {
      if (err instanceof SlackError && ACCOUNT_ERRORS.includes(err.code)) throw err;
      log.error("slack:item-unreadable", { account_id: this.accountId, thread_id: c.thread_id, error: messageOf(err) });
      if (!(err instanceof SlackError) || err.code.startsWith("http_") || PASSING_ERRORS.includes(err.code)) return "failed";
    }
    if (this.opts.threads.get(this.accountId, c.thread_id)?.state === "open") return "card";
    this.nothingAt.set(c.thread_id, c.ts);
    return "nothing";
  }

  private async message(c: Candidate): Promise<ObservedMessage | null> {
    const { client } = this.opts;
    const found = new Map<string, SlackMessage>();
    if (c.dm) {
      const page = await client.conversationsHistory({ channel: c.dm.id, oldest: c.dm.last_read ?? undefined, limit: DM_MESSAGES });
      for (const m of page.messages) if (!c.dm.last_read || tsAfter(m.ts, c.dm.last_read)) found.set(m.ts, m);
    }
    const record = this.opts.threads.get(this.accountId, c.thread_id);
    const mark = record?.dealt_message_id ?? null;
    const isNew = (ts: string, from: string | null) => !from || tsAfter(ts, from);
    const brought = new Set((record?.brought_ids ?? []).filter((id) => isNew(id, mark)));
    const newestItemPerThread = new Map<string, string>();
    for (const { channel, ts, thread_ts } of c.items) {
      if (!channel || !ts || !thread_ts) continue;
      const was = newestItemPerThread.get(`${channel}:${thread_ts}`);
      if (!was || tsAfter(ts, was)) newestItemPerThread.set(`${channel}:${thread_ts}`, ts);
    }
    const threadsRead = new Map<string, SlackMessage[]>();
    const thread = async (channel: string, threadTs: string, ts: string) => {
      const key = `${channel}:${threadTs}`;
      const known = threadsRead.get(key);
      if (known) return known;
      const messages = await this.threadUpTo(channel, threadTs, newestItemPerThread.get(key) ?? ts);
      threadsRead.set(key, messages);
      return messages;
    };
    for (const item of c.items) {
      const { channel, ts } = item;
      if (!channel || !ts) continue;
      const page = item.thread_ts
        ? { messages: await thread(channel, item.thread_ts, ts) }
        : { messages: (await client.conversationsHistory({ channel, latest: ts, inclusive: true, limit: 1 })).messages.filter((m) => m.ts === ts) };
      for (const m of page.messages) if (m.ts && !tsAfter(m.ts, ts)) found.set(m.ts, m);
      if (c.dm) continue;
      if (item.type !== "thread_v2" || !item.thread_ts) {
        if (isNew(ts, mark)) brought.add(ts);
        continue;
      }
      // Outside (Slack): a followed thread's item names only its newest reply, so every reply by someone else since the mark, or since
      // the person last read the thread in Slack, brought the card.
      const root = page.messages.find((m) => m.ts === item.thread_ts);
      const read = mark ?? (typeof root?.raw.last_read === "string" && root.raw.last_read ? root.raw.last_read : null);
      for (const m of page.messages) if (m.ts !== item.thread_ts && m.user !== this.me && !tsAfter(m.ts, ts) && isNew(m.ts, read)) brought.add(m.ts);
    }
    const list = [...found.values()].filter((m) => tsIso(m.ts)).sort((a, b) => tsKey(a.ts).localeCompare(tsKey(b.ts)));
    const newest = list.at(-1);
    const at = newest ? tsIso(newest.ts) : null;
    if (!newest || !at) return null;
    const lines: string[] = [];
    for (const m of list.slice(-3)) lines.push([await this.plain(m.text), ...slackFiles(m).map(filePlain)].filter(Boolean).join("\n"));
    return {
      thread_id: c.thread_id,
      message_id: newest.ts,
      at,
      sender: await this.sender(newest),
      subject: firstLine(lines.at(-1) ?? ""),
      lines,
      reach: slackReach(
        c.dm !== null,
        c.items.map((i) => i.type),
      ),
      place: c.dm ? null : await this.place(c.thread_id.slice(0, c.thread_id.indexOf(":"))),
      sender_avatar: newest.user ? ((await this.person(newest.user)).image ?? null) : null,
      brought_ids: [...brought].sort((x, y) => tsKey(x).localeCompare(tsKey(y))),
    };
  }

  /**
   * A thread's parent and its replies up to `ts`, or all of them when `ts` is null. Slack gives replies oldest first, so
   * the pages are followed until one reaches `ts`: one page alone misses the newest reply of a long thread.
   */
  private async threadUpTo(channel: string, threadTs: string, ts: string | null): Promise<SlackMessage[]> {
    const messages: SlackMessage[] = [];
    let cursor: string | undefined;
    for (let n = 0; n < THREAD_PAGES; n++) {
      const page = await this.opts.client.conversationsReplies({ channel, ts: threadTs, limit: THREAD_PAGE, cursor });
      messages.push(...page.messages);
      if (!page.has_more || !page.next_cursor || (ts !== null && page.messages.some((m) => !tsAfter(ts, m.ts)))) break;
      cursor = page.next_cursor;
    }
    return messages;
  }

  /**
   * Whether a DM card that client.counts no longer lists has ended: the DM is read past the card's newest message, or
   * Slack no longer has it for the person (a group DM they left). When Slack will not say now, the card waits a tick.
   */
  private async closedDmEnded(r: ThreadRecord): Promise<boolean> {
    try {
      const { last_read } = await this.opts.client.conversationsInfo(r.thread_id);
      return last_read !== null && !tsAfter(r.newest_message_id, last_read);
    } catch (err) {
      if (err instanceof SlackError && ACCOUNT_ERRORS.includes(err.code)) throw err;
      if (err instanceof SlackError && err.code === "channel_not_found") return true;
      log.error("slack:dm-unreadable", { account_id: this.accountId, thread_id: r.thread_id, error: messageOf(err) });
      return false;
    }
  }

  private async sender(m: SlackMessage): Promise<string> {
    if (m.user) return this.name(m.user);
    const username = m.raw.username;
    return typeof username === "string" && username ? username : "a Slack app";
  }

  private async name(user: string): Promise<string> {
    return (await this.person(user)).name;
  }

  private readonly inFlightPeople = new Map<string, Promise<{ name: string; image: string | null }>>();
  private readonly inFlightPlaces = new Map<string, Promise<string | null>>();

  private person(user: string): Promise<{ name: string; image: string | null }> {
    const known = this.names.get(user);
    if (known !== undefined) return Promise.resolve(known);
    const active = this.inFlightPeople.get(user);
    if (active) return active;
    const task = (async () => {
      try {
        const u = await this.opts.client.usersInfo(user);
        const person = { name: u.display_name || u.real_name || u.name || user, image: u.image || null };
        this.names.set(user, person);
        return person;
      } finally {
        this.inFlightPeople.delete(user);
      }
    })();
    this.inFlightPeople.set(user, task);
    return task;
  }

  private place(channel: string): Promise<string | null> {
    if (this.places.has(channel)) return Promise.resolve(this.places.get(channel) ?? null);
    const active = this.inFlightPlaces.get(channel);
    if (active) return active;
    const task = (async () => {
      try {
        const info = await this.opts.client.conversationsInfo(channel).catch((err: unknown) => {
          if (err instanceof SlackError && ACCOUNT_ERRORS.includes(err.code)) throw err;
          return null;
        });
        const place = info?.name ? `#${info.name}` : null;
        this.places.set(channel, place);
        return place;
      } finally {
        this.inFlightPlaces.delete(channel);
      }
    })();
    this.inFlightPlaces.set(channel, task);
    return task;
  }

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
