import type { Accounts } from "./accounts.ts";
import { GOOGLE_TOKEN_URL, SHARED_GOOGLE_APP, parseGmailSecret, type GmailSecret, type GoogleApp } from "./google-app.ts";

/**
 * A thin Gmail client over fetch for one connected account (plan 067, U4, KTD4): read, list, history, label change,
 * create a draft, and send the person's own reply (plan 068). Agents never send (R18): no agent tool is given
 * `sendReply`, which only the reply frame the person's own devices send reaches (mod/outside-threads.ts). Tokens come from the account's keychain secret and are
 * refreshed there; a refresh Google refuses marks the account disconnected, so the Inbox can say how to reconnect (R22).
 */

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
/** An access token this close to its expiry is refreshed first, so a call does not start with one about to lapse. */
const EXPIRY_MARGIN_MS = 60 * 1000;
/**
 * How long one call to Google may take, as SlackClient allows: a call that hangs past it fails that tick, which the
 * next tick tries again, instead of holding the account's sync until loki restarts.
 */
const TIMEOUT_MS = 20_000;
/** The reasons Google gives when a Workspace admin has not allowed the app. */
const ADMIN_REASONS = ["admin_policy_enforced"];

/** One message header, as Gmail names it. */
export interface GmailHeader {
  name: string;
  value: string;
}

/** A part of a message's MIME tree, in Gmail's own names; `body.data` is base64url, present with format full. */
export interface GmailMessagePart {
  mimeType: string;
  filename: string;
  headers: GmailHeader[];
  body: { data?: string; size: number; attachmentId?: string };
  parts: GmailMessagePart[];
}

/** A message, in Gmail's own names; `payload` holds the headers (metadata) or the whole tree (full). */
export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  historyId: string;
  internalDate: string;
  payload: GmailMessagePart | null;
}

/** A thread and its messages, oldest first, as Gmail returns them. */
export interface GmailThread {
  id: string;
  historyId: string;
  messages: GmailMessage[];
}

/** A message and the labels a history record says were added to or removed from it. */
export interface GmailLabelChange {
  message: GmailMessage;
  labelIds: string[];
}

/** One history record, in Gmail's own names; each list is empty when the record has none of that kind. */
export interface GmailHistoryRecord {
  id: string;
  messagesAdded: GmailMessage[];
  messagesDeleted: GmailMessage[];
  labelsAdded: GmailLabelChange[];
  labelsRemoved: GmailLabelChange[];
}

/**
 * What changed since a history id: every record, across pages, and the mailbox's history id now; or, when Gmail no
 * longer keeps history that far back, that it expired, so the watcher starts again from a fresh listing.
 */
export type GmailHistory = { kind: "changes"; history: GmailHistoryRecord[]; history_id: string } | { kind: "expired" };

/** One page of a message search: the ids found and where the next page starts. */
export interface GmailMessagePage {
  messages: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
}

/** The mailbox: its address and its newest history id. */
export interface GmailProfile {
  emailAddress: string;
  historyId: string;
}

/** A reply to keep as a draft in the thread it answers; loki writes it, the person sends it from Gmail. */
export interface GmailDraftInput {
  threadId: string;
  /** The Message-ID header of the message replied to. */
  inReplyTo: string;
  /** The thread's References, to which inReplyTo is added. */
  references: string[];
  to: string[];
  cc: string[];
  subject: string;
  body: string;
}

/** A Gmail call that failed: the HTTP status and Google's reason, for callers that treat some failures as answers. */
export class GmailError extends Error {
  readonly status: number;
  readonly reason: string | null;

  constructor(message: string, status: number, reason: string | null) {
    super(message);
    this.name = "GmailError";
    this.status = status;
    this.reason = reason;
  }
}

/** What GmailClient is built from; fetch and the clock are injected so tests own them. */
export interface GmailClientOptions {
  accounts: Accounts;
  account_id: string;
  /** The app to refresh with when the account was signed in with the shared one (SHARED_GOOGLE_APP). */
  sharedApp?: GoogleApp;
  fetch?: typeof fetch;
  now?: () => Date;
  /** A fresh signal for each call, aborted when the call has run too long; tests pass one they abort themselves. */
  timeout?: () => AbortSignal;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const list = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);
