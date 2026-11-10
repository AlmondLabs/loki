import type { JiraCardTicket, JiraFieldChange } from "../core/frame-types.ts";
import type { ThreadMessage, ThreadText } from "./handoff.ts";
import {
  jiraPersonOf,
  jiraTicketUrl,
  type JiraClient,
  type JiraEvent,
  type JiraEventPage,
  type JiraEventPageOptions,
  type JiraIssue,
  type JiraSecret,
} from "./jira.ts";
import { eventLines } from "./jira-sync.ts";
import { adfText } from "./jira-text.ts";
import { VIEW_AROUND, VIEW_LOAD, type CardView } from "./slack-view.ts";

/**
 * Reading a Jira ticket (plan 2026-11-10-1451, U5; plan 089): whole for a hand-off, its fields and description first,
 * then its comments, then its field history; and on a card as the ticket itself, with its comments as the card's
 * messages in a window around what is new (KTD14). A ticket's comments and history are two lists Jira pages
 * separately, each read from its newest end. Nothing here changes a ticket: only the reading calls are asked for.
 */

/** The calls reading a ticket makes; JiraClient has them. */
export type JiraViewClient = Pick<JiraClient, "issue" | "comments" | "history">;

/** One of a ticket's two lists of events, read a page at a time. */
type EventList = (opts: JiraEventPageOptions) => Promise<JiraEventPage>;

/**
 * The parts of a ticket its card shows, by the names Jira's history gives them (plan 089, Decision 2): the fields, the
 * header's type and project, the title and the description. A change to any other field is "also changed".
 */
const SHOWN = new Set(["status", "assignee", "reporter", "priority", "Sprint", "labels", "issuetype", "project", "summary", "description"]);

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

/**
 * A ticket's own text for a hand-off and the owner's tools: its key and summary, each field it has, and its
 * description, as from its reporter at the time it was made.
 */
function ticketMessage(issue: JiraIssue): ThreadMessage {
  const fields: Array<[string, string | null]> = [
    ["type", issue.type],
    ["project", issue.project],
    ["status", issue.status],
    ["assignee", issue.assignee],
    ["reporter", issue.reporter],
    ["priority", issue.priority],
    ["sprint", issue.sprint],
    ["labels", issue.labels.length ? issue.labels.join(", ") : null],
  ];
  const description = adfText(issue.description).lines;
  return {
    sender: issue.reporter ?? "someone",
    at: issue.created,
    text: [
      `${issue.key}: ${issue.summary}`,
      ...fields.flatMap(([name, value]) => (value ? [`${name}: ${value}`] : [])),
      ...(description.length ? ["", "description:", ...description] : []),
    ].join("\n"),
  };
}

/** A ticket's whole text for a hand-off and the owner's tools: the ticket itself, then every comment, then every history entry, oldest first. */
export function jiraThreadText(client: (accountId: string) => JiraViewClient): ThreadText {
  return async (accountId, threadId) => {
    const me = jiraPersonOf(accountId);
    const c = client(accountId);
    const [issue, comments, history] = await Promise.all([
      c.issue(threadId),
      readBack(
        (opts) => c.comments(threadId, opts),
        () => false,
      ),
      readBack(
        (opts) => c.history(threadId, opts),
        () => false,
      ),
    ]);
    return [ticketMessage(issue), ...comments.events.map((e) => messageOf(e, me)), ...history.events.map((e) => messageOf(e, me))];
  };
}

/**
 * A Jira card's window (KTD14, plan 089): the comments after the card's dealt mark, or with no mark the comments that
 * brought it, with the 5 before them, and 20 more before a comment when the card asks. A comment is new when it is
 * someone else's and comes after the dealt mark, or with no mark when it brought the card; ids are compared as text,
 * so a comment deleted in Jira never shifts the mark (R12). The opening window also carries the ticket, its fields
 * marked by the changes that are new by the same rule; a load of earlier comments does not, since the card has it.
 * The window says the ticket's address in the browser, on the site's own domain when it has one (R14), from the
 * account's keychain entry.
 */
