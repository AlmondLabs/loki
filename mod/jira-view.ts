import { messageOf as errorText } from "../core/errors.ts";
import type { JiraCardTicket, JiraFieldChange } from "../core/frame-types.ts";
import type { ThreadMessage, ThreadText } from "./handoff.ts";
import {
  JiraError,
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
import { log } from "./log.ts";
import { VIEW_AROUND, VIEW_LOAD, type CardView } from "./slack-view.ts";

/**
 * Reading a Jira ticket (plan 2026-11-10-1451, U5; plan 089): whole for a hand-off, its fields and description first,
 * then its comments, then its field history; and on a card, in a window around what is new (KTD14), either as the
 * ticket itself with its comments as the card's messages, when the app asks for the ticket, or as one log of comments
 * and field changes merged by event id, which sorts by time across the two (KTD8), for an app older than plan 089 or
 * when the ticket's fields cannot be read. A ticket's comments and history are two lists Jira pages separately, each
 * read from its newest end. Nothing here changes a ticket: only the reading calls are asked for.
 */

/** The calls reading a ticket makes; JiraClient has them. */
export type JiraViewClient = Pick<JiraClient, "issue" | "comments" | "history">;

/** One of a ticket's two lists of events, read a page at a time. */
type EventList = (opts: JiraEventPageOptions) => Promise<JiraEventPage>;

/** Events read back from the newest end until `enough` says they will do: oldest first, whether more are left, and how many there are in all. */
type ReadEvents = (enough: (events: readonly JiraEvent[]) => boolean) => Promise<{ events: JiraEvent[]; more: boolean; total: number }>;

const byId = (a: JiraEvent, b: JiraEvent): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The parts of a ticket its card shows, by the names Jira's history gives them (plan 089, Decision 2): the fields, the
 * header's type and project, the title and the description. A change to any other field is "also changed".
 */
const SHOWN = new Set(["status", "assignee", "reporter", "priority", "Sprint", "labels", "issuetype", "project", "summary", "description"]);

/**
 * A list's events from its newest end back, oldest first, until `enough` says the events read so far will do or the
 * list is read to its start; `more` says whether earlier events are left unread.
 */
async function readBack(list: EventList, enough: (events: readonly JiraEvent[]) => boolean): Promise<{ events: JiraEvent[]; more: boolean; total: number }> {
  const events: JiraEvent[] = [];
  let before: number | null = null;
  for (;;) {
    const page: JiraEventPage = await list({ before });
    events.unshift(...page.events);
    if (page.earlier === null) return { events, more: false, total: page.total };
    if (enough(events)) return { events, more: true, total: page.total };
    before = page.earlier;
  }
}

/** Both of a ticket's lists read back as far as `enough` asks of each, merged oldest first, and whether either has more before. */
async function readTicket(
  client: JiraViewClient,
  ticket: string,
  enough: (events: readonly JiraEvent[]) => boolean,
): Promise<{ events: JiraEvent[]; more: boolean; total: number }> {
  const [comments, history] = await Promise.all([
    readBack((opts) => client.comments(ticket, opts), enough),
    readBack((opts) => client.history(ticket, opts), enough),
  ]);
  return { events: [...comments.events, ...history.events].sort(byId), more: comments.more || history.more, total: comments.total + history.total };
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
 * A Jira card's window (KTD14, plan 089): the events after the card's dealt mark, or with no mark the events that
 * brought it, with the 5 before them, and 20 more before an event when the card asks. An event is new when it is
 * someone else's and comes after the dealt mark, or with no mark when it brought the card; ids are compared as text,
 * so an event deleted in Jira never shifts the mark (R12). When the app asks for the ticket, the events are the
 * comments alone and the opening window also carries the ticket, its fields marked by the changes that are new by the
 * same rule; a load of earlier comments does not, since the card has it. When it does not ask, as an app older than
 * plan 089 does not, or the ticket's fields or the site's list of fields cannot be read, the events are the comments
 * and the field changes together, so every change still shows; a refused token fails the read, as any read does. The
 * window says the ticket's address in the browser, on the site's own domain when it has one (R14), from the account's
 * keychain entry.
 */
export function jiraCardView(client: (accountId: string) => JiraViewClient, secret: (accountId: string) => Promise<JiraSecret | null>): CardView {
  return async (accountId, threadId, facts, ask) => {
    const me = jiraPersonOf(accountId);
    const mark = facts.dealt_message_id;
    const brought = new Set(facts.brought_ids);
    const isNew = (e: JiraEvent) => e.author.account_id !== me && (mark !== null ? e.id > mark : brought.has(e.id));
    const draw = (e: JiraEvent) => messageOf(e, me, { ...(isNew(e) ? { unread: true } : {}), ...(brought.has(e.id) ? { brought: true } : {}) });
    const c = client(accountId);
    const comments: ReadEvents = (enough) => readBack((opts) => c.comments(threadId, opts), enough);
    const merged: ReadEvents = (enough) => readTicket(c, threadId, enough);
    const opening = ask.ticket === true && !ask.direction;
    const [kept, read, ticket] = await Promise.all([
      secret(accountId),
      windowOf(ask.ticket === true ? comments : merged, mark, facts.brought_ids, ask),
      opening ? ticketOf(c, threadId, me, mark, facts.brought_ids, isNew).catch(unreadTicket) : null,
    ]);
    // The ticket could not be read: its comments alone would hide its changes, so the card gets the one log instead.
    const { shown, moreBefore } = opening && !ticket ? await windowOf(merged, mark, facts.brought_ids, ask) : read;
    const link = kept && facts.place ? { link: jiraTicketUrl(kept, facts.place) } : {};
    return {
      messages: shown.map(draw),
      window: { view: "channel", thread_ts: null, more_before: moreBefore, more_after: false },
      ...link,
      ...(ticket ? { ticket: { ...ticket, comment_count: read.total } } : {}),
    };
  };
}

/**
 * A ticket whose fields could not be read is left off its card, which shows the one log instead; a refused token is
 * not, since only reconnecting helps and the read says so.
 */
function unreadTicket(err: unknown): null {
  if (err instanceof JiraError && err.code === "rejected") throw err;
  log("jira:ticket-unread", { error: errorText(err) });
  return null;
}

/**
 * Which events a window shows, from `read`: the comments alone, or the comments and field changes merged. A load
 * before an event gives the 20 before it; one after gives none, since a window always runs to the newest event. The
 * opening window starts 5 before the first event after the mark (or the first that brought the card), and with
 * neither ends on the newest event and the 5 before it. Each list is read back only as far as the window can need.
 */
async function windowOf(
  read: ReadEvents,
  mark: string | null,
  broughtIds: readonly string[],
  ask: { direction?: "before" | "after"; from?: string },
): Promise<{ shown: JiraEvent[]; moreBefore: boolean; total: number }> {
  if (ask.direction === "after") return { shown: [], moreBefore: false, total: 0 };
  if (ask.direction === "before" && ask.from) {
    const from = ask.from;
    const { events, more, total } = await read((got) => got.filter((e) => e.id < from).length >= VIEW_LOAD);
    const earlier = events.filter((e) => e.id < from);
    return { shown: earlier.slice(-VIEW_LOAD), moreBefore: more || earlier.length > VIEW_LOAD, total };
  }
  const firstBrought = [...broughtIds].sort().at(0) ?? null;
  // Before the window's anchor: at or before the mark, else before what brought the card; with neither, everything is.
  const old = (e: JiraEvent) => (mark !== null ? e.id <= mark : firstBrought !== null ? e.id < firstBrought : true);
  const { events, more, total } = await read((got) => got.filter(old).length >= VIEW_AROUND);
  const anchor = events.findIndex((e) => !old(e));
  const start = Math.max(0, (anchor < 0 ? events.length - 1 : anchor) - VIEW_AROUND);
  return { shown: events.slice(start), moreBefore: more || start > 0, total };
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
): Promise<Omit<JiraCardTicket, "comment_count">> {
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
