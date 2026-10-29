import { describe, expect, test } from "vitest";
import { Awake } from "../daemon/awake.ts";

/** A spawner that records what it starts and whether each was stopped. */
function recorder() {
  const started: Array<{ command: string; args: string[]; killed: boolean }> = [];
  const spawn = (command: string, args: string[]) => {
    const rec = { command, args, killed: false };
    started.push(rec);
    return { kill: () => ((rec.killed = true), true), on: () => undefined } as never;
  };
  return { started, spawn };
}

describe("keeping a paired Mac awake", () => {
  test("pairing the first Mac holds off sleep on power for the daemon's life; unpairing the last lets go", () => {
    const r = recorder();
    const awake = new Awake({ spawn: r.spawn, platform: "darwin", pid: 4242 });
    awake.set(true);
    awake.set(true);
    expect(r.started).toEqual([{ command: "/usr/bin/caffeinate", args: ["-s", "-w", "4242"], killed: false }]);
    awake.set(false);
    expect(r.started[0].killed).toBe(true);
    expect(awake.held()).toBe(false);
  });

  test("a caffeinate that cannot be started lets go, and the next pairing tries again", () => {
    const listeners = new Map<string, () => void>();
    let started = 0;
    const spawn = () => {
      started++;
      return {
        kill: () => true,
        on: (event: string, fn: () => void) => listeners.set(event, fn),
      } as never;
    };
    const awake = new Awake({ spawn, platform: "darwin", pid: 1 });
    awake.set(true);
    const failed = listeners.get("error");
    expect(failed).toBeDefined();
    failed?.();
    expect(awake.held()).toBe(false);
    awake.set(true);
    expect(started).toBe(2);
  });

  test("on Linux and Windows nothing is started", () => {
    for (const platform of ["linux", "win32"] as const) {
      const r = recorder();
      new Awake({ spawn: r.spawn, platform, pid: 1 }).set(true);
      expect(r.started).toEqual([]);
    }
  });
});
