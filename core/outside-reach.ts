import type { OutsideReach } from "./frame-types.ts";
import type { MailTraits } from "./mail-filter.ts";

/**
 * How directly a card is meant for the person (plan 073), on one scale for Slack, mail and chats: 1 needs them (a DM, a
 * mail to them, a chat that asked them), 2 names them, 3 is their own work coming back, 4 names a group, 5 is everyone,
 * 6 is a machine. The card's tag shows it; only level 1 takes the attention colour, and 5 and 6 are muted.
 */
export type ReachLevel = 1 | 2 | 3 | 4 | 5 | 6;

/** Each reach's level on the scale. */
export const REACH_LEVEL: Record<OutsideReach, ReachLevel> = {
  dm: 1,
  to_you: 1,
  mention: 2,
  thread: 3,
  group: 4,
  not_to_you: 4,
  channel: 5,
  list: 5,
  automated: 6,
};

/** Each reach in the tag's words, lowercase as desktop chips are. */
export const REACH_LABEL: Record<OutsideReach, string> = {
  dm: "direct",
  to_you: "to you",
  mention: "mentioned you",
  thread: "your thread",
  group: "your group",
  not_to_you: "not to you",
  channel: "@channel",
  list: "list",
  automated: "automated",
};

/**
 * A mail's reach from its traits (plan 069). A machine's or a list's mail reads as that even when it is addressed to
 * the person, since a bill or a newsletter to them is still not someone asking.
 */
export function mailReach(traits: MailTraits | null): OutsideReach | null {
  if (!traits) return null;
  if (traits.automated) return "automated";
  if (traits.list) return "list";
  return traits.to_you ? "to_you" : "not_to_you";
}

/** The Slack Activity kinds a card is made of, as reaches. */
const SLACK_KINDS: Partial<Record<string, OutsideReach>> = {
  at_user: "mention",
  thread_v2: "thread",
  at_user_group: "group",
  at_channel: "channel",
  at_everyone: "channel",
};

/** A Slack card's reach: a DM, else the most direct of the Activity kinds it came from; null when none is known. */
export function slackReach(dm: boolean, kinds: readonly string[]): OutsideReach | null {
  if (dm) return "dm";
  let best: OutsideReach | null = null;
  for (const k of kinds) {
    const r = SLACK_KINDS[k];
    if (r && (!best || REACH_LEVEL[r] < REACH_LEVEL[best])) best = r;
  }
  return best;
}