const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});

function parsePart(v: unknown): GmailMessagePart {
  const r = rec(v);
  const body = rec(r.body);
  return {
    mimeType: str(r.mimeType),
    filename: str(r.filename),
    headers: list(r.headers).map((h) => ({ name: str(rec(h).name), value: str(rec(h).value) })),
    body: {
      size: typeof body.size === "number" ? body.size : 0,
      ...(typeof body.data === "string" ? { data: body.data } : {}),
      ...(typeof body.attachmentId === "string" ? { attachmentId: body.attachmentId } : {}),
    },
    parts: list(r.parts).map(parsePart),
  };
}

function parseMessage(v: unknown): GmailMessage {
  const r = rec(v);
  return {
    id: str(r.id),
    threadId: str(r.threadId),
    labelIds: list(r.labelIds).filter((l): l is string => typeof l === "string"),
    snippet: str(r.snippet),
    historyId: str(r.historyId),
    internalDate: str(r.internalDate),
    payload: r.payload === undefined ? null : parsePart(r.payload),
  };
}

const parseLabelChange = (v: unknown): GmailLabelChange => ({
  message: parseMessage(rec(v).message),
  labelIds: list(rec(v).labelIds).filter((l): l is string => typeof l === "string"),
});

function parseHistoryRecord(v: unknown): GmailHistoryRecord {
  const r = rec(v);
  return {
    id: str(r.id),
    messagesAdded: list(r.messagesAdded).map((m) => parseMessage(rec(m).message)),
    messagesDeleted: list(r.messagesDeleted).map((m) => parseMessage(rec(m).message)),
    labelsAdded: list(r.labelsAdded).map(parseLabelChange),
    labelsRemoved: list(r.labelsRemoved).map(parseLabelChange),
  };
}

/** Google's reason for a failure, from a token answer (`error`) or an API answer (`error.errors[].reason`, `error.details[].reason`, `error.status`). */
function reasonsOf(body: Record<string, unknown>): string[] {
  if (typeof body.error === "string") return [body.error];
  const e = rec(body.error);
  return [...list(e.errors).map((x) => str(rec(x).reason)), ...list(e.details).map((x) => str(rec(x).reason)), str(e.status)].filter(Boolean);
}
const isAdminBlock = (reasons: string[]) => reasons.some((r) => ADMIN_REASONS.includes(r.toLowerCase()));

/** A header value on one line: an agent-written subject or address must never add a header (a Bcc) of its own. */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
/** A header in RFC 2047's encoded form when it is not plain ASCII, as a subject in another language needs. */
const encodedWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

