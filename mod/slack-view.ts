import type { JiraCardTicket, OutsideWindow, OutsideWindowAsk, SlackCardView, SlackFile, SlackReaction } from "../core/frame-types.ts";
import { senderOf, tsIso } from "./account-ops/slack.ts";
import type { ThreadMessage } from "./account-ops/thread.ts";
import type { SlackClient, SlackMessage } from "./slack.ts";
import { reactionEmoji, readSlackMessage, slackFileParts, type SlackNames, type SlackThumb } from "./slack-markup.ts";
import { SlackError, tsAfter, tsKey } from "./slack.ts";

export const VIEW_AROUND = 5;
export const VIEW_LOAD = 20;
const DM_RUN = 50;
/**
 * Pages of 100 read to reach the messages right after a message in a busy channel. Slack gives the newest first, so a
 * channel with more than this many messages since shows none after, and says more came.
 */
const AFTER_PAGES = 3;
const PAGE = 100;
const THREAD_PAGES = 5;
const THREAD_PAGE = 200;

interface Person {
  name: string;
  image: string | null;
}

type ViewClient = Pick<SlackClient, "conversationsReplies" | "conversationsHistory" | "conversationsInfo" | "usersInfo" | "emojiList">;

export interface CardFacts {
  dealt_message_id: string | null;
  brought_ids: readonly string[];
  newest_message_id: string | null;
  place?: string | null;
}

export interface CardWindow<W extends OutsideWindow | null = OutsideWindow> {
  messages: ThreadMessage[];
  window: W;
  link?: string;
  ticket?: JiraCardTicket;
}

export type CardView<W extends OutsideWindow | null = OutsideWindow> = (
  accountId: string,
  threadId: string,
  facts: CardFacts,
  ask: OutsideWindowAsk,
) => Promise<CardWindow<W>>;

