import type { Scope } from "../core/desk-core.ts";
import type { EventContext } from "./letta-types.ts";

interface ConversationEvent {
  conversationId?: string | null;
  agentId?: string | null;
}

/** Resolve the conversation identity carried by lifecycle and turn events. */
export function runtimeFromEvent(event: ConversationEvent | undefined, ctx: EventContext): { conversationId: string | null; agentId: string | null } {
  return {
    conversationId: event?.conversationId ?? ctx.conversation?.id ?? null,
    agentId: event?.agentId ?? ctx.agent?.id ?? null,
  };
}

type Timer = ReturnType<typeof setTimeout>;
type SetTimer = (callback: () => void, delay: number) => Timer;
type ClearTimer = (timer: Timer) => void;

/** Debounces work per desk so activity on one conversation cannot cancel another's refresh. */
export class ScopeDebouncer {
  private readonly timers = new Map<Scope, Timer>();
  private readonly setTimer: SetTimer;
  private readonly clearTimer: ClearTimer;

  constructor(setTimer: SetTimer = setTimeout, clearTimer: ClearTimer = clearTimeout) {
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
  }

  schedule(scope: Scope, callback: () => void, delay: number): void {
    const previous = this.timers.get(scope);
    if (previous !== undefined) this.clearTimer(previous);
    const timer = this.setTimer(() => {
      if (this.timers.get(scope) !== timer) return;
      this.timers.delete(scope);
      callback();
    }, delay);
    this.timers.set(scope, timer);
  }

  clear(): void {
    for (const timer of this.timers.values()) this.clearTimer(timer);
    this.timers.clear();
  }
}
