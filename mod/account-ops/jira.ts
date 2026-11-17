import type { AccountRecord } from "../accounts.ts";
import { JiraError, type JiraClient } from "../jira.ts";
import type { FlowRecord, ReplyDestination } from "./thread.ts";

export interface ReplyJiraReads extends Pick<JiraClient, "ticketFacts"> {
  linkHost(): Promise<string | null>;
}

const siteOf = (account: AccountRecord): string => account.account_id.split(":")[1] ?? "";

const KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

async function ticketOf(account: AccountRecord, client: ReplyJiraReads, reference: string): Promise<string> {
  const ref = reference.trim();
  if (KEY.test(ref)) return ref.toUpperCase();
  if (/^\d+$/.test(ref)) return ref;
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    throw new Error(`${ref} is not a ticket: give its key (OPS-12), its id, or its link`);
  }
  const site = siteOf(account);
  const linkHost = await client.linkHost().catch(() => null);
  const host = url.hostname.toLowerCase();
  if (host !== site.toLowerCase() && host !== linkHost?.toLowerCase()) throw new Error(`that link is not on ${site}, the site of this account`);
  const key = /\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)/.exec(url.pathname)?.[1] ?? url.searchParams.get("selectedIssue") ?? "";
  if (!KEY.test(key)) throw new Error("that link names no ticket: give its key (OPS-12) instead");
  return key.toUpperCase();
}

export async function jiraReplyDestination(account: AccountRecord, client: ReplyJiraReads, reference: string, flow: FlowRecord): Promise<ReplyDestination> {
  const ticket = await ticketOf(account, client, reference);
  const facts = await client.ticketFacts(ticket).catch((err: unknown) => {
    if (err instanceof JiraError && err.status === 404) throw new Error(`there is no ticket ${ticket} on ${siteOf(account)} that you can see`);
    throw err;
  });
  return {
    thread_id: facts.id,
    subject: facts.summary,
    to: [],
    cc: [],
    place: facts.key,
    in_flow: flow(account.account_id, facts.id) !== null,
    shared_outside: false,
    heard_by: { assignee: facts.assignee, reporter: facts.reporter, watchers: facts.watchers, customer_sees: facts.service_desk },
  };
}
