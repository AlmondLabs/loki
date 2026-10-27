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
  /** Files a user message carried (attachment tags, core/attention/content.ts), from the live send and from history alike. */
  files?: FileRef[];
  /** Data URLs of images sent with a user message (live rows only; history shows a marker). */
  images?: string[];
  /** A user message typed mid-turn that has not gone out yet. */
  queued?: boolean;
  /**
   * When the message was written, ISO 8601 (the store's time, an imported log's `timestamp`, or the moment a
   * live row arrived). Absent when nobody knows: such a
   * row shows no time and starts no day.
   */
  at?: string;
}

/** How long a lean tool row's label and name may be: one line, as the closed step shows it. */
export const LEAN_LINE_MAX = 200;

const line = (text: string): string => {
  const first = text.split("\n", 1)[0];
  return first.length > LEAN_LINE_MAX || first.length < text.length ? `${first.slice(0, LEAN_LINE_MAX).trimEnd()}…` : first;
};

/**
 * The rows of a history page as they travel (plan 041), from position `start`: a finished tool row keeps its one-line
 * label and name, its description and whether it failed, and leaves out its input and output, which most of a page's
 * bytes were; its step says where it is, so opening it fetches the rest. A call still waiting for its result goes
 * whole, so the approval or result that comes for it finds it; so does every other row.
 */
export function leanPage(rows: readonly TranscriptRow[], start: number): TranscriptRow[] {
  return rows.map((r, i) => {
    if (r.role !== "tool" || !r.tool || (r.tool.output === undefined && !r.tool.failed)) return r;
    const { input: _input, output: _output, ...step } = r.tool;
    return { ...r, text: line(r.text), tool: { ...step, name: line(step.name), row: start + i } };
  });
}
