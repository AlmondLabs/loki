import { senderOf, slackPlain, tsIso, type ThreadMessage, type ThreadText } from "./handoff.ts";
import type { SlackClient, SlackMessage } from "./slack.ts";
import { tsAfter, tsKey } from "./slack-sync.ts";

/** The channel messages a card shows before its thread's first message (plan 074). */
export const VIEW_BEFORE = 5;
/** The channel messages a card shows after its thread's first message (plan 074). */
export const VIEW_AFTER = 5;
/** A DM card's latest messages, as many as its thread read shows. */
export const VIEW_DM = 50;
/**
 * Pages of 100 read to reach the messages right after a thread in a busy channel. Slack gives the newest first, so a
 * channel with more than this many messages since shows none after, and says more came.
 */
const AFTER_PAGES = 3;
const PAGE = 100;

/** Who wrote a message as the card shows them: the name Slack shows and their photo. */
interface Person {
  name: string;
  image: string | null;
}

type ViewClient = Pick<SlackClient, "conversationsReplies" | "conversationsHistory" | "conversationsInfo" | "usersInfo">;

/**
 * A Slack card's body as the channel shows it (plan 074): for a thread (`<channel>:<ts>`), the channel's messages
 * before its first message, that message with its replies, and the channel's messages after it; for a DM, its
 * latest messages. Each message carries its sender's photo and whether the person has read it, from the thread's own
 * read marker for replies and the channel's for the rest. People are remembered across reads of one account, so
 * opening another card asks Slack only about people not seen yet.
 */
export function slackChannelView(client: (accountId: string) => ViewClient): ThreadText {
  const people = new Map<string, Map<string, Person>>();
  return async (accountId, threadId) => {
    const slack = client(accountId);
    const seen = people.get(accountId) ?? new Map<string, Person>();
    people.set(accountId, seen);
    const person = async (user: string): Promise<Person> => {
      const had = seen.get(user);
      if (had) return had;
      const u = await slack.usersInfo(user).catch(() => null);
      const p = { name: u ? u.display_name || u.real_name || u.name || user : user, image: u?.image || null };
      seen.set(user, p);
      return p;
    };
    const name = async (user: string) => (await person(user)).name;
    // The account is the workspace and the person it calls as (`slack:<team>:<user>`), so a message by that user is theirs.
    const me = accountId.split(":").at(2) ?? "";
    const draw = async (m: SlackMessage, read: string | null, extra: Partial<ThreadMessage> = {}): Promise<ThreadMessage> => {
      const mine = me !== "" && m.user === me;
      const image = m.user ? (await person(m.user)).image : null;
      return {
        id: m.ts,
        sender: await senderOf(m, name),
        at: tsIso(m.ts),
        text: await slackPlain(m.text, name),
        mine,
        ...(image ? { avatar: image } : {}),
        ...(!mine && read !== null && tsAfter(m.ts, read) ? { unread: true } : {}),
        ...extra,
      };
    };
    const at = threadId.indexOf(":");
    if (at < 0) {
      const [page, info] = await Promise.all([
        slack.conversationsHistory({ channel: threadId, limit: VIEW_DM }),
        slack.conversationsInfo(threadId).catch(() => null),
      ]);
      const read = info?.last_read ?? null;
      const out: ThreadMessage[] = [];
      for (const m of byTime(page.messages)) out.push(await draw(m, read));
      return out;
    }
    const channel = threadId.slice(0, at);
    const ts = threadId.slice(at + 1);
    const [thread, before, later, info] = await Promise.all([
      slack.conversationsReplies({ channel, ts, limit: 200 }),
      slack.conversationsHistory({ channel, latest: ts, inclusive: false, limit: VIEW_BEFORE }),
      afterThread(slack, channel, ts),
      slack.conversationsInfo(channel).catch(() => null),
    ]);
    const channelRead = info?.last_read ?? null;
    const messages = byTime(thread.messages);
    const first = messages.find((m) => m.ts === ts) ?? messages.at(0);
    const lastRead = first?.raw.last_read;
    const threadRead = typeof lastRead === "string" && lastRead ? lastRead : channelRead;
    const out: ThreadMessage[] = [];
    for (const m of byTime(before.messages)) out.push(await draw(m, channelRead, withReplies(m)));
    for (const m of messages) out.push(await draw(m, m === first ? channelRead : threadRead, m === first ? {} : { in_thread: true }));
    for (const m of later.messages) out.push(await draw(m, channelRead, withReplies(m)));
    const last = out.at(-1);
    if (later.more && last) last.more_after = true;
    return out;
  };
}

/**
 * The channel's messages right after a thread's first message, oldest first, and whether more came after them. Slack
 * gives the newest first, so the read pages back towards the thread; a channel with more since than AFTER_PAGES pages
 * hold shows none, rather than messages from long after.
 */
async function afterThread(slack: ViewClient, channel: string, ts: string): Promise<{ messages: SlackMessage[]; more: boolean }> {
  const found: SlackMessage[] = [];
  let page = await slack.conversationsHistory({ channel, oldest: ts, limit: PAGE });
  found.push(...page.messages);
  for (let n = 1; page.has_more && page.next_cursor && n < AFTER_PAGES; n++) {
    page = await slack.conversationsHistory({ channel, oldest: ts, limit: PAGE, cursor: page.next_cursor });
    found.push(...page.messages);
  }
  if (page.has_more) return { messages: [], more: true };
  const sorted = byTime(found.filter((m) => m.ts !== ts));
  return { messages: sorted.slice(0, VIEW_AFTER), more: sorted.length > VIEW_AFTER };
}

/** A channel message's reply count, when it has a thread of its own. */
function withReplies(m: SlackMessage): Partial<ThreadMessage> {
  return m.reply_count > 0 ? { replies: m.reply_count } : {};
}

function byTime(messages: readonly SlackMessage[]): SlackMessage[] {
  return [...messages].sort((a, b) => tsKey(a.ts).localeCompare(tsKey(b.ts)));
}
