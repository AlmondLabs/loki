import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { conversationDirName } from "../../core/desk-core.ts";
import { foldSteps, type Step } from "../../core/attention/thread.ts";
import { messageSteps } from "../../core/attention/pi-steps.ts";
import type { TranscriptRow } from "../../core/attention/transcript.ts";

/**
 * Letta's conversation logs as loki showed them before the move to its own daemon (plan 017): the reference the
 * import is checked against (test/import-convert.test.ts, scripts/pi-import-check.ts), so a converted chat folds into
 * the same rows its Letta log did.
 */

/**
 * The conversation's full text transcript from the local backend log
 * (`messages.jsonl`).
 * Tool calls become one-line markers carrying their step (the input, and the
 * result from its toolResult line, paired by call id), harness notices
 * (background task results, compaction) become event rows; thinking is
 * skipped. Only the last `limit` rows are returned, oldest first.
 */
export function readLocalTranscript(
  conversationId: string,
  agentId: string | null | undefined,
  limit: number,
  backendDir: string,
): TranscriptRow[] {
  return readLocalTranscriptPage(conversationId, agentId, limit, backendDir).rows;
}

/** The last `limit` rows, and whether the log holds older ones. */
export function readLocalTranscriptPage(
  conversationId: string,
  agentId: string | null | undefined,
  limit: number,
  backendDir: string,
): { rows: TranscriptRow[]; more: boolean } {
  const path = join(backendDir, "conversations", conversationDirName(conversationId, agentId), "messages.jsonl");
  if (!existsSync(path)) return { rows: [], more: false };
  const out = foldSteps(readFileSync(path, "utf8").split("\n").flatMap(logSteps));
  return out.length > limit ? { rows: out.slice(out.length - limit), more: true } : { rows: out, more: false };
}

/**
 * One line of the local log as thread steps (core/attention/thread.ts): a user or assistant message with its text,
 * the assistant's tool calls after its words, and a toolResult line as the result of the call it names. Thinking,
 * session and compaction lines, and anything that does not parse, are nothing.
 */
function logSteps(line: string): Step[] {
  if (!line.trim()) return [];
  let entry: { type?: string; timestamp?: unknown; message?: { role?: string; content?: unknown; toolCallId?: unknown; isError?: unknown; metadata?: { created_at?: unknown } } };
  try {
    entry = JSON.parse(line) as typeof entry;
  } catch {
    return [];
  }
  const m = entry.message;
  if (entry.type !== "message" || !m) return [];
  // Letta's local backend writes the time on every message line; older lines may lack it.
  const stamp = typeof entry.timestamp === "string" ? entry.timestamp : typeof m.metadata?.created_at === "string" ? m.metadata.created_at : null;
  return messageSteps(m, stamp && Number.isFinite(Date.parse(stamp)) ? stamp : null);
}
