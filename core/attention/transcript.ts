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
}

/** A file a message carried (its attachment tag), shown as a chip on the bubble. */
export interface FileRef {
  path: string;
  name: string;
  size?: number;
  mime?: string;
}

export interface TranscriptRow {
  role: "user" | "assistant" | "tool" | "event";
  text: string;
  /** On a tool row: the call, its input and its result, when they were seen. */
  tool?: ToolStep;
  summary?: string | null;
  detail?: string | null;
  /** Files a user message carried (Letta attachment tags), from the live send and from history alike. */
  files?: FileRef[];
  /** Data URLs of images sent with a user message (live rows only; history shows a marker). */
  images?: string[];
  /** A user message typed mid-turn that has not gone out yet. */
  queued?: boolean;
  /**
   * When the message was written, ISO 8601 (Letta's `date`, the local log's `timestamp`, or the moment a
   * live row arrived). Absent when nobody knows: such a
   * row shows no time and starts no day.
   */
  at?: string;
}
