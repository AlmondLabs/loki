import { messageOf as errorText } from "../core/errors.ts";
import type { JiraCardTicket, JiraFieldChange, SlackFile } from "../core/frame-types.ts";
import type { ThreadMessage, ThreadText } from "./account-ops/thread.ts";
import {
  JiraError,
  jiraPersonOf,
  jiraTicketUrl,
  type JiraAttachment,
  type JiraClient,
  type JiraEvent,
  type JiraEventPage,
  type JiraEventPageOptions,
  type JiraIssue,
  type JiraSecret,
} from "./jira.ts";
import { eventLines } from "./jira-sync.ts";
import { adfBlocks, adfFiles, adfText, type JiraFileRef } from "./jira-text.ts";
import { log } from "./log.ts";
import { VIEW_AROUND, VIEW_LOAD, type CardView } from "./slack-view.ts";

export type JiraTextClient = Pick<JiraClient, "issue" | "comments" | "history">;

export type JiraViewClient = JiraTextClient & Pick<JiraClient, "attachments">;

export type JiraPreview = (accountId: string, attachmentId: string) => Promise<string | null>;

function kindOf(filename: string): string | null {
  return /\.([a-z0-9]{1,5})$/i.exec(filename)?.[1]?.toUpperCase() ?? null;
}

async function fileOf(
  ref: JiraFileRef,
  attachments: readonly JiraAttachment[],
  places: { site: string | null; ticket: string | null },
  preview: (attachmentId: string) => Promise<string | null>,
): Promise<SlackFile> {
  if (ref.type === "external" && ref.url) return { name: ref.name ?? ref.url, kind: null, size: null, link: ref.url };
  const named = ref.name ? attachments.filter((a) => a.filename === ref.name) : [];
  const a = named.length === 1 ? named[0] : null;
  if (!a || !places.site) return { name: ref.name ?? "attachment", kind: null, size: null, link: places.ticket };
  const file: SlackFile = {
    name: a.filename,
    kind: kindOf(a.filename),
    size: a.size || null,
    link: `https://${places.site}/rest/api/3/attachment/content/${encodeURIComponent(a.id)}`,
  };
  if (!a.mime_type.startsWith("image/") || ref.width === null || ref.height === null) return file;
  const name = await preview(a.id);
  return name ? { ...file, preview: { name, width: ref.width, height: ref.height } } : file;
}

function unreadAttachments(err: unknown): JiraAttachment[] {
  if (err instanceof JiraError && err.code === "rejected") throw err;
  log("jira:attachments-unread", { error: errorText(err) });
  return [];
}

type EventList = (opts: JiraEventPageOptions) => Promise<JiraEventPage>;

type ReadEvents = (enough: (events: readonly JiraEvent[]) => boolean) => Promise<{ events: JiraEvent[]; more: boolean; total: number }>;

const byId = (a: JiraEvent, b: JiraEvent): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const SHOWN = new Set(["status", "assignee", "reporter", "priority", "Sprint", "labels", "issuetype", "project", "summary", "description"]);

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

function commentLook(event: JiraEvent, me: string): Partial<ThreadMessage> {
  const face = event.author.avatar ? { avatar: event.author.avatar } : {};
  if (event.kind !== "comment") return face;
  return {
    ...face,
    body: adfBlocks(event.body),
    ...(me && adfText(event.body).mentions.includes(me) ? { mentions_me: true } : {}),
  };
}

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

export function jiraThreadText(client: (accountId: string) => JiraTextClient): ThreadText {
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

export function jiraCardView(
  client: (accountId: string) => JiraViewClient,
  secret: (accountId: string) => Promise<JiraSecret | null>,
  preview: JiraPreview = () => Promise.resolve(null),
): CardView {
  return async (accountId, threadId, facts, ask) => {
    const me = jiraPersonOf(accountId);
    const mark = facts.dealt_message_id;
    const brought = new Set(facts.brought_ids);
    const isNew = (e: JiraEvent) => e.author.account_id !== me && (mark !== null ? e.id > mark : brought.has(e.id));
    const draw = (e: JiraEvent) =>
      messageOf(e, me, { ...(isNew(e) ? { unread: true } : {}), ...(brought.has(e.id) ? { brought: true } : {}), ...commentLook(e, me) });
    const c = client(accountId);
    const comments: ReadEvents = (enough) => readBack((opts) => c.comments(threadId, opts), enough);
    const merged: ReadEvents = (enough) => readTicket(c, threadId, enough);
    const opening = ask.ticket === true && !ask.direction;
    const [kept, read, ticket] = await Promise.all([
      secret(accountId),
      windowOf(ask.ticket === true ? comments : merged, mark, facts.brought_ids, ask),
      opening ? ticketOf(c, threadId, me, mark, facts.brought_ids, isNew).catch(unreadTicket) : null,
    ]);
    const { shown, moreBefore } = opening && !ticket ? await windowOf(merged, mark, facts.brought_ids, ask) : read;
    const ticketUrl = kept && facts.place ? jiraTicketUrl(kept, facts.place) : null;
    const link = ticketUrl ? { link: ticketUrl } : {};
    const refs = new Map(shown.map((e) => [e.id, e.kind === "comment" ? adfFiles(e.body) : []]));
    const attachments = [...refs.values()].some((r) => r.length) ? await c.attachments(threadId).catch(unreadAttachments) : [];
    const places = { site: kept?.site ?? null, ticket: ticketUrl };
    const messages = await Promise.all(
      shown.map(async (e) => {
        const files = refs.get(e.id) ?? [];
        if (!files.length) return draw(e);
        const slackFiles = await Promise.all(files.map((ref) => fileOf(ref, attachments, places, (id) => preview(accountId, id))));
        return { ...draw(e), slack_files: slackFiles };
      }),
    );
    return {
      messages,
      window: { view: "channel", thread_ts: null, more_before: moreBefore, more_after: false },
      ...link,
      ...(ticket ? { ticket: { ...ticket, comment_count: read.total } } : {}),
    };
  };
}

function unreadTicket(err: unknown): null {
  if (err instanceof JiraError && err.code === "rejected") throw err;
  log("jira:ticket-unread", { error: errorText(err) });
  return null;
}

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
  const old = (e: JiraEvent) => (mark !== null ? e.id <= mark : firstBrought !== null ? e.id < firstBrought : true);
  const { events, more, total } = await read((got) => got.filter(old).length >= VIEW_AROUND);
  const anchor = events.findIndex((e) => !old(e));
  const start = Math.max(0, (anchor < 0 ? events.length - 1 : anchor) - VIEW_AROUND);
  return { shown: events.slice(start), moreBefore: more || start > 0, total };
}

function setAsNewest<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
}

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
  const runs = new Map<string, JiraFieldChange>();
  for (const event of history.events) {
    if (event.kind !== "history") continue;
    for (const item of event.items) {
      const run = runs.get(item.field);
      if (event.author.account_id === me) runs.delete(item.field);
      if (event.author.account_id === me || !isNew(event)) continue;
      setAsNewest(runs, item.field, {
        field: item.field,
        from: run ? run.from : item.from,
        to: item.to,
        by: event.author.display_name || "someone",
        at: event.created,
      });
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
