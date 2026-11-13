import type { SlackClient, SlackMessage } from "../slack.ts";
import { readSlackMessage } from "../slack-markup.ts";
import type { ThreadMessage, ThreadText } from "./thread.ts";

/**
 * Reading Slack (plan 097, U1): a DM or an Activity thread as loki's messages, each sender by the name Slack shows.
 * One implementation, which hand-offs, Flow's cards and the owner's account tools all call.
 */

/** How many messages of a Slack DM a hand-off sends: its latest, since a DM is one long conversation. */
const DM_MESSAGES = 50;

/**
 * A Slack thread's whole text: an Activity thread (`<channel>:<ts>`) by its replies, a DM (its channel id) by its
 * latest messages, oldest first, with each person by the name Slack shows and links by their label.
 */
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
    // The account is the workspace and the person it calls as (`slack:<team>:<user>`), so a message by that user is theirs.
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

/** Who wrote a Slack message: a person by the name Slack shows, else the app that posted it. */
export async function senderOf(m: SlackMessage, name: (user: string) => Promise<string>): Promise<string> {
  if (m.user) return name(m.user);
  const username = m.raw.username;
  return typeof username === "string" && username ? username : "a Slack app";
}

/** A Slack ts as ISO time, or "" when it is not one. */
export function tsIso(ts: string): string {
  const ms = Number(ts) * 1000;
  return Number.isFinite(ms) && ms > 0 ? new Date(Math.floor(ms)).toISOString() : "";
}
