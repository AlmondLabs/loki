import type { TranscriptRow } from "../../../core/attention/transcript.ts";

export interface TurnError {
  text: string;
  raw: string | null;
}

const DROPPED = /socket connection was closed|ECONNRESET|socket hang up|fetch failed|terminated|network (?:error|connection)|EPIPE/i;

export function readTurnError(error: string): TurnError {
  const raw = error.trim();
  const said = [...raw.matchAll(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\"/g, '"')).pop() ?? raw;
  if (DROPPED.test(said)) return { text: "The connection to the model dropped partway through.", raw };
  const line = said.split("\n")[0].trim();
  const text = line.length > 200 ? `${line.slice(0, 197)}…` : line || "The turn failed.";
  return { text, raw: raw !== text ? raw : null };
}

export function retryMessage(rows: TranscriptRow[]): { label: string; text: string } | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.role === "event") continue;
    if (r.role === "user") return r.text.trim() ? { label: "Send Again", text: r.text } : null;
    return { label: "Continue", text: "Continue where you stopped: the connection to the model dropped." };
  }
  return null;
}