/** The reply as an RFC 2822 message: plain text in UTF-8, threaded by In-Reply-To and References. */
function rfc2822(d: GmailDraftInput): string {
  const references = [...d.references, d.inReplyTo].map(oneLine).filter(Boolean);
  const headers = [
    d.to.length ? `To: ${d.to.map(oneLine).join(", ")}` : "",
    d.cc.length ? `Cc: ${d.cc.map(oneLine).join(", ")}` : "",
    `Subject: ${encodedWord(oneLine(d.subject))}`,
    d.inReplyTo ? `In-Reply-To: ${oneLine(d.inReplyTo)}` : "",
    references.length ? `References: ${[...new Set(references)].join(" ")}` : "",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ].filter(Boolean);
  const body = (
    Buffer.from(d.body.replace(/\r?\n/g, "\r\n"), "utf8")
      .toString("base64")
      .match(/.{1,76}/g) ?? []
  ).join("\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${body}\r\n`;
}

/** One connected Gmail account's calls. */
export class GmailClient {
  private readonly opts: GmailClientOptions;
  private secret: GmailSecret | null = null;

  constructor(opts: GmailClientOptions) {
    this.opts = opts;
  }

  /** The mailbox's address and newest history id. */
  async profile(): Promise<GmailProfile> {
    const r = rec(await this.call("GET", "/profile"));
    return { emailAddress: str(r.emailAddress), historyId: str(r.historyId) };
  }

  /**
   * The addresses the person writes from, so a message to any of them counts as to them. A mailbox whose settings
   * cannot be read gives its own address alone.
   */
  async sendAsAddresses(): Promise<string[]> {
    try {
      const r = rec(await this.call("GET", "/settings/sendAs"));
      const addresses = list(r.sendAs)
        .map((s) => str(rec(s).sendAsEmail))
        .filter(Boolean);
      if (addresses.length) return addresses;
    } catch (error) {
      if (!(error instanceof GmailError) || error.status !== 403 || isAdminBlock(error.reason ? [error.reason] : [])) throw error;
    }
    return [(await this.profile()).emailAddress];
  }

  /** Every change since a history id, following every page; Gmail's 404 means that history is gone. */
  async historySince(historyId: string): Promise<GmailHistory> {
    const history: GmailHistoryRecord[] = [];
    let pageToken: string | undefined;
    let latest = historyId;
    do {
      let r: Record<string, unknown>;
      try {
        r = rec(await this.call("GET", "/history", { startHistoryId: historyId, ...(pageToken ? { pageToken } : {}) }));
      } catch (error) {
        if (error instanceof GmailError && error.status === 404) return { kind: "expired" };
        throw error;
      }
      history.push(...list(r.history).map(parseHistoryRecord));
      latest = str(r.historyId) || latest;
      pageToken = str(r.nextPageToken) || undefined;
    } while (pageToken);
    return { kind: "changes", history, history_id: latest };
  }

  /** One page of the messages matching a Gmail search (`q`, as in Gmail's search box). */
  async listMessages(q: string, pageToken?: string): Promise<GmailMessagePage> {
    const r = rec(await this.call("GET", "/messages", { q, ...(pageToken ? { pageToken } : {}) }));
    const next = str(r.nextPageToken);
    return {
      messages: list(r.messages).map((m) => ({ id: str(rec(m).id), threadId: str(rec(m).threadId) })),
      ...(next ? { nextPageToken: next } : {}),
    };
  }

  /** A thread with its messages: their headers only (metadata), or every part (full). */
  async getThread(threadId: string, format: "metadata" | "full"): Promise<GmailThread> {
    const r = rec(await this.call("GET", `/threads/${encodeURIComponent(threadId)}`, { format }));
    return { id: str(r.id), historyId: str(r.historyId), messages: list(r.messages).map(parseMessage) };
  }

  /**
   * Take labels off the given messages: INBOX to archive them, UNREAD to mark them read. By message, not by thread, so
   * mail that came after what the person saw keeps its labels.
   */
  async batchModify(ids: string[], change: { removeLabels: string[] }): Promise<void> {
    if (ids.length === 0) return;
    await this.call("POST", "/messages/batchModify", undefined, { ids, removeLabelIds: change.removeLabels });
  }

  /** Keep a reply as a draft in its thread, for the person to read and send from Gmail; the draft's id. */
  async createDraft(draft: GmailDraftInput): Promise<{ id: string; messageId: string }> {
    const raw = Buffer.from(rfc2822(draft), "utf8").toString("base64url");
    const r = rec(await this.call("POST", "/drafts", undefined, { message: { raw, threadId: draft.threadId } }));
    return { id: str(r.id), messageId: str(rec(r.message).id) };
  }

  /**
   * Send the person's own reply in its thread (plan 068): the message `createDraft` would keep, sent now. Only the
   * person's reply frame calls this; no agent tool is given it.
   */
  async sendReply(reply: GmailDraftInput): Promise<{ id: string }> {
    const raw = Buffer.from(rfc2822(reply), "utf8").toString("base64url");
    const r = rec(await this.call("POST", "/messages/send", undefined, { raw, threadId: reply.threadId }));
    return { id: str(r.id) };
  }

  // --- tokens and requests -----------------------------------------------------------------------------------------

  private now(): number {
    return (this.opts.now?.() ?? new Date()).getTime();
  }

  private get fetch(): typeof fetch {
    return this.opts.fetch ?? fetch;
  }

  private signal(): AbortSignal {
    return this.opts.timeout?.() ?? AbortSignal.timeout(TIMEOUT_MS);
  }

  /** A Gmail call with a good access token; a 401 refreshes the token once and tries again. */
  private async call(method: "GET" | "POST", path: string, query?: Record<string, string>, body?: unknown): Promise<unknown> {
    const url = `${API}${path}${query ? `?${new URLSearchParams(query).toString()}` : ""}`;
    const request = async (token: string) =>
      this.fetch(url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: this.signal(),
      });
    let res = await request(await this.accessToken());
    if (res.status === 401) res = await request(await this.refresh());
    const answer = rec(await res.json().catch(() => ({})));
    if (res.ok) return answer;
    const reasons = reasonsOf(answer);
    if (res.status === 403 && isAdminBlock(reasons)) this.disconnect("admin_blocks");
    const message = str(rec(answer.error).message) || `Gmail answered ${res.status}`;
    throw new GmailError(
      res.status === 403 && isAdminBlock(reasons) ? "your Google admin blocks this app: use your own Google app in Preferences › Accounts" : message,
      res.status,
      reasons[0] ?? null,
    );
  }

  private async load(): Promise<GmailSecret> {
    if (this.secret) return this.secret;
    const secret = parseGmailSecret(await this.opts.accounts.getSecret(this.opts.account_id));
    if (!secret) {
      this.disconnect("sign_in_again");
      throw new GmailError("this Gmail account keeps no sign-in: sign in again", 401, null);
    }
    this.secret = secret;
    return secret;
  }

  /** The access token, refreshed first when it has lapsed or is about to. */
  private async accessToken(): Promise<string> {
    const secret = await this.load();
    if (Date.parse(secret.expires_at) - EXPIRY_MARGIN_MS <= this.now() || !secret.access_token) return this.refresh();
    return secret.access_token;
  }

  /**
   * A new access token from the refresh token, kept in the keychain. Google refusing the refresh token (`invalid_grant`:
   * revoked, expired, or the password changed) means only a new sign-in helps, and the account says so.
   */
  private async refresh(): Promise<string> {
    const secret = await this.load();
    const app = secret.own_app ?? this.opts.sharedApp ?? SHARED_GOOGLE_APP;
    const res = await this.fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: secret.refresh_token,
        client_id: app.client_id,
        client_secret: app.client_secret,
      }).toString(),
      signal: this.signal(),
    });
    const answer = rec(await res.json().catch(() => ({})));
    if (!res.ok) {
      const reasons = reasonsOf(answer);
      if (isAdminBlock(reasons)) {
        this.disconnect("admin_blocks");
        throw new GmailError("your Google admin blocks this app: use your own Google app in Preferences › Accounts", res.status, reasons[0] ?? null);
      }
      if (reasons.includes("invalid_grant")) {
        this.disconnect("sign_in_again");
        throw new GmailError("Gmail asks you to sign in again", res.status, "invalid_grant");
      }
      throw new GmailError(`Google would not refresh the sign-in (${res.status})`, res.status, reasons[0] ?? null);
    }
    const access = str(answer.access_token);
    const expiresIn = typeof answer.expires_in === "number" ? answer.expires_in : 0;
    if (!access) throw new GmailError("Google gave no access token", res.status, null);
    // Google may hand out a new refresh token; the newest one is the one that keeps working.
    const next: GmailSecret = {
      ...secret,
      access_token: access,
      refresh_token: str(answer.refresh_token) || secret.refresh_token,
      expires_at: new Date(this.now() + expiresIn * 1000).toISOString(),
    };
    await this.opts.accounts.setSecret(this.opts.account_id, JSON.stringify(next));
    this.secret = next;
    return access;
  }

  /** Mark the account disconnected with why, unless it already says so; an account no longer here is left alone. */
  private disconnect(cause: "sign_in_again" | "admin_blocks"): void {
    // A sign-in made again later writes new tokens to the keychain: read them then, not the ones that stopped working.
    this.secret = null;
    const account = this.opts.accounts.get(this.opts.account_id);
    if (!account) return;
    if (typeof account.status === "object" && account.status.disconnected === cause) return;
    this.opts.accounts.setStatus(this.opts.account_id, { disconnected: cause });
  }
}
