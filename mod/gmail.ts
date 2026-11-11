import { headerMailboxes } from "../core/mail-header.ts";
import type { Accounts } from "./accounts.ts";
import type { GoogleApp } from "./google-app.ts";
import { GoogleAuth, GoogleError } from "./google-auth.ts";

/**
 * A thin Gmail client over fetch for one connected account (plan 067, U4, KTD4): read, list, history, labels and label changes,
 * create a draft, and send. `sendReply` is reached by the reply frame the person's own devices send
 * (mod/outside-threads.ts) and by the scripts' Gmail tool (mod/google-tools/gmail.ts, plan 2026-11-11 scripts); no tool
 * the model calls directly sends. Its calls go through the account's sign-in (mod/google-auth.ts), which refreshes the
 * tokens in the keychain and marks the account disconnected when Google refuses them, so the Inbox can say how to
 * reconnect (R22).
 */

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

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

/** One of the account's labels: Gmail's own (`system`, as INBOX) or one the person made (`user`), by id and name. */
export interface GmailLabel {
  id: string;
  name: string;
  type: "system" | "user";
}

/** One page of a message search: the ids found and where the next page starts. */
export interface GmailMessagePage {
  messages: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
}

/** One page of the inbox's threads (plan 088): their ids, newest first, and where the next page starts. */
export interface GmailThreadPage {
  threads: string[];
  nextPageToken?: string;
}

/** The mailbox: its address and its newest history id. */
export interface GmailProfile {
  emailAddress: string;
  historyId: string;
}

/** A file carried by a forwarded mail (plan 076): its name, type and bytes. */
export interface GmailAttachment {
  filename: string;
  mimeType: string;
  data: Buffer;
}

/**
 * A reply to keep as a draft in the thread it answers (loki writes it, the person sends it from Gmail), or the person's
 * own to send. `body` is plain text; with `html` the message carries both (plan 076), as Gmail's own replies do.
 */
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
  /** The From header, as `"Name" <address>` or a bare address; Gmail's default when left out. */
  from?: string;
  bcc?: string[];
  html?: string;
  attachments?: GmailAttachment[];
}

/** One address the person sends from (Gmail's send-as), with the name it shows and its signature as Gmail keeps it, in HTML. */
export interface GmailSendAs {
  address: string;
  name: string;
  signature: string;
  isDefault: boolean;
}

