import type { OutsideReach } from "./frame-types.ts";
import type { MailTraits } from "./mail-filter.ts";

export type ReachLevel = 1 | 2 | 3 | 4 | 5 | 6;

export const REACH_LEVEL: Record<OutsideReach, ReachLevel> = {
  dm: 1,
  to_you: 1,
  mention: 2,
  thread: 3,
  assigned: 3,
  group: 4,
  not_to_you: 4,
  watching: 4,
  channel: 5,
  list: 5,
  automated: 6,
};

export const REACH_LABEL: Record<OutsideReach, string> = {
  dm: "direct",
  to_you: "to you",
  mention: "mentioned you",
  thread: "your thread",
  assigned: "assigned to you",
  group: "your group",
  not_to_you: "not to you",
  watching: "watching",
  channel: "@channel",
  list: "list",
  automated: "automated",
};

export function mailReach(traits: MailTraits | null): OutsideReach | null {
  if (!traits) return null;
  if (traits.automated) return "automated";
  if (traits.list) return "list";
  return traits.to_you ? "to_you" : "not_to_you";
}

const SLACK_KINDS: Partial<Record<string, OutsideReach>> = {
  at_user: "mention",
  thread_v2: "thread",
  at_user_group: "group",
  at_channel: "channel",
  at_everyone: "channel",
};

export function slackReach(dm: boolean, kinds: readonly string[]): OutsideReach | null {
  if (dm) return "dm";
  let best: OutsideReach | null = null;
  for (const k of kinds) {
    const r = SLACK_KINDS[k];
    if (r && (!best || REACH_LEVEL[r] < REACH_LEVEL[best])) best = r;
  }
  return best;
}
