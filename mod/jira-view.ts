import type { ThreadMessage, ThreadText } from "./handoff.ts";
import { jiraTicketUrl, type JiraClient, type JiraEvent, type JiraEventPage, type JiraEventPageOptions, type JiraSecret } from "./jira.ts";
import { eventLines } from "./jira-sync.ts";
import { VIEW_AROUND, VIEW_LOAD, type CardView } from "./slack-view.ts";

/**
 * Reading a Jira ticket (plan 2026-11-10-1451, U5): whole, oldest first, for a hand-off, and as a card's window around
 * what is new (KTD14). A ticket's events live in two lists Jira pages separately, its comments and its history, and
 * both are read from their newest end and merged by event id, which sorts by time across the two (KTD8). Nothing here
 * changes a ticket: only the reading calls are asked for.
 */

/** The calls reading a ticket makes; JiraClient has them. */
export type JiraViewClient = Pick<JiraClient, "comments" | "history">;

/** One of a ticket's two lists of events, read a page at a time. */
type EventList = (opts: JiraEventPageOptions) => Promise<JiraEventPage>;

/** The person's Atlassian id: everything after the host in `jira:<host>:<account id>`, since the id may hold colons itself. */
const personOf = (accountId: string): string => accountId.split(":").slice(2).join(":");

const byId = (a: JiraEvent, b: JiraEvent): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * A list's events from its newest end back, oldest first, until `enough` says the events read so far will do or the
 * list is read to its start; `more` says whether earlier events are left unread.
 */
async function readBack(list: EventList, enough: (events: readonly JiraEvent[]) => boolean): Promise<{ events: JiraEvent[]; more: boolean }> {
  const events: JiraEvent[] = [];
  let before: number | null = null;
  for (;;) {
    const page: JiraEventPage = await list({ before });
    events.unshift(...page.events);
    if (page.earlier === null) return { events, more: false };
    if (enough(events)) return { events, more: true };
    before = page.earlier;
  }
}

/** Both of a ticket's lists read back as far as `enough` asks of each, merged oldest first, and whether either has more before. */
async function readTicket(
  client: JiraViewClient,
  ticket: string,
  enough: (events: readonly JiraEvent[]) => boolean,
): Promise<{ events: JiraEvent[]; more: boolean }> {
  const [comments, history] = await Promise.all([
    readBack((opts) => client.comments(ticket, opts), enough),
    readBack((opts) => client.history(ticket, opts), enough),
  ]);
  return { events: [...comments.events, ...history.events].sort(byId), more: comments.more || history.more };
}

/** An event as a card or a hand-off shows it: who made it, when, its text as plain lines (KTD15), and whether it is the person's. */
function messageOf(event: JiraEvent, me: string, extra: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: event.id,
    sender: event.author.display_name || "someone",
    at: event.created,
    text: eventLines(event).join("\n"),
    mine: event.author.account_id === me,
    ...extra,
  };
}

/** A ticket's whole text, oldest first, for a hand-off and the owner's tools: every comment and history entry. */
export function jiraThreadText(client: (accountId: string) => JiraViewClient): ThreadText {
  return async (accountId, threadId) => {
    const me = personOf(accountId);
    const { events } = await readTicket(client(accountId), threadId, () => false);
    return events.map((e) => messageOf(e, me));
  };
}

/**
 * A Jira card's window (KTD14): the events after the card's dealt mark, or with no mark the events that brought it, with
 * the 5 before them, and 20 more before an event when the card asks. Each list is read back only until it holds 5 (or
 * 20) events before that point, which is all the window can need of it. An event is new when it is someone else's and
 * comes after the dealt mark, or with no mark when it brought the card; ids are compared as text, so an event deleted
 * in Jira never shifts the mark (R12). The window says the ticket's address in the browser, on the site's own domain
 * when it has one (R14), from the account's keychain entry.
 */
export function jiraCardView(client: (accountId: string) => JiraViewClient, secret: (accountId: string) => Promise<JiraSecret | null>): CardView {
  return async (accountId, threadId, facts, ask) => {
    const me = personOf(accountId);
    const mark = facts.dealt_message_id;
    const brought = new Set(facts.brought_ids);
    const isNew = (e: JiraEvent) => e.author.account_id !== me && (mark !== null ? e.id > mark : brought.has(e.id));
    const draw = (e: JiraEvent) => messageOf(e, me, { ...(isNew(e) ? { unread: true } : {}), ...(brought.has(e.id) ? { brought: true } : {}) });
    const kept = await secret(accountId);
    const link = kept && facts.place ? { link: jiraTicketUrl(kept, facts.place) } : {};
    const { shown, moreBefore } = await jiraViewOf(client(accountId), threadId, mark, facts.brought_ids, ask);
    return { messages: shown.map(draw), window: { view: "channel", thread_ts: null, more_before: moreBefore, more_after: false }, ...link };
  };
}

/**
 * Which events a window shows. A load before an event gives the 20 before it; one after gives none, since a window
 * always runs to the newest event. The opening window starts 5 before the first event after the mark (or the first
 * that brought the card), and with neither ends on the newest event and the 5 before it.
 */
async function jiraViewOf(
  client: JiraViewClient,
  ticket: string,
  mark: string | null,
  broughtIds: readonly string[],
  ask: { direction?: "before" | "after"; from?: string },
): Promise<{ shown: JiraEvent[]; moreBefore: boolean }> {
  if (ask.direction === "after") return { shown: [], moreBefore: false };
  if (ask.direction === "before" && ask.from) {
    const from = ask.from;
    const { events, more } = await readTicket(client, ticket, (read) => read.filter((e) => e.id < from).length >= VIEW_LOAD);
    const earlier = events.filter((e) => e.id < from);
    return { shown: earlier.slice(-VIEW_LOAD), moreBefore: more || earlier.length > VIEW_LOAD };
  }
  const firstBrought = [...broughtIds].sort().at(0) ?? null;
  // Before the window's anchor: at or before the mark, else before what brought the card; with neither, everything is.
  const old = (e: JiraEvent) => (mark !== null ? e.id <= mark : firstBrought !== null ? e.id < firstBrought : true);
  const { events, more } = await readTicket(client, ticket, (read) => read.filter(old).length >= VIEW_AROUND);
  const anchor = events.findIndex((e) => !old(e));
  const start = Math.max(0, (anchor < 0 ? events.length - 1 : anchor) - VIEW_AROUND);
  return { shown: events.slice(start), moreBefore: more || start > 0 };
}
