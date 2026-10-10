/**
 * Letta's conversation logs into pi-durable entries (plan 017, KTD6). Letta Code's local backend writes each
 * conversation as Pi's session format v3 (`messages.jsonl`): a session header, then message and compaction entries
 * linked by `parentId`. pi-durable has no import API, so the converter writes the same messages as the entries its own
 * tasks would have written: `pi.user`, `pi.assistant`, `pi.tool-result` and `pi.compaction` with its head.
 */

/** A message as pi-ai and pi-durable carry it, with Letta's bookkeeping fields left behind. */
export type ImportedMessage = Record<string, unknown> & { role: string; timestamp: number };

/**
 * A message Letta wrote off its main path: the person saw it, the model never did. It is kept for the thread and
 * carries no model messages (core/attention/pi-steps.ts reads it).
 */
export const BRANCH_KIND = "loki.branch";

/** One converted entry: its pi-durable draft, the Letta entry it came from, and the line it was on. */
export type ImportedEntry = {
  sourceId: string;
  line: number;
  kind: "pi.user" | "pi.assistant" | "pi.tool-result" | "pi.compaction" | typeof BRANCH_KIND;
  /** Absent for a branch entry: the model does not see it. */
  model?: ImportedMessage[];
  data?: { diagnostics: [] } | { reason: "threshold" } | { message: ImportedMessage };
  /** For a compaction: the Letta entry its summary keeps from. */
  headSourceId?: string;
};

/** pi-durable's own wrapping of a compaction summary (`harness/compaction.js`), so an imported summary reads the same. */
const SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const SUMMARY_SUFFIX = "\n</summary>";

/** The fields of each role that pi-ai reads; Letta adds `id`, `otid` and `metadata`, which the model never sees. */
const FIELDS: Record<string, readonly string[]> = {
  user: ["content"],
  assistant: ["content", "api", "provider", "model", "responseId", "usage", "stopReason", "errorMessage"],
  toolResult: ["toolCallId", "toolName", "content", "isError"],
};

type LogLine = {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: Record<string, unknown> & { role?: string; timestamp?: unknown; metadata?: { created_at?: unknown } };
  summary?: string;
  firstKeptEntryId?: string;
};

/**
 * A line's time in milliseconds, read in the order the mod's log reader reads it (`mod/desks.ts` logSteps): the line's
 * own stamp, then Letta's metadata, then the message's timestamp. Letta stamps a line when it is written, which for a
 * streamed answer is later than the message's own timestamp, and the thread shows the line's.
 */
function timeOf(line: LogLine): number {
  const m = line.message;
  for (const stamp of [line.timestamp, m?.metadata?.created_at]) {
    const t = typeof stamp === "string" ? Date.parse(stamp) : Number.NaN;
    if (Number.isFinite(t)) return t;
  }
  return typeof m?.timestamp === "number" && Number.isFinite(m.timestamp) ? m.timestamp : 0;
}

function cleanMessage(m: Record<string, unknown> & { role: string }, timestamp: number): ImportedMessage {
  const out: ImportedMessage = { role: m.role, timestamp };
  for (const field of FIELDS[m.role] ?? []) if (m[field] !== undefined) out[field] = m[field];
  return out;
}

/**
 * The entries of one log, in the order its lines were written. Pi's session format is a tree, and what the model saw
 * is the path from the newest entry back to the first. A message off that path (a reply Letta replaced, a reminder
 * it dropped) was still shown, so it is kept as a branch entry the model does not see, where it was written. Lines
 * that do not parse are skipped.
 */
export function lettaLogEntries(text: string): ImportedEntry[] {
  const lines: Array<{ line: LogLine; index: number }> = [];
  const byId = new Map<string, { line: LogLine; index: number }>();
  text.split("\n").forEach((raw, index) => {
    if (!raw.trim()) return;
    let line: LogLine;
    try {
      line = JSON.parse(raw) as LogLine;
    } catch {
      return;
    }
    if (line.type !== "message" && line.type !== "compaction") return;
    if (typeof line.id !== "string") return;
    const item = { line, index };
    lines.push(item);
    byId.set(line.id, item);
  });
  const seen = new Set<string>();
  for (let item = lines.at(-1); item && !seen.has(item.line.id!); item = item.line.parentId ? byId.get(item.line.parentId) : undefined) {
    seen.add(item.line.id!);
  }

  const out: ImportedEntry[] = [];
  for (const { line, index } of lines) {
    const sourceId = line.id!;
    if (!seen.has(sourceId)) {
      const m = line.message;
      if (line.type === "message" && m && typeof m.role === "string" && m.role in FIELDS) {
        out.push({ sourceId, line: index, kind: BRANCH_KIND, data: { message: cleanMessage(m as Record<string, unknown> & { role: string }, timeOf(line)) } });
      }
      continue;
    }
    if (line.type === "compaction") {
      // A summary whose kept entry is not on the path keeps nothing it can point at: leave it out.
      if (typeof line.summary !== "string" || !line.firstKeptEntryId || !seen.has(line.firstKeptEntryId)) continue;
      const text = `${SUMMARY_PREFIX}${line.summary}${SUMMARY_SUFFIX}`;
      out.push({
        sourceId,
        line: index,
        kind: "pi.compaction",
        model: [{ role: "user", content: [{ type: "text", text }], timestamp: timeOf(line) }],
        data: { reason: "threshold" },
        headSourceId: line.firstKeptEntryId,
      });
      continue;
    }
    const m = line.message;
    if (!m || typeof m.role !== "string" || !(m.role in FIELDS)) continue;
    const message = cleanMessage(m as Record<string, unknown> & { role: string }, timeOf(line));
    if (m.role === "user") out.push({ sourceId, line: index, kind: "pi.user", model: [message] });
    else if (m.role === "assistant") out.push({ sourceId, line: index, kind: "pi.assistant", model: [message] });
    else out.push({ sourceId, line: index, kind: "pi.tool-result", model: [message], data: { diagnostics: [] } });
  }
  return out;
}

/** The working directory a log's session header names, if any. */
export function lettaLogCwd(text: string): string | undefined {
  const newline = text.indexOf("\n");
  const first = newline < 0 ? text : text.slice(0, newline);
  try {
    const header = JSON.parse(first) as { type?: string; cwd?: unknown };
    return header.type === "session" && typeof header.cwd === "string" ? header.cwd : undefined;
  } catch {
    return undefined;
  }
}
