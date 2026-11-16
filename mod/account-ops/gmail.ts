import { htmlToText, tidyMail } from "../../core/mail-text.ts";
import type { AccountRecord } from "../accounts.ts";
import type { GmailClient, GmailMessage, GmailMessagePart } from "../gmail.ts";
import { GoogleError } from "../google-auth.ts";
import { headerOf, replyAllOf, replySubject, replyTarget } from "../reply-addressing.ts";
import { MAIL_HTML_MAX, type FlowRecord, type ReplyDestination, type ThreadMessage, type ThreadText } from "./thread.ts";

const decoded = (data: string): string => Buffer.from(data, "base64url").toString("utf8");

function partOf(part: GmailMessagePart | null, mimeType: string): GmailMessagePart | null {
  if (!part) return null;
  if (part.mimeType === mimeType && part.body.data && !part.filename) return part;
  for (const p of part.parts) {
    const found = partOf(p, mimeType);
    if (found) return found;
  }
  return null;
}

export const mailHeader = (m: GmailMessage, name: string): string => m.payload?.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

export async function gmailThread(
  client: Pick<GmailClient, "getThread">,
  accountId: string,
  threadId: string,
): Promise<{ subject: string; messages: ThreadMessage[] }> {
  const thread = await client.getThread(threadId, "full");
  const own = accountId.startsWith("gmail:") ? accountId.slice("gmail:".length) : "";
  const opening = thread.messages.at(0);
  const messages = thread.messages.map((m): ThreadMessage => {
    const from = mailHeader(m, "from");
    const at = Number(m.internalDate);
    const { text, html } = mailParts(m);
    const to = mailHeader(m, "to");
    const cc = mailHeader(m, "cc");
    const files = mailAttachments(m).map((f) => ({ name: f.filename, size: f.size }));
    return {
      sender: from || "someone",
      id: m.id,
      mine: own !== "" && addressOf(from) === own,
      at: Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : "",
      text,
      ...(html !== null && html.length <= MAIL_HTML_MAX ? { html } : {}),
      ...(to ? { to } : {}),
      ...(cc ? { cc } : {}),
      ...(files.length ? { files } : {}),
    };
  });
  return { subject: opening ? mailHeader(opening, "subject") : "", messages };
}

export function gmailThreadText(client: (accountId: string) => Pick<GmailClient, "getThread">): ThreadText {
  return async (accountId, threadId) => (await gmailThread(client(accountId), accountId, threadId)).messages;
}

export function mailParts(m: GmailMessage): { text: string; html: string | null } {
  const plain = partOf(m.payload, "text/plain")?.body.data;
  const html = partOf(m.payload, "text/html")?.body.data;
  const markup = html ? decoded(html) : null;
  return { text: plain ? tidyMail(decoded(plain)) : markup !== null ? htmlToText(markup) : tidyMail(m.snippet), html: markup };
}

export function mailAttachments(m: GmailMessage): Array<{ filename: string; mimeType: string; attachmentId: string; size: number }> {
  const out: Array<{ filename: string; mimeType: string; attachmentId: string; size: number }> = [];
  const walk = (part: GmailMessagePart | null) => {
    if (!part) return;
    if (part.filename && part.body.attachmentId)
      out.push({ filename: part.filename, mimeType: part.mimeType, attachmentId: part.body.attachmentId, size: part.body.size });
    part.parts.forEach(walk);
  };
  walk(m.payload);
  return out;
}

function addressOf(from: string): string {
  const angled = /<([^>]+)>/.exec(from)?.[1] ?? from;
  return angled.trim().toLowerCase();
}

export type ReplyGmailReads = Pick<GmailClient, "getThread" | "sendAsAddresses">;

export async function gmailReplyDestination(account: AccountRecord, client: ReplyGmailReads, reference: string, flow: FlowRecord): Promise<ReplyDestination> {
  const threadId = reference.trim();
  const thread = await client.getThread(threadId, "metadata").catch((err: unknown) => {
    if (err instanceof GoogleError && (err.status === 404 || err.status === 400)) throw new Error(`there is no thread ${threadId} in ${account.address}`);
    throw err;
  });
  const record = flow(account.account_id, threadId);
  const newest = replyTarget(thread.messages);
  const own = [account.address, ...(await client.sendAsAddresses().catch(() => []))];
  return {
    thread_id: threadId,
    subject: replySubject(headerOf(newest, "Subject") || record?.subject_or_first_line || ""),
    ...replyAllOf(newest, own),
    place: null,
    in_flow: record !== null,
    shared_outside: false,
    heard_by: null,
  };
}
