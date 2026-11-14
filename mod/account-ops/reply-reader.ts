import type { AccountRecord } from "../accounts.ts";
import { gmailReplyDestination, type ReplyGmailReads } from "./gmail.ts";
import { jiraReplyDestination, type ReplyJiraReads } from "./jira.ts";
import { slackReplyDestination, type ReplySlackReads } from "./slack.ts";
import type { FlowRecord, ReplyDestination } from "./thread.ts";

/**
 * Reading where a reply goes (plan 2026-11-14-1530, U1, KTD2): an account's client for its service's reads, the one a
 * reply's reader needs. A new provider is a new arm here, and `readReplyDestination` then fails to compile until it has
 * a reader.
 */
export type ReplyReads =
  { provider: "gmail"; client: ReplyGmailReads } | { provider: "slack"; client: ReplySlackReads } | { provider: "jira"; client: ReplyJiraReads };

/**
 * Where a reply in one of an account's threads lands, read from the service: the agent's reference (an id, a key, a
 * link, a `#channel`) checked and turned into the thread Flow would key it by, with what the card shows of it. Throws
 * why when the service does not know the thread, or it belongs to another site or workspace (R6).
 */
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
