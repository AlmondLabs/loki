import type { AccountStatus } from "../core/frame-types.ts";
import type { Accounts } from "./accounts.ts";
import { textToAdf } from "./jira-text.ts";
import type { JiraHistoryItem } from "./jira-text.ts";
import { log } from "./log.ts";

/**
 * A thin Jira Cloud client over fetch for one connected site (plan 2026-11-10-1451, U2), calling as the person with
 * their email and a classic API token as basic auth against the site's own API host (KTD3). It reads who the token
 * belongs to, where the site lives, the tickets the person watches, and a ticket's fields, comments and history, and it posts
 * the person's own comment. Nothing else here can change a ticket (R20): `postComment` is the only request that is not
 * a GET, and no agent tool is given it.
 *
 * Every call goes through one wrapper that tells three answers apart (KTD5). Jira rejecting the token marks the
 * account as needing a new one (R3). A rate limit holds every call back for as long as Jira asks and is never a
 * rejection. Anything else is a failed call, and a ticket the person cannot see is a failure of that ticket alone.
 */

/** What an account's keychain entry holds for Jira: the site's API host, and the email and API token to call it with. */
export interface JiraSecret {
  /** The host calls go to, as in `acme.atlassian.net`. */
  site: string;
  email: string;
  token: string;
  /**
   * The host people browse the site at, as in `jira.acme.example`, kept only when it differs from `site` (a custom
   * domain), so a card's link opens the address the person knows. An entry from before it was kept has none.
   */
  link_host?: string;
}

/** A Jira account's keychain entry read back, or null when there is none or it is not one: then only connecting again helps. */
export function parseJiraSecret(raw: string | null): JiraSecret | null {
  if (!raw) return null;
  try {
    const r = rec(JSON.parse(raw) as unknown);
    if (!(str(r.site) && str(r.email) && str(r.token))) return null;
    return { site: str(r.site), email: str(r.email), token: str(r.token), ...(str(r.link_host) ? { link_host: str(r.link_host) } : {}) };
  } catch {
    return null;
  }
}

/**
 * The person's Atlassian id in a Jira account's id: everything after the host in `jira:<host>:<account id>`, since the
 * id may hold colons itself. One place reads it, so a change to the account id's shape cannot miss a copy.
 */
export function jiraPersonOf(accountId: string): string {
  return accountId.split(":").slice(2).join(":");
}

/** A ticket's address in the browser (R14): on the site's own domain when it has one, else on its API host. */
export function jiraTicketUrl(secret: Pick<JiraSecret, "site" | "link_host">, key: string): string {
  return `https://${secret.link_host ?? secret.site}/browse/${encodeURIComponent(key)}`;
}

/** Jira's header, on an answer of any status, when it did not accept the credentials: some calls answer 200 with it. */
const LOGIN_REASON_HEADER = "x-seraph-loginreason";
const LOGIN_FAILED = "AUTHENTICATED_FAILED";
/** How long to hold back after a rate limit that names no wait. */
const DEFAULT_RETRY_MS = 60_000;
const TIMEOUT_MS = 20_000;
/** How many tickets a search page asks for unless told. */
const SEARCH_PAGE = 50;
/** How many comments or history entries a page asks for unless told. */
const EVENT_PAGE = 50;
/** The fields a search asks for by name: Jira returns only the id otherwise. */
const SEARCH_FIELDS = "summary,updated,assignee";
/** The fields a card shows of a ticket (plan 089, Decision 2), asked for by name; the site's sprint field is added to them. */
const ISSUE_FIELDS = "summary,issuetype,project,status,assignee,reporter,priority,labels,description,created";
/** The name a Jira site gives its sprint field, whose id differs from site to site. */
const SPRINT_NAME = "Sprint";
/** The digits a Jira id is padded to inside an event id, so ids compare as text the way their numbers do. */
const ID_DIGITS = 12;

/**
 * A Jira call that failed. `code` says how: `rejected` (Jira did not accept the token), `rate_limited` (Jira asked for
 * a wait), `not_found` (the ticket is gone or the person may not see it), or `http_<status>` for anything else.
 */
export class JiraError extends Error {
  readonly code: string;
  /** The HTTP status Jira answered with; 0 when no request was made. */
  readonly status: number;
  /** For `rate_limited`: how long is left of the wait Jira asked for. */
  readonly retryAfterMs: number | null;

