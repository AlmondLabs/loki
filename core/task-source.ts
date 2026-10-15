import type { Task } from "./frame-types.ts";

/**
 * A task filed from a chat message ("Add task"): which message, so the task links back to it and the message
 * shows the task's chip. Transcript rows carry no id, so a message is named by its role and a short hash of its
 * text, the same in the live thread and in history; the time it was written backs that up.
 */
export interface TaskSource {
  /** The whole message, or a selection inside it (⌘⇧T). */
  origin: "message" | "selection";
  role: "user" | "assistant";
  /** messageKey(role, text) of the message. */
  key: string;
  /** When the message was written, when the row knew. */
  at: string | null;
  /** A short quote: the selection, or the message's opening, on one line. */
  quote: string;
}

/** The longest quote kept on a task's metadata; the whole text is its description. */
export const QUOTE_MAX = 160;
/** The longest description a message makes: a long reply is cut, with a mark. */
export const DESCRIPTION_MAX = 4000;
/** The longest progress note a chip shows (the agent's newest comment). */
export const NOTE_MAX = 200;

/** FNV-1a over the role and the text (line endings and edge whitespace aside), as 8 hex digits. */
export function messageKey(role: string, text: string): string {
  const s = `${role}\u0000${text.replace(/\r\n/g, "\n").trim()}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Text on one line, at most `max` characters, cut with an ellipsis. */
export function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/**
 * The quote a task keeps: the text on one line without markdown's marks, as find in the transcript reads it
 * (chat/transcript-window.ts), so the quote both reads plainly in Tasks and finds its message again.
 */
export function quoteOf(text: string, max = QUOTE_MAX): string {
  return oneLine(text.replace(/[*_`~#>|\\[\]]/g, ""), max);
}

/**
 * The title the editor starts with: the text's first line that says something, without markdown's marks
 * (headings, list bullets, quotes, emphasis, inline code, a link's address), cut to a title's length.
 */
export function titleFrom(text: string, max = 120): string {
  for (const raw of text.split("\n")) {
    const line = raw
      .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_`~]+/g, "")
      .trim();
    if (line && !/^`{3}/.test(raw.trim())) return oneLine(line, max);
  }
  return "";
}

/** The task's description: the message or selection as a markdown quote. */
export function quoteBlock(text: string): string {
  const body = text.replace(/\r\n/g, "\n").trim();
  const cut = body.length > DESCRIPTION_MAX ? `${body.slice(0, DESCRIPTION_MAX).trimEnd()}…` : body;
  return cut
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");
}

/** A source as the bridge receives it, or undefined when it is not one. */
export function parseTaskSource(v: unknown): TaskSource | undefined {
  if (!v || typeof v !== "object") return undefined;
  const s = v as Record<string, unknown>;
  if (s.origin !== "message" && s.origin !== "selection") return undefined;
  if (s.role !== "user" && s.role !== "assistant") return undefined;
  if (typeof s.key !== "string" || !/^[0-9a-f]{8}$/.test(s.key)) return undefined;
  const at = typeof s.at === "string" && s.at.length <= 40 && Number.isFinite(Date.parse(s.at)) ? s.at : null;
  const quote = typeof s.quote === "string" ? oneLine(s.quote, QUOTE_MAX) : "";
  return { origin: s.origin, role: s.role, key: s.key, at, quote };
}

/** The source stamped on a task's metadata (mod/tasks.ts createArgs). */
export function sourceMetadata(s: TaskSource): Record<string, string> {
  const md: Record<string, string> = { origin: s.origin, msg_role: s.role, msg_key: s.key };
  if (s.at) md.msg_at = s.at;
  if (s.quote) md.quote = s.quote;
  return md;
}

/** The source a task was filed from, read back from its metadata; null for a task not filed from a message. */
export function taskSource(t: Task): (TaskSource & { conversation: string | null; agent_id: string | null }) | null {
  // The metadata is the task file's, read from disk: any key may be missing.
  const md: Partial<Record<string, string>> = t.metadata;
  if ((md.origin !== "message" && md.origin !== "selection") || (md.msg_role !== "user" && md.msg_role !== "assistant") || !md.msg_key) return null;
  return {
    origin: md.origin,
    role: md.msg_role,
    key: md.msg_key,
    at: md.msg_at ?? null,
    quote: md.quote ?? "",
    conversation: md.conversation ?? null,
    agent_id: md.agent_id ?? null,
  };
}

/** Whether a task came from this message: its key, or failing that (the text read back differently) its role and time. */
export function fromMessage(t: Task, row: { role: string; text: string; at?: string }): boolean {
  const s = taskSource(t);
  if (s?.role !== row.role) return false;
  return s.key === messageKey(row.role, row.text) || (!!s.at && s.at === row.at);
}

/**
 * The tasks filed from a conversation's messages, by message key; a task matched only by its time is filed under
 * its own key too, and the row looks it up by both (tasksForRow).
 */
export function tasksByMessage(tasks: Task[], conversation: string): Map<string, Task[]> {
  const byKey = new Map<string, Task[]>();
  for (const t of tasks) {
    const s = taskSource(t);
    if (s?.conversation !== conversation) continue;
    for (const k of s.at ? [s.key, `${s.role}@${s.at}`] : [s.key]) byKey.set(k, [...(byKey.get(k) ?? []), t]);
  }
  return byKey;
}

/** One message's tasks out of tasksByMessage, each once. */
export function tasksForRow(byKey: Map<string, Task[]>, row: { role: string; text: string; at?: string }): Task[] {
  const found = [...(byKey.get(messageKey(row.role, row.text)) ?? []), ...(row.at ? (byKey.get(`${row.role}@${row.at}`) ?? []) : [])];
  return [...new Map(found.map((t) => [t.id, t])).values()];
}

/** What a message's chip says: still open, an agent's done? waiting for you, or done. */
export type ChipState = "open" | "waiting" | "done";

/** The state of a task's chip on its message: done once closed, waiting while an agent has asked whether it is done, open otherwise. */
export function chipState(t: Task): ChipState {
  if (t.status === "closed") return "done";
  return t.metadata.done_asked ? "waiting" : "open";
}
