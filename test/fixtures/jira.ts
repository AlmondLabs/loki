/**
 * A stand-in for one Jira Cloud site, driven through an injected fetch (plan 2026-11-10-1451, U2). It keeps tickets, who
 * watches each, their comments and their history, and the one email and API token it accepts. Every request is
 * recorded, so a test can say which endpoints were reached and with what, and every comment posted is kept in `posted`.
 * Switches in `state` make it answer as Jira does when the token is refused or the site asks for a wait.
 */

/** A person on the fake site. */
export interface FakeJiraPerson {
  account_id: string;
  display_name: string;
}

/** A request the fake received: its method, URL, body as text and authorization header. */
export interface FakeJiraRequest {
  method: string;
  url: URL;
  body: string;
  authorization: string;
}

/** When something happened: a Date, or the text Jira would give (`2026-11-10T19:35:27.259+0530`), served as written. */
export type FakeJiraTime = Date | string;

/** One changed field of a history entry, by the values Jira shows. */
export interface FakeJiraChange {
  field: string;
  from: string | null;
  to: string | null;
}

interface StoredComment {
  id: string;
  author: FakeJiraPerson;
  created: string;
  ms: number;
  body: unknown;
}

interface StoredHistory {
  id: string;
  author: FakeJiraPerson;
  created: string;
  ms: number;
  items: FakeJiraChange[];
}

interface StoredTicket {
  id: string;
  key: string;
  summary: string;
  updated: number;
  assignee: FakeJiraPerson | null;
  watchers: Set<string>;
  hidden: boolean;
  comments: StoredComment[];
  history: StoredHistory[];
}

/** The person the accepted token belongs to. */
export const JIRA_ME: FakeJiraPerson = { account_id: "acc-me", display_name: "Mina Example" };
/** Someone else on the site. */
export const JIRA_ADA: FakeJiraPerson = { account_id: "acc-ada", display_name: "Ada Lovelace" };
/** A second someone else. */
export const JIRA_BOB: FakeJiraPerson = { account_id: "acc-bob", display_name: "Bob Stone" };

