import { messageOf } from "../core/errors.ts";
import type { AccountStatus } from "../core/frame-types.ts";
import type { Accounts } from "./accounts.ts";
import { textToAdf } from "./jira-text.ts";
import type { JiraHistoryItem } from "./jira-text.ts";
import { log } from "./log.ts";

export interface JiraSecret {
  site: string;
  email: string;
  token: string;
  link_host?: string;
}

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

export function jiraTicketUrl(secret: Pick<JiraSecret, "site" | "link_host">, key: string): string {
  return `https://${secret.link_host ?? secret.site}/browse/${encodeURIComponent(key)}`;
}

/** Jira's header, on an answer of any status, when it did not accept the credentials: some calls answer 200 with it. */
const LOGIN_REASON_HEADER = "x-seraph-loginreason";
const LOGIN_FAILED = "AUTHENTICATED_FAILED";
const DEFAULT_RETRY_MS = 60_000;
const TIMEOUT_MS = 20_000;
const UPLOAD_BYTES_PER_MS = 150;
const THUMBNAIL_MAX_BYTES = 1_000_000;
const SEARCH_PAGE = 50;
const EVENT_PAGE = 50;
/** The fields a search asks for by name: Jira returns only the id otherwise. */
const SEARCH_FIELDS = "summary,updated,assignee";
const META_PAGE = 50;
const MAX_META_PAGES = 20;
const ISSUE_FIELDS = "summary,issuetype,project,status,assignee,reporter,priority,labels,description,created";
/** The name a Jira site gives its sprint field, whose id differs from site to site. */
const SPRINT_NAME = "Sprint";
const ID_DIGITS = 12;

export function jiraUploadTimeoutMs(bytes: number): number {
  return TIMEOUT_MS + Math.ceil(bytes / UPLOAD_BYTES_PER_MS);
}

export interface JiraFile {
  name: string;
  data: Uint8Array;
}

export class JiraError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfterMs: number | null;
  readonly fields: Readonly<Record<string, string>>;

  constructor(message: string, code: string, status: number, retryAfterMs: number | null = null, fields: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "JiraError";
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.fields = fields;
  }
}

export interface JiraIssueType {
  id: string;
  name: string;
  subtask: boolean;
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
  types: JiraIssueType[];
}

export interface JiraPriority {
  id: string;
  name: string;
}

export interface JiraCreateField {
  id: string;
  name: string;
  required: boolean;
  has_default: boolean;
}

export interface JiraNewIssue {
  project: string;
  type_id: string;
  title: string;
  description: string;
  mentions?: ReadonlyArray<{ display: string; id: string | null }>;
  assignee?: string | null;
  priority_id?: string | null;
  labels?: readonly string[];
  parent?: string | null;
}

export interface JiraClientOptions {
  secret: () => Promise<JiraSecret | null>;
  setStatus: (status: AccountStatus) => void;
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface JiraIdentity {
  account_id: string;
  display_name: string;
  /** Null when the person's privacy settings hide it. */
  email: string | null;
}

export interface JiraServerInfo {
  base_url: string;
  display_url: string;
}

export interface JiraTicket {
  /** Jira's numeric id, which stays the same when the ticket moves to another project. */
  id: string;
  key: string;
  summary: string;
  updated: string;
  assignee_account_id: string | null;
}

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
  sprint: string | null;
  labels: string[];
  description: unknown;
  created: string;
}

export interface JiraTicketFacts {
  id: string;
  key: string;
  summary: string;
  assignee: string | null;
  reporter: string | null;
  watchers: number;
  service_desk: boolean;
}

export interface JiraAttachment {
  id: string;
  filename: string;
  mime_type: string;
  size: number;
}

export interface JiraThumbnail {
  data: Buffer;
  type: string;
}

export interface JiraTicketPage {
  tickets: JiraTicket[];
  next_page_token: string | null;
}

export interface JiraUser {
  account_id: string;
  display_name: string;
  /** Jira hides most people's address unless their profile shares it. */
  email: string | null;
}

export type JiraUserScope =
  | { kind: "site" }
  | { kind: "ticket"; ticket: string }
  | { kind: "project"; project: string }
  | { kind: "assignee"; ticket: string }
  | { kind: "assignee"; project: string };

const USER_PAGE = 50;

export interface JiraPerson {
  account_id: string;
  display_name: string;
  avatar?: string;
}

