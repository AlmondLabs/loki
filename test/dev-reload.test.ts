import { describe, expect, test, vi } from "vitest";
import { DevReload, MOD_SETTLE_MS } from "../daemon/dev-reload.ts";
import type { Severity } from "../core/log-line.ts";
import type { RestartAnswer } from "../mod/frames/daemon.ts";

function setup(built = false) {
  const said: string[] = [];
  const severities: Array<Severity | undefined> = [];
  const restarts: string[] = [];
  const state = { idle: true, reloads: 0, builds: 0, buildFails: null as string | null, reloadSays: "ok", release: () => {}, finishBuild: () => {} };
  const dev = new DevReload({
    reloadMod: () =>
      new Promise((resolve) => {
        state.reloads++;
        state.release = () => resolve(state.reloadSays);
      }),
    ...(built
      ? {
          buildPage: () =>
            new Promise<string | null>((resolve) => {
              state.builds++;
              state.finishBuild = () => resolve(state.buildFails);
            }),
        }
      : {}),
    restart: (why) => restarts.push(why),
    idle: () => Promise.resolve(state.idle),
    report: (m, severity) => {
      said.push(m);
      severities.push(severity);
    },
  });
  return { dev, state, said, severities, restarts };
}

function restartOf(answer: RestartAnswer): () => void {
  if (answer.code !== "restart") throw new Error(`expected a restart, got ${answer.code}`);
  return answer.restart;
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("a checkout keeping up with its sources (plan 024)", () => {
  test("a burst of mod changes is one reload, once the files have been still for a moment", async () => {
    vi.useFakeTimers();
    const s = setup();
    const first = s.dev.modChanged("mod/index.ts");
    await vi.advanceTimersByTimeAsync(MOD_SETTLE_MS - 1);
    void s.dev.modChanged("core/frames.ts");
    await vi.advanceTimersByTimeAsync(MOD_SETTLE_MS - 1);
    void s.dev.modChanged("mod/bridge.ts");
    await vi.advanceTimersByTimeAsync(MOD_SETTLE_MS - 1);
    expect(s.state.reloads).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.state.reloads).toBe(1);
    s.state.release();
    await first;
    expect(s.said).toEqual(["mod loki reloaded after mod/bridge.ts changed: ok"]);
    expect(s.severities).toEqual(["info"]);
  });

  test("a change while the mod reloads is one more reload after it, again once the files are still", async () => {
    vi.useFakeTimers();
    const s = setup();
    const first = s.dev.modChanged("mod/index.ts");
    await vi.advanceTimersByTimeAsync(MOD_SETTLE_MS);
    void s.dev.modChanged("mod/bridge.ts");
    s.state.release();
    await vi.advanceTimersByTimeAsync(MOD_SETTLE_MS - 1);
    expect(s.state.reloads).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.state.reloads).toBe(2);
    s.state.release();
    await first;
    expect(s.said).toEqual(["mod loki reloaded after mod/index.ts changed: ok", "mod loki reloaded after mod/bridge.ts changed: ok"]);
  });

  test("a reload that fails is reported as an error", async () => {
    vi.useFakeTimers();
    const s = setup();
    s.state.reloadSays = "mod loki failed to load: boom";
    const first = s.dev.modChanged("mod/index.ts");
    await vi.advanceTimersByTimeAsync(MOD_SETTLE_MS);
    s.state.release();
    await first;
    expect(s.said).toEqual(["mod loki reloaded after mod/index.ts changed: mod loki failed to load: boom"]);
    expect(s.severities).toEqual(["error"]);
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
    expect(s.said).toEqual(["daemon/chat-move.ts changed: update loki to use it"]);
    expect(s.restarts).toEqual([]);
  });

  test("asked to restart, it hands back the restart when nothing runs; while a chat works it says so, and restarts only anyway", async () => {
    const s = setup();
    s.dev.daemonChanged("daemon/passes.ts");
    s.state.idle = false;
    expect(await s.dev.restart(false)).toEqual({ code: "not_updated", reason: "a chat is still working or waiting for you: updating now cuts it off" });
    restartOf(await s.dev.restart(true))();
    expect(s.restarts).toEqual(["daemon/passes.ts changed"]);
    const asked = setup();
    restartOf(await asked.dev.restart(false))();
    expect(asked.restarts).toEqual(["asked"]);
  });

  test("the restart it hands back waits to be run", async () => {
    const s = setup();
    s.dev.daemonChanged("daemon/passes.ts");
    const restart = restartOf(await s.dev.restart(false));
    expect(s.restarts).toEqual([]);
    restart();
    expect(s.restarts).toEqual(["daemon/passes.ts changed"]);
  });

  test("under Vite a page change is hot reload's: nothing is due", () => {
    const s = setup();
    s.dev.pageChanged("app/src/shell/shell.tsx");
    expect(s.dev.restartDue()).toBeNull();
  });
});

