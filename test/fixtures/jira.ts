/**
 * A stand-in for one Jira Cloud site, driven through an injected fetch (plan 2026-11-10-1451, U2). It keeps tickets, who
 * watches each, their fields and description (plan 089), their comments and their history, a list of fields with a
 * Sprint custom field unless `state.has_sprints` is off, and the one email and API token it accepts. Tickets may
 * carry attachments, listed under the issue's `attachment` field and served as thumbnails (plan 093). Every request is
 * recorded, so a test can say which endpoints were reached and with what, and every comment posted is kept in `posted`.
 * Switches in `state` make it answer as Jira does when the token is refused or the site asks for a wait.
 */

/** A person on the fake site. */
export interface FakeJiraPerson {
  account_id: string;
  display_name: string;
  /** The 48 px picture Jira gives under `avatarUrls`; left out, the person has none. */
  avatar?: string;
}

/** A request the fake received: its method, URL, body as text, authorization header and redirect mode. */
export interface FakeJiraRequest {
  method: string;
  url: URL;
  body: string;
  authorization: string;
  /** The fetch's `redirect` option, `follow` when it was left out, as fetch's own default. */
  redirect: RequestRedirect;
}

/** A file attached to a ticket on the fake site; its thumbnail is `thumbnail`, or a few made-up PNG bytes when left out. */
export interface FakeJiraAttachment {
  id: string;
  filename: string;
  mime_type: string;
  size: number;
  thumbnail?: Buffer;
}

/** How the fake's thumbnail route answers: as Jira does with `redirect=false`, or one of the ways it may refuse. */
export type FakeJiraThumbnailAnswer = "image" | "redirect" | "unauthorized" | "not_image" | "oversize";

/** Where a redirected thumbnail points, a media host apart from the site, as Jira's own redirect does. */
export const JIRA_MEDIA_HOST = "api.media.atlassian.com";
/** The bytes a thumbnail answers with unless its attachment names its own. */
export const JIRA_THUMBNAIL_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

/** A sprint as Jira Cloud lists it in a ticket's sprint field. */
export interface FakeJiraSprint {
  name: string;
  state: "active" | "closed" | "future";
}

/** The fields a ticket's card shows (plan 089), each left out of the answer when null. */
export interface FakeJiraFields {
  type: string | null;
  project: string | null;
  status: string | null;
  reporter: FakeJiraPerson | null;
  priority: string | null;
  labels: string[];
  sprints: FakeJiraSprint[];
  /** The description as plain text, served as a document of one paragraph per line; null for none. */
  description: string | null;
  /** The files attached to the ticket, served under the `attachment` field. */
  attachments: FakeJiraAttachment[];
}

/** The id the fake site gives its sprint field, as a real site gives a custom field. */
export const JIRA_SPRINT_FIELD = "customfield_10020";

