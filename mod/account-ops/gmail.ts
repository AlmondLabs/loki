import { htmlToText, tidyMail } from "../../core/mail-text.ts";
import type { GmailClient, GmailMessage, GmailMessagePart } from "../gmail.ts";
import { MAIL_HTML_MAX, type ThreadMessage, type ThreadText } from "./thread.ts";

/**
 * Reading Gmail (plan 097, U1): a thread as loki's messages, and a message's text and files. One implementation, which
 * hand-offs, Flow's cards, the owner's account tools and the scripts' Gmail tools all call.
 */

/** A base64url body as text. */
const decoded = (data: string): string => Buffer.from(data, "base64url").toString("utf8");

/** The first part of a MIME tree of one type, depth first, that has a body. */
function partOf(part: GmailMessagePart | null, mimeType: string): GmailMessagePart | null {
  if (!part) return null;
  if (part.mimeType === mimeType && part.body.data && !part.filename) return part;
  for (const p of part.parts) {
    const found = partOf(p, mimeType);
    if (found) return found;
  }
  return null;
}

/** A message's header by name, in any case; "" when it has none. */
export const mailHeader = (m: GmailMessage, name: string): string => m.payload?.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

/**
 * A Gmail thread read with format full: its subject (its first message's) and each message as loki's: its plain part,
 * else its HTML as text, else its snippet; and its HTML part as written, when it has one, for the person's card to
 * draw. `accountId` is the mailbox's, so a message from its own address is marked as the person's.
 */
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

/** A Gmail thread's messages as a ThreadText reader, for hand-offs and Flow's cards. */
export function gmailThreadText(client: (accountId: string) => Pick<GmailClient, "getThread">): ThreadText {
  return async (accountId, threadId) => (await gmailThread(client(accountId), accountId, threadId)).messages;
}

/** A message read with format full as text (its plain part, else its HTML as text, else its snippet) and its HTML part as written, or null. */
export function mailParts(m: GmailMessage): { text: string; html: string | null } {
  const plain = partOf(m.payload, "text/plain")?.body.data;
  const html = partOf(m.payload, "text/html")?.body.data;
  const markup = html ? decoded(html) : null;
  return { text: plain ? tidyMail(decoded(plain)) : markup !== null ? htmlToText(markup) : tidyMail(m.snippet), html: markup };
}

/** A message's attachments, read with format full: each file part's name, type and Gmail's id for its bytes. */
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

/** The address in a From header ("Ada <ada@acme.com>" or a bare address), lowercased; "" when it has none. */
function addressOf(from: string): string {
  const angled = /<([^>]+)>/.exec(from)?.[1] ?? from;
  return angled.trim().toLowerCase();
}