  constructor(message: string, code: string, status: number, retryAfterMs: number | null = null) {
    super(message);
    this.name = "JiraError";
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** What JiraClient is built from; fetch and the clock are injected so tests own them. */
export interface JiraClientOptions {
  /** The site, email and token to call with, read for each call so a reconnect's new token is used; null when none is kept. */
  secret: () => Promise<JiraSecret | null>;
  /** Tell the account its status changed: here only ever to `{ disconnected: "sign_in_again" }`, each time Jira rejects the token. */
  setStatus: (status: AccountStatus) => void;
  fetch?: typeof fetch;
  now?: () => Date;
}

/** Who the token belongs to, as Jira's profile reports it. */
export interface JiraIdentity {
  account_id: string;
  display_name: string;
  /** Null when the person's privacy settings hide it. */
  email: string | null;
}

/** Where a site lives: the address its API answers at, and the one people browse, which differ on a custom domain. */
export interface JiraServerInfo {
  base_url: string;
  display_url: string;
}

/** A watched ticket as the search returns it. */
export interface JiraTicket {
  /** Jira's numeric id, which stays the same when the ticket moves to another project. */
  id: string;
  key: string;
  summary: string;
  /** When the ticket last changed, in UTC to the millisecond. */
  updated: string;
  assignee_account_id: string | null;
}

/**
 * A ticket's fields as its card shows them (plan 089): the header's type and project, the fixed set of fields, and the
 * description as Jira's document, for `adfText` to read. A field the ticket does not have is null, or empty for labels.
 */
export interface JiraIssue {
  id: string;
  key: string;
  summary: string;
  type: string | null;
  project: string | null;
  status: string | null;
  assignee: string | null;
  reporter: string | null;
  priority: string | null;
  /** The sprint the ticket is in: its active one, else the last it was put in; null on a site without a sprint field. */
  sprint: string | null;
  labels: string[];
  /** The description as Jira's document; null when it has none. */
  description: unknown;
  /** When the ticket was made, in UTC to the millisecond. */
  created: string;
}

/** One page of watched tickets, and the token that asks for the next; null on the last page. */
export interface JiraTicketPage {
  tickets: JiraTicket[];
  next_page_token: string | null;
}

/** Someone who wrote a comment or changed a ticket. */
export interface JiraPerson {
  account_id: string;
  display_name: string;
  /**
   * Their picture: the 48 px one of Jira's `avatarUrls`, which the card draws as Slack draws a photo (plan 091); absent
   * when Jira gave none or one that is not a web address.
   */
  avatar?: string;
}

/**
 * Something that happened on a ticket: a comment, or a history entry of changed fields (KTD8). `id` is the creation
 * time in UTC to the millisecond, then `c` or `h`, then Jira's id padded with zeros, so ids compare as text in the
 * order the events happened, comments and history together.
 */
export type JiraEvent = {
  id: string;
  /** Jira's own id for the comment or the history entry. */
  jira_id: string;
  /** When it was made, in UTC to the millisecond. */
  created: string;
  author: JiraPerson;
} & (
  | {
      kind: "comment";
      /** The comment as Jira's document, for `adfText` to read. */
      body: unknown;
    }
  | { kind: "history"; items: JiraHistoryItem[] }
);

/** A page of a ticket's comments or history, oldest first, and what to pass as `before` for the page before it; null at the start. */
export interface JiraEventPage {
  events: JiraEvent[];
  earlier: number | null;
  /** How many the whole list holds, as Jira counts it. */
  total: number;
}

/** Which page of events to read: `limit` of them, ending just before position `before`, or at the newest when it is left out. */
export interface JiraEventPageOptions {
  limit?: number;
  before?: number | null;
}

const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);

/**
 * A time Jira gave (`2026-11-10T19:35:27.259+0530`) in UTC to the millisecond, so times from people in different zones
 * compare as text. Jira writes the offset without a colon, which a date parser is not promised to read. A time that
 * does not parse is returned as given.
 */
export function jiraTime(value: string): string {
  const ms = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
}

/** The id of a comment (`c`) or a history entry (`h`) made at `created`, which sorts by time and then by Jira's id (KTD8). */
export function jiraEventId(created: string, kind: "c" | "h", jiraId: string): string {
  return `${jiraTime(created)}:${kind}${jiraId.padStart(ID_DIGITS, "0")}`;
}

/** Someone as Jira gives them: their id, their name, and their 48 px picture when it is a web address (plan 091). */
function parsePerson(v: unknown): JiraPerson {
  const r = rec(v);
  const avatar = str(rec(r.avatarUrls)["48x48"]);
  return { account_id: str(r.accountId), display_name: str(r.displayName), ...(avatar.startsWith("https://") ? { avatar } : {}) };
}

function parseComment(v: unknown): JiraEvent {
  const r = rec(v);
  const created = str(r.created);
  return {
    id: jiraEventId(created, "c", str(r.id)),
    kind: "comment",
    jira_id: str(r.id),
    created: jiraTime(created),
    author: parsePerson(r.author),
    body: r.body,
  };
}

function parseHistory(v: unknown): JiraEvent {
  const r = rec(v);
  const created = str(r.created);
  // Jira names a value by `fromString` and `toString`, with the stored value beside it. Every object has a method
  // called `toString`, so the answer's own field is read, never the one each object inherits.
  const items = list(r.items).map((raw): JiraHistoryItem => {
    const item = rec(raw);
    const shown = new Map(Object.entries(item)).get("toString");
    return { field: str(item.field), from: strOrNull(item.fromString) ?? strOrNull(item.from), to: strOrNull(shown) ?? strOrNull(item.to) };
  });
  return { id: jiraEventId(created, "h", str(r.id)), kind: "history", jira_id: str(r.id), created: jiraTime(created), author: parsePerson(r.author), items };
}

function parseTicket(v: unknown): JiraTicket {
  const r = rec(v);
  const fields = rec(r.fields);
  return {
    id: str(r.id),
    key: str(r.key),
    summary: str(fields.summary),
    updated: jiraTime(str(fields.updated)),
    assignee_account_id: strOrNull(rec(fields.assignee).accountId),
  };
}

const nameOf = (v: unknown): string | null => strOrNull(rec(v).name) ?? strOrNull(rec(v).displayName);

/**
 * The sprint a ticket is in, from the sprint field's value: Jira Cloud gives a list of sprints, each with its name and
 * state, and older sites a list of texts holding `name=` and `state=`. The active sprint wins, else the last one listed.
 */
function sprintOf(v: unknown): string | null {
  const sprints = list(v).flatMap((s) => {
    const name = typeof s === "string" ? (/name=([^,\]]+)/.exec(s)?.[1] ?? null) : strOrNull(rec(s).name);
    const active = typeof s === "string" ? /state=ACTIVE/i.test(s) : rec(s).state === "active";
    return name ? [{ name, active }] : [];
  });
  return (sprints.find((s) => s.active) ?? sprints.at(-1))?.name ?? null;
}

