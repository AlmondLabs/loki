import { describe, expect, test } from "vitest";
import { alive, watchParent } from "../daemon/parent-watch.ts";
import { killTree } from "../daemon/tree-kill.ts";

function ticker() {
  let tick: (() => void) | null = null;
  let cleared = false;
  return {
    every: (fn: () => void) => {
      tick = fn;
      return () => {
        cleared = true;
      };
    },
    tick: () => tick?.(),
    cleared: () => cleared,
  };
}

describe("watching the loki that started the daemon", () => {
  test("a parent that stays alive never stops the daemon", () => {
    const clock = ticker();
    let stops = 0;
    watchParent({ pid: 41, alive: () => true, every: clock.every, gone: () => stops++ });
    clock.tick();
    clock.tick();
    expect(stops).toBe(0);
  });

  test("a parent that goes stops the daemon once, on the next tick, and the watch ends", () => {
    const clock = ticker();
    let up = true;
    let stops = 0;
    watchParent({ pid: 41, alive: () => up, every: clock.every, gone: () => stops++ });
    up = false;
    clock.tick();
    clock.tick();
    expect(stops).toBe(1);
    expect(clock.cleared()).toBe(true);
  });

  test("a pid the daemon may not signal still counts as alive; one that does not exist does not", () => {
    const refuse = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    expect(alive(41, refuse("EPERM"))).toBe(true);
    expect(alive(41, refuse("ESRCH"))).toBe(false);
    expect(alive(41, () => true)).toBe(true);
  });
});

describe("ending a process and everything it started", () => {
  test("Windows ends the tree with taskkill", () => {
    const ran: string[][] = [];
    killTree(512, { platform: "win32", run: (command, args) => ran.push([command, ...args]), signal: () => {} });
    expect(ran).toEqual([["taskkill", "/PID", "512", "/T", "/F"]]);
  });

  test("the Mac and Linux signal the process group, or the process when it leads none", () => {
    const sent: Array<[number, string]> = [];
    killTree(512, { platform: "darwin", run: () => {}, signal: (pid, sig) => sent.push([pid, sig]) });
    expect(sent).toEqual([[-512, "SIGTERM"]]);

    const fallback: Array<[number, string]> = [];
    killTree(513, {
      platform: "linux",
      run: () => {},
      signal: (pid, sig) => {
        fallback.push([pid, sig]);
        if (pid < 0) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      },
    });
    expect(fallback).toEqual([
      [-513, "SIGTERM"],
      [513, "SIGTERM"],
    ]);
  });
});
