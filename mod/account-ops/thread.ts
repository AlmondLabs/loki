import type { MailFile, ReplyHeardBy, SlackAttachment, SlackBlock, SlackFile, SlackReaction } from "../../core/frame-types.ts";

export interface ThreadMessage {
  sender: string;
  at: string;
  text: string;
  mine?: boolean;
  id?: string;
  avatar?: string;
  in_thread?: boolean;
  unread?: boolean;
  replies?: number;
  more_after?: boolean;
  body?: SlackBlock[];
  attachments?: SlackAttachment[];
  brought?: boolean;
  mentions_me?: boolean;
  new_replies?: number | true;
  reactions?: SlackReaction[];
  slack_files?: SlackFile[];
  html?: string;
  inline_images?: Record<string, string>;
  to?: string;
  cc?: string;
  files?: MailFile[];
}

export const MAIL_HTML_MAX = 512 * 1024;

export type ThreadText = (accountId: string, threadId: string) => Promise<ThreadMessage[]>;

export interface ReplyDestination {
  thread_id: string;
  subject: string;
  to: string[];
  cc: string[];
  place: string | null;
  in_flow: boolean;
  shared_outside: boolean;
  heard_by: ReplyHeardBy | null;
}

export type FlowRecord = (accountId: string, threadId: string) => { sender: string; subject_or_first_line: string } | null;
