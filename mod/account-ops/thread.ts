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
