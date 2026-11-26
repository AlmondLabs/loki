import type { AccountDisconnectCause, AccountProvider, OutsideFacts, OutsideSeed } from "../../../core/frame-types.ts";
import type { CardMark } from "./card-head";
import { senderName } from "./mail-thread";

const SERVICE: Record<AccountProvider, string> = { gmail: "Gmail", slack: "Slack", jira: "Jira" };

export function mendLabel(cause: AccountDisconnectCause, provider: AccountProvider): string | null {
  if (cause === "temporarily_failing") return null;
  if (cause === "sign_in_again") return provider === "jira" ? "Add Token…" : "Sign In…";
  return "Connect Again…";
}

export function disconnectedText(cause: AccountDisconnectCause, provider: AccountProvider): string {
  const service = SERVICE[provider];
  const where = "Preferences › Accounts";
  switch (cause) {
    case "sign_in_again":
      return `${service} wants a new ${provider === "jira" ? "API token" : "sign-in"}: ${where}`;
    case "admin_blocks":
      return `a workspace admin blocks loki in ${service}: ask them, then connect again in ${where}`;
    case "slack_signed_out":
      return `the Slack app signed out: sign in there, then connect again in ${where}`;
    case "temporarily_failing":
      return `${service} keeps failing for now: loki tries again on its own`;
  }
}

export function outsideWho(o: OutsideFacts): string {
  return [o.account_label, SERVICE[o.provider], o.owner_name ?? "its agent"].join(" · ");
}

export function outsideTitle(o: OutsideFacts): string {
  switch (o.provider) {
    case "gmail":
      return o.subject || "No subject";
    case "slack":
      return senderName(o.sender);
    case "jira":
      return ticketLine(o);
  }
}

export function ticketLine(o: Pick<OutsideFacts, "place" | "subject">): string {
  return [o.place, o.subject].filter(Boolean).join(" · ");
}

export function ticketAddress(o: OutsideFacts, link: string | null = null): string | null {
  if (o.provider !== "jira") return null;
  return link ?? (o.place ? `https://${o.account_label}/browse/${encodeURIComponent(o.place)}` : null);
}

export function replyPlace(o: OutsideFacts, inThread = false): string {
  switch (o.provider) {
    case "gmail":
      return "Reply to all";
    case "slack":
      return inThread || o.thread_id.includes(":") ? "Reply in the thread" : "Reply in the DM";
    case "jira":
      return "Comment on the ticket";
  }
}

export function freshSeeds(seeds: readonly OutsideSeed[] | undefined, taken: readonly string[]): OutsideSeed[] {
  return (seeds ?? []).filter((s) => !taken.includes(s.id));
}

export function withSeeds(text: string, seeds: readonly OutsideSeed[]): string {
  return [text.trimEnd(), ...seeds.map((s) => s.text)].filter(Boolean).join("\n\n");
}

export const SEND_TITLE: Record<AccountProvider, string> = {
  gmail: "Send it as you; the card stays for your next move",
  slack: "Send it as you; the card stays for your next move",
  jira: "Post it on the ticket as you; the card stays, unread, for your next move",
};

export const SEND_NOTE: Record<AccountProvider, string> = {
  gmail: "Waits 10 seconds so you can undo. The card stays for your next swipe.",
  slack: "Sends as you. The card stays for your next swipe.",
  jira: "Posts on the ticket as you. The card stays until you read it.",
};

export const MARK: Record<AccountProvider, CardMark> = { gmail: "mail", slack: "slack", jira: "jira" };

export const CAME_FROM: Record<AccountProvider, string> = {
  gmail: "The mailbox it came to",
  slack: "The workspace it came from",
  jira: "The site it came from",
};

export const LATER_TITLE: Record<AccountProvider, string> = {
  gmail: "Keep it unread in Gmail: the card comes back in a day, or sooner if something new arrives",
  slack: "Keep it unread in Slack: the card comes back in a day, or sooner if something new arrives",
  jira: "Keep it unread: the card comes back in a day, or sooner if the ticket changes",
};

export const READ_TITLE: Record<AccountProvider, string> = {
  gmail: "Mark it read in Gmail: the card rests and comes back later",
  slack: "Mark it read in Slack: the card ends until someone writes again",
  jira: "Done reading: the card ends until the ticket changes again; nothing changes in Jira",
};

export const ARCHIVE_TITLE: Record<AccountProvider, string | null> = {
  gmail: "Done with this thread: it leaves Flow and is archived in Gmail",
  slack: "Done with this thread: it leaves Flow and is marked read in Slack",
  jira: null,
};

export const HANDOFF_TITLE: Record<AccountProvider, (owner: string) => string> = {
  gmail: (owner) => `Give the whole thread to ${owner} in one of its chats; the card leaves until someone writes again`,
  slack: (owner) => `Give the whole thread to ${owner} in one of its chats; the card leaves until someone writes again`,
  jira: (owner) => `Give the whole ticket to ${owner} in one of its chats; the card stays until you read it`,
};