function parseIssue(v: unknown, sprintField: string | null): JiraIssue {
  const r = rec(v);
  const fields = rec(r.fields);
  return {
    id: str(r.id),
    key: str(r.key),
    summary: str(fields.summary),
    type: nameOf(fields.issuetype),
    project: nameOf(fields.project) ?? strOrNull(rec(fields.project).key),
    status: nameOf(fields.status),
    assignee: nameOf(fields.assignee),
    reporter: nameOf(fields.reporter),
    priority: nameOf(fields.priority),
    sprint: sprintField ? sprintOf(fields[sprintField]) : null,
    labels: list(fields.labels).filter((l): l is string => typeof l === "string" && l !== ""),
    description: fields.description ?? null,
    created: jiraTime(str(fields.created)),
  };
}

/** One connected Jira site's calls. */
export class JiraClient {
  private readonly opts: JiraClientOptions;
  /** Until when Jira asked for no calls (a rate limit), in ms since the epoch; the wait covers every call to the site. */
  private holdUntil = 0;
  /**
   * The site's sprint field id, found once from its list of fields and kept for the client's life (plan 089), null
   * when the site has none. A look that failed is not kept, so the next read asks again.
   */
  private sprintId: Promise<string | null> | null = null;

  constructor(opts: JiraClientOptions) {
    this.opts = opts;
  }

  /** Who the token belongs to, which connecting checks before keeping the account. An answer naming no account is a rejection. */
  async myself(): Promise<JiraIdentity> {
    const r = await this.call("GET", "/rest/api/3/myself");
    const accountId = str(r.accountId);
    // Jira answers some calls with a bad token as it would an anonymous visitor: 200, and no account.
    if (!accountId) return this.rejected("the profile names no account", 200);
    return { account_id: accountId, display_name: str(r.displayName), email: strOrNull(r.emailAddress) };
  }