interface StoredTicket extends FakeJiraFields {
  id: string;
  key: string;
  summary: string;
  updated: number;
  created: number;
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
const person = (p: FakeJiraPerson) => ({
  accountId: p.account_id,
  displayName: p.display_name,
  active: true,
  ...(p.avatar ? { avatarUrls: { "16x16": `${p.avatar}?s=16`, "48x48": p.avatar } } : {}),
});
const paragraphs = (text: string) => ({ version: 1, type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
/** A description's text as Jira's document: a paragraph for each line. */
const lines = (text: string) => ({
  version: 1,
  type: "doc",
  content: text.split("\n").map((t) => ({ type: "paragraph", content: [{ type: "text", text: t }] })),
});
const NO_FIELDS: FakeJiraFields = {
  type: null,
  project: null,
  status: null,
  reporter: null,
  priority: null,
  labels: [],
  sprints: [],
  description: null,
  attachments: [],
};

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
    /** Whether the site has a field named Sprint; a site without Jira Software has none. */
    has_sprints: true,
    /** One read that fails with this status: a ticket's fields (`issue`) or the site's list of fields (`field`); null for none. */
    broken: null as { read: "issue" | "field"; status: number } | null,
    /** How the thumbnail route answers; a request without `redirect=false` is redirected whatever this says, as Jira does. */
    thumbnail: "image" as FakeJiraThumbnailAnswer,
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

  /** The answer a broken read gives: Jira's refusal of the token for 401, else a failure with a message. */
  const breaks = (read: "issue" | "field"): Response | null => {
    if (state.broken?.read !== read) return null;
    if (state.broken.status === 401) return new Response("Client must be authenticated to access this resource.", { status: 401 });
    return json(state.broken.status, { errorMessages: ["Internal server error"] });
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

    const one = /^\/rest\/api\/3\/issue\/([^/]+)$/.exec(path);
    if (one && req.method === "GET") {
      const broken = breaks("issue");
      if (broken) return broken;
      const ticket = find(decodeURIComponent(one[1]));
      if (!ticket) return json(404, { errorMessages: ["Issue does not exist or you do not have permission to see it."] });
      const fields = (q.get("fields") ?? "").split(",").filter(Boolean);
      const named = (name: string | null) => (name ? { name } : null);
      const all: Record<string, unknown> = {
        summary: ticket.summary,
        updated: stamp(ticket.updated),
        created: stamp(ticket.created),
        assignee: ticket.assignee ? person(ticket.assignee) : null,
        reporter: ticket.reporter ? person(ticket.reporter) : null,
        issuetype: named(ticket.type),
        project: ticket.project ? { key: ticket.key.split("-")[0], name: ticket.project } : null,
        status: named(ticket.status),
        priority: named(ticket.priority),
        labels: ticket.labels,
        description: ticket.description === null ? null : lines(ticket.description),
        attachment: ticket.attachments.map((a) => ({
          self: `https://${host}/rest/api/3/attachment/${a.id}`,
          id: a.id,
          filename: a.filename,
          author: person(me),
          created: stamp(ticket.created),
          size: a.size,
          mimeType: a.mime_type,
          content: `https://${host}/rest/api/3/attachment/content/${a.id}`,
          ...(a.mime_type.startsWith("image/") ? { thumbnail: `https://${host}/rest/api/3/attachment/thumbnail/${a.id}` } : {}),
        })),
        ...(state.has_sprints
          ? { [JIRA_SPRINT_FIELD]: ticket.sprints.length ? ticket.sprints.map((s, i) => ({ id: i + 1, name: s.name, state: s.state, boardId: 1 })) : null }
          : {}),
      };
      return json(200, { id: ticket.id, key: ticket.key, fields: Object.fromEntries(fields.filter((f) => f in all).map((f) => [f, all[f]])) });
    }
    // Every field the person may see, a list rather than an object; a custom field's id differs from site to site.
    if (path === "/rest/api/3/field" && req.method === "GET")
      return (
        breaks("field") ??
        json(200, [
          { id: "summary", name: "Summary", custom: false },
          { id: "status", name: "Status", custom: false },
          { id: "customfield_10016", name: "Story point estimate", custom: true },
          ...(state.has_sprints ? [{ id: JIRA_SPRINT_FIELD, name: "Sprint", custom: true }] : []),
        ])
      );
    const thumb = /^\/rest\/api\/3\/attachment\/thumbnail\/([^/]+)$/.exec(path);
    if (thumb && req.method === "GET") return thumbnail(decodeURIComponent(thumb[1]), q);
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

  /** A thumbnail's answer: Jira redirects to its media host, token in the address, unless asked with `redirect=false`. */
  const thumbnail = (id: string, q: URLSearchParams): Response => {
    const file = tickets.flatMap((t) => (t.hidden ? [] : t.attachments)).find((a) => a.id === id);
    if (!file) return json(404, { errorMessages: ["The attachment does not exist."] });
    if (state.thumbnail === "redirect" || q.get("redirect") !== "false")
      return new Response(null, { status: 303, headers: { location: `https://${JIRA_MEDIA_HOST}/file/${id}/image?token=media-token` } });
    if (state.thumbnail === "unauthorized") return new Response("Client must be authenticated to access this resource.", { status: 401 });
    if (state.thumbnail === "not_image") return new Response("<html>a page</html>", { status: 200, headers: { "content-type": "text/html;charset=UTF-8" } });
    const bytes = state.thumbnail === "oversize" ? Buffer.alloc(1_000_001) : (file.thumbnail ?? JIRA_THUMBNAIL_BYTES);
    return new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": "image/png" } });
  };

  function store(ticket: StoredTicket, at: FakeJiraTime, author: FakeJiraPerson, body: unknown, id?: string): StoredComment {
    const comment = { id: id ?? String(++commentSeq), author, created: written(at), ms: instant(at), body };
    ticket.comments.push(comment);
    ticket.updated = Math.max(ticket.updated, comment.ms);
    return comment;
  }

  // A redirect is followed, as fetch follows one, unless the caller asked for `manual` or `error`, so a test sees any
  // request that would have reached another host.
  const fetchFn = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const req: FakeJiraRequest = {
      method: init?.method ?? "GET",
      url,
      body: typeof init?.body === "string" ? init.body : "",
      authorization: new Headers(init?.headers).get("authorization") ?? "",
      redirect: init?.redirect ?? "follow",
    };
    requests.push(req);
    const here = url.protocol === "https:" && (url.host === host || (state.display_url !== null && url.origin === state.display_url));
    const res = here ? site(req) : json(404, {});
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location && req.redirect === "follow") return fetchFn(location, { ...init, method: "GET", body: undefined });
    return Promise.resolve(res);
  };

  return {
    fetch: fetchFn,
    host,
    me,
    requests,
    posted,
    state,
    /** A ticket, watched by the person unless `watchers` says otherwise; `at` is when it last changed (now when left out). Returns its numeric id. */
    addTicket(
      input: { key: string; summary: string; at?: FakeJiraTime; watchers?: FakeJiraPerson[]; assignee?: FakeJiraPerson | null } & Partial<FakeJiraFields>,
    ): string {
      const id = String(++ticketSeq);
      const { key: _key, summary: _summary, at: _at, watchers: _watchers, assignee: _assignee, ...fields } = input;
      tickets.push({
        ...NO_FIELDS,
        ...fields,
        id,
        key: input.key,
        summary: input.summary,
        updated: instant(input.at ?? opts.now()),
        created: instant(input.at ?? opts.now()),
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
    /**
     * Change a ticket's title, key, assignee, watchers or other fields in place, as edits in Jira would; its update time
     * is left alone, and no history is written: `change` writes that.
     */
    edit(
      key: string,
      patch: { key?: string; summary?: string; assignee?: FakeJiraPerson | null; watchers?: FakeJiraPerson[] } & Partial<FakeJiraFields>,
    ): void {
      const ticket = must(key);
      const { key: _key, summary: _summary, assignee: _assignee, watchers: _watchers, ...fields } = patch;
      Object.assign(ticket, fields);
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
