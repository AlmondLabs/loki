import { applyChatEvent, type Live } from "../../core/attention/model.ts";
import type { Step } from "../../core/attention/thread.ts";

export const user = (raw: string, at: string | null = null): Step => ({ kind: "user", raw, at });

export const said = (text: string, at: string | null = null): Step => ({ kind: "assistant", text, at });

export const piece = (text: string, at: string | null = null): Step => ({ kind: "assistant", text, at, chunk: true });

export const call = (name: string, id: string | null, args?: unknown, at: string | null = null): Step => ({ kind: "call", name, args, id, at });

export const approval = (name: string, id: string | null, args?: unknown, at: string | null = null): Step => ({ kind: "approval", name, args, id, at });

export const result = (id: string, output: unknown, failed = false): Step => ({ kind: "result", id, output, failed });

export function push(l: Live, step: Step, now = new Date().toISOString()): { changed: boolean; userSpoke: boolean } {
  return applyChatEvent(l, { kind: "step", step: "at" in step ? { ...step, at: step.at ?? now } : step }, now);
}