/** A time as Jira writes it: milliseconds, then an offset without a colon. */
const stamp = (ms: number) => new Date(ms).toISOString().replace("Z", "+0000");
/** The instant a time names; Jira's offset has no colon, which Date.parse is not promised to read. */
const instant = (at: FakeJiraTime) => (at instanceof Date ? at.getTime() : Date.parse(at.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")));
const written = (at: FakeJiraTime) => (at instanceof Date ? stamp(at.getTime()) : at);
const person = (p: FakeJiraPerson) => ({ accountId: p.account_id, displayName: p.display_name, active: true });
const paragraphs = (text: string) => ({ version: 1, type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

/** One Jira Cloud site with one signed-in person, on the test's clock. */
export function fakeJira(opts: { now: () => Date; host?: string; email?: string; token?: string; me?: FakeJiraPerson }) {
  const host = opts.host ?? "acme.atlassian.net";
  const me = opts.me ?? JIRA_ME;
  const tickets: StoredTicket[] = [];
  const requests: FakeJiraRequest[] = [];
  /** Every comment posted through the API, in order: the ticket's key, the new comment's id and the document sent. */
  const posted: Array<{ key: string; id: string; body: unknown }> = [];
  const state = {
    /** The email and token the site accepts; change the token to make the one in use stop working. */
    email: opts.email ?? "mina@example.com",
    token: opts.token ?? "fixture-jira-token",
    /** Every call is refused with 401, as for a revoked token. */
    unauthorized: false,
    /** Every call answers 200 with an empty body and Jira's failed-login header. */
    failed_login: false,
    /** The profile answers 200 as an anonymous visitor, with no account id. */
    profile_without_id: false,
    /** Every call answers 429 asking for this many seconds' wait; null for no limit. */
    retry_after: null as number | null,
    /** The name of the list in a history answer: Jira's reference shows both. */
    history_list: "values" as "values" | "histories",
    /** The address people browse the site at, when it has a custom domain. */
    display_url: null as string | null,
  };
  let ticketSeq = 10000;
  let commentSeq = 30000;
  let historySeq = 50000;

  const json = (status: number, value: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
  const find = (idOrKey: string) => tickets.find((t) => !t.hidden && (t.id === idOrKey || t.key === idOrKey));
  const must = (key: string) => {
    const t = tickets.find((x) => x.key === key);
    if (!t) throw new Error(`the fake Jira has no ticket ${key}`);
    return t;
  };
  const commentJson = (c: StoredComment) => ({ id: c.id, author: person(c.author), body: c.body, created: c.created, updated: c.created });
  const historyJson = (h: StoredHistory) => ({
    id: h.id,
    author: person(h.author),
    created: h.created,
    items: h.items.map((i) => ({ field: i.field, fieldtype: "jira", from: null, fromString: i.from, to: null, toString: i.to })),
  });
  const byTime = <T extends { ms: number; id: string }>(events: T[]) => [...events].sort((a, b) => a.ms - b.ms || Number(a.id) - Number(b.id));
  const slice = <T>(all: T[], q: URLSearchParams, fallback: number) => {
    const startAt = Number(q.get("startAt") ?? "0");
    const maxResults = Number(q.get("maxResults") ?? String(fallback));
    return { startAt, maxResults, total: all.length, page: all.slice(startAt, startAt + maxResults) };
  };

  const search = (q: URLSearchParams): Response => {
    const jql = /^watcher = currentUser\(\)(?: AND updated >= -(\d+)m)? ORDER BY updated (ASC|DESC)$/.exec(q.get("jql") ?? "");
    if (!jql) return json(400, { errorMessages: [`the fake Jira does not read this JQL: ${q.get("jql") ?? ""}`] });
    const since = jql[1] ? opts.now().getTime() - Number(jql[1]) * 60_000 : null;
    const direction = jql[2] === "ASC" ? 1 : -1;
    const found = tickets
      .filter((t) => !t.hidden && t.watchers.has(me.account_id) && (since === null || t.updated >= since))
      .sort((a, b) => direction * (a.updated - b.updated));
    const from = Number(q.get("nextPageToken") ?? "0");
    const size = Number(q.get("maxResults") ?? "50");
    // Jira returns only the id unless fields are named.
    const fields = (q.get("fields") ?? "").split(",").filter(Boolean);
    const all: Record<string, (t: StoredTicket) => unknown> = {
      summary: (t) => t.summary,
      updated: (t) => stamp(t.updated),
      assignee: (t) => (t.assignee ? person(t.assignee) : null),
    };
    const issues = found.slice(from, from + size).map((t) => ({
      id: t.id,
      key: t.key,
      fields: Object.fromEntries(fields.filter((f) => f in all).map((f) => [f, all[f](t)])),
    }));
    const isLast = from + size >= found.length;
    return json(200, { issues, isLast, ...(isLast ? {} : { nextPageToken: String(from + size) }) });
  };

  const site = (req: FakeJiraRequest): Response => {
    const path = req.url.pathname;
    const q = req.url.searchParams;
    // The site says where it lives to anyone, signed in or not.
    if (path === "/rest/api/3/serverInfo" && req.method === "GET")
      return json(200, { baseUrl: `https://${host}`, displayUrl: state.display_url ?? `https://${host}`, deploymentType: "Cloud" });
    if (state.retry_after !== null) return json(429, {}, { "retry-after": String(state.retry_after) });
    if (state.failed_login) return new Response("", { status: 200, headers: { "x-seraph-loginreason": "AUTHENTICATED_FAILED" } });
    const expected = `Basic ${Buffer.from(`${state.email}:${state.token}`).toString("base64")}`;
    if (state.unauthorized || req.authorization !== expected) return new Response("Client must be authenticated to access this resource.", { status: 401 });

    if (path === "/rest/api/3/myself" && req.method === "GET")
      return json(200, state.profile_without_id ? {} : { ...person(me), emailAddress: state.email, timeZone: "Asia/Kolkata" });
    // The search Jira retired in 2025.
    if (path === "/rest/api/3/search") return json(410, { errorMessages: ["The requested API has been removed. Please migrate to /rest/api/3/search/jql."] });
    if (path === "/rest/api/3/search/jql" && req.method === "GET") return search(q);

    const issue = /^\/rest\/api\/3\/issue\/([^/]+)\/(comment|changelog)$/.exec(path);
    if (issue) {
      const ticket = find(decodeURIComponent(issue[1]));
      // Jira hides a ticket the person may not see behind the same answer as one that is not there.
      if (!ticket) return json(404, { errorMessages: ["Issue does not exist or you do not have permission to see it."] });
      if (issue[2] === "changelog" && req.method === "GET") {
        const { page, ...paging } = slice(byTime(ticket.history), q, 100);
        return json(200, { ...paging, isLast: paging.startAt + page.length >= paging.total, [state.history_list]: page.map(historyJson) });
      }
      if (issue[2] === "comment" && req.method === "GET") {
        const { page, ...paging } = slice(byTime(ticket.comments), q, 100);
        return json(200, { ...paging, comments: page.map(commentJson) });
      }
      if (issue[2] === "comment" && req.method === "POST") {
        const sent = JSON.parse(req.body) as { body?: { type?: unknown } };
        if (sent.body?.type !== "doc") return json(400, { errorMessages: ["Comment body is not valid!"] });
        const comment = store(ticket, opts.now(), me, sent.body);
        posted.push({ key: ticket.key, id: comment.id, body: sent.body });
        return json(201, commentJson(comment));
      }
    }
    return json(404, { errorMessages: ["Not Found"] });
  };

  function store(ticket: StoredTicket, at: FakeJiraTime, author: FakeJiraPerson, body: unknown, id?: string): StoredComment {
    const comment = { id: id ?? String(++commentSeq), author, created: written(at), ms: instant(at), body };
    ticket.comments.push(comment);
    ticket.updated = Math.max(ticket.updated, comment.ms);
    return comment;
  }

  const fetchFn = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const req: FakeJiraRequest = {
      method: init?.method ?? "GET",
      url,
      body: typeof init?.body === "string" ? init.body : "",
      authorization: new Headers(init?.headers).get("authorization") ?? "",
    };
    requests.push(req);
    const here = url.protocol === "https:" && (url.host === host || (state.display_url !== null && url.origin === state.display_url));
    return Promise.resolve(here ? site(req) : json(404, {}));
  };

  return {
    fetch: fetchFn,
    host,
    me,
    requests,
    posted,
    state,
    /** A ticket, watched by the person unless `watchers` says otherwise; `at` is when it last changed (now when left out). Returns its numeric id. */
    addTicket(input: { key: string; summary: string; at?: FakeJiraTime; watchers?: FakeJiraPerson[]; assignee?: FakeJiraPerson | null }): string {
      const id = String(++ticketSeq);
      tickets.push({
        id,
        key: input.key,
        summary: input.summary,
        updated: instant(input.at ?? opts.now()),
        assignee: input.assignee ?? null,
        watchers: new Set((input.watchers ?? [me]).map((p) => p.account_id)),
        hidden: false,
        comments: [],
        history: [],
      });
      return id;
    },
    /** Someone comments on a ticket at a time: plain `text`, or a whole document as `body`. Returns the comment's id. */
    comment(key: string, input: { at: FakeJiraTime; author: FakeJiraPerson; text?: string; body?: unknown; id?: string }): string {
      return store(must(key), input.at, input.author, input.body ?? paragraphs(input.text ?? ""), input.id).id;
    },
    /** Someone changes fields of a ticket at a time: one history entry with an item per field. Returns the entry's id. */
    change(key: string, input: { at: FakeJiraTime; author: FakeJiraPerson; items: FakeJiraChange[]; id?: string }): string {
      const ticket = must(key);
      const entry = { id: input.id ?? String(++historySeq), author: input.author, created: written(input.at), ms: instant(input.at), items: input.items };
      ticket.history.push(entry);
      ticket.updated = Math.max(ticket.updated, entry.ms);
      return entry.id;
    },
    /** Change a ticket's title, key, assignee or watchers in place, as edits in Jira would; its update time is left alone. */
    edit(key: string, patch: { key?: string; summary?: string; assignee?: FakeJiraPerson | null; watchers?: FakeJiraPerson[] }): void {
      const ticket = must(key);
      if (patch.key !== undefined) ticket.key = patch.key;
      if (patch.summary !== undefined) ticket.summary = patch.summary;
      if (patch.assignee !== undefined) ticket.assignee = patch.assignee;
      if (patch.watchers !== undefined) ticket.watchers = new Set(patch.watchers.map((p) => p.account_id));
    },
    /** The person loses sight of a ticket: it answers "not found" and leaves the search. */
    hide(key: string): void {
      must(key).hidden = true;
    },
    /** Requests that could change something on the site: every one that is not a GET. */
    writes: () => requests.filter((r) => r.method !== "GET"),
  };
}
