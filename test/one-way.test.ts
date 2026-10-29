import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Listeners } from "../core/listeners.ts";
import { keyedQueue, serialQueue } from "../core/serial.ts";
import { coalesce, debounce } from "../core/timers.ts";

/** A promise the test settles by hand. */
function gate() {
  let open: () => void = () => {};
  let fail: (e: Error) => void = () => {};
  const p = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { p, open, fail };
}

describe("one way per job (plan 054)", () => {
  test("listeners hear each emit until they take themselves back", () => {
    const heard: string[] = [];
    const ls = new Listeners<[word: string]>();
    const stop = ls.add((w) => heard.push(`a:${w}`));
    ls.add((w) => heard.push(`b:${w}`));
    ls.emit("one");
    stop();
    ls.emit("two");
    expect(heard).toEqual(["a:one", "b:one", "b:two"]);
    expect(ls.size).toBe(1);
  });

  test("a serial queue runs one piece at a time, and a failure does not stop the next", async () => {
    const run = serialQueue();
    const order: string[] = [];
    const first = gate();
    const a = run(async () => {
      order.push("a start");
      await first.p;
      order.push("a end");
    });
    const b = run(() => Promise.resolve(void order.push("b")));
    await Promise.resolve();
    expect(order).toEqual(["a start"]);
    first.fail(new Error("no"));
    await expect(a).rejects.toThrow("no");
    await b;
    expect(order).toEqual(["a start", "b"]);
  });

  test("a keyed queue holds work per key only, and says when each piece settled", async () => {
    const settled: string[] = [];
    const run = keyedQueue((key) => settled.push(key));
    const slow = gate();
    const order: string[] = [];
    const x1 = run("x", async () => {
      await slow.p;
      order.push("x1");
    });
    const x2 = run("x", () => Promise.resolve(void order.push("x2")));
    await run("y", () => Promise.resolve(void order.push("y")));
    expect(order).toEqual(["y"]);
    slow.open();
    await Promise.all([x1, x2]);
    expect(order).toEqual(["y", "x1", "x2"]);
    await Promise.resolve();
    expect(settled.sort()).toEqual(["x", "x", "y"]);
  });

  describe("bursts", () => {
    beforeEach(() => void vi.useFakeTimers());
    afterEach(() => void vi.useRealTimers());

    test("coalesce runs once, counted from the first call, so a steady stream still runs", () => {
      const fn = vi.fn();
      const b = coalesce(fn, 100);
      b.schedule();
      vi.advanceTimersByTime(60);
      b.schedule();
      vi.advanceTimersByTime(40);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test("debounce runs once the calls stop", () => {
      const fn = vi.fn();
      const b = debounce(fn, 100);
      b.schedule();
      vi.advanceTimersByTime(60);
      b.schedule();
      vi.advanceTimersByTime(60);
      expect(fn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(40);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test("flush runs a waiting burst now, and cancel drops it", () => {
      const fn = vi.fn();
      const b = coalesce(fn, 100);
      b.flush();
      expect(fn).not.toHaveBeenCalled(); // nothing waiting
      b.schedule();
      b.flush();
      expect(fn).toHaveBeenCalledTimes(1);
      b.schedule();
      b.cancel();
      vi.advanceTimersByTime(200);
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });
});