  /**
   * Where the site lives: its API address and the one people browse. Jira answers this to anyone, so the token is not
   * sent: connecting asks it of the address the person typed, before that address is known to be their site.
   */
  async serverInfo(): Promise<JiraServerInfo> {
    const r = await this.call("GET", "/rest/api/3/serverInfo", undefined, undefined, false);
    const base = str(r.baseUrl);
    return { base_url: base, display_url: str(r.displayUrl) || base };
  }

  /**
   * One page of the tickets the person watches. With `sinceMinutes`, those changed in that many minutes, oldest change
   * first: a relative time, so the person's Jira time zone never matters. With null, every watched ticket, most
   * recently changed first, which is how the past is filled.
   */
  async searchWatched(opts: { sinceMinutes: number | null; pageToken?: string | null; limit?: number }): Promise<JiraTicketPage> {
    const jql =
      opts.sinceMinutes === null
        ? "watcher = currentUser() ORDER BY updated DESC"
        : `watcher = currentUser() AND updated >= -${Math.max(1, Math.ceil(opts.sinceMinutes))}m ORDER BY updated ASC`;
    const r = await this.call("GET", "/rest/api/3/search/jql", {
      jql,
      fields: SEARCH_FIELDS,
      maxResults: String(opts.limit ?? SEARCH_PAGE),
      ...(opts.pageToken ? { nextPageToken: opts.pageToken } : {}),
    });
    return { tickets: list(r.issues).map(parseTicket), next_page_token: strOrNull(r.nextPageToken) };
  }

  /**
   * One ticket by its id or its key, as the search gives it: the owner's tools name a ticket either way, and both lead
   * to the numeric id a card keeps (KTD7). A ticket the person may not see is not found.
   */
  async ticket(idOrKey: string): Promise<JiraTicket> {
    return parseTicket(await this.call("GET", `/rest/api/3/issue/${encodeURIComponent(idOrKey)}`, { fields: SEARCH_FIELDS }));
  }

  /**
   * A ticket's fields as its card shows them (plan 089), by its id or its key, with the sprint read from the site's own
   * sprint field. A ticket the person may not see is not found.
   */
  async issue(idOrKey: string): Promise<JiraIssue> {
    const sprint = await this.sprintField();
    const fields = sprint ? `${ISSUE_FIELDS},${sprint}` : ISSUE_FIELDS;
    return parseIssue(await this.call("GET", `/rest/api/3/issue/${encodeURIComponent(idOrKey)}`, { fields }), sprint);
  }

  /** A page of a ticket's comments, read from the newest back; the ticket is named by its id or its key. */
  async comments(ticket: string, opts: JiraEventPageOptions = {}): Promise<JiraEventPage> {
    return this.page(`/rest/api/3/issue/${encodeURIComponent(ticket)}/comment`, opts, (r) => list(r.comments).map(parseComment));
  }

  /** A page of a ticket's history, read from the newest back; the ticket is named by its id or its key. */
  async history(ticket: string, opts: JiraEventPageOptions = {}): Promise<JiraEventPage> {
    // Jira's reference names the list `histories` in one place and `values` in another; whichever is there is read.
    return this.page(`/rest/api/3/issue/${encodeURIComponent(ticket)}/changelog`, opts, (r) =>
      (Array.isArray(r.values) ? list(r.values) : list(r.histories)).map(parseHistory),
    );
  }

  /**
   * Post the person's own comment on a ticket, as plain text (R17), and return the new comment's Jira id. Only the
   * person's own send reaches this; it is the one call here that changes anything in Jira.
   */
  async postComment(ticket: string, text: string): Promise<{ id: string }> {
    const r = await this.call("POST", `/rest/api/3/issue/${encodeURIComponent(ticket)}/comment`, undefined, { body: textToAdf(text) });
    return { id: str(r.id) };
  }

  // --- requests ----------------------------------------------------------------------------------------------------

  private now(): number {
    return (this.opts.now?.() ?? new Date()).getTime();
  }

  /**
   * The id of the site's field named Sprint, a custom field whose id differs from site to site, asked of the site's
   * list of fields the first time and remembered; null when the site has none.
   */
  private sprintField(): Promise<string | null> {
    this.sprintId ??= this.request("GET", "/rest/api/3/field").then(
      (answer) =>
        strOrNull(
          list(answer)
            .map(rec)
            .find((f) => f.name === SPRINT_NAME)?.id,
        ),
      (err: unknown) => {
        this.sprintId = null;
        throw err;
      },
    );
    return this.sprintId;
  }

