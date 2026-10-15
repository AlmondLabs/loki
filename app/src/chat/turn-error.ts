import type { TranscriptRow } from "../../../core/attention/transcript.ts";

/**
 * A failed turn in words a person reads: what the harness reported (often a JSON blob), reduced to one sentence,
 * with the raw text kept for whoever wants it. Pure, so the wording is tested (test/turn-error.test.ts).
 */
export interface TurnError {
  text: string;
  /** The harness's own words, when they say more than `text`. */
  raw: string | null;
}

/** A dropped connection, in Bun's, Node's and undici's words. */
const DROPPED = /socket connection was closed|ECONNRESET|socket hang up|fetch failed|terminated|network (?:error|connection)|EPIPE/i;

export function readTurnError(error: string): TurnError {
  const raw = error.trim();
  // `{"error": {"error": {"type": "llm_error", "message": "…"}}}`: the innermost message is what happened.
  const said = [...raw.matchAll(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\"/g, '"')).pop() ?? raw;
  if (DROPPED.test(said)) return { text: "The connection to the model dropped partway through.", raw };
  const line = said.split("\n")[0].trim();
  const text = line.length > 200 ? `${line.slice(0, 197)}…` : line || "The turn failed.";
  return { text, raw: raw !== text ? raw : null };
}

/**
 * What to send to try again: your last message again when the agent never answered it (nothing after it in the
 * thread), else a nudge to carry on, since the agent was partway through its work and has your message already.
 */
export function retryMessage(rows: TranscriptRow[]): { label: string; text: string } | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.role === "event") continue;
    if (r.role === "user") return r.text.trim() ? { label: "Send again", text: r.text } : null;
    return { label: "Continue", text: "Continue where you stopped: the connection to the model dropped." };
  }
  return null;
}