export function slackChannelView(
  client: (accountId: string) => ViewClient,
  preview: (accountId: string, thumb: SlackThumb) => Promise<SlackFile["preview"] | null> = () => Promise.resolve(null),
): CardView {
  const people = new Map<string, Map<string, Promise<Person>>>();
  const channels = new Map<string, Map<string, Promise<string | null>>>();
  const emoji = new Map<string, Promise<Record<string, string>>>();
  return async (accountId, threadId, facts, ask) => {
    const slack = client(accountId);
    const seen = people.get(accountId) ?? new Map<string, Promise<Person>>();
    people.set(accountId, seen);
    const named = channels.get(accountId) ?? new Map<string, Promise<string | null>>();
    channels.set(accountId, named);
    let own = emoji.get(accountId);
    if (!own) {
      own = slack.emojiList().catch(() => {
        emoji.delete(accountId);
        return {};
      });
      emoji.set(accountId, own);
    }
    const person = (user: string): Promise<Person> => {
      const had = seen.get(user);
      if (had) return had;
      const p = slack
        .usersInfo(user)
        .catch(() => null)
        .then((u) => ({ name: u ? u.display_name || u.real_name || u.name || user : user, image: u?.image || null }));
      seen.set(user, p);
      return p;
    };
    const name = async (user: string) => (await person(user)).name;
    const channelName = (id: string): Promise<string | null> => {
      const had = named.get(id);
      if (had) return had;
      const p = slack
        .conversationsInfo(id)
        .then((c) => c.name)
        .catch(() => null);
      named.set(id, p);
      return p;
    };
    let ownEmoji: Record<string, string> = {};
    const names: SlackNames = { person: name, channel: channelName, emoji: (n) => ownEmoji[n] ?? null };
    const me = accountId.split(":").at(2) ?? "";
    const mine = (m: SlackMessage) => me !== "" && m.user === me;
    const withPreviews = (m: SlackMessage): Promise<SlackFile[]> =>
      Promise.all(
        slackFileParts(m).map(async ({ file, thumb }) => {
          const shown = thumb ? await preview(accountId, thumb) : null;
          return shown ? { ...file, preview: shown } : file;
        }),
      );
    const draw = async (m: SlackMessage, extra: Partial<ThreadMessage> = {}): Promise<ThreadMessage> => {
      const image = m.user ? (await person(m.user)).image : null;
      const words = await readSlackMessage(m, names);
      return {
        id: m.ts,
        sender: await senderOf(m, name),
        at: tsIso(m.ts),
        text: words.text,
        mine: mine(m),
        body: words.body,
        ...(words.attachments.length ? { attachments: words.attachments } : {}),
        ...(words.files.length ? { slack_files: await withPreviews(m) } : {}),
        ...(image ? { avatar: image } : {}),
        ...reactionsOf(m, me, names),
        ...extra,
      };
    };

    const at = threadId.indexOf(":");
    const dm = at < 0;
    const channel = dm ? threadId : threadId.slice(0, at);
    const cardTs = dm ? null : threadId.slice(at + 1);
    const [info, emojiRead] = await Promise.all([slack.conversationsInfo(channel).catch(() => null), own]);
    ownEmoji = emojiRead;
    const mark = facts.dealt_message_id;
    const channelRead = info?.last_read ?? null;
    const remembered = facts.brought_ids.length > 0 ? facts.brought_ids : facts.newest_message_id ? [facts.newest_message_id] : [];
    const broughtIds = dm ? [] : remembered.filter((id) => !mark || tsAfter(id, mark));
    const brought = new Set(broughtIds);
    const later = (a: string | null, b: string | null) => (a && b ? (tsAfter(a, b) ? a : b) : (a ?? b));
    const isNew = (m: SlackMessage, slackRead: string | null): boolean => {
      if (mine(m)) return false;
      if (!dm && brought.size > 0) return brought.has(m.ts);
      const from = dm ? later(mark, slackRead) : (mark ?? slackRead);
      return from !== null && tsAfter(m.ts, from);
    };
    const flags = (m: SlackMessage, slackRead: string | null): Partial<ThreadMessage> => ({
      ...(isNew(m, slackRead) ? { unread: true } : {}),
      ...(brought.has(m.ts) ? { brought: true } : {}),
    });

    const view: SlackCardView = ask.view ?? (cardTs && brought.size > 0 && broughtIds.every((id) => id !== cardTs) ? "thread" : "channel");

    if (view === "thread") {
      const threadTs = ask.thread_ts ?? cardTs;
      if (!threadTs) return { messages: [], window: { view, thread_ts: null, more_before: false, more_after: false } };
      const whole = await wholeThread(slack, channel, threadTs);
      const root = whole.messages.find((m) => m.ts === threadTs);
      const replies = whole.messages.filter((m) => m.ts !== threadTs);
      const lastRead = root?.raw.last_read;
      const threadRead = typeof lastRead === "string" && lastRead ? lastRead : channelRead;
      const opened = ask.thread_ts !== undefined && !ask.direction;
      const [start, end] = opened
        ? [0, replies.length]
        : cut(
            replies.map((m) => m.ts),
            replies.map((m) => isNew(m, threadRead)),
            ask,
          );
      const shown = replies.slice(start, end);
      const drawn = await Promise.all([
        ...(root && !ask.direction ? [draw(root, flags(root, channelRead))] : []),
        ...shown.map((m) => draw(m, flags(m, threadRead))),
      ]);
      const after = replies.length - end;
      return {
        messages: drawn,
        window: { view, thread_ts: threadTs, more_before: start, more_after: whole.more ? true : after },
      };
    }

    const ownReplies = cardTs ? broughtIds.filter((id) => id !== cardTs).length : 0;
    const repliesOf = async (m: SlackMessage): Promise<Partial<ThreadMessage>> => {
      if (m.reply_count <= 0) return {};
      const count: Partial<ThreadMessage> = { replies: m.reply_count };
      if (cardTs) return m.ts === cardTs && ownReplies > 0 ? { ...count, new_replies: ownReplies } : count;
      const latest = m.raw.latest_reply;
      const from = later(mark, channelRead);
      if (typeof latest !== "string" || from === null || !tsAfter(latest, from)) return count;
      try {
        const thread = await wholeThread(slack, channel, m.ts);
        const n = thread.messages.filter((r) => r.ts !== m.ts && !mine(r) && tsAfter(r.ts, from)).length;
        return n > 0 ? { ...count, new_replies: n } : count;
      } catch (err) {
        if (err instanceof SlackError) return { ...count, new_replies: true };
        throw err;
      }
    };
    if (ask.direction && ask.from) {
      const page = ask.direction === "before" ? await before(slack, channel, ask.from, VIEW_LOAD) : await after(slack, channel, ask.from, VIEW_LOAD);
      const drawn = await Promise.all(page.messages.map(async (m) => draw(m, { ...flags(m, channelRead), ...(await repliesOf(m)) })));
      return {
        messages: drawn,
        window: {
          view,
          thread_ts: null,
          more_before: ask.direction === "before" ? page.more : false,
          more_after: ask.direction === "after" ? page.more : false,
        },
      };
    }

    let around: SlackMessage[];
    let moreBefore: boolean;
    let moreAfter: boolean;
    let far = false;
    if (cardTs) {
      const [earlier, post, next] = await Promise.all([
        before(slack, channel, cardTs, VIEW_AROUND),
        slack.conversationsHistory({ channel, latest: cardTs, inclusive: true, limit: 1 }),
        after(slack, channel, cardTs, VIEW_AROUND),
      ]);
      around = [...earlier.messages, ...post.messages.filter((m) => m.ts === cardTs), ...next.messages];
      moreBefore = earlier.more;
      moreAfter = next.more;
      far = next.far;
    } else {
      const from = later(mark, channelRead);
      const run = from ? await after(slack, channel, from, DM_RUN) : { messages: [], more: false, far: false };
      const firstNew = run.messages.find((m) => isNew(m, channelRead));
      if (firstNew) {
        const earlier = await before(slack, channel, firstNew.ts, VIEW_AROUND);
        const fromFirst = run.messages.filter((m) => !tsAfter(firstNew.ts, m.ts));
        const lastNew = fromFirst.reduce((n, m, i) => (isNew(m, channelRead) ? i : n), 0);
        around = [...earlier.messages, ...fromFirst.slice(0, lastNew + 1 + VIEW_AROUND)];
        moreBefore = earlier.more;
        moreAfter = run.more || fromFirst.length > lastNew + 1 + VIEW_AROUND;
      } else {
        const latest = await slack.conversationsHistory({ channel, limit: VIEW_AROUND + 1 });
        around = byTime(latest.messages);
        moreBefore = latest.has_more;
        moreAfter = false;
      }
    }
    const drawn = await Promise.all(around.map(async (m) => draw(m, { ...flags(m, channelRead), ...(await repliesOf(m)) })));
    const last = drawn.at(-1);
    if (far && last) last.more_after = true;
    return { messages: drawn, window: { view, thread_ts: null, more_before: moreBefore, more_after: moreAfter } };
  };
}

