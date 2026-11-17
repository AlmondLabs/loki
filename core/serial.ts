export type SerialQueue = <T>(work: () => Promise<T>) => Promise<T>;

export function serialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work, work);
    tail = run.catch(() => {});
    return run;
  };
}

export type KeyedQueue = <T>(key: string, work: () => Promise<T>) => Promise<T>;

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
