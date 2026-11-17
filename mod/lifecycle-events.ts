import type { Scope } from "../core/desk-core.ts";
import { debounce, type Burst } from "../core/timers.ts";

export class ScopeDebouncer {
  private readonly waiting = new Map<Scope, { burst: Burst; work: () => void }>();
  private readonly ms: number;

  constructor(ms: number) {
    this.ms = ms;
  }

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

  clear(): void {
    for (const { burst } of this.waiting.values()) burst.cancel();
    this.waiting.clear();
  }
}