/** What GmailClient is built from; fetch and the clock are injected so tests own them. */
export interface GmailClientOptions {
  accounts: Accounts;
  account_id: string;
  /** The account's sign-in, shared with the Google tools (mod/index.ts); one of its own is made when left out. */
  auth?: GoogleAuth;
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

/** A header value on one line: an agent-written subject or address must never add a header (a Bcc) of its own. */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
/** A header in RFC 2047's encoded form when it is not plain ASCII, as a subject in another language needs. */
const encodedWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

/**
 * One To, Cc or Bcc entry as the header carries it: each person in it written out again from their name and address,
 * the name quoted where it holds a comma, a quote or the like, and encoded where it is not plain ASCII. An entry is
 * never copied into the header as it came, since a name taken from a stranger's From could close its own quote and
 * name a second recipient; one with no address in it adds nobody.
 */
const mailboxes = (entry: string): string[] =>
  headerMailboxes(oneLine(entry)).map(({ name, address }) => {
    if (!name) return address;
    if (!/^[\x20-\x7e]*$/.test(name)) return `${encodedWord(name)} <${address}>`;
    return /^[\w !#$%&'*+/=?^`{|}~-]+$/.test(name) ? `${name} <${address}>` : `"${name.replace(/[\\"]/g, "\\$&")}" <${address}>`;
  });

/** Bytes as base64 in lines of 76, as MIME wants them. */
const base64Lines = (data: Buffer): string => (data.toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
/** Text as a base64 MIME body, its lines ended the way mail ends them. */
const textBody = (text: string): string => base64Lines(Buffer.from(text.replace(/\r?\n/g, "\r\n"), "utf8"));
/** A MIME part: its headers, then its body. */
const part = (headers: string[], body: string): string => `${headers.join("\r\n")}\r\n\r\n${body}`;
/** Parts under one boundary, closed. */
const multipart = (boundary: string, parts: string[]): string => `${parts.map((p) => `--${boundary}\r\n${p}`).join("\r\n")}\r\n--${boundary}--`;
/** A file name as a MIME parameter, in RFC 2231's form so a name in any language survives. */
const fileParam = (name: string): string => `filename*=UTF-8''${encodeURIComponent(oneLine(name) || "attachment")}`;

/**
 * The reply as an RFC 2822 message, threaded by In-Reply-To and References: plain text alone, as drafts were before
 * plan 076, or plain text and HTML together, with any forwarded files after them.
 */
export function rfc2822(d: GmailDraftInput, boundary = "loki"): string {
  const references = [...d.references, d.inReplyTo].map(oneLine).filter(Boolean);
  const to = d.to.flatMap(mailboxes);
  const cc = d.cc.flatMap(mailboxes);
  const bcc = (d.bcc ?? []).flatMap(mailboxes);
  const headers = [
    d.from ? `From: ${oneLine(d.from)}` : "",
    to.length ? `To: ${to.join(", ")}` : "",
    cc.length ? `Cc: ${cc.join(", ")}` : "",
    // Gmail takes Bcc from the message it sends and leaves it off what the others get.
    bcc.length ? `Bcc: ${bcc.join(", ")}` : "",
    `Subject: ${encodedWord(oneLine(d.subject))}`,
    d.inReplyTo ? `In-Reply-To: ${oneLine(d.inReplyTo)}` : "",
    references.length ? `References: ${[...new Set(references)].join(" ")}` : "",
    "MIME-Version: 1.0",
  ].filter(Boolean);
  const plain = part(["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64"], textBody(d.body));
  const text =
    d.html === undefined
      ? plain
      : part(
          [`Content-Type: multipart/alternative; boundary="${boundary}-alt"`],
          multipart(`${boundary}-alt`, [plain, part(["Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64"], textBody(d.html))]),
        );
  const files = d.attachments ?? [];
  const whole =
    files.length === 0
      ? text
      : part(
          [`Content-Type: multipart/mixed; boundary="${boundary}-mix"`],
          multipart(`${boundary}-mix`, [
            text,
            ...files.map((f) =>
              part(
                [
                  `Content-Type: ${oneLine(f.mimeType) || "application/octet-stream"}`,
                  `Content-Disposition: attachment; ${fileParam(f.filename)}`,
                  "Content-Transfer-Encoding: base64",
                ],
                base64Lines(f.data),
              ),
            ),
          ]),
        );
  return `${headers.join("\r\n")}\r\n${whole}\r\n`;
}

/** How long the send-as settings are kept before they are read again: a signature changed in Gmail shows within this. */
const SEND_AS_KEEP_MS = 10 * 60 * 1000;

/** One connected Gmail account's calls. */
export class GmailClient {
  private readonly opts: GmailClientOptions;
  private readonly auth: GoogleAuth;
  private sendAsKept: { at: number; list: GmailSendAs[] } | null = null;

  constructor(opts: GmailClientOptions) {
    this.opts = opts;
    this.auth = opts.auth ?? new GoogleAuth(opts);
  }

  private now(): number {
    return (this.opts.now?.() ?? new Date()).getTime();
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
    return (await this.sendAs()).map((s) => s.address);
  }

  /**
   * The addresses the person writes from, each with its name and signature (plan 076), kept for SEND_AS_KEEP_MS. A
   * mailbox whose settings cannot be read gives its own address alone, with no name or signature.
   */
  async sendAs(): Promise<GmailSendAs[]> {
    const kept = this.sendAsKept;
    if (kept && this.now() - kept.at < SEND_AS_KEEP_MS) return kept.list;
    let found: GmailSendAs[] = [];
    try {
      const r = rec(await this.call("GET", "/settings/sendAs"));
      found = list(r.sendAs)
        .map((v) => {
          const s = rec(v);
          return { address: str(s.sendAsEmail), name: str(s.displayName), signature: str(s.signature), isDefault: s.isDefault === true };
        })
        .filter((s) => s.address);
    } catch (error) {
      // Settings Gmail will not show (a 403 that is not an admin's block) leave the mailbox's own address.
      if (!(error instanceof GoogleError) || error.status !== 403 || error.reason?.toLowerCase() === "admin_policy_enforced") throw error;
    }
    if (!found.length) found = [{ address: (await this.profile()).emailAddress, name: "", signature: "", isDefault: true }];
    this.sendAsKept = { at: this.now(), list: found };
    return found;
  }

  /** One attachment's bytes, by the message it is on and Gmail's id for it, for a forward (plan 076). */
  async attachment(messageId: string, attachmentId: string): Promise<Buffer> {
    const r = rec(await this.call("GET", `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`));
    return Buffer.from(str(r.data), "base64url");
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
        if (error instanceof GoogleError && error.status === 404) return { kind: "expired" };
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

  /**
   * One page of the threads in the inbox, newest first (plan 088), by the INBOX label rather than a search, since a
   * search can lag behind the mailbox and the label cannot.
   */
  async listInbox(pageToken?: string): Promise<GmailThreadPage> {
    const r = rec(await this.call("GET", "/threads", { labelIds: "INBOX", maxResults: "500", ...(pageToken ? { pageToken } : {}) }));
    const next = str(r.nextPageToken);
    return {
      threads: list(r.threads)
        .map((t) => str(rec(t).id))
        .filter(Boolean),
      ...(next ? { nextPageToken: next } : {}),
    };
  }

  /** A thread with its messages: their headers only (metadata), or every part (full). */
  async getThread(threadId: string, format: "metadata" | "full"): Promise<GmailThread> {
    const r = rec(await this.call("GET", `/threads/${encodeURIComponent(threadId)}`, { format }));
    return { id: str(r.id), historyId: str(r.historyId), messages: list(r.messages).map(parseMessage) };
  }

  /**
   * Put labels on and take labels off the given messages in one request: INBOX off to archive, UNREAD off to mark read,
   * and either back on to undo. By message, not by thread, so mail that came after what the person saw keeps its labels.
   * A list left out or empty is not sent.
   */
  async batchModify(ids: string[], change: { addLabels?: string[]; removeLabels?: string[] }): Promise<void> {
    const add = change.addLabels ?? [];
    const remove = change.removeLabels ?? [];
    if (ids.length === 0 || (add.length === 0 && remove.length === 0)) return;
    await this.call("POST", "/messages/batchModify", undefined, {
      ids,
      ...(add.length ? { addLabelIds: add } : {}),
      ...(remove.length ? { removeLabelIds: remove } : {}),
    });
  }

  /** The account's labels: Gmail's own (INBOX, UNREAD, STARRED and the like) and the ones the person made. */
  async labels(): Promise<GmailLabel[]> {
    const r = rec(await this.call("GET", "/labels"));
    return list(r.labels).map((l) => ({ id: str(rec(l).id), name: str(rec(l).name), type: rec(l).type === "system" ? "system" : "user" }));
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
    // A new message (a script's, plan 2026-11-11) has no thread yet: Gmail starts one.
    const r = rec(await this.call("POST", "/messages/send", undefined, { raw, ...(reply.threadId ? { threadId: reply.threadId } : {}) }));
    return { id: str(r.id) };
  }

  /** A Gmail call through the account's sign-in (GoogleAuth): its JSON answer, `{}` for an empty one. */
  private call(method: "GET" | "POST", path: string, query?: Record<string, string>, body?: unknown): Promise<unknown> {
    return this.auth.json({ service: "gmail", method, url: `${API}${path}`, ...(query ? { query } : {}), ...(body === undefined ? {} : { json: body }) });
  }
}
