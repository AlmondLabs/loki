import { describe, expect, test } from "vitest";
import { DevReload } from "../daemon/dev-reload.ts";

/** A dev reload with its reload and checks in the test's hands. */
function setup() {
  const said: string[] = [];
  const restarts: string[] = [];
  const state = { idle: true, reloads: 0, release: () => {} };
  const dev = new DevReload({
    reloadMod: () =>
      new Promise((resolve) => {
        state.reloads++;
        state.release = () => resolve("ok");
      }),
    restart: (why) => restarts.push(why),
    idle: () => Promise.resolve(state.idle),
    report: (m) => said.push(m),
  });
  return { dev, state, said, restarts };
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

  test("a daemon change only makes a restart due: the window hears it, and nothing restarts by itself", () => {
    const s = setup();
    const heard: string[] = [];
    s.dev.onRestartDue((f) => heard.push(f));
    expect(s.dev.restartDue()).toBeNull();
    s.dev.daemonChanged("daemon/chat-move.ts");
    s.dev.daemonChanged("core/harness.ts");
    expect(s.dev.restartDue()).toBe("core/harness.ts");
    expect(heard).toEqual(["daemon/chat-move.ts", "core/harness.ts"]);
    expect(s.said).toEqual(["daemon/chat-move.ts changed: restart loki to use it"]);
    expect(s.restarts).toEqual([]);
  });

  test("asked to restart, it does when nothing runs; while a chat works it says so, and restarts only anyway", async () => {
    const s = setup();
    s.dev.daemonChanged("daemon/passes.ts");
    s.state.idle = false;
    expect(await s.dev.restart(false)).toBe("a chat is still working or waiting for you: restarting now cuts it off");
    expect(s.restarts).toEqual([]);
    expect(await s.dev.restart(true)).toBeNull();
    expect(s.restarts).toEqual(["daemon/passes.ts changed"]);
    s.state.idle = true;
    expect(await setup().dev.restart(false)).toBeNull(); // asked with nothing due: the installed app's restart
  });
});
