/** An image attached to an outgoing message: base64 payload plus a data URL for showing it. */
export interface ImageAttachment {
  id: string;
  mediaType: string;
  data: string;
  url: string;
}

/**
 * A file attached to a message that is not an image: already uploaded to the Mac (mod/uploads.ts), so the
 * message carries only where it is, in Letta's attachment tag, and the agent reads it with its own tools.
 */
export interface FileAttachment {
  id: string;
  kind: "file";
  path: string;
  name: string;
  size: number;
  mime: string;
}

/** What the message box holds: images (sent inside the message) and files (sent as their path). */
export type Attachment = ImageAttachment | FileAttachment;

export const isFileAttachment = (a: Attachment): a is FileAttachment => (a as FileAttachment).kind === "file";

const xmlAttr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A file as Letta's channels hand one to an agent: `<attachment kind="file" local_path=… name=… mime_type=… size_bytes=… />`. */
export function attachmentTag(f: { path: string; name: string; size: number; mime: string }): string {
  return `<attachment kind="file" local_path="${xmlAttr(f.path)}" name="${xmlAttr(f.name)}" mime_type="${xmlAttr(f.mime)}" size_bytes="${f.size}" />`;
}

/** The text a message goes out with: what was typed, then one tag per file. */
export function withAttachments(text: string, files: Array<{ path: string; name: string; size: number; mime: string }>): string {
  if (!files.length) return text;
  const tags = files.map(attachmentTag).join("\n");
  return text.trim() ? `${text}\n\n${tags}` : tags;
}

export type UserContent = string | Array<{ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } }>;

/**
 * The `content` of a create_message user message: a plain string when there are
 * no images, otherwise text and image parts in the shape Letta's app-server
 * validates (`{ type: "image", source: { type: "base64", media_type, data } }`).
 */
export function buildUserContent(text: string, images: ImageAttachment[] = [], context?: string): UserContent {
  if (!images.length && !context) return text;
  const parts: Exclude<UserContent, string> = [];
  if (context) parts.push({ type: "text", text: context });
  if (text.trim()) parts.push({ type: "text", text });
  for (const img of images) parts.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
  return parts;
}

/**
 * The environment note, in the shape Letta Desktop uses, so an agent talked to from loki keeps its sense of time
 * (it has no clock, and chats run for days) and knows which chat you are on. The folder is not in it: Letta Code
 * sends its own environment context (working directory, git) at a session's start, whenever the folder changes
 * and after compaction. Rendered transcripts strip system reminders, so you never see it. This is the full note,
 * a chat's first; `environmentNote` decides when a chat needs one again.
 */
export function environmentReminder(opts: { now?: Date; desk?: string | null; locale?: string } = {}): string {
  const now = opts.now ?? new Date();
  const when = localTime(now, opts.locale);
  const lines = [
    "<system-reminder>",
    "This is an automated message providing context about the user's environment.",
    "The user is sending a message via loki, on their Mac or a paired phone (not the Letta desktop app).",
    `User's device local time: ${when}`,
  ];
  if (opts.desk) lines.push(`The user is looking at this conversation in loki, the chat ("${opts.desk}").`);
  lines.push("</system-reminder>");
  return lines.join("\n");
}


/** A chat's note is sent again once this long has passed since its last one. */
export const ENV_NOTE_EVERY_MS = 30 * 60_000;

/** What a chat was last told: when, on which local day, in which time zone, and the chat's name. */
export interface EnvNoteTold {
  at: number;
  day: string;
  zone: string;
  desk: string | null;
}

/**
 * The note this message should carry, if any. A chat's first message gets the full note. After that it comes
 * again only when the agent's picture would be wrong: 30 minutes on, a new local day, another time zone, or the
 * chat renamed. Then it is the short form (the time, and the name when that changed). `told` is what to remember
 * once the message goes out.
 */
export function environmentNote(
  last: EnvNoteTold | undefined,
  opts: { now?: Date; desk?: string | null; locale?: string; zone?: string } = {},
): { text: string | null; told: EnvNoteTold } {
  const now = opts.now ?? new Date();
  const desk = opts.desk ?? null;
  const told: EnvNoteTold = {
    at: now.getTime(),
    day: `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`,
    zone: opts.zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    desk,
  };
  if (!last) return { text: environmentReminder({ now, desk, locale: opts.locale }), told };
  const renamed = desk !== null && desk !== last.desk;
  const due = told.at - last.at >= ENV_NOTE_EVERY_MS || told.day !== last.day || told.zone !== last.zone;
  if (!due && !renamed) return { text: null, told: { ...last, desk: desk ?? last.desk } };
  const lines = ["<system-reminder>", `User's device local time: ${localTime(now, opts.locale)}`];
  if (renamed) lines.push(`The user is looking at this conversation in loki, the chat ("${desk}").`);
  lines.push("</system-reminder>");
  return { text: lines.join("\n"), told };
}

function localTime(now: Date, locale?: string): string {
  return now.toLocaleString(locale ?? undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short" });
}

/** One question from Letta's AskUserQuestion tool. */
export interface AskQuestion {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
}

/** Read the tool's input defensively: only questions with text and at least one option count. */
export function askQuestions(input: unknown): AskQuestion[] {
  const qs = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(qs)) return [];
  const out: AskQuestion[] = [];
  for (const q of qs as Array<Record<string, unknown>>) {
    if (typeof q?.question !== "string" || !q.question.trim()) continue;
    const options = Array.isArray(q.options)
      ? (q.options as Array<Record<string, unknown>>).filter((o) => typeof o?.label === "string" && o.label.trim()).map((o) => ({ label: o.label as string, description: typeof o.description === "string" ? o.description : undefined }))
      : [];
    out.push({ question: q.question, header: typeof q.header === "string" ? q.header : undefined, options, multiSelect: q.multiSelect === true });
  }
  return out;
}

/**
 * The tool input handed back with the answers filled in, keyed by question text
 * (multi-select answers are labels joined with ", "), which is how Letta's own
 * channel clients answer: an allow decision with this as `updated_input`.
 */
export function buildQuestionAnswer(input: unknown, answers: Record<string, string | string[]>): Record<string, unknown> {
  const base = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const prev = (base.answers as Record<string, string> | undefined) ?? {};
  const flat: Record<string, string> = { ...prev };
  for (const [q, a] of Object.entries(answers)) flat[q] = Array.isArray(a) ? a.join(", ") : a;
  return { ...base, answers: flat };
}
