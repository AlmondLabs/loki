import { PAST_CAP } from "../core/account-refill.ts";
import { messageOf } from "../core/errors.ts";
import type { OutsideChange } from "../core/frame-types.ts";
import type { AccountThreads, ObservedMessage, OutsideSource, ThreadRecord } from "./account-threads.ts";
import type { AccountSync } from "./account-watcher.ts";
import type { AccountRecord, Accounts } from "./accounts.ts";
import { log } from "./log.ts";
import { filePlain, slackFiles } from "./slack-markup.ts";
import { slackReach } from "../core/outside-reach.ts";
import { SLACK_ACTIVITY_TYPES, SlackError, type SlackActivityItem, type SlackClient, type SlackCount, type SlackMessage } from "./slack.ts";

export interface SlackSyncOptions {
  accounts: Pick<Accounts, "get" | "setBackfill">;
  threads: Pick<AccountThreads, "observe" | "describe" | "markGoneOutThere" | "get" | "list">;
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

interface Candidate {
  thread_id: string;
  ts: string;
  dm: SlackCount | null;
  items: SlackActivityItem[];
}

interface RefillState {
  step: number;
  exhausted: boolean;
}

/**
 * A Slack ts as a string that sorts in time order: seconds padded, then the six-digit fraction. Comparing ts as numbers
 * loses the last digits of the fraction, which is what tells two messages in one second apart.
 */
export const tsKey = (ts: string): string => {
  const [s = "", f = ""] = ts.split(".");
  return `${s.padStart(12, "0")}.${f.padEnd(6, "0")}`;
};
export const tsAfter = (a: string, b: string): boolean => tsKey(a) > tsKey(b);

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
  private readonly names = new Map<string, { name: string; image: string | null }>();
  private readonly places = new Map<string, string | null>();
  private activity = new Map<string, SlackActivityItem[]>();
  private readonly marked = new Map<string, SlackActivityItem[]>();
  private nextFullWalk = 0;
  private walk: { cursor: string; items: SlackActivityItem[]; pages: number } | null = null;

  constructor(opts: SlackSyncOptions) {
    this.opts = opts;
    this.accountId = opts.account.account_id;
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

    const connectedAt = this.opts.account.connected_at;
    const older: Candidate[] = [];
    for (const c of candidates.values()) {
      if ((tsIso(c.ts) ?? "") < connectedAt) older.push(c);
      else await this.observe(c, false);
    }

    for (const r of threads.list(this.accountId)) {
      if (r.state !== "open" || r.waiting || r.kept_open || candidates.has(r.thread_id)) continue;
      if (r.thread_id.includes(":")) {
        if (feed.complete) threads.markGoneOutThere(this.accountId, r.thread_id);
        continue;
      }
      const dm = dms.get(r.thread_id);
      // A DM closed in Slack drops out of client.counts, so Slack is asked about it alone, else its card never ends.
      const ended = dm ? !dm.has_unreads || (dm.last_read !== null && !tsAfter(r.newest_message_id, dm.last_read)) : await this.closedDmEnded(r);
      if (ended) threads.markGoneOutThere(this.accountId, r.thread_id);
    }

    const open = threads.list(this.accountId).filter((r) => r.state === "open" && !this.opts.resting?.(r)).length;
    if (open < PAST_CAP) await this.refill(older, feed.complete, PAST_CAP - open);
  }

  async archive(record: ThreadRecord): Promise<void> {
    if (!record.thread_id.includes(":")) await this.opts.client.markDm(record.thread_id, record.newest_message_id);
    const items = (this.activity.get(record.thread_id) ?? []).filter((i) => !i.ts || !tsAfter(i.ts, record.newest_message_id));
    if (items.length === 0) return;
    try {
      await this.opts.client.markActivity(items, true);
    } catch (err) {
      log("slack:activity-mark-failed", { account_id: this.accountId, thread_id: record.thread_id, read: true, error: messageOf(err) });
      return;
    }
    const keys = new Set(items.map((i) => i.key));
    const left = (this.activity.get(record.thread_id) ?? []).filter((i) => !keys.has(i.key));
    if (left.length > 0) this.activity.set(record.thread_id, left);
    else this.activity.delete(record.thread_id);
    this.marked.set(record.thread_id, items);
  }

