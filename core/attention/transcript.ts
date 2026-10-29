/**
 * One row of a conversation as loki shows it everywhere (desk chat, Catch Up, the phone):
 * user and assistant bubbles, quiet tool markers, collapsible harness events.
 */
/**
 * A tool the agent ran, as the thread's steps show it: what it was, what it was given (the command, the path,
 * or the whole input), what came back, and whether it failed. Input and output are capped (TOOL_TEXT_MAX) so a
 * long log never rides every frame; `id` pairs a result with its call. Rows from before this was kept have none.
 */
export interface ToolStep {
  name: string;
  id?: string;
  input?: string;
  /** What the agent said the call is for (Bash's `description`), shown as the step's line when it gave one. */
  description?: string;
  output?: string;
  failed?: boolean;
  /** On a failed call: what went wrong, one line from the end of its whole result (core/harness.ts errorOf). */
  error?: string;
  /**
   * Set on a step a history page sent lean, without its input and output (plan 041): the row's position in the chat's
   * log, which `history_step_get` answers with the whole step.
   */
  row?: number;
}

/** A file a message carried (its attachment tag), shown as a chip on the bubble. */
export interface FileRef {
  path: string;
  name: string;
  size?: number;
  mime?: string;
}

/** One row of a conversation as every view draws it (the desk chat, the Inbox, the phone): a user or assistant bubble, a quiet tool marker, or a collapsible harness event. */
export interface TranscriptRow {
  role: "user" | "assistant" | "tool" | "event";
  text: string;
  /** On a tool row: the call, its input and its result, when they were seen. */
  tool?: ToolStep;
  summary?: string | null;
  detail?: string | null;
  /**
   * Set on an event a history page sent lean, without its long `detail` (plan 043): the row's position in the chat's
   * log, which `history_step_get` answers with the whole detail.
   */
  row?: number;
  /** Files a user message carried (attachment tags, core/attention/content.ts), from the live send and from history alike. */
  files?: FileRef[];
  /** Data URLs of images sent with a user message (live rows only; history shows a marker). */
  images?: string[];
  /** A user message typed mid-turn that has not gone out yet. */
  queued?: boolean;
  /** On the event a message sent from a suggestion leaves (plan 049): the chat the suggestion was made in, which the row opens. */
  link?: { agent_id: string; conversation_id: string };
  /**
   * When the message was written, ISO 8601 (the store's time, an imported log's `timestamp`, or the moment a
   * live row arrived). Absent when nobody knows: such a
   * row shows no time and starts no day.
   */
  at?: string;
}

/** How long a lean tool row's label and name may be: one line, as the closed step shows it. */
export const LEAN_LINE_MAX = 200;

/**
 * How long an event's detail may be and still travel with its page (plan 043). Most are longer (the median is about
 * 2,000 characters); a shorter one costs less than the round trip that would fetch it.
 */
export const LEAN_DETAIL_MAX = 1000;

const line = (text: string): string => {
  const first = text.split("\n", 1)[0];
  return first.length > LEAN_LINE_MAX || first.length < text.length ? `${first.slice(0, LEAN_LINE_MAX).trimEnd()}…` : first;
};

/**
 * The rows of a history page as they travel (plans 041 and 043), from position `start`: a finished tool row keeps its
 * one-line label and name, its description and whether it failed, and leaves out its input and output, which most of a
 * page's bytes were; its step says where it is, so opening it fetches the rest. An event with a detail longer than
 * LEAN_DETAIL_MAX (a background task's result, a loaded skill) leaves the detail out the same way and says where it
 * is. A call still waiting for its result goes whole, so the approval or result that comes for it finds it; so does
 * every other row.
 */
export function leanPage(rows: readonly TranscriptRow[], start: number): TranscriptRow[] {
  return rows.map((r, i) => {
    if (r.role === "event" && r.detail && r.detail.length > LEAN_DETAIL_MAX) return { ...r, detail: null, row: start + i };
    if (r.role !== "tool" || !r.tool || (r.tool.output === undefined && !r.tool.failed)) return r;
    const { input: _input, output: _output, ...step } = r.tool;
    return { ...r, text: line(r.text), tool: { ...step, name: line(step.name), row: start + i } };
  });
}

/** What `history_step_get` answers for one row a page sent lean: a tool row's whole step, or an event's whole detail. */
export interface WholeRow {
  step: ToolStep | null;
  detail: string | null;
}
