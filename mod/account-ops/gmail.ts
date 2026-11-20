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

export interface MailPictures {
  keep: (key: string, read: () => Promise<{ data: Buffer; type: string }>) => Promise<string | null>;
  attachment: (messageId: string, attachmentId: string) => Promise<Buffer>;
  waited: () => Promise<void>;
}

interface PastedPicture {
  message_id: string;
  content_id: string;
  part: GmailMessagePart;
}

const CID_SRC = /<img\b[^>]*?\ssrc\s*=\s*(?:"\s*cid:([^"]*)"|'\s*cid:([^']*)'|cid:([^\s"'>]+))/gi;

function cidOf(written: string): string {
  try {
    return decodeURIComponent(written.trim());
  } catch {
    return written.trim();
  }
}

function shownCids(html: string): Set<string> {
  return new Set([...html.matchAll(CID_SRC)].map((m) => cidOf(m[1] ?? m[2] ?? m[3] ?? "")));
}

function contentIdOf(part: GmailMessagePart): string {
  const value = part.headers.find((h) => h.name.toLowerCase() === "content-id")?.value.trim() ?? "";
  return /^<(.*)>$/.exec(value)?.[1] ?? value;
}

function pastedPictures(messageId: string, html: string, root: GmailMessagePart | null): PastedPicture[] {
  const shown = shownCids(html);
  const out: PastedPicture[] = [];
  const walk = (part: GmailMessagePart) => {
    const contentId = contentIdOf(part);
    if (part.mimeType.toLowerCase().startsWith("image/") && contentId && shown.has(contentId) && (part.body.attachmentId || part.body.data))
      out.push({ message_id: messageId, content_id: contentId, part });
    part.parts.forEach(walk);
  };
  if (root && shown.size) walk(root);
  return out;
}

async function namedPictures(accountId: string, wanted: PastedPicture[], pictures: MailPictures): Promise<Map<PastedPicture, string>> {
  const named = new Map<PastedPicture, string>();
  const all = Promise.all(
    wanted.map(async (p) => {
      const { attachmentId, data } = p.part.body;
      const read = async () => ({
        data: attachmentId ? await pictures.attachment(p.message_id, attachmentId) : Buffer.from(data ?? "", "base64url"),
        type: p.part.mimeType,
      });
      const name = await pictures.keep(`gmail:${accountId}:${p.message_id}:${p.content_id}`, read).catch(() => null);
      if (name) named.set(p, name);
    }),
  );
  await Promise.race([all, pictures.waited()]);
  return new Map(named);
}

export async function gmailThread(
  client: Pick<GmailClient, "getThread">,
  accountId: string,
  threadId: string,
  pictures?: MailPictures,
): Promise<{ subject: string; messages: ThreadMessage[] }> {
  const thread = await client.getThread(threadId, "full");
  const own = accountId.startsWith("gmail:") ? accountId.slice("gmail:".length) : "";
  const opening = thread.messages.at(0);
  const read = thread.messages.map((m) => {
    const { text, html } = mailParts(m);
    const kept = html !== null && html.length <= MAIL_HTML_MAX ? html : null;
    return { m, text, html: kept, wanted: pictures && kept !== null ? pastedPictures(m.id, kept, m.payload) : [] };
  });
  const named = pictures
    ? await namedPictures(
        accountId,
        read.flatMap((r) => r.wanted),
        pictures,
      )
    : new Map<PastedPicture, string>();
  const messages = read.map(({ m, text, html, wanted }): ThreadMessage => {
    const from = mailHeader(m, "from");
    const at = Number(m.internalDate);
    const to = mailHeader(m, "to");
    const cc = mailHeader(m, "cc");
    const shown = wanted.flatMap((p) => {
      const name = named.get(p);
      return name ? [{ picture: p, name }] : [];
    });
    const shownAttachments = new Set(shown.map((s) => s.picture.part.body.attachmentId));
    const files = mailAttachments(m)
      .filter((f) => !shownAttachments.has(f.attachmentId))
      .map((f) => ({ name: f.filename, size: f.size }));
    const inlineImages = Object.fromEntries(shown.map((s) => [s.picture.content_id, s.name]));
    return {
      sender: from || "someone",
      id: m.id,
      mine: own !== "" && addressOf(from) === own,
      at: Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : "",
      text,
      ...(html !== null ? { html } : {}),
      ...(shown.length ? { inline_images: inlineImages } : {}),
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