function cut(ids: readonly string[], fresh: readonly boolean[], ask: OutsideWindowAsk): [number, number] {
  if (ask.direction && ask.from) {
    const i = ids.indexOf(ask.from);
    if (i < 0) return [0, 0];
    return ask.direction === "before" ? [Math.max(0, i - VIEW_LOAD), i] : [i + 1, Math.min(ids.length, i + 1 + VIEW_LOAD)];
  }
  const first = fresh.indexOf(true);
  const last = fresh.lastIndexOf(true);
  if (first < 0) return [Math.max(0, ids.length - 1 - VIEW_AROUND), ids.length];
  return [Math.max(0, first - VIEW_AROUND), Math.min(ids.length, last + 1 + VIEW_AROUND)];
}

async function wholeThread(slack: ViewClient, channel: string, ts: string): Promise<{ messages: SlackMessage[]; more: boolean }> {
  const found: SlackMessage[] = [];
  let page = await slack.conversationsReplies({ channel, ts, limit: THREAD_PAGE });
  found.push(...page.messages);
  for (let n = 1; page.has_more && page.next_cursor && n < THREAD_PAGES; n++) {
    page = await slack.conversationsReplies({ channel, ts, limit: THREAD_PAGE, cursor: page.next_cursor });
    found.push(...page.messages);
  }
  return { messages: byTime(found), more: page.has_more };
}

async function before(slack: ViewClient, channel: string, ts: string, count: number): Promise<{ messages: SlackMessage[]; more: boolean }> {
  const page = await slack.conversationsHistory({ channel, latest: ts, inclusive: false, limit: count });
  return { messages: byTime(page.messages), more: page.has_more };
}

/**
 * Up to `count` channel messages right after `ts`, oldest first, and whether more came after them. Slack gives the
 * newest first, so the read pages back towards `ts`; a channel with more since than AFTER_PAGES pages hold shows none,
 * rather than messages from long after, and says it is `far`: there is more, but no load could reach it.
 */
async function after(slack: ViewClient, channel: string, ts: string, count: number): Promise<{ messages: SlackMessage[]; more: boolean; far: boolean }> {
  const found: SlackMessage[] = [];
  let page = await slack.conversationsHistory({ channel, oldest: ts, limit: PAGE });
  found.push(...page.messages);
  for (let n = 1; page.has_more && page.next_cursor && n < AFTER_PAGES; n++) {
    page = await slack.conversationsHistory({ channel, oldest: ts, limit: PAGE, cursor: page.next_cursor });
    found.push(...page.messages);
  }
  if (page.has_more) return { messages: [], more: false, far: true };
  const sorted = byTime(found.filter((m) => m.ts !== ts));
  return { messages: sorted.slice(0, count), more: sorted.length > count, far: false };
}

function byTime(messages: readonly SlackMessage[]): SlackMessage[] {
  return [...messages].sort((a, b) => tsKey(a.ts).localeCompare(tsKey(b.ts)));
}

function reactionsOf(m: SlackMessage, me: string, names: Pick<SlackNames, "emoji">): { reactions?: SlackReaction[] } {
  const raw = m.raw.reactions;
  if (!Array.isArray(raw)) return {};
  const reactions: SlackReaction[] = [];
  for (const r of raw as unknown[]) {
    if (typeof r !== "object" || r === null) continue;
    const { name, count, users } = r as Record<string, unknown>;
    if (typeof name !== "string" || !name || typeof count !== "number" || count < 1) continue;
    const mine = me !== "" && Array.isArray(users) && users.includes(me);
    reactions.push({ name, count, mine, emoji: reactionEmoji(name, names) });
  }
  return reactions.length ? { reactions } : {};
}
