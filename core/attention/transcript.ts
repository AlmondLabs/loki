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
  /** A user message typed mid-turn that has not gone out yet. */
  queued?: boolean;
  /**
   * When the message was written, ISO 8601 like the harness's `TranscriptMessage.at` (Letta's `date`,
   * the local log's `timestamp`, or the moment a live row arrived). Absent when nobody knows: such a
   * row shows no time and starts no day.
   */
  at?: string;
}

/** A harness history message as a row: its time kept when it has one, left off when it has none. */
export function fromHistory(m: { role: TranscriptRow["role"]; text: string; summary?: string | null; detail?: string | null; at?: string | null }): TranscriptRow {
  const row: TranscriptRow = { role: m.role, text: m.text };
  if (m.summary !== undefined) row.summary = m.summary;
  if (m.detail !== undefined) row.detail = m.detail;
  if (m.at) row.at = m.at;
  return row;
}

/**
 * A reloaded thread with the times the rows had before: live rows were stamped on arrival and the
 * history that replaces them may not carry times. Rows are paired by role and text from the end (the
 * newest rows are the ones that streamed in), so an older repeat of "ok" does not take the newest
 * one's time. A row's own time always wins.
 */
export function carryTimes(rows: TranscriptRow[], before: TranscriptRow[]): TranscriptRow[] {
  const known = new Map<string, Array<string | undefined>>();
  for (const r of before) {
    const k = `${r.role}\u0000${r.text}`;
    const list = known.get(k);
    if (list) list.push(r.at);
    else known.set(k, [r.at]);
  }
  const out = rows.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const at = known.get(`${out[i].role}\u0000${out[i].text}`)?.pop();
    if (!out[i].at && at) out[i] = { ...out[i], at };
  }
  return out;
}
