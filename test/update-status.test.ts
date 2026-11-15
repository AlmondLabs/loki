import { describe, expect, test } from "vitest";
import { followStatus, UPDATE_EVENT, type StatusCalls, type UpdateStatus } from "../app/src/shell/use-loki-update.ts";

// Plan 2026-11-15-2319, U5: each window follows the shell's update status by listening for loki:update and then asking
// once, so neither a status from before the page loaded nor one sent while it asked is lost, and no listener outlives it.

const status = (kind: "idle" | "checking"): UpdateStatus => ({ channel: "stable", current: "2026.1116.0", state: { kind } });

/** A promise with its resolve handed out, so a test decides when each shell call answers. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Stand-in shell calls: the test answers the listen and the ask itself, and sends events to the handler listened with. */
function fakeShell() {
  const listening = deferred<() => void>();
  const answer = deferred<UpdateStatus>();
  const asked: string[] = [];
  const events: string[] = [];
  let handler: ((e: { payload: UpdateStatus }) => void) | null = null;
  let unlistened = 0;
  const calls: StatusCalls = {
    listen: (event, h) => {
      events.push(event);
      handler = h;
      return listening.promise;
    },
    invoke: (command) => {
      asked.push(command);
      return answer.promise;
    },
  };
  const listen = () =>
    listening.resolve(() => {
      unlistened++;
    });
  const send = (s: UpdateStatus) => handler?.({ payload: s });
  return { calls, listen, answer, send, asked, events, unlistened: () => unlistened };
}

/** Let every queued promise callback run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("following the shell's update status", () => {
  test("it listens first and asks only once listening; the answer applies when no event came", async () => {
    const shell = fakeShell();
    const applied: UpdateStatus[] = [];
    followStatus(shell.calls, (s) => applied.push(s));
    await settle();
    expect(shell.events).toEqual([UPDATE_EVENT]);
    expect(shell.asked).toEqual([]);
    shell.listen();
    await settle();
    expect(shell.asked).toEqual(["update_status"]);
    shell.answer.resolve(status("idle"));
    await settle();
    expect(applied).toEqual([status("idle")]);
  });

  test("an event heard before the answer wins over the answer, which is older", async () => {
    const shell = fakeShell();
    const applied: UpdateStatus[] = [];
    followStatus(shell.calls, (s) => applied.push(s));
    shell.listen();
    await settle();
    shell.send(status("checking"));
    shell.answer.resolve(status("idle"));
    await settle();
    expect(applied).toEqual([status("checking")]);
  });

  test("closing before the listener is in place stops it exactly once, and nothing applies or is asked", async () => {
    const shell = fakeShell();
    const applied: UpdateStatus[] = [];
    const stop = followStatus(shell.calls, (s) => applied.push(s));
    stop();
    shell.listen();
    await settle();
    expect(shell.unlistened()).toBe(1);
    expect(shell.asked).toEqual([]);
    expect(applied).toEqual([]);
  });

  test("closing after it is listening stops the listener once, and a late answer does not apply", async () => {
    const shell = fakeShell();
    const applied: UpdateStatus[] = [];
    const stop = followStatus(shell.calls, (s) => applied.push(s));
    shell.listen();
    await settle();
    stop();
    shell.answer.resolve(status("idle"));
    await settle();
    expect(shell.unlistened()).toBe(1);
    expect(applied).toEqual([]);
  });
});
