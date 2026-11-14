import type { MailFile, SlackAttachment, SlackBlock, SlackFile, SlackReaction } from "../../core/frame-types.ts";

/**
 * A thread as loki reads it from an account (plan 097, U1): the shape every reader returns, whatever the service, and
 * that hand-offs, Flow's cards and the owner's tools all take.
 */

/** One message of a thread as the hand-off sends it: who wrote it, when (ISO), and its text. */
export interface ThreadMessage {
  sender: string;
  at: string;
  text: string;
  /** Whether the account's own person wrote it (plan 068), so the card can mark it; absent when the reader cannot tell. */
  mine?: boolean;
  /** The message's own id in its service (Gmail's id, Slack's ts), so the card can key it; absent when unknown. */
  id?: string;
  /** The rest of what a card draws of a Slack message (plan 074); a hand-off's reader leaves them out. */
  avatar?: string;
  in_thread?: boolean;
  unread?: boolean;
  replies?: number;
  more_after?: boolean;
  /** A Slack message read the way Slack draws it, and what an app attached to it (plan 075). */
  body?: SlackBlock[];
  attachments?: SlackAttachment[];
  /** What a Slack card's window marks on a message (plan 077). */
  brought?: boolean;
  /** A Jira comment that mentions the person, which its card draws with the mention look (plan 091). */
  mentions_me?: boolean;
  new_replies?: number | true;
  /** A Slack message's reactions (plan 079) and the files shared in it (plan 080). */
  reactions?: SlackReaction[];
  slack_files?: SlackFile[];
  /**
   * A mail's HTML part as its sender wrote it, for the person's own card to draw (it never goes to a model); absent for
   * Slack, for mail with no HTML part, and for one larger than MAIL_HTML_MAX, which the card shows as text instead.
   */
  html?: string;
  /** A mail's To and Cc headers and its files (plan 078), for the person's card; a hand-off's text leaves them out. */
  to?: string;
  cc?: string;
  files?: MailFile[];
}

/** The largest HTML part, in characters, the card is given to draw; a larger one is shown as its text. */
export const MAIL_HTML_MAX = 512 * 1024;

/** A thread's whole text from its account, oldest first; one reader per service. */
export type ThreadText = (accountId: string, threadId: string) => Promise<ThreadMessage[]>;

/**
 * Where a reply lands, read from its service when the agent proposes it (plan 2026-11-14-1530, KTD2): what the card
 * shows so the person sees the service's own words, never only the agent's. The thread id is the one Flow keys the
 * thread by (Gmail's thread id, Slack's DM channel or `<channel>:<thread ts>`, Jira's numeric issue id), so the reply
 * goes where the card said whatever the agent typed.
 */
export interface ReplyDestination {
  thread_id: string;
  /** The mail's subject with one "Re:", a Slack thread's first line, a Jira ticket's title; "" when there is none. */
  subject: string;
  /** Gmail: whom reply all reaches and copies; empty for Slack and Jira. */
  to: string[];
  cc: string[];
  /** Slack: the conversation in words ("#ops", "the thread in your DM with Grace Lee"); Jira: the ticket's key. */
  place: string | null;
  /** Whether the thread has a record in Flow; a reply where it has none says so on its card (R10). */
  in_flow: boolean;
  /** Slack: whether people outside the workspace are in the conversation (R10). */
  shared_outside: boolean;
  /** Jira: who Jira usually tells of a comment, and whether a service desk's customer sees it (R10). */
  heard_by: JiraHeardBy | null;
}

/** Who Jira usually tells of a comment on a ticket: its assignee and reporter by name, and its watchers by count. */
export interface JiraHeardBy {
  assignee: string | null;
  reporter: string | null;
  watchers: number;
  /** A service desk's ticket, whose customer sees a comment posted as this one is. */
  customer_sees: boolean;
}

/**
 * What a reader knows of Flow's record of a thread: only that it is there, and the names it lends where the service
 * has not answered (KTD2). A record never decides where a reply goes.
 */
export type FlowRecord = (accountId: string, threadId: string) => { sender: string; subject_or_first_line: string } | null;
