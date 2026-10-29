/**
 * The one way loki runs async work one piece at a time (plan 053). Node runs a single thread, but awaits interleave:
 * two git commits in one repo fail on its lock, and a read split from its write by another loses the first. A queue
 * runs each piece once every earlier one has settled, failed or not, and each call settles as its own work does, so
 * one failure never blocks the next.
 */

/** A queue: `run(work)` starts `work` after the work queued before it. */
export type SerialQueue = <T>(work: () => Promise<T>) => Promise<T>;

/** A new queue. */
export function serialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work, work);
    tail = run.catch(() => {});
    return run;
  };
}

/** A queue per key (a repo, a chat, a provider): work under one key waits only for that key's. */
export type KeyedQueue = <T>(key: string, work: () => Promise<T>) => Promise<T>;

/** A new set of queues by key; `settled` hears the key after each piece of its work settles, and a key with none waiting is let go. */
export function keyedQueue(settled?: (key: string) => void): KeyedQueue {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const run = (tails.get(key) ?? Promise.resolve()).then(work, work);
    const tail = run.then(
      () => {},
      () => {},
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
      settled?.(key);
    });
    return run;
  };
}
