import { contentImages, contentText, toolArgsShown, toolOutput } from "../harness.ts";
import type { Step } from "./thread.ts";

/**
 * Pi's messages as thread steps (core/attention/thread.ts): a durable entry's pi-ai message, as the daemon stores it.
 * Structural types only: core imports no packages (test/core-portability.test.ts).
 */

/** A pi-ai message as either source stores it: user, assistant, toolResult or system. */
export interface PiMessage {
  role?: string;
  content?: unknown;
  toolCallId?: unknown;
  isError?: unknown;
  timestamp?: unknown;
}

/** A pi-durable transcript entry: its kind, the messages it gives the model, and its own data. */
export interface PiEntry {
  kind: string;
  model?: readonly PiMessage[];
  data?: unknown;
}

/**
 * Names a picture in a user message as the mod serves it (plan 029; the daemon's ChatImages keeps the file), or null
 * when it cannot be kept. Without one, a message's pictures stay the "[image]" lines its text carries.
 */
export type ImageNamer = (image: { data: string; mimeType: string }) => string | null;

/** When a message was written, from its numeric timestamp; null when it has none. */
export function messageAt(m: PiMessage): string | null {
  return typeof m.timestamp === "number" && Number.isFinite(m.timestamp) ? new Date(m.timestamp).toISOString() : null;
}

/**
 * One message as steps: a user message with its text, the assistant's words then its tool calls, and a tool result
 * as the result of the call it names. System messages and thinking are nothing.
 */
export function messageSteps(m: PiMessage, at: string | null, nameImage?: ImageNamer): Step[] {
  if (m.role === "toolResult")
    return typeof m.toolCallId === "string" ? [shownStep({ kind: "result", id: m.toolCallId, output: m.content, failed: m.isError === true })] : [];
  if (m.role !== "user" && m.role !== "assistant") return [];
  const text = contentText(m.content);
  if (m.role === "user") {
    const images = nameImage ? contentImages(m.content).flatMap((image) => nameImage(image) ?? []) : [];
    return [{ kind: "user", raw: text, at, ...(images.length ? { images } : {}) }];
  }
  const out: Step[] = [{ kind: "assistant", text, at }];
  for (const part of Array.isArray(m.content) ? m.content : []) {
    const p = part as { type?: string; name?: string; arguments?: unknown; id?: unknown } | null;
    if (p?.type === "toolCall" && p.name)
      out.push(shownStep({ kind: "call", name: p.name, args: p.arguments, id: typeof p.id === "string" ? p.id : null, at }));
  }
  return out;
}

/**
 * A step as a window needs it (plan 035): a tool's result as its text, capped as the transcript caps it (pictures and
 * other parts that are not text leave nothing, as they do in a window), and a call's arguments with every string cut.
 * The daemon keeps steps this way and sends them this way; the store and the model keep everything.
 */
export function shownStep(step: Step): Step {
  if (step.kind === "result") return { ...step, output: toolOutput(step.output) };
  if (step.kind === "call" || step.kind === "approval") return { ...step, args: toolArgsShown(step.args) };
  return step;
}

/** The entry kinds a thread shows; prompt changes, resets and compaction summaries are the model's, not the person's. */
const SHOWN = new Set(["pi.user", "pi.assistant", "pi.tool-result"]);

/** A message from off Letta's main path, in a chat imported from Letta (`loki.branch`): shown, never sent to the model. */
const BRANCH = "loki.branch";

/** One pi-durable entry as steps; `nameImage` keeps a user message's pictures (plan 029). */
export function entrySteps(entry: PiEntry, nameImage?: ImageNamer): Step[] {
  if (entry.kind === BRANCH) {
    const message = (entry.data as { message?: PiMessage } | undefined)?.message;
    return message ? messageSteps(message, messageAt(message), nameImage) : [];
  }
  if (!SHOWN.has(entry.kind)) return [];
  return (entry.model ?? []).flatMap((m) => messageSteps(m, messageAt(m), nameImage));
}
