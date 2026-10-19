import { describe, expect, test } from "vitest";
import { DevReload } from "../daemon/dev-reload.ts";

/** A dev reload with its clock, timers and checks in the test's hands. */
function setup() {
  const clock = { now: 0 };
  const timers: Array<{ at: number; fn: () => void }> = [];
  const said: string[] = [];
  const restarts: string[] = [];
  const state = { idle: false, reloads: 0, release: () => {} };
  const dev = new DevReload({
    reloadMod: () =>
      new Promise((resolve) => {
        state.reloads++;
        state.release = () => resolve("ok");
      }),
    restart: (why) => restarts.push(why),
    idle: () => Promise.resolve(state.idle),
    report: (m) => said.push(m),
    pollMs: 5000,
    giveUpMs: 60_000,
    now: () => clock.now,
    later: (fn, ms) => {
      const t = { at: clock.now + ms, fn };
      timers.push(t);
      return () => timers.splice(timers.indexOf(t), 1);
    },
  });
  /** Move the clock on, running each timer that comes due. */
  const pass = async (ms: number) => {
    clock.now += ms;
    for (const t of timers.filter((x) => x.at <= clock.now)) {
      timers.splice(timers.indexOf(t), 1);
      t.fn();
      await Promise.resolve();
      await Promise.resolve();
    }
  };
  return { dev, state, said, restarts, pass, timers };
}

describe("a checkout keeping up with its sources (plan 024)", () => {
  test("a burst of mod changes is one reload, and one more after it for what changed meanwhile", async () => {
    const s = setup();
    const first = s.dev.modChanged("mod/index.ts");
    void s.dev.modChanged("core/frames.ts");
    void s.dev.modChanged("mod/bridge.ts");
    expect(s.state.reloads).toBe(1);
    s.state.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(s.state.reloads).toBe(2);
    s.state.release();
    await first;
    expect(s.said).toEqual(["mod loki reloaded after mod/index.ts changed: ok", "mod loki reloaded after mod/bridge.ts changed: ok"]);
  });

  test("a daemon change restarts at once when nothing runs", async () => {
    const s = setup();
    s.state.idle = true;
    await s.dev.daemonChanged("daemon/chat-backend.ts");
    expect(s.restarts).toEqual(["daemon/chat-backend.ts changed"]);
  });

  test("while a chat runs it waits, and restarts when the turn ends, naming the latest change", async () => {
    const s = setup();
    await s.dev.daemonChanged("daemon/chat-move.ts");
    await s.dev.daemonChanged("daemon/passes.ts");
    expect(s.restarts).toEqual([]);
    await s.pass(5000);
    expect(s.restarts).toEqual([]);
    s.state.idle = true;
    await s.pass(5000);
    expect(s.restarts).toEqual(["daemon/passes.ts changed"]);
    expect(s.timers).toHaveLength(0);
  });

  test("after waiting too long it says a restart is due and stops looking; a later change waits again", async () => {
    const s = setup();
    await s.dev.daemonChanged("core/harness.ts");
    for (let i = 0; i < 12; i++) await s.pass(5000);
    expect(s.said).toEqual(["core/harness.ts changed, but a chat is still running: restart loki to use it"]);
    expect(s.timers).toHaveLength(0);
    s.state.idle = true;
    await s.dev.daemonChanged("daemon/main.ts");
    expect(s.restarts).toEqual(["daemon/main.ts changed"]);
  });

  test("stopping cancels a wait", async () => {
    const s = setup();
    await s.dev.daemonChanged("daemon/main.ts");
    s.dev.stop();
    s.state.idle = true;
    await s.pass(10_000);
    expect(s.restarts).toEqual([]);
  });
});
