import type { AccountRecord } from "../accounts.ts";
import { JiraError, type JiraClient } from "../jira.ts";
import type { FlowRecord, ReplyDestination } from "./thread.ts";

/**
 * Reading where a Jira comment goes (plan 2026-11-14-1530, U1): any ticket of the site the person can see, named by
 * its key, its id or its link, read from Jira itself rather than from Flow's record, which once was the only way a key
 * could be found (plan 2026-11-10-1451, R28).
 */

/**
 * What reading a comment's ticket needs of the site: the ticket's facts, and the host people browse the site at when
 * it is not the API's own (a custom domain), which a link may name.
 */
export interface ReplyJiraReads extends Pick<JiraClient, "ticketFacts"> {
  linkHost(): Promise<string | null>;
}

/** A Jira site's host from its account id, `jira:<host>:<account id>`. */
const siteOf = (account: AccountRecord): string => account.account_id.split(":")[1] ?? "";

/** A ticket key as Jira writes it: a project key, a hyphen, a number. */
const KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/**
 * The ticket a reference names, as Jira is asked for it: a key in upper case, an id as given, or a link's key when the
 * link is the account's own site. Throws why for anything else, so a link to another site is never followed.
 */
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

/**
 * Where a comment goes: the ticket by its numeric id, which stays when it moves to another project (plan
 * 2026-11-10-1451, KTD7), shown by its key and title, with who Jira usually tells. A ticket Jira does not have, or the
 * person may not see, is refused.
 */
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
