import { basename } from "node:path";
import { htmlToText } from "../../core/mail-text.ts";
import type { GmailMessage, GmailMessagePart } from "../gmail.ts";
import { uploadToDrive } from "./drive.ts";
import { accountFor, count, flag, listing, md5, optText, readInChat, rec, str, textArg, textList, writeInChat, type GoogleToolDef } from "./core.ts";

/**
 * Gmail for scripts (plan 2026-11-11 scripts, U7): search, read, change labels, send, and save attachments, to the
 * chat's folder or straight to Drive (R20), whose bytes never pass through the script. These go to Gmail directly,
 * never through Flow's own moves (mod/account-threads.ts): Flow sees what they change as it sees a change made in
 * Gmail, and nothing a script does is taken for the person's own pick (R22). A script may send (R15); a reply card in
 * Flow still drafts.
 */

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

const header = (m: GmailMessage, name: string): string => m.payload?.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

/** Every part of a message's MIME tree, depth first. */
function partsOf(part: GmailMessagePart | null): GmailMessagePart[] {
  return part ? [part, ...part.parts.flatMap(partsOf)] : [];
}

/** The part of a message's MIME tree (as Gmail answers it) that holds an attachment. */
function attachmentPart(part: unknown, attachmentId: string): { filename: string; mimeType: string } | undefined {
  const p = rec(part);
  if (str(rec(p.body).attachmentId) === attachmentId) return { filename: str(p.filename), mimeType: str(p.mimeType) };
  for (const child of Array.isArray(p.parts) ? p.parts : []) {
    const found = attachmentPart(child, attachmentId);
    if (found) return found;
  }
  return undefined;
}

const decode = (data: string | undefined): string => (data ? Buffer.from(data, "base64url").toString("utf8") : "");

/** A message's text: its plain part, or its HTML part made plain. */
function textOf(m: GmailMessage): string {
  const parts = partsOf(m.payload).filter((p) => !p.filename);
  const plain = parts.find((p) => p.mimeType === "text/plain" && p.body.data);
  if (plain) return decode(plain.body.data);
  const html = parts.find((p) => p.mimeType === "text/html" && p.body.data);
  return html ? htmlToText(decode(html.body.data)) : "";
}

/** A message as a script reads it: who, when, its labels, its text, and its attachments by id. */
function messageOf(m: GmailMessage): Record<string, unknown> {
  return {
    id: m.id,
    thread_id: m.threadId,
    from: header(m, "From"),
    to: header(m, "To"),
    cc: header(m, "Cc"),
    subject: header(m, "Subject"),
    date: header(m, "Date"),
    labels: m.labelIds,
    text: textOf(m),
    attachments: partsOf(m.payload)
      .filter((p) => p.filename && p.body.attachmentId)
      .map((p) => ({ id: p.body.attachmentId, filename: p.filename, mime_type: p.mimeType, size: p.body.size })),
  };
}

const search: GoogleToolDef = {
  name: "google_gmail_search",
  description:
    'Search mail with Gmail\'s search syntax (`query`, e.g. "from:billing has:attachment newer_than:30d"): threads with their snippet. One page, or with `all_pages` every page saved to a file, answered with its path and the first 20.',
  properties: {
    query: { type: "string" },
    all_pages: { type: "boolean" },
    page: { type: "string", description: "next_page from an earlier answer" },
    page_size: { type: "integer", description: "Up to 500; default 100" },
  },
  required: ["query"],
  service: "gmail",
  reads: true,
  run: (call) => {
    const q = textArg(call.args, "query");
    const maxResults = String(count(call.args, "page_size", 100, 500));
    return listing(
      call,
      "google_gmail_search",
      flag(call.args, "all_pages"),
      async (token) => {
        const r = rec(
          await call.auth.json({ service: "gmail", method: "GET", url: `${API}/threads`, query: { q, maxResults, ...(token ? { pageToken: token } : {}) } }),
        );
        const threads = Array.isArray(r.threads) ? r.threads : [];
        return { items: threads.map((t) => ({ id: str(rec(t).id), snippet: str(rec(t).snippet) })), next: str(r.nextPageToken) || undefined };
      },
      optText(call.args, "page"),
    );
  },
};

const read: GoogleToolDef = {
  name: "google_gmail_read",
  description: "Read a mail thread (`thread`): each message's sender, recipients, subject, date, labels, text, and its attachments by id.",
  properties: { thread: { type: "string" } },
  required: ["thread"],
  service: "gmail",
  reads: true,
  run: async (call) => {
    const thread = await call.deps.gmail(call.account.account_id).getThread(textArg(call.args, "thread"), "full");
    return { id: thread.id, messages: thread.messages.map(messageOf) };
  },
};

