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
  /**
   * On an ACP agent's call: the kind the agent gave it (`read`, `edit`, `delete`, `move`, `search`, `execute`, `think`,
   * `fetch`, `other`), which picks the step's icon and tag, since its name is the agent's own title.
   */
  acp_kind?: string;
  output?: string;
  failed?: boolean;
  /** On a failed call: what went wrong, one line from the end of its whole result (core/harness.ts errorOf). */
  error?: string;
  /**
   * Set on a step a history page sent lean, without its input and output (plan 041): the row's position in the chat's
   * log, which `history_step_get` answers with the whole step.
   */
  row?: number;
  /**
   * On an agent's plan (an ACP `plan` update, plan 097 U9): its entries, read from the step's result, so the Plan
   * draws them and a lean history page, which drops the output, still carries them.
   */
  plan?: PlanItem[];
}

export interface PlanItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface FileRef {
  path: string;
  name: string;
  size?: number;
  mime?: string;
}

/**
 * What an event row is, for the rows the thread draws in a way of their own. Set where the row is built
 * (core/harness.ts, ThreadModel) and carried in history pages from the daemon; a row without it is drawn as a plain
 * event.
 */
export type EventKind = "subagent" | "chat_message" | "canvas" | "moved" | "command";

export interface TranscriptRow {
  role: "user" | "assistant" | "tool" | "event";
  text: string;
  /** On a tool row: the call, its input and its result, when they were seen. */
  tool?: ToolStep;
  summary?: string | null;
  /** On a background task's finished notice: the whole command it ran, which the opened step shows. */
  command?: string;
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
  /** On a subagent's finished notice: the helper chat that answered, which clicking the row opens in Workers. */
  subagent_chat?: string;
  /** On an event row: what kind it is, when it is one drawn in a way of its own (EventKind). */
  event?: EventKind;
  /**
   * What the agent thought before this row (plan 097, U9): an ACP agent's thought chunks, or a model's thinking kept
   * in its message, capped at THOUGHT_MAX here (the store keeps all of it). On the reply or the call that followed it.
   */
  thought?: string;
  /** How long it thought, when the thought was heard live; a history page does not know and leaves it out. */
  thought_ms?: number;
  /**
   * When the message was written, ISO 8601 (the store's time, an imported log's `timestamp`, or the moment a
   * live row arrived). Absent when nobody knows: such a
   * row shows no time and starts no day.
   */
  at?: string;
}

export const THOUGHT_MAX = 4000;

export const LEAN_LINE_MAX = 200;

export const LEAN_DETAIL_MAX = 1000;

const line = (text: string): string => {
  const first = text.split("\n", 1)[0];
  return first.length > LEAN_LINE_MAX || first.length < text.length ? `${first.slice(0, LEAN_LINE_MAX).trimEnd()}…` : first;
};

export function leanPage(rows: readonly TranscriptRow[], start: number): TranscriptRow[] {
  return rows.map((r, i) => {
    if (r.role === "event" && r.detail && r.detail.length > LEAN_DETAIL_MAX) return { ...r, detail: null, row: start + i };
    if (r.role !== "tool" || !r.tool || (r.tool.output === undefined && !r.tool.failed)) return r;
    const { input: _input, output: _output, ...step } = r.tool;
    return { ...r, text: line(r.text), tool: { ...step, name: line(step.name), row: start + i } };
  });
}

export interface WholeRow {
  step: ToolStep | null;
  detail: string | null;
}