  /**
   * A page of a list Jira serves oldest first by position, read from the end. Without `before`, the first answer says
   * how many there are: a list no longer than a page is already whole, and a longer one is asked again for its tail.
   */
  private async page(path: string, opts: JiraEventPageOptions, parse: (answer: Record<string, unknown>) => JiraEvent[]): Promise<JiraEventPage> {
    const limit = opts.limit ?? EVENT_PAGE;
    const ask = async (startAt: number, count: number) => this.call("GET", path, { startAt: String(startAt), maxResults: String(count) });
    let start = Math.max(0, (opts.before ?? 0) - limit);
    let answer = await ask(start, opts.before == null ? limit : opts.before - start);
    if (opts.before == null && num(answer.total) > limit) {
      start = num(answer.total) - limit;
      answer = await ask(start, limit);
    }
    const events = parse(answer);
    return { events, earlier: start > 0 ? start : null, total: Math.max(num(answer.total), start + events.length) };
  }

  /** One request whose answer is an object, as nearly every Jira answer is. */
  private async call(method: "GET" | "POST", path: string, query?: Record<string, string>, body?: unknown, withToken = true): Promise<Record<string, unknown>> {
    return rec(await this.request(method, path, query, body, withToken));
  }

  /** One request to the site, and the one place that decides whether an answer is a rejection, a wait or a failure. */
  private async request(method: "GET" | "POST", path: string, query?: Record<string, string>, body?: unknown, withToken = true): Promise<unknown> {
    const wait = this.holdUntil - this.now();
    if (wait > 0) throw new JiraError(`Jira asked loki to wait ${Math.ceil(wait / 1000)} s`, "rate_limited", 0, wait);
    const secret = await this.opts.secret();
    if (!secret) return this.rejected("the account keeps no token", 0);
    const res = await (this.opts.fetch ?? fetch)(`https://${secret.site}${path}${query ? `?${new URLSearchParams(query).toString()}` : ""}`, {
      method,
      headers: {
        accept: "application/json",
        ...(withToken ? { authorization: `Basic ${Buffer.from(`${secret.email}:${secret.token}`).toString("base64")}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 429) return this.rateLimited(res.headers.get("retry-after"));
    if (res.status === 401 || (res.headers.get(LOGIN_REASON_HEADER) ?? "").includes(LOGIN_FAILED)) return this.rejected(`answered ${res.status}`, res.status);
    const answer: unknown = await res.json().catch(() => ({}));
    if (res.ok) return answer;
    const said = str(list(rec(answer).errorMessages)[0]) || `Jira answered ${res.status}`;
    // Jira hides a ticket the person may not see behind "not found": that says nothing about the account.
    throw new JiraError(said, res.status === 404 ? "not_found" : `http_${res.status}`, res.status);
  }

  /** Jira did not accept the token: revoked, expired or mistyped. Only a new token helps, and the account says so (R3). */
  private rejected(why: string, status: number): never {
    log("jira:rejected", { why });
    this.opts.setStatus({ disconnected: "sign_in_again" });
    throw new JiraError("Jira did not accept the API token: reconnect with a new one in Preferences › Accounts", "rejected", status);
  }

  /** Hold every call back for as long as Jira asks; the account stays connected. */
  private rateLimited(retryAfter: string | null): never {
    const seconds = Number(retryAfter);
    const wait = retryAfter !== null && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_MS;
    this.holdUntil = this.now() + wait;
    log("jira:rate-limited", { wait_ms: wait });
    throw new JiraError(`Jira asked loki to wait ${Math.ceil(wait / 1000)} s`, "rate_limited", 429, wait);
  }
}

/**
 * The client of one connected Jira account (plan 2026-11-10-1451, U3). It reads the site, email and token from the
 * account's keychain entry for each call, so a reconnect's new token is used at once, and a token Jira rejects marks
 * the account as needing a new one (R3). An account that already says so is not written again, since every call made
 * with a rejected token would otherwise tell every client the accounts changed; one no longer here is left alone.
 */
export function jiraAccountClient(
  accounts: Pick<Accounts, "get" | "getSecret" | "setStatus">,
  accountId: string,
  opts: Pick<JiraClientOptions, "fetch" | "now"> = {},
): JiraClient {
  return new JiraClient({
    ...opts,
    secret: async () => parseJiraSecret(await accounts.getSecret(accountId)),
    setStatus: (status) => {
      const account = accounts.get(accountId);
      if (!account || JSON.stringify(account.status) === JSON.stringify(status)) return;
      accounts.setStatus(accountId, status);
    },
  });
}
