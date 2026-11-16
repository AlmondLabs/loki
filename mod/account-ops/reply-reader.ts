import type { AccountRecord } from "../accounts.ts";
import { gmailReplyDestination, type ReplyGmailReads } from "./gmail.ts";
import { jiraReplyDestination, type ReplyJiraReads } from "./jira.ts";
import { slackReplyDestination, type ReplySlackReads } from "./slack.ts";
import type { FlowRecord, ReplyDestination } from "./thread.ts";

export type ReplyReads =
  { provider: "gmail"; client: ReplyGmailReads } | { provider: "slack"; client: ReplySlackReads } | { provider: "jira"; client: ReplyJiraReads };

export function readReplyDestination(account: AccountRecord, reads: ReplyReads, reference: string, flow: FlowRecord): Promise<ReplyDestination> {
  switch (reads.provider) {
    case "gmail":
      return gmailReplyDestination(account, reads.client, reference, flow);
    case "slack":
      return slackReplyDestination(account, reads.client, reference, flow);
    case "jira":
      return jiraReplyDestination(account, reads.client, reference, flow);
  }
}
