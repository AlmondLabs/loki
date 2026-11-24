import { randomUUID } from "node:crypto";
import { headerMailboxes } from "../core/mail-header.ts";
import type { Accounts } from "./accounts.ts";
import type { GoogleApp } from "./google-app.ts";
import { GOOGLE_TIMEOUT_MS, GoogleAuth, GoogleError } from "./google-auth.ts";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
/** Gmail's upload route for a send, which takes a message up to Gmail's 25 MB where the JSON route stops far sooner. */
const UPLOAD_SEND = "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send";
const UPLOAD_DRAFT = "https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts";
const UPLOAD_CAP_BYTES = 17 * 1024 * 1024;

const uploadTimeoutMs = (bytes: number): number => Math.max(GOOGLE_TIMEOUT_MS, Math.ceil((120_000 * bytes) / UPLOAD_CAP_BYTES));

export interface GmailHeader {
  name: string;
  value: string;
}

/** A part of a message's MIME tree, in Gmail's own names; `body.data` is base64url, present with format full. */
export interface GmailMessagePart {
  /** The part's place in the tree ("0", "1.2"), which stays the same each time the message is read. */
  partId?: string;
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

export interface GmailLabelChange {
  message: GmailMessage;
  labelIds: string[];
}

export interface GmailHistoryRecord {
  id: string;
  messagesAdded: GmailMessage[];
  messagesDeleted: GmailMessage[];
  labelsAdded: GmailLabelChange[];
  labelsRemoved: GmailLabelChange[];
}

export type GmailHistory = { kind: "changes"; history: GmailHistoryRecord[]; history_id: string } | { kind: "expired" };

export interface GmailLabel {
  id: string;
  name: string;
  type: "system" | "user";
}

export interface GmailMessagePage {
  messages: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
}

export interface GmailThreadPage {
  threads: string[];
  nextPageToken?: string;
}

export interface GmailProfile {
  emailAddress: string;
  historyId: string;
}

export interface GmailAttachment {
  filename: string;
  mimeType: string;
  data: Buffer;
}

export interface GmailDraftInput {
  threadId: string;
  inReplyTo: string;
  references: string[];
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  from?: string;
  bcc?: string[];
  html?: string;
  attachments?: GmailAttachment[];
  outboxId?: string;
  messageId?: string;
  reaction?: string;
}

export const OUTBOX_HEADER = "X-Loki-Outbox";

export interface GmailSendAs {
  address: string;
  name: string;
  signature: string;
  isDefault: boolean;
}

export interface GmailClientOptions {
  accounts: Accounts;
  account_id: string;
  auth?: GoogleAuth;
  sharedApp?: GoogleApp;
  fetch?: typeof fetch;
  now?: () => Date;
  timeout?: () => AbortSignal;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const list = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);
const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});

