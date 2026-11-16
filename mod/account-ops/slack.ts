import type { AccountRecord } from "../accounts.ts";
import { SlackError, type SlackClient, type SlackMessage } from "../slack.ts";
import { readSlackMessage } from "../slack-markup.ts";
import type { FlowRecord, ReplyDestination, ThreadMessage, ThreadText } from "./thread.ts";

const DM_MESSAGES = 50;

export function slackThreadText(client: (accountId: string) => Pick<SlackClient, "conversationsReplies" | "conversationsHistory" | "usersInfo">): ThreadText {
  return async (accountId, threadId) => {
    const slack = client(accountId);
    const names = new Map<string, string>();
    const name = async (user: string) => {
      let known = names.get(user);
      if (known === undefined) {
        const u = await slack.usersInfo(user).catch(() => null);
        known = u ? u.display_name || u.real_name || u.name || user : user;
        names.set(user, known);
      }
      return known;
    };
    const at = threadId.indexOf(":");
    const page =
      at < 0
        ? await slack.conversationsHistory({ channel: threadId, limit: DM_MESSAGES })
        : await slack.conversationsReplies({ channel: threadId.slice(0, at), ts: threadId.slice(at + 1), limit: 200 });
    const messages = [...page.messages].sort((a, b) => Number(a.ts) - Number(b.ts));
    const me = accountId.split(":").at(2) ?? "";
    const out: ThreadMessage[] = [];
    for (const m of messages)
      out.push({
        sender: await senderOf(m, name),
        at: tsIso(m.ts),
        text: (await readSlackMessage(m, { person: name })).text,
        mine: me !== "" && m.user === me,
        id: m.ts,
      });
    return out;
  };
}

export async function senderOf(m: SlackMessage, name: (user: string) => Promise<string>): Promise<string> {
  if (m.user) return name(m.user);
  const username = m.raw.username;
  return typeof username === "string" && username ? username : "a Slack app";
}

export function tsIso(ts: string): string {
  const ms = Number(ts) * 1000;
  return Number.isFinite(ms) && ms > 0 ? new Date(Math.floor(ms)).toISOString() : "";
}

export type ReplySlackReads = Pick<SlackClient, "authTest" | "conversationsInfo" | "conversationsReplies" | "usersConversations" | "usersInfo">;

const FIRST_LINE_MAX = 120;

/** A message link's ts: `p1700000000123456` is `1700000000.123456`. */
const linkTs = (p: string): string | null => (/^p\d{7,}$/.test(p) ? `${p.slice(1, -6)}.${p.slice(-6)}` : null);

async function placeOf(account: AccountRecord, client: ReplySlackReads, reference: string): Promise<{ channel: string; ts: string | null }> {
  const ref = reference.trim();
  if (ref.startsWith("#")) {
    const wanted = ref.slice(1).toLowerCase();
    let cursor: string | null = null;
    do {
      const page = await client.usersConversations(cursor);
      const found = page.conversations.find((c) => c.name?.toLowerCase() === wanted);
      if (found) return { channel: found.id, ts: null };
      cursor = page.next_cursor;
    } while (cursor);
    throw new Error(`you are not in ${ref} in ${account.address}, or it does not exist: loki posts only where you are`);
  }
  if (/^[A-Z0-9]+(:\d+\.\d+)?$/.test(ref)) {
    const at = ref.indexOf(":");
    return at < 0 ? { channel: ref, ts: null } : { channel: ref.slice(0, at), ts: ref.slice(at + 1) };
  }
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    throw new Error(`${ref} is not a Slack conversation: give its id, its link, or #name`);
  }
  const own = new URL((await client.authTest()).url || "https://invalid.example").hostname.toLowerCase();
  const host = url.hostname.toLowerCase();
  // An Enterprise Grid link may carry the organisation's host rather than the workspace's.
  if (host !== own && !host.endsWith(".enterprise.slack.com")) throw new Error(`that link is not in ${account.address}, the workspace of this account`);
  const [, archives, channel = "", message = ""] = url.pathname.split("/");
  if (archives !== "archives" || !/^[A-Z0-9]+$/.test(channel)) throw new Error("that link names no conversation: give its id or #name instead");
  const thread = url.searchParams.get("thread_ts");
  const ts = thread && /^\d+\.\d+$/.test(thread) ? thread : message ? linkTs(message) : null;
  if (message && !ts) throw new Error("that link names no message: give its conversation's id or #name instead");
  return { channel, ts };
}

export async function slackReplyDestination(account: AccountRecord, client: ReplySlackReads, reference: string, flow: FlowRecord): Promise<ReplyDestination> {
  const { channel, ts } = await placeOf(account, client, reference);
  const info = await client.conversationsInfo(channel).catch((err: unknown) => {
    if (err instanceof SlackError && err.code === "channel_not_found")
      throw new Error(`there is no conversation ${channel} in ${account.address} that you can see`);
    throw err;
  });
  if (!info.is_im && !info.is_mpim && info.is_member === false)
    throw new Error(`you are not in #${info.name ?? channel} in ${account.address}: loki posts only where you are`);
  const names = new Map<string, string>();
  const name = async (user: string) => {
    let known = names.get(user);
    if (known === undefined) {
      const u = await client.usersInfo(user).catch(() => null);
      known = u ? u.display_name || u.real_name || u.name || user : user;
      names.set(user, known);
    }
    return known;
  };
  let parent: SlackMessage | null = null;
  if (ts) {
    const read = async (at: string) => (await client.conversationsReplies({ channel, ts: at, limit: 1 })).messages.at(0) ?? null;
    const first = await read(ts).catch((err: unknown) => {
      if (err instanceof SlackError && err.code === "thread_not_found") return null;
      throw err;
    });
    if (!first) throw new Error(`there is no message ${ts} in that conversation`);
    const top = first.thread_ts ?? first.ts;
    parent = top === first.ts ? first : ((await read(top)) ?? first);
  }
  const threadId = parent ? `${channel}:${parent.thread_ts ?? parent.ts}` : channel;
  const record = flow(account.account_id, threadId) ?? (info.is_im ? flow(account.account_id, channel) : null);
  const partner = info.is_im && info.user ? await name(info.user) : null;
  const conversation = info.is_im
    ? `your DM with ${partner && partner !== info.user ? partner : record?.sender || partner || "a person Slack did not name"}`
    : info.is_mpim
      ? "your group DM"
      : `#${info.name ?? channel}`;
  const line = parent ? ((await readSlackMessage(parent, { person: name })).text.split("\n").find((l) => l.trim()) ?? "").trim() : "";
  return {
    thread_id: threadId,
    subject: parent ? (line.length > FIRST_LINE_MAX ? `${line.slice(0, FIRST_LINE_MAX - 1)}…` : line) : (record?.subject_or_first_line ?? ""),
    to: [],
    cc: [],
    place: parent ? `the thread in ${conversation}` : conversation,
    in_flow: record !== null,
    shared_outside: info.is_ext_shared === true,
    heard_by: null,
  };
}
