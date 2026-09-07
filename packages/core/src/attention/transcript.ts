/**
 * One row of a conversation as loki shows it everywhere (desk chat, Catch Up, the phone):
 * user and assistant bubbles, quiet tool markers, collapsible harness events.
 */
export interface TranscriptRow {
  role: "user" | "assistant" | "tool" | "event";
  text: string;
  summary?: string | null;
  detail?: string | null;
  /** Data URLs of images sent with a user message (live rows only; history shows a marker). */
  images?: string[];
}
