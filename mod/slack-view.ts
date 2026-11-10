import type { OutsideWindow, OutsideWindowAsk, SlackCardView, SlackFile, SlackReaction } from "../core/frame-types.ts";
import { senderOf, tsIso, type ThreadMessage } from "./handoff.ts";
import type { SlackClient, SlackMessage } from "./slack.ts";
import { reactionEmoji, readSlackMessage, slackFileParts, type SlackNames, type SlackThumb } from "./slack-markup.ts";
import { SlackError } from "./slack.ts";
import { tsAfter, tsKey } from "./slack-sync.ts";

/** The messages a card shows on each side of what is new when it opens (plan 077, R1). */
export const VIEW_AROUND = 5;
/** The messages one press of "load earlier" or "load later" adds (plan 077, R3). */
export const VIEW_LOAD = 20;
/** The most unread DM messages a card opens on; a longer run says more came after. */
const DM_RUN = 50;
/**
 * Pages of 100 read to reach the messages right after a message in a busy channel. Slack gives the newest first, so a
 * channel with more than this many messages since shows none after, and says more came.
 */
const AFTER_PAGES = 3;
const PAGE = 100;
/**
 * Pages of 200 read of one thread, which is read whole and cut to the window (plan 077, KTD4). A thread longer than
 * this shows its first 1,000 replies and says more came.
 */
const THREAD_PAGES = 5;
const THREAD_PAGE = 200;

/** Who wrote a message as the card shows them: the name Slack shows and their photo. */
interface Person {
  name: string;
  image: string | null;
}

type ViewClient = Pick<SlackClient, "conversationsReplies" | "conversationsHistory" | "conversationsInfo" | "usersInfo" | "emojiList">;

/** What the card's record says about it (plan 077, KTD1, KTD2): the dealt-with mark and the messages that brought it. */
export interface CardFacts {
  dealt_message_id: string | null;
  brought_ids: readonly string[];
  /** The card's newest message, the one its header names; what brought a card that remembers nothing else. */
  newest_message_id: string | null;
  /** Where the card's thread is, as its record names it: a Jira ticket's key, which its link is built from. */
  place?: string | null;
}

/** A card's window: its messages, oldest first, and what more there is (plan 077). */
export interface CardWindow {
  messages: ThreadMessage[];
  window: OutsideWindow;
  /** The thread's address in the browser, for a Jira card (R14). */
  link?: string;
}

/** A card's window read from its account: the opening one, or what `ask` asks for. */
export type CardView = (accountId: string, threadId: string, facts: CardFacts, ask: OutsideWindowAsk) => Promise<CardWindow>;

/**
 * A Slack card's body as a window around what is new (plan 077): the messages that brought the card, with 5 messages
 * either side, in the thread alone when every new message is a reply in it (R10), else in the channel or DM around it;
 * 20 more before or after a message when the card asks; and a post's whole thread when the person opens it. Each message carries its sender's photo, whether it is new,
 * whether it brought the card, and its words read as Slack draws them (plan 075). People, channels and the workspace's
 * own emoji are remembered across reads of one account, so opening another card asks Slack only about what it has not
 * seen yet; the emoji are read once per account while loki runs. `preview` gives a shared picture its thumbnail (plan
 * 080); without it every file is a chip.
 */
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
    // A workspace whose emoji cannot be read shows its own by name; the read is tried again on the next card.
    let own = emoji.get(accountId);
    if (!own) {
      own = slack.emojiList().catch(() => {
        emoji.delete(accountId);
        return {};
      });
      emoji.set(accountId, own);
    }
    // The lookup itself is remembered, so messages drawn at once by one person ask Slack about them once.
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
    // The workspace's emoji are read beside the messages (below), and messages are drawn once both are in.
    let ownEmoji: Record<string, string> = {};
    const names: SlackNames = { person: name, channel: channelName, emoji: (n) => ownEmoji[n] ?? null };
    // The account is the workspace and the person it calls as (`slack:<team>:<user>`), so a message by that user is theirs.
    const me = accountId.split(":").at(2) ?? "";
    const mine = (m: SlackMessage) => me !== "" && m.user === me;
    // A picture's thumbnail is fetched beside the rest of the card; one that cannot be had leaves its file a chip.
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
    // Only what brought the card since the person last dealt with it counts (R6): a reply sent with "later" marks the
    // card dealt with while the record still holds what brought it before.
    // A card from before plan 077 remembers nothing that brought it, so its newest message, which its header names, is
    // taken as what did: the card opens on it, in its thread when it is a reply there.
    const remembered = facts.brought_ids.length > 0 ? facts.brought_ids : facts.newest_message_id ? [facts.newest_message_id] : [];
    const broughtIds = dm ? [] : remembered.filter((id) => !mark || tsAfter(id, mark));
    const brought = new Set(broughtIds);
    // A DM is new from the later of loki's mark and Slack's own read marker, so reading on in Slack is not new here (R7).
    const later = (a: string | null, b: string | null) => (a && b ? (tsAfter(a, b) ? a : b) : (a ?? b));
    // What is new (plan 077, R2, R6): in a DM, the person's unread messages after the dealt-with mark, else after
    // Slack's read marker; on a channel or thread card, the messages that brought it. A card from before this change
    // brought nothing it remembers, so its new messages are those after Slack's read markers, as before.
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
      // A thread the person opened from the channel or DM comes whole, so every reply can be read in it; the card's
      // own thread opens on its window around what is new.
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

    // A post's new replies (plan 077, R11, KTD6): on a channel card, its own post's replies that brought it, counted
    // from the record; in a DM, each post whose latest reply is after the mark has its thread read and counted.
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
    // The channel or DM view. A load reads 20 more on one side of a message.
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

    // The opening window: around the card's own post, or around a DM's unread run.
    let around: SlackMessage[];
    let moreBefore: boolean;
    let moreAfter: boolean;
    // More came after than loki reads (KTD5): the card says so in words, since no load could reach it.
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
        // Nothing new: the DM's latest messages, the newest last.
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

/**
 * Where a window starts and ends in a run of messages, as indexes: 5 either side of the new ones when it opens, else
 * 20 before or after the message asked from. With nothing new it ends at the newest message.
 */
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

/** A thread read whole, its first message first, and whether it is longer than loki reads (plan 077, KTD4). */
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

/** Up to `count` channel messages right before `ts`, oldest first, and whether there are more before them. */
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

/**
 * A message's reactions as the card draws them (plan 079): Slack's `reactions`, each with its count, whether the
 * person is among those who reacted, and its emoji; nothing when it has none.
 */
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
