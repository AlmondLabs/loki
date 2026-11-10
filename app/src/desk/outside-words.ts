import type { AccountDisconnectCause, AccountProvider, OutsideFacts, OutsideSeed } from "../../../core/frame-types.ts";
import type { CardMark } from "./card-head";
import { senderName } from "./mail-thread";

/**
 * The words an outside card says for each service (plan 067): its title, where a reply goes, what each move does, and
 * a Jira ticket's line, address and approved comments. Kept apart from `outside-card`, which draws them, so a service's
 * words are read in one place.
 */

/** The service's own name, as the card's meta and notices say it. */
const SERVICE: Record<AccountProvider, string> = { gmail: "Gmail", slack: "Slack", jira: "Jira" };

/** What a disconnected account's cards say (R22): what happened and how to reconnect, lowercase as desktop meta. */
export function disconnectedText(cause: AccountDisconnectCause, provider: AccountProvider): string {
  const service = SERVICE[provider];
  const where = "Preferences › Accounts";
  switch (cause) {
    case "sign_in_again":
      // A Jira site is connected with an API token the person makes, so there is no sign-in to make again.
      return `${service} wants a new ${provider === "jira" ? "API token" : "sign-in"}: ${where}`;
    case "admin_blocks":
      return `a workspace admin blocks loki in ${service}: ask them, then connect again in ${where}`;
    case "slack_signed_out":
      return `the Slack app signed out: sign in there, then connect again in ${where}`;
    case "temporarily_failing":
      return `${service} keeps failing for now: loki tries again on its own`;
  }
}

/** The account and its owner, as the card names them: "ada@acme.com · Gmail · Work". */
export function outsideWho(o: OutsideFacts): string {
  return [o.account_label, SERVICE[o.provider], o.owner_name ?? "its agent"].join(" · ");
}

/**
 * The card's title: a mail's subject; for Slack, who wrote, since a Slack message has no subject of its own; for Jira,
 * the ticket's key and title.
 */
export function outsideTitle(o: OutsideFacts): string {
  switch (o.provider) {
    case "gmail":
      return o.subject || "no subject";
    case "slack":
      return senderName(o.sender);
    case "jira":
      return ticketLine(o);
  }
}

/** A Jira ticket as its card names it: "OPS-7 · Rotate the keys". */
export function ticketLine(o: Pick<OutsideFacts, "place" | "subject">): string {
  return [o.place, o.subject].filter(Boolean).join(" · ");
}

/**
 * A Jira ticket's address in the browser (R14): as its site's Mac read it, on the site's own domain, else on the
 * account's host until the read comes back; null for mail and Slack.
 */
export function ticketAddress(o: OutsideFacts, link: string | null = null): string | null {
  if (o.provider !== "jira") return null;
  return link ?? (o.place ? `https://${o.account_label}/browse/${encodeURIComponent(o.place)}` : null);
}

/** Where the person's reply goes, in words: reply-all in a mail thread, the DM or a Slack thread, or a comment on the ticket. */
export function replyPlace(o: OutsideFacts): string {
  switch (o.provider) {
    case "gmail":
      return "reply to all";
    case "slack":
      return o.thread_id.includes(":") ? "reply in the thread" : "reply in the DM";
    case "jira":
      return "comment on the ticket";
  }
}

/**
 * The comments the person approved for a Jira card that its box has not taken in yet (plan 2026-11-10-1451, KTD18): a
 * box takes each seed once, by its proposal's id, so one already there is never added again.
 */
export function freshSeeds(seeds: readonly OutsideSeed[] | undefined, taken: readonly string[]): OutsideSeed[] {
  return (seeds ?? []).filter((s) => !taken.includes(s.id));
}

/** The box's text with approved comments added after whatever is already there, each after a blank line. */
export function withSeeds(text: string, seeds: readonly OutsideSeed[]): string {
  return [text.trimEnd(), ...seeds.map((s) => s.text)].filter(Boolean).join("\n\n");
}

/** What the desktop's send button says it does, for each service: a Jira comment leaves the card unread (KTD11). */
export const SEND_TITLE: Record<AccountProvider, string> = {
  gmail: "send it as you; the card stays for your next move",
  slack: "send it as you; the card stays for your next move",
  jira: "post it on the ticket as you; the card stays, unread, for your next move",
};

/** The line under the phone's send, for each service. */
export const SEND_NOTE: Record<AccountProvider, string> = {
  gmail: "Waits 10 seconds so you can undo. The card stays for your next swipe.",
  slack: "Sends as you. The card stays for your next swipe.",
  jira: "Posts on the ticket as you. The card stays until you read it.",
};

/** The mark on a card's face for where it came from. */
export const MARK: Record<AccountProvider, CardMark> = { gmail: "mail", slack: "slack", jira: "jira" };

/** What the header's second line names first: a mail's sender, a Slack channel or DM, or a Jira ticket's key and title. */
export function headWhat(facts: OutsideFacts): string | null {
  switch (facts.provider) {
    case "gmail":
      return senderName(facts.sender);
    case "slack":
      return facts.place ?? (facts.reach === "dm" ? "direct message" : null);
    case "jira":
      return ticketLine(facts) || null;
  }
}

/** Where a card came from, as the header says it when more than one account of its service is connected. */
export const CAME_FROM: Record<AccountProvider, string> = {
  gmail: "the mailbox it came to",
  slack: "the workspace it came from",
  jira: "the site it came from",
};

/** What later says it does, for each service: Jira keeps no read mark, so nothing changes there (R20). */
export const LATER_TITLE: Record<AccountProvider, string> = {
  gmail: "keep it unread in Gmail: the card comes back in a day, or sooner if something new arrives",
  slack: "keep it unread in Slack: the card comes back in a day, or sooner if something new arrives",
  jira: "keep it unread: the card comes back in a day, or sooner if the ticket changes",
};

/** What read says it does, for each service. */
export const READ_TITLE: Record<AccountProvider, string> = {
  gmail: "mark it read in Gmail: the card rests and comes back later",
  slack: "mark it read in Slack: the card ends until someone writes again",
  jira: "done reading: the card ends until the ticket changes again; nothing changes in Jira",
};

/**
 * What archive says it does, for each service; null where there is no archive: a Jira card ends only with read, so it
 * draws none (KTD12).
 */
export const ARCHIVE_TITLE: Record<AccountProvider, string | null> = {
  gmail: "done with this thread: it leaves the Inbox and is archived in Gmail",
  slack: "done with this thread: it leaves the Inbox and is marked read in Slack",
  jira: null,
};

/** What hand off says it does, for each service: a mail or a Slack card leaves with it, and a Jira card stays (KTD13). */
export const HANDOFF_TITLE: Record<AccountProvider, (owner: string) => string> = {
  gmail: (owner) => `give the whole thread to ${owner} in one of its chats; the card leaves until someone writes again`,
  slack: (owner) => `give the whole thread to ${owner} in one of its chats; the card leaves until someone writes again`,
  jira: (owner) => `give the whole ticket to ${owner} in one of its chats; the card stays until you read it`,
};