  async restore(record: ThreadRecord): Promise<void> {
    const items = this.marked.get(record.thread_id);
    if (!items) return;
    this.marked.delete(record.thread_id);
    try {
      await this.opts.client.markActivity(items, false);
    } catch (err) {
      log("slack:activity-mark-failed", { account_id: this.accountId, thread_id: record.thread_id, read: false, error: messageOf(err) });
      return;
    }
    const keys = new Set(items.map((i) => i.key));
    this.activity.set(record.thread_id, [...(this.activity.get(record.thread_id) ?? []).filter((i) => !keys.has(i.key)), ...items]);
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

  private async unreadActivity(): Promise<{ items: SlackActivityItem[]; complete: boolean }> {
    const now = (this.opts.now?.() ?? new Date()).getTime();
    const page = async (cursor: string | undefined) => {
      const p = await this.opts.client.activityFeed({ unreadOnly: true, types: SLACK_ACTIVITY_TYPES, cursor, limit: FEED_PAGE });
      // Slack may send kinds that were not asked for; a reaction or anything else is never a card.
      return { items: p.items.filter((i) => i.is_unread && (SLACK_ACTIVITY_TYPES as readonly string[]).includes(i.type)), next: p.next_cursor };
    };
    if (!this.walk && now < this.nextFullWalk) {
      const first = await page(undefined);
      return { items: first.items, complete: !first.next };
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
          return { items: walk.items, complete: true };
        }
        walk.cursor = p.next;
      }
      this.nextFullWalk = now + FULL_WALK_MS;
      return { items: walk.items, complete: false };
    } catch (err) {
      if (!(err instanceof SlackError && err.code === "ratelimited") || walk.pages === 0) throw err;
      this.walk = walk;
      return { items: walk.items, complete: false };
    }
  }

  private async refill(older: Candidate[], complete: boolean, room: number): Promise<void> {
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
    const taken = new Set<string>();
    for (;;) {
      const days = REFILL_DAYS.at(state.step);
      const cutoff = days === undefined ? "" : new Date(connected - days * DAY_MS).toISOString();
      const batch = unseen.filter((c) => !taken.has(c.thread_id) && (tsIso(c.ts) ?? "") >= cutoff).slice(0, room - taken.size);
      for (const c of batch) {
        await this.observe(c, true);
        taken.add(c.thread_id);
      }
      if (taken.size >= room) break;
      if (days !== undefined) state.step++;
      else {
        state.exhausted = complete;
        break;
      }
    }
    if (state.step !== start.step || state.exhausted !== start.exhausted) this.opts.accounts.setBackfill(this.accountId, { ...state });
  }

  private async observe(c: Candidate, fromBackfill: boolean): Promise<void> {
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
      return;
    }
    try {
      const m = await this.message(c);
      if (m) this.opts.threads.observe(this.accountId, { ...m, from_backfill: fromBackfill });
    } catch (err) {
      if (err instanceof SlackError && ACCOUNT_ERRORS.includes(err.code)) throw err;
      log("slack:item-unreadable", { account_id: this.accountId, thread_id: c.thread_id, error: messageOf(err) });
    }
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
    const me = this.accountId.split(":").at(2) ?? "";
    // A card's items in one thread share a single read of it, up to the newest of them, since a long thread takes pages.
    const newestIn = new Map<string, string>();
    for (const { channel, ts, thread_ts } of c.items) {
      if (!channel || !ts || !thread_ts) continue;
      const was = newestIn.get(`${channel}:${thread_ts}`);
      if (!was || tsAfter(ts, was)) newestIn.set(`${channel}:${thread_ts}`, ts);
    }
    const threadsRead = new Map<string, SlackMessage[]>();
    const thread = async (channel: string, threadTs: string, ts: string) => {
      const key = `${channel}:${threadTs}`;
      const known = threadsRead.get(key);
      if (known) return known;
      const messages = await this.threadUpTo(channel, threadTs, newestIn.get(key) ?? ts);
      threadsRead.set(key, messages);
      return messages;
    };
    for (const item of c.items) {
      const { channel, ts } = item;
      if (!channel || !ts) continue;
      const page = item.thread_ts
        ? { messages: await thread(channel, item.thread_ts, ts) }
        : await client.conversationsHistory({ channel, latest: ts, inclusive: true, limit: 1 });
      for (const m of page.messages) if (m.ts && !tsAfter(m.ts, ts)) found.set(m.ts, m);
      if (c.dm) continue;
      if (item.type !== "thread_v2" || !item.thread_ts) {
        if (isNew(ts, mark)) brought.add(ts);
        continue;
      }
      // A followed thread's item names only its newest reply, so every reply by someone else since the mark, or since
      // the person last read the thread in Slack, brought the card.
      const root = page.messages.find((m) => m.ts === item.thread_ts);
      const read = mark ?? (typeof root?.raw.last_read === "string" && root.raw.last_read ? root.raw.last_read : null);
      for (const m of page.messages) if (m.ts !== item.thread_ts && m.user !== me && !tsAfter(m.ts, ts) && isNew(m.ts, read)) brought.add(m.ts);
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
   * A thread's parent and its replies up to `ts`. Slack gives replies oldest first, so the pages are followed until one
   * reaches `ts`: one page alone misses the newest reply of a long thread.
   */
  private async threadUpTo(channel: string, threadTs: string, ts: string): Promise<SlackMessage[]> {
    const messages: SlackMessage[] = [];
    let cursor: string | undefined;
    for (let n = 0; n < THREAD_PAGES; n++) {
      const page = await this.opts.client.conversationsReplies({ channel, ts: threadTs, limit: THREAD_PAGE, cursor });
      messages.push(...page.messages);
      if (!page.has_more || !page.next_cursor || page.messages.some((m) => !tsAfter(ts, m.ts))) break;
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
      log("slack:dm-unreadable", { account_id: this.accountId, thread_id: r.thread_id, error: messageOf(err) });
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

  private async person(user: string): Promise<{ name: string; image: string | null }> {
    const known = this.names.get(user);
    if (known !== undefined) return known;
    const u = await this.opts.client.usersInfo(user);
    const person = { name: u.display_name || u.real_name || u.name || user, image: u.image || null };
    this.names.set(user, person);
    return person;
  }

  private async place(channel: string): Promise<string | null> {
    if (this.places.has(channel)) return this.places.get(channel) ?? null;
    const info = await this.opts.client.conversationsInfo(channel).catch((err: unknown) => {
      if (err instanceof SlackError && ACCOUNT_ERRORS.includes(err.code)) throw err;
      return null;
    });
    const place = info?.name ? `#${info.name}` : null;
    this.places.set(channel, place);
    return place;
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
