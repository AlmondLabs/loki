import { useSyncExternalStore } from "react";
import type { TaskSource } from "../../../core/task-source.ts";

/**
 * "Open the message" from a task in Tasks: the chat opens, and its thread scrolls to the message the task came from.
 * The ask waits here until that conversation's thread is on screen and takes it (useRevealMessage in message-tasks.tsx).
 */
export interface RevealAsk {
  conversation: string;
  source: Pick<TaskSource, "role" | "key" | "at" | "quote">;
  tick: number;
}

let pending: RevealAsk | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export function requestReveal(conversation: string, source: RevealAsk["source"]): void {
  pending = { conversation, source, tick: Date.now() };
  emit();
}

/** The thread found the message (or gave up): the ask is done. */
export function takeReveal(tick: number): void {
  if (pending?.tick !== tick) return;
  pending = null;
  emit();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** The ask for this conversation, while there is one. */
export function useRevealAsk(conversation: string | null): RevealAsk | null {
  // No ask on a server render (the tests' static markup): nothing has been asked for there.
  const ask = useSyncExternalStore(
    subscribe,
    () => pending,
    () => null,
  );
  return ask && conversation && ask.conversation === conversation ? ask : null;
}