export type JiraEvent = {
  id: string;
  jira_id: string;
  created: string;
  author: JiraPerson;
} & (
  | {
      kind: "comment";
      body: unknown;
    }
  | { kind: "history"; items: JiraHistoryItem[] }
);

export interface JiraEventPage {
  events: JiraEvent[];
  earlier: number | null;
  total: number;
}

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

export function jiraEventId(created: string, kind: "c" | "h", jiraId: string): string {
  return `${jiraTime(created)}:${kind}${jiraId.padStart(ID_DIGITS, "0")}`;
}

function userSearchOf(among: JiraUserScope): [string, Record<string, string>] {
  switch (among.kind) {
    case "site":
      return ["/rest/api/3/user/search", {}];
    case "ticket":
      return ["/rest/api/3/user/viewissue/search", { issueKey: among.ticket }];
    case "project":
      return ["/rest/api/3/user/permission/search", { permissions: "BROWSE_PROJECTS", projectKey: among.project }];
    case "assignee":
      return ["/rest/api/3/user/assignable/search", "ticket" in among ? { issueKey: among.ticket } : { project: among.project }];
  }
}

function parseUser(v: unknown): JiraUser[] {
  const r = rec(v);
  const id = str(r.accountId);
  if (!id || r.active === false || r.accountType === "app") return [];
  return [{ account_id: id, display_name: str(r.displayName), email: strOrNull(r.emailAddress) }];
}

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
  // Outside (Jira): Jira names a value by `fromString` and `toString`, with the stored value beside it. Every object has a method
  // called `toString`, so the answer's own field is read, never the one each object inherits.
  const items = list(r.items).map((raw): JiraHistoryItem => {
    const item = rec(raw);
    const shown = new Map(Object.entries(item)).get("toString");
    return { field: str(item.field), from: strOrNull(item.fromString) ?? strOrNull(item.from), to: strOrNull(shown) ?? strOrNull(item.to) };
  });
  return { id: jiraEventId(created, "h", str(r.id)), kind: "history", jira_id: str(r.id), created: jiraTime(created), author: parsePerson(r.author), items };
}

function parseAttachment(v: unknown): JiraAttachment[] {
  const r = rec(v);
  const id = str(r.id);
  const filename = str(r.filename);
  return id && filename ? [{ id, filename, mime_type: str(r.mimeType), size: num(r.size) }] : [];
}

const basicAuth = (secret: JiraSecret) => `Basic ${Buffer.from(`${secret.email}:${secret.token}`).toString("base64")}`;

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

export class JiraClient {
  private readonly opts: JiraClientOptions;
  private holdUntil = 0;
  private sprintId: Promise<string | null> | null = null;

  constructor(opts: JiraClientOptions) {
    this.opts = opts;
  }

