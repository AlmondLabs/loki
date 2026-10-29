/**
 * The one way loki tells others that something changed (plan 054): a set of listeners, each added with the call that
 * takes it back. Every store, client and watcher that is listened to keeps one of these rather than its own Set.
 */

/** Listeners called with `A`, in the order they were added. */
export class Listeners<A extends unknown[] = []> {
  private readonly fns = new Set<(...args: A) => void>();

  /** Hear each change from now on; returns the way to stop. */
  add(fn: (...args: A) => void): () => void {
    this.fns.add(fn);
    return () => void this.fns.delete(fn);
  }

  /** Tell every listener, as a Set iterates: one taken back while this runs and not yet told is not told. */
  emit(...args: A): void {
    for (const fn of this.fns) fn(...args);
  }

  /** How many listen now. */
  get size(): number {
    return this.fns.size;
  }

  /** Stop hearing for everyone (the thing listened to is closing). */
  clear(): void {
    this.fns.clear();
  }
}
