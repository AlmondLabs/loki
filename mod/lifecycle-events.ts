import type { Scope } from "../core/desk-core.ts";
import { debounce, type Burst } from "../core/timers.ts";

/**
 * Debounces work per desk, so activity on one conversation cannot cancel another's refresh: core/timers.ts's
 * `debounce`, one per desk that has work waiting. The latest work scheduled for a desk is the one that runs.
 */
export class ScopeDebouncer {
  private readonly waiting = new Map<Scope, { burst: Burst; work: () => void }>();
  private readonly ms: number;

  /** `ms`: how long a desk must be quiet before its work runs. */
  constructor(ms: number) {
    this.ms = ms;
  }

  /** Run `work` for `scope` once that desk has been quiet for `ms`, in place of any work it had waiting. */
  schedule(scope: Scope, work: () => void): void {
    let entry = this.waiting.get(scope);
    if (!entry) {
      const fresh: { burst: Burst; work: () => void } = {
        work,
        burst: debounce(() => {
          this.waiting.delete(scope);
          fresh.work();
        }, this.ms),
      };
      entry = fresh;
      this.waiting.set(scope, entry);
    }
    entry.work = work;
    entry.burst.schedule();
  }

  /** Drop every desk's waiting work (the mod is stopping). */
  clear(): void {
    for (const { burst } of this.waiting.values()) burst.cancel();
    this.waiting.clear();
  }
}
