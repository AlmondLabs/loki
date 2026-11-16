export class Listeners<A extends unknown[] = []> {
  private readonly fns = new Set<(...args: A) => void>();

  add(fn: (...args: A) => void): () => void {
    this.fns.add(fn);
    return () => void this.fns.delete(fn);
  }

  emit(...args: A): void {
    for (const fn of this.fns) fn(...args);
  }

  get size(): number {
    return this.fns.size;
  }

  clear(): void {
    this.fns.clear();
  }
}
