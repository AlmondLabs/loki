import { contentText } from "../harness.ts";
import type { Step } from "./thread.ts";

/**
 * Pi's messages as thread steps (core/attention/thread.ts). Letta's local log and pi-durable's entries both carry
 * pi-ai messages, so one adapter reads both: the import's log reader (daemon/import/letta-log.ts) hands it a log
 * line's message, the daemon a durable entry's. Structural types only: core imports no packages (test/core-portability.test.ts).
 */

/** A pi-ai message as either source stores it: user, assistant, toolResult or system. */
export type PiMessage = {
  role?: string;
  content?: unknown;
  toolCallId?: unknown;
  isError?: unknown;
  timestamp?: unknown;
};

/** A pi-durable transcript entry: its kind, the messages it gives the model, and its own data. */
export type PiEntry = { kind: string; model?: readonly PiMessage[]; data?: unknown };

/** When a message was written, from its numeric timestamp; null when it has none. */
export function messageAt(m: PiMessage): string | null {
  return typeof m.timestamp === "number" && Number.isFinite(m.timestamp) ? new Date(m.timestamp).toISOString() : null;
}

/**
 * One message as steps: a user message with its text, the assistant's words then its tool calls, and a tool result
 * as the result of the call it names. System messages and thinking are nothing.
 */
export function messageSteps(m: PiMessage, at: string | null): Step[] {
  if (m.role === "toolResult") return typeof m.toolCallId === "string" ? [{ kind: "result", id: m.toolCallId, output: m.content, failed: m.isError === true }] : [];
  if (m.role !== "user" && m.role !== "assistant") return [];
  const text = contentText(m.content);
  if (m.role === "user") return [{ kind: "user", raw: text, at }];
  const out: Step[] = [{ kind: "assistant", text, at }];
  for (const part of Array.isArray(m.content) ? m.content : []) {
    const p = part as { type?: string; name?: string; arguments?: unknown; id?: unknown } | null;
    if (p?.type === "toolCall" && p.name) out.push({ kind: "call", name: p.name, args: p.arguments, id: typeof p.id === "string" ? p.id : null, at });
  }
  return out;
}

/** The entry kinds a thread shows; prompt changes, resets and compaction summaries are the model's, not the person's. */
const SHOWN = new Set(["pi.user", "pi.assistant", "pi.tool-result"]);

/** A message imported from off Letta's main path: shown, never sent to the model (daemon/import/convert.ts). */
const BRANCH = "loki.branch";

/** One pi-durable entry as steps. */
export function entrySteps(entry: PiEntry): Step[] {
  if (entry.kind === BRANCH) {
    const message = (entry.data as { message?: PiMessage } | undefined)?.message;
    return message ? messageSteps(message, messageAt(message)) : [];
  }
  if (!SHOWN.has(entry.kind)) return [];
  return (entry.model ?? []).flatMap((m) => messageSteps(m, messageAt(m)));
}