const modify: GoogleToolDef = {
  name: "google_gmail_modify",
  description:
    "Change mail's labels: `messages` and/or whole `threads` (ids); `archive`, `read` (true marks read, false unread), `add_labels` and `remove_labels` (label ids or names). Answers with how many messages changed.",
  properties: {
    messages: { type: "array", items: { type: "string" } },
    threads: { type: "array", items: { type: "string" } },
    archive: { type: "boolean" },
    read: { type: "boolean" },
    add_labels: { type: "array", items: { type: "string" } },
    remove_labels: { type: "array", items: { type: "string" } },
  },
  service: "gmail",
  reads: false,
  run: async (call) => {
    const client = call.deps.gmail(call.account.account_id);
    const named = [...textList(call.args, "add_labels"), ...textList(call.args, "remove_labels")];
    const labels = named.length ? await client.labels() : [];
    const idOf = (name: string) => labels.find((l) => l.id === name || l.name.toLowerCase() === name.toLowerCase())?.id ?? name;
    const add = textList(call.args, "add_labels").map(idOf);
    const remove = textList(call.args, "remove_labels").map(idOf);
    if (call.args.archive === true) remove.push("INBOX");
    if (call.args.read === true) remove.push("UNREAD");
    if (call.args.read === false) add.push("UNREAD");
    const ids = [...textList(call.args, "messages")];
    for (const thread of textList(call.args, "threads")) ids.push(...(await client.getThread(thread, "metadata")).messages.map((m) => m.id));
    if (!ids.length) throw new Error("name `messages` or `threads` to change");
    if (!add.length && !remove.length) throw new Error("say what to change: archive, read, add_labels or remove_labels");
    // Gmail takes up to 1000 messages a call.
    for (let i = 0; i < ids.length; i += 1000) await client.batchModify(ids.slice(i, i + 1000), { addLabels: add, removeLabels: remove });
    return { changed: ids.length, added: add, removed: remove };
  },
};

const send: GoogleToolDef = {
  name: "google_gmail_send",
  description:
    "Send mail now: `to` (and `cc`, `bcc`), `subject`, `body` (plain text) or `html`, `attachments` (paths in this chat's folder). With `reply_to` (a thread id) it answers that thread's last message, in the thread. Answers with the sent message's id and thread.",
  properties: {
    to: { type: "array", items: { type: "string" } },
    cc: { type: "array", items: { type: "string" } },
    bcc: { type: "array", items: { type: "string" } },
    subject: { type: "string" },
    body: { type: "string" },
    html: { type: "string" },
    attachments: { type: "array", items: { type: "string" } },
    reply_to: { type: "string" },
  },
  required: ["to"],
  service: "gmail",
  reads: false,
  run: async (call) => {
    const client = call.deps.gmail(call.account.account_id);
    const to = textList(call.args, "to");
    if (!to.length) throw new Error("`to` is required");
    const replyTo = optText(call.args, "reply_to");
    const last = replyTo ? (await client.getThread(replyTo, "metadata")).messages.at(-1) : undefined;
    if (replyTo && !last) throw new Error(`there is no thread ${replyTo} in ${call.account.address}`);
    const subject =
      optText(call.args, "subject") ?? (last ? (/^re:/i.test(header(last, "Subject")) ? header(last, "Subject") : `Re: ${header(last, "Subject")}`) : "");
    const files = await Promise.all(
      textList(call.args, "attachments").map(async (path) => {
        const { full, data } = await readInChat(call.ctx, path);
        return { filename: basename(full), mimeType: "application/octet-stream", data: Buffer.from(data) };
      }),
    );
    const html = optText(call.args, "html");
    const sent = await client.sendReply({
      threadId: last?.threadId ?? "",
      inReplyTo: last ? header(last, "Message-ID") : "",
      references: last ? header(last, "References").split(/\s+/).filter(Boolean) : [],
      to,
      cc: textList(call.args, "cc"),
      bcc: textList(call.args, "bcc"),
      subject,
      body: optText(call.args, "body") ?? (html ? htmlToText(html) : ""),
      ...(html ? { html } : {}),
      ...(files.length ? { attachments: files } : {}),
    });
    return { id: sent.id, thread_id: last?.threadId ?? null, to, subject };
  },
};

const attachment: GoogleToolDef = {
  name: "google_gmail_attachment",
  description:
    "Save a mail attachment (`message`, `attachment` ids from google_gmail_read): to `path` in this chat's folder, or straight to Drive with `drive_folder` (a folder id, or \"root\"), named `name` or its own name. Its bytes never pass through the script. Answers with its name, size and MD5, and the Drive file's when it went there.",
  properties: {
    message: { type: "string" },
    attachment: { type: "string" },
    path: { type: "string" },
    drive_folder: { type: "string" },
    name: { type: "string" },
  },
  required: ["message", "attachment"],
  service: "gmail",
  reads: false,
  run: async (call) => {
    const messageId = textArg(call.args, "message");
    const attachmentId = textArg(call.args, "attachment");
    const path = optText(call.args, "path");
    const folder = optText(call.args, "drive_folder");
    if (!path && !folder) throw new Error("say where it goes: `path` or `drive_folder`");
    const client = call.deps.gmail(call.account.account_id);
    // Its name and type, from the part of the message that holds it.
    const part = attachmentPart(
      rec(await call.auth.json({ service: "gmail", method: "GET", url: `${API}/messages/${encodeURIComponent(messageId)}`, query: { format: "full" } }))
        .payload,
      attachmentId,
    );
    const name = optText(call.args, "name") ?? (part?.filename || (path ? basename(path) : "attachment"));
    const data = new Uint8Array(await client.attachment(messageId, attachmentId));
    const out: Record<string, unknown> = { name, size: data.byteLength, md5: md5(data) };
    if (path) out.path = await writeInChat(call.ctx, path, data);
    if (folder) {
      // Drive must be granted too: the account is checked again for it.
      accountFor(call.deps, call.ctx, call.account.address, "drive");
      out.drive_file = await uploadToDrive(call.auth, {
        data,
        name,
        mimeType: part?.mimeType || "application/octet-stream",
        ...(folder === "root" ? {} : { folder }),
      });
    }
    return out;
  },
};

/** The Gmail tools. */
export const gmailTools: GoogleToolDef[] = [search, read, modify, send, attachment];