export function jiraCardView(client: (accountId: string) => JiraViewClient, secret: (accountId: string) => Promise<JiraSecret | null>): CardView {
  return async (accountId, threadId, facts, ask) => {
    const me = jiraPersonOf(accountId);
    const mark = facts.dealt_message_id;
    const brought = new Set(facts.brought_ids);
    const isNew = (e: JiraEvent) => e.author.account_id !== me && (mark !== null ? e.id > mark : brought.has(e.id));
    const draw = (e: JiraEvent) => messageOf(e, me, { ...(isNew(e) ? { unread: true } : {}), ...(brought.has(e.id) ? { brought: true } : {}) });
    const c = client(accountId);
    const [kept, { shown, moreBefore }, ticket] = await Promise.all([
      secret(accountId),
      commentsOf(c, threadId, mark, facts.brought_ids, ask),
      ask.direction ? null : ticketOf(c, threadId, me, mark, facts.brought_ids, isNew),
    ]);
    const link = kept && facts.place ? { link: jiraTicketUrl(kept, facts.place) } : {};
    return {
      messages: shown.map(draw),
      window: { view: "channel", thread_ts: null, more_before: moreBefore, more_after: false },
      ...link,
      ...(ticket ? { ticket } : {}),
    };
  };
}

/**
 * Which comments a window shows. A load before a comment gives the 20 before it; one after gives none, since a window
 * always runs to the newest comment. The opening window starts 5 before the first comment after the mark (or the
 * first that brought the card), and with neither ends on the newest comment and the 5 before it.
 */
async function commentsOf(
  client: JiraViewClient,
  ticket: string,
  mark: string | null,
  broughtIds: readonly string[],
  ask: { direction?: "before" | "after"; from?: string },
): Promise<{ shown: JiraEvent[]; moreBefore: boolean }> {
  const list: EventList = (opts) => client.comments(ticket, opts);
  if (ask.direction === "after") return { shown: [], moreBefore: false };
  if (ask.direction === "before" && ask.from) {
    const from = ask.from;
    const { events, more } = await readBack(list, (read) => read.filter((e) => e.id < from).length >= VIEW_LOAD);
    const earlier = events.filter((e) => e.id < from);
    return { shown: earlier.slice(-VIEW_LOAD), moreBefore: more || earlier.length > VIEW_LOAD };
  }
  const firstBrought = [...broughtIds].sort().at(0) ?? null;
  // Before the window's anchor: at or before the mark, else before what brought the card; with neither, everything is.
  const old = (e: JiraEvent) => (mark !== null ? e.id <= mark : firstBrought !== null ? e.id < firstBrought : true);
  const { events, more } = await readBack(list, (read) => read.filter(old).length >= VIEW_AROUND);
  const anchor = events.findIndex((e) => !old(e));
  const start = Math.max(0, (anchor < 0 ? events.length - 1 : anchor) - VIEW_AROUND);
  return { shown: events.slice(start), moreBefore: more || start > 0 };
}

/**
 * The ticket as its card shows it (plan 089): its fields and description, and what someone else changed since the
 * dealt mark. The history is read back only to the mark (or to what first brought the card), which is all that can be
 * new. For each field, the newest change that `isNew` is kept, with what the field was before the first of a run of
 * them; a change by the person ends the run, since they made the field what it is or saw it when they did.
 */
async function ticketOf(
  client: JiraViewClient,
  ticket: string,
  me: string,
  mark: string | null,
  broughtIds: readonly string[],
  isNew: (e: JiraEvent) => boolean,
): Promise<JiraCardTicket> {
  const firstBrought = [...broughtIds].sort().at(0) ?? null;
  const since = (e: JiraEvent) => (mark !== null ? e.id > mark : firstBrought !== null && e.id >= firstBrought);
  const [issue, history] = await Promise.all([
    client.issue(ticket),
    readBack(
      (opts) => client.history(ticket, opts),
      (read) => read.some((e) => !since(e)),
    ),
  ]);
  // A Map keeps the order entries were set in, so taking a field out before setting it again orders by newest change.
  const runs = new Map<string, JiraFieldChange>();
  for (const event of history.events) {
    if (event.kind !== "history") continue;
    for (const item of event.items) {
      const run = runs.get(item.field);
      if (event.author.account_id === me) runs.delete(item.field);
      if (event.author.account_id === me || !isNew(event)) continue;
      runs.delete(item.field);
      runs.set(item.field, { field: item.field, from: run ? run.from : item.from, to: item.to, by: event.author.display_name || "someone", at: event.created });
    }
  }
  const changes = [...runs.values()];
  return {
    key: issue.key,
    summary: issue.summary,
    type: issue.type,
    project: issue.project,
    fields: { status: issue.status, assignee: issue.assignee, reporter: issue.reporter, priority: issue.priority, sprint: issue.sprint, labels: issue.labels },
    description: adfText(issue.description).lines,
    changed: changes.filter((c) => SHOWN.has(c.field)).map((c) => (c.field === "description" ? { ...c, from: null, to: null } : c)),
    also_changed: changes.filter((c) => !SHOWN.has(c.field)).map(({ field, by, at }) => ({ field, by, at })),
  };
}