describe("updating a checkout that runs the built page (plan 041)", () => {
  test("a page change makes an update due; update builds and does not restart", async () => {
    const s = setup(true);
    s.dev.pageChanged("app/src/shell/shell.tsx");
    expect(s.dev.restartDue()).toBe("app/src/shell/shell.tsx");
    const done = s.dev.restart(false);
    await settle();
    expect(s.state.builds).toBe(1);
    s.state.finishBuild();
    expect(await done).toEqual({ code: "updated" });
    expect(s.restarts).toEqual([]);
    expect(s.dev.restartDue()).toBeNull();
  });

  test("with the daemon's code changed too, update builds first, then restarts", async () => {
    const s = setup(true);
    s.dev.pageChanged("core/frames.ts");
    s.dev.daemonChanged("core/frames.ts");
    const done = s.dev.restart(false);
    await settle();
    expect(s.restarts).toEqual([]);
    s.state.finishBuild();
    restartOf(await done)();
    expect(s.restarts).toEqual(["core/frames.ts changed"]);
  });

  test("a build alone goes ahead while a chat works; a restart waits for anyway", async () => {
    const s = setup(true);
    s.state.idle = false;
    s.dev.pageChanged("app/src/chat/composer.tsx");
    const built = s.dev.restart(false);
    await settle();
    s.state.finishBuild();
    expect(await built).toEqual({ code: "updated" });
    s.dev.daemonChanged("daemon/passes.ts");
    expect(await s.dev.restart(false)).toEqual({ code: "not_updated", reason: "a chat is still working or waiting for you: updating now cuts it off" });
    expect(s.restarts).toEqual([]);
  });

  test("a page that does not build keeps the update due and says what failed", async () => {
    const s = setup(true);
    s.state.buildFails = "app/src/x.tsx: Unexpected token";
    s.dev.pageChanged("app/src/x.tsx");
    const done = s.dev.restart(false);
    await settle();
    s.state.finishBuild();
    expect(await done).toEqual({ code: "not_updated", reason: "the page did not build:\napp/src/x.tsx: Unexpected token" });
    expect(s.dev.restartDue()).toBe("app/src/x.tsx");
  });

  test("a change while it builds stays due for the next update", async () => {
    const s = setup(true);
    s.dev.pageChanged("app/src/a.tsx");
    const done = s.dev.restart(false);
    await settle();
    s.dev.pageChanged("app/src/b.tsx");
    s.state.finishBuild();
    expect(await done).toEqual({ code: "updated" });
    expect(s.dev.restartDue()).toBe("app/src/b.tsx");
  });

  test("two clicks while it builds are one update", async () => {
    const s = setup(true);
    s.dev.pageChanged("app/src/a.tsx");
    const first = s.dev.restart(false);
    const second = s.dev.restart(false);
    await settle();
    s.state.finishBuild();
    expect(await first).toEqual({ code: "updated" });
    expect(await second).toEqual({ code: "updated" });
    expect(s.state.builds).toBe(1);
  });
});