function parsePart(v: unknown): GmailMessagePart {
  const r = rec(v);
  const body = rec(r.body);
  return {
    ...(typeof r.partId === "string" ? { partId: r.partId } : {}),
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
const part = (headers: string[], body: string): string => `${headers.join("\r\n")}\r\n\r\n${body}`;
const multipart = (boundary: string, parts: string[]): string => `${parts.map((p) => `--${boundary}\r\n${p}`).join("\r\n")}\r\n--${boundary}--`;
/** A file name as a MIME parameter, in RFC 2231's form so a name in any language survives. */
const fileParam = (name: string): string => `filename*=UTF-8''${encodeURIComponent(oneLine(name) || "attachment")}`;

export function rfc2822(d: GmailDraftInput, boundary = "loki"): string {
  const references = [...d.references, d.inReplyTo].map(oneLine).filter(Boolean);
  const to = d.to.flatMap(mailboxes);
  const cc = d.cc.flatMap(mailboxes);
  const bcc = (d.bcc ?? []).flatMap(mailboxes);
  const headers = [
    d.from ? `From: ${oneLine(d.from)}` : "",
    to.length ? `To: ${to.join(", ")}` : "",
    cc.length ? `Cc: ${cc.join(", ")}` : "",
    // Outside (Gmail): Gmail takes Bcc from the message it sends and leaves it off what the others get.
    bcc.length ? `Bcc: ${bcc.join(", ")}` : "",
    `Subject: ${encodedWord(oneLine(d.subject))}`,
    d.inReplyTo ? `In-Reply-To: ${oneLine(d.inReplyTo)}` : "",
    references.length ? `References: ${[...new Set(references)].join(" ")}` : "",
    d.outboxId ? `${OUTBOX_HEADER}: ${oneLine(d.outboxId)}` : "",
    d.messageId ? `Message-ID: ${oneLine(d.messageId)}` : "",
    "MIME-Version: 1.0",
  ].filter(Boolean);
  const plain = part(["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64"], textBody(d.body));
  // Outside (Gmail): a reaction is its own part between the plain text and the HTML (developers.google.com/workspace/gmail/reactions/format).
  const reaction =
    d.reaction === undefined
      ? []
      : [
          part(
            ["Content-Type: text/vnd.google.email-reaction+json; charset=UTF-8", "Content-Transfer-Encoding: base64"],
            textBody(JSON.stringify({ emoji: d.reaction, version: 1 })),
          ),
        ];
  const html = d.html === undefined ? [] : [part(["Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64"], textBody(d.html))];
  const text =
    reaction.length + html.length === 0
      ? plain
      : part([`Content-Type: multipart/alternative; boundary="${boundary}-alt"`], multipart(`${boundary}-alt`, [plain, ...reaction, ...html]));
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

const SEND_AS_KEEP_MS = 10 * 60 * 1000;

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

  async profile(): Promise<GmailProfile> {
    const r = rec(await this.call("GET", "/profile"));
    return { emailAddress: str(r.emailAddress), historyId: str(r.historyId) };
  }

  async sendAsAddresses(): Promise<string[]> {
    return (await this.sendAs()).map((s) => s.address);
  }

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
      // Outside (Gmail): settings Gmail will not show (a 403 that is not an admin's block) leave the mailbox's own address.
      if (!(error instanceof GoogleError) || error.status !== 403 || error.reason?.toLowerCase() === "admin_policy_enforced") throw error;
    }
    if (!found.length) found = [{ address: (await this.profile()).emailAddress, name: "", signature: "", isDefault: true }];
    this.sendAsKept = { at: this.now(), list: found };
    return found;
  }

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

  async listMessages(q: string, pageToken?: string): Promise<GmailMessagePage> {
    const r = rec(await this.call("GET", "/messages", { q, ...(pageToken ? { pageToken } : {}) }));
    const next = str(r.nextPageToken);
    return {
      messages: list(r.messages).map((m) => ({ id: str(rec(m).id), threadId: str(rec(m).threadId) })),
      ...(next ? { nextPageToken: next } : {}),
    };
  }

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

  async getMessage(messageId: string): Promise<GmailMessage> {
    return parseMessage(await this.call("GET", `/messages/${encodeURIComponent(messageId)}`, { format: "full" }));
  }

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

  async labels(): Promise<GmailLabel[]> {
    const r = rec(await this.call("GET", "/labels"));
    return list(r.labels).map((l) => ({ id: str(rec(l).id), name: str(rec(l).name), type: rec(l).type === "system" ? "system" : "user" }));
  }

  async sendReply(reply: GmailDraftInput): Promise<{ id: string; threadId?: string }> {
    const thread = reply.threadId ? { threadId: reply.threadId } : {};
    const r = rec(
      reply.attachments?.length
        ? await this.upload(rfc2822(reply), thread, UPLOAD_SEND)
        : await this.call("POST", "/messages/send", undefined, { raw: Buffer.from(rfc2822(reply), "utf8").toString("base64url"), ...thread }),
    );
    return { id: str(r.id), ...(typeof r.threadId === "string" ? { threadId: r.threadId } : {}) };
  }

  async createDraft(draft: GmailDraftInput): Promise<{ id: string; message_id: string; threadId?: string }> {
    const thread = draft.threadId ? { threadId: draft.threadId } : {};
    const r = rec(
      draft.attachments?.length
        ? await this.upload(rfc2822(draft), { message: thread }, UPLOAD_DRAFT)
        : await this.call("POST", "/drafts", undefined, { message: { raw: Buffer.from(rfc2822(draft), "utf8").toString("base64url"), ...thread } }),
    );
    const message = rec(r.message);
    return { id: str(r.id), message_id: str(message.id), ...(typeof message.threadId === "string" ? { threadId: message.threadId } : {}) };
  }

  private upload(message: string, meta: Record<string, unknown>, url: string): Promise<unknown> {
    // The boundary must not occur in the message (https://www.rfc-editor.org/rfc/rfc2046#section-5.1.1), whose own
    // boundaries start "loki-" and whose files are base64.
    const boundary = `upload-${randomUUID()}`;
    const body = Buffer.from(
      [
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}`,
        `--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n${message}`,
        `--${boundary}--\r\n`,
      ].join("\r\n"),
      "utf8",
    );
    return this.auth.json({
      service: "gmail",
      method: "POST",
      url,
      query: { uploadType: "multipart" },
      body: { data: new Uint8Array(body), type: `multipart/related; boundary=${boundary}` },
      timeoutMs: uploadTimeoutMs(body.length),
    });
  }

  private call(method: "GET" | "POST", path: string, query?: Record<string, string>, body?: unknown): Promise<unknown> {
    return this.auth.json({ service: "gmail", method, url: `${API}${path}`, ...(query ? { query } : {}), ...(body === undefined ? {} : { json: body }) });
  }
}