  async myself(): Promise<JiraIdentity> {
    const r = await this.call("GET", "/rest/api/3/myself");
    const accountId = str(r.accountId);
    // Outside (Jira): Jira answers some calls with a bad token as it would an anonymous visitor: 200, and no account.
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

  async ticket(idOrKey: string): Promise<JiraTicket> {
    return parseTicket(await this.call("GET", `/rest/api/3/issue/${encodeURIComponent(idOrKey)}`, { fields: SEARCH_FIELDS }));
  }

  async issue(idOrKey: string): Promise<JiraIssue> {
    const sprint = await this.sprintField();
    const fields = sprint ? `${ISSUE_FIELDS},${sprint}` : ISSUE_FIELDS;
    return parseIssue(await this.call("GET", `/rest/api/3/issue/${encodeURIComponent(idOrKey)}`, { fields }), sprint);
  }

  async ticketFacts(idOrKey: string): Promise<JiraTicketFacts> {
    const r = await this.call("GET", `/rest/api/3/issue/${encodeURIComponent(idOrKey)}`, { fields: "summary,assignee,reporter,watches,project" });
    const fields = rec(r.fields);
    return {
      id: str(r.id),
      key: str(r.key),
      summary: str(fields.summary),
      assignee: nameOf(fields.assignee),
      reporter: nameOf(fields.reporter),
      watchers: num(rec(fields.watches).watchCount),
      service_desk: rec(fields.project).projectTypeKey === "service_desk",
    };
  }

  async comments(ticket: string, opts: JiraEventPageOptions = {}): Promise<JiraEventPage> {
    return this.page(`/rest/api/3/issue/${encodeURIComponent(ticket)}/comment`, opts, (r) => list(r.comments).map(parseComment));
  }

  async history(ticket: string, opts: JiraEventPageOptions = {}): Promise<JiraEventPage> {
    // Outside (Jira): Jira's reference names the list `histories` in one place and `values` in another; whichever is there is read.
    return this.page(`/rest/api/3/issue/${encodeURIComponent(ticket)}/changelog`, opts, (r) =>
      (Array.isArray(r.values) ? list(r.values) : list(r.histories)).map(parseHistory),
    );
  }

  async searchUsers(among: JiraUserScope, by: { query: string } | { account_id: string }): Promise<JiraUser[]> {
    const who: Record<string, string> = "query" in by ? { query: by.query } : { accountId: by.account_id };
    const [path, scope] = userSearchOf(among);
    const answer = await this.request("GET", path, { ...scope, ...who, maxResults: String(USER_PAGE) });
    return list(answer).flatMap(parseUser);
  }

  async attachments(ticket: string): Promise<JiraAttachment[]> {
    const r = await this.call("GET", `/rest/api/3/issue/${encodeURIComponent(ticket)}`, { fields: "attachment" });
    return list(rec(r.fields).attachment).flatMap(parseAttachment);
  }

  async thumbnail(id: string): Promise<JiraThumbnail | null> {
    if (this.holdUntil > this.now()) return null;
    const secret = await this.opts.secret();
    if (!secret) return null;
    try {
      const res = await (this.opts.fetch ?? fetch)(`https://${secret.site}/rest/api/3/attachment/thumbnail/${encodeURIComponent(id)}?redirect=false`, {
        headers: { accept: "image/*", authorization: basicAuth(secret) },
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 429) {
        this.hold(res.headers.get("retry-after"));
        return null;
      }
      const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (!res.ok || !type.startsWith("image/")) return null;
      const data = Buffer.from(await res.arrayBuffer());
      return data.length <= THUMBNAIL_MAX_BYTES ? { data, type } : null;
    } catch (err) {
      log("jira:thumbnail-failed", { error: messageOf(err) });
      return null;
    }
  }

  async projects(): Promise<JiraProject[]> {
    const out: JiraProject[] = [];
    for (let startAt = 0, page = 0; page < MAX_META_PAGES; page++) {
      const r = await this.call("GET", "/rest/api/3/project/search", {
        action: "create",
        expand: "issueTypes",
        startAt: String(startAt),
        maxResults: String(META_PAGE),
      });
      const values = list(r.values).map(rec);
      for (const p of values)
        out.push({
          id: str(p.id),
          key: str(p.key),
          name: str(p.name),
          types: list(p.issueTypes)
            .map(rec)
            .map((t) => ({ id: str(t.id), name: str(t.name), subtask: t.subtask === true })),
        });
      startAt += values.length;
      if (r.isLast === true || values.length === 0) break;
    }
    return out;
  }

  async priorities(): Promise<JiraPriority[]> {
    const r = await this.request("GET", "/rest/api/3/priority");
    return list(r)
      .map(rec)
      .map((p) => ({ id: str(p.id), name: str(p.name) }))
      .filter((p) => p.id && p.name);
  }

  async formFields(project: string, typeId: string): Promise<JiraCreateField[]> {
    const out: JiraCreateField[] = [];
    const path = `/rest/api/3/issue/createmeta/${encodeURIComponent(project)}/issuetypes/${encodeURIComponent(typeId)}`;
    for (let startAt = 0, page = 0; page < MAX_META_PAGES; page++) {
      const r = await this.call("GET", path, { startAt: String(startAt), maxResults: String(META_PAGE) });
      const values = list(r.fields ?? r.values).map(rec);
      for (const f of values)
        out.push({ id: str(f.fieldId) || str(f.key), name: str(f.name), required: f.required === true, has_default: f.hasDefaultValue === true });
      startAt += values.length;
      const total = num(r.total);
      if (values.length === 0 || r.isLast === true || (total > 0 && startAt >= total)) break;
    }
    return out;
  }

  async createIssue(issue: JiraNewIssue): Promise<{ id: string; key: string }> {
    const fields: Record<string, unknown> = {
      project: { key: issue.project },
      issuetype: { id: issue.type_id },
      summary: issue.title,
      ...(issue.description.trim() ? { description: textToAdf(issue.description, issue.mentions ?? []) } : {}),
      ...(issue.assignee ? { assignee: { accountId: issue.assignee } } : {}),
      ...(issue.priority_id ? { priority: { id: issue.priority_id } } : {}),
      ...(issue.labels?.length ? { labels: [...issue.labels] } : {}),
      ...(issue.parent ? { parent: { key: issue.parent } } : {}),
    };
    const r = await this.call("POST", "/rest/api/3/issue", undefined, { fields });
    return { id: str(r.id), key: str(r.key) };
  }

  async postComment(ticket: string, text: string, mentions: ReadonlyArray<{ display: string; id: string | null }> = []): Promise<{ id: string }> {
    const r = await this.call("POST", `/rest/api/3/issue/${encodeURIComponent(ticket)}/comment`, undefined, { body: textToAdf(text, mentions) });
    return { id: str(r.id) };
  }

  async attachFiles(ticket: string, files: JiraFile[]): Promise<string[]> {
    const form = new FormData();
    // Outside (TypeScript): a Blob takes only bytes over a plain ArrayBuffer, and a caller's view may sit over a shared
    // one, so each is copied.
    for (const f of files) form.append("file", new Blob([new Uint8Array(f.data)]), f.name);
    const size = files.reduce((n, f) => n + f.data.byteLength, 0);
    const answer = await this.request("POST", `/rest/api/3/issue/${encodeURIComponent(ticket)}/attachments`, undefined, undefined, true, {
      form,
      timeoutMs: jiraUploadTimeoutMs(size),
    });
    const names = list(answer).flatMap((a) => (str(rec(a).filename) ? [str(rec(a).filename)] : []));
    return names.length ? names : files.map((f) => f.name);
  }

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

  private async call(method: "GET" | "POST", path: string, query?: Record<string, string>, body?: unknown, withToken = true): Promise<Record<string, unknown>> {
    return rec(await this.request(method, path, query, body, withToken));
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    query?: Record<string, string>,
    body?: unknown,
    withToken = true,
    upload?: { form: FormData; timeoutMs: number },
  ): Promise<unknown> {
    const wait = this.holdUntil - this.now();
    if (wait > 0) throw new JiraError(`Jira asked loki to wait ${Math.ceil(wait / 1000)} s`, "rate_limited", 0, wait);
    const secret = await this.opts.secret();
    if (!secret) return this.rejected("the account keeps no token", 0);
    const sent = (this.opts.fetch ?? fetch)(`https://${secret.site}${path}${query ? `?${new URLSearchParams(query).toString()}` : ""}`, {
      method,
      headers: {
        accept: "application/json",
        ...(withToken ? { authorization: basicAuth(secret) } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(upload ? { "x-atlassian-token": "no-check" } : {}),
      },
      ...(upload ? { body: upload.form } : body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(upload?.timeoutMs ?? TIMEOUT_MS),
    });
    const res = upload
      ? await sent.catch((err: unknown) => {
          if (err instanceof Error && err.name === "TimeoutError")
            throw new JiraError("Jira did not answer in time: the files may be on the ticket: check before sending again", "timeout", 0);
          throw err;
        })
      : await sent;
    if (res.status === 429) return this.rateLimited(res.headers.get("retry-after"));
    if (res.status === 401 || (res.headers.get(LOGIN_REASON_HEADER) ?? "").includes(LOGIN_FAILED)) return this.rejected(`answered ${res.status}`, res.status);
    const answer: unknown = await res.json().catch(() => ({}));
    if (res.ok) return answer;
    const fields = Object.fromEntries(Object.entries(rec(rec(answer).errors)).filter((e): e is [string, string] => typeof e[1] === "string"));
    const said = str(list(rec(answer).errorMessages)[0]) || Object.values(fields)[0] || `Jira answered ${res.status}`;
    // Outside (Jira): Jira hides a ticket the person may not see behind "not found": that says nothing about the account.
    throw new JiraError(said, res.status === 404 ? "not_found" : `http_${res.status}`, res.status, null, fields);
  }

  private rejected(why: string, status: number): never {
    log("jira:rejected", { why });
    this.opts.setStatus({ disconnected: "sign_in_again" });
    throw new JiraError("Jira did not accept the API token: reconnect with a new one in Preferences › Accounts", "rejected", status);
  }

  private hold(retryAfter: string | null): number {
    const seconds = Number(retryAfter);
    const wait = retryAfter !== null && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_MS;
    this.holdUntil = this.now() + wait;
    log("jira:rate-limited", { wait_ms: wait });
    return wait;
  }

  private rateLimited(retryAfter: string | null): never {
    const wait = this.hold(retryAfter);
    throw new JiraError(`Jira asked loki to wait ${Math.ceil(wait / 1000)} s`, "rate_limited", 429, wait);
  }
}

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
