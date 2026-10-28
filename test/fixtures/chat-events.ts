import { applyChatEvent, type Live } from "../../core/attention/model.ts";
import type { Step } from "../../core/attention/thread.ts";

/**
 * Thread steps and chat events as the daemon hands them to the app (daemon/chat-events.ts, daemon/acp/chats.ts): how
 * the live-chat and thread tests describe a turn, in loki's own shapes.
 */

/** A message you wrote, as written: markup in it is the thread's to fold. */
export const user = (raw: string, at: string | null = null): Step => ({ kind: "user", raw, at });

/** A whole reply, as history has it. */
export const said = (text: string, at: string | null = null): Step => ({ kind: "assistant", text, at });

/** A streamed piece of the reply: the pieces join as they came. */
export const piece = (text: string, at: string | null = null): Step => ({ kind: "assistant", text, at, chunk: true });

/** A tool call; the same id again carries more of its arguments. */
export const call = (name: string, id: string | null, args?: unknown, at: string | null = null): Step => ({ kind: "call", name, args, id, at });

/** The approval request for a call. */
export const approval = (name: string, id: string | null, args?: unknown, at: string | null = null): Step => ({ kind: "approval", name, args, id, at });

/** What came back from the call with this id. */
export const result = (id: string, output: unknown, failed = false): Step => ({ kind: "result", id, output, failed });

/** Push a step live, as the daemon does: one that carries a time and has none is stamped with the moment it came. */
export function push(l: Live, step: Step, now = new Date().toISOString()): { changed: boolean; userSpoke: boolean } {
  return applyChatEvent(l, { kind: "step", step: "at" in step ? { ...step, at: step.at ?? now } : step }, now);
}
