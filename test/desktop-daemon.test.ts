import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { LOG_MAX_BYTES, openDaemonLog, rotateLog } from "../desktop/daemon-log.ts";
import {
  crashLoopNote,
  daemonCommand,
  daemonEnv,
  DaemonSupervisor,
  emptyStatus,
  oldDataNote,
  progressDue,
  restartDelay,
  wrapChild,
  type DaemonChild,
  type DaemonDeps,
  type DaemonStatus,
  type SpawnRequest,
} from "../desktop/daemon.ts";
import type { LockHolder } from "../desktop/procs.ts";
import { must } from "./fixtures/must.ts";

const temps: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "loki-desktop-daemon-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

function fakeClock() {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    after: (ms: number, fn: () => void) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return () => {
        timers.delete(id);
      };
    },
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])
          .at(0);
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

class FakeChild implements DaemonChild {
  readonly pid: number;
  private readonly events: string[];
  private readonly listeners: Array<(code: number | null) => void> = [];
  private code: { value: number | null } | null = null;
  answersStop = false;

  constructor(pid: number, events: string[]) {
    this.pid = pid;
    this.events = events;
  }

  send(message: "stop"): boolean {
    this.events.push(`send ${message} ${this.pid}`);
    if (this.answersStop) queueMicrotask(() => this.exit(0));
    return true;
  }

  signal(signal: NodeJS.Signals): void {
    this.events.push(`signal ${signal} ${this.pid}`);
  }

  kill(): void {
    this.events.push(`kill ${this.pid}`);
    this.exit(null);
  }

  exit(code: number | null): void {
    if (this.code) return;
    this.code = { value: code };
    for (const l of this.listeners.splice(0)) l(code);
  }

  get exited(): boolean {
    return this.code !== null;
  }

  onExit(listener: (code: number | null) => void): void {
    if (this.code) listener(this.code.value);
    else this.listeners.push(listener);
  }
}

function harness(overrides: Partial<DaemonDeps> = {}) {
  const clock = fakeClock();
  const events: string[] = [];
  const children: FakeChild[] = [];
  const requests: Array<{ at: number; request: SpawnRequest }> = [];
  const published: DaemonStatus[] = [];
  const lokiDir = join("home", "x", ".loki");
  let gate: Promise<void> | null = null;
  const deps: DaemonDeps = {
    lokiDir,
    platform: "darwin",
    parentPid: 777,
    env: { PATH: "/usr/bin:/bin", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--inspect", HOME: "/home/x" },
    entries: { entry: join(lokiDir, "daemon", "daemon.mjs"), modEntry: join(lokiDir, "mod", "loki-mod.mjs") },
    findNode: () => Promise.resolve({ found: true, node: "/opt/node/bin/node", dir: "/opt/node/bin", version: [24, 1, 0] }),
    git: null,
    toolsMissing: () => Promise.resolve(null),
    installTools: () => Promise.resolve(),
    lockHolder: () => Promise.resolve({ kind: "none" }),
    stopLeftover: (pid) => {
      events.push(`stop leftover ${pid}`);
      return Promise.resolve(true);
    },
    spawn: async (request) => {
      requests.push({ at: clock.now(), request });
      if (gate) await gate;
      const child = new FakeChild(100 + children.length, events);
      children.push(child);
      events.push(`spawn ${child.pid}`);
      return child;
    },
    clock,
    publish: (status) => published.push(status),
    log: () => {},
    ...overrides,
  };
  const daemon = new DaemonSupervisor(deps);
  const last = () => must(children.at(-1), "a daemon child");
  return {
    daemon,
    clock,
    events,
    children,
    requests,
    published,
    last,
    hold: () => {
      let open = () => {};
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return () => {
        gate = null;
        open();
      };
    },
  };
}

describe("the daemon's command and environment", () => {
  test("its sources run with type stripping, its bundle as it is, and both are told loki's pid", () => {
    const base = { node: "/usr/local/bin/node", dir: "/home/x/.loki", tokenFile: "/home/x/.loki/token", parentPid: 4242 };
    expect(daemonCommand({ ...base, entry: "/src/loki/daemon/main.ts", modEntry: "/src/loki/mod/boot.ts" })).toEqual({
      command: "/usr/local/bin/node",
      args: [
        "--disable-warning=ExperimentalWarning",
        "--experimental-strip-types",
        "/src/loki/daemon/main.ts",
        "--loki-daemon",
        "--dir",
        "/home/x/.loki",
        "--mod",
        "/src/loki/mod/boot.ts",
        "--token-file",
        "/home/x/.loki/token",
        "--parent-pid",
        "4242",
      ],
    });
    const bundle = daemonCommand({ ...base, entry: "/data/daemon/daemon.mjs", modEntry: "/data/mod/loki-mod.mjs" });
    expect(bundle.args.slice(0, 2)).toEqual(["--disable-warning=ExperimentalWarning", "/data/daemon/daemon.mjs"]);
  });

  test("the found Node's folder comes first on PATH, then PortableGit's, and no ELECTRON_ or NODE_OPTIONS reaches it", () => {
    const env = daemonEnv(
      { PATH: "/usr/bin:/bin", ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ASAR: "1", NODE_OPTIONS: "--inspect", HOME: "/home/x" },
      ["/opt/node/bin"],
      "darwin",
    );
    expect(env).toEqual({ HOME: "/home/x", PATH: "/opt/node/bin:/usr/bin:/bin" });
    expect(daemonEnv({}, ["/opt/node/bin"], "linux").PATH).toBe("/opt/node/bin");
    const windows = daemonEnv(
      { Path: "C:\\Windows\\system32;C:\\Windows", Node_Options: "--inspect", electron_run_as_node: "1", USERPROFILE: "C:\\Users\\x" },
      ["C:\\Program Files\\nodejs", "C:\\Users\\x\\.loki\\runtime\\git-2.56.1-win-x64\\cmd", "C:\\Users\\x\\.loki\\runtime\\git-2.56.1-win-x64\\bin"],
      "win32",
    );
    expect(windows).toEqual({
      USERPROFILE: "C:\\Users\\x",
      PATH: "C:\\Program Files\\nodejs;C:\\Users\\x\\.loki\\runtime\\git-2.56.1-win-x64\\cmd;C:\\Users\\x\\.loki\\runtime\\git-2.56.1-win-x64\\bin;C:\\Windows\\system32;C:\\Windows",
    });
  });

  test("a start spawns that command with that environment", async () => {
    const h = harness();
    await h.daemon.start();
    const { request } = must(h.requests[0], "a spawn");
    expect(request.command).toBe("/opt/node/bin/node");
    expect(request.args).toContain("--loki-daemon");
    expect(request.args.slice(-2)).toEqual(["--parent-pid", "777"]);
    expect(request.env.PATH.split(":")[0]).toBe("/opt/node/bin");
    expect(Object.keys(request.env).some((k) => k.startsWith("ELECTRON_") || k === "NODE_OPTIONS")).toBe(false);
    expect(request.log).toBe(join("home", "x", ".loki", "logs", "daemon.log"));
    expect(h.daemon.status()).toEqual({ ...emptyStatus(), node: "24.1.0" });
  });
});

describe("the daemon's log", () => {
  test("a log past its size is set aside once and a smaller one is left", () => {
    const dir = tempDir();
    const log = join(dir, "daemon.log");
    const aside = join(dir, "daemon.log.1");
    writeFileSync(log, "short");
    rotateLog(log, 10);
    expect([existsSync(log), existsSync(aside)]).toEqual([true, false]);
    writeFileSync(log, "longer than ten bytes");
    writeFileSync(aside, "the one before");
    rotateLog(log, 10);
    expect(existsSync(log)).toBe(false);
    expect(readFileSync(aside, "utf8")).toBe("longer than ten bytes");
    rotateLog(log, 10);
  });

  test("opening the log past 10 MB moves it to daemon.log.1 and starts a fresh one in a new logs folder", () => {
    const dir = tempDir();
    const log = join(dir, "logs", "daemon.log");
    const write = (text: string | Buffer) => {
      const fd = openDaemonLog(log);
      writeFileSync(fd, text);
      closeSync(fd);
    };
    write(Buffer.alloc(LOG_MAX_BYTES, 0x61));
    write("b");
    expect(existsSync(join(dir, "logs", "daemon.log.1"))).toBe(false);
    write("new\n");
    expect(readFileSync(join(dir, "logs", "daemon.log.1")).length).toBe(LOG_MAX_BYTES + 1);
    expect(readFileSync(log, "utf8")).toBe("new\n");
    write("appended\n");
    expect(readFileSync(log, "utf8")).toBe("new\nappended\n");
  });
});

describe("the supervisor's rules", () => {
  test("a daemon that keeps dying is restarted ever more slowly up to thirty seconds", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((n) => restartDelay(n) / 1000)).toEqual([1, 2, 4, 8, 16, 30, 30, 30]);
  });

  test("a daemon that keeps stopping is said so from its third exit in a minute", () => {
    const log = join("logs", "daemon.log");
    expect(crashLoopNote(0, log)).toBeNull();
    expect(crashLoopNote(2, log)).toBeNull();
    const note = must(crashLoopNote(3, log), "a note at the third exit");
    expect(note).toContain("keeps stopping (3 times in the last minute)");
    expect(note).toContain("daemon.log");
  });

  test("only the old-data exit stops the restarts with its note", () => {
    const log = join("logs", "daemon.log");
    expect(oldDataNote(4, log)).toContain("2026.1116");
    for (const other of [null, 0, 1, 3]) expect(oldDataNote(other, log)).toBeNull();
  });

  test("download progress goes out at its ends and at most every quarter second between", () => {
    const p = (done: number, total: number | null = 1000) => ({ name: "git" as const, version: "2.56.1", done, total });
    expect(progressDue(null, 0, p(500))).toBe(true);
    expect(progressDue(0, 0, p(0))).toBe(true);
    expect(progressDue(0, 0, p(1000))).toBe(true);
    expect(progressDue(0, 100, p(500))).toBe(false);
    expect(progressDue(0, 250, p(500))).toBe(true);
    expect(progressDue(0, 100, p(500, null))).toBe(false);
  });
});

describe("supervision", () => {
  test("restarts run 1, 2, 4, 8, 16 and 30 seconds apart while exits come inside a minute, and reset after a quiet minute", async () => {
    const h = harness();
    await h.daemon.start();
    const gaps: number[] = [];
    for (let i = 0; i < 6; i++) {
      const before = h.requests.length;
      const exitAt = h.clock.now();
      h.last().exit(1);
      await flush();
      while (h.requests.length === before) await h.clock.advance(500);
      gaps.push((must(h.requests.at(-1), "a restart").at - exitAt) / 1000);
    }
    expect(gaps).toEqual([1, 2, 4, 8, 16, 30]);
    await h.clock.advance(61_000);
    const exitAt = h.clock.now();
    h.last().exit(1);
    await h.clock.advance(1000);
    expect((must(h.requests.at(-1), "a restart").at - exitAt) / 1000).toBe(1);
  });

  test("a daemon exit while running schedules a restart and publishes the status", async () => {
    const h = harness();
    await h.daemon.start();
    h.published.length = 0;
    h.last().exit(1);
    await h.clock.advance(999);
    expect(h.requests).toHaveLength(1);
    await h.clock.advance(1);
    expect(h.requests).toHaveLength(2);
    expect(h.published.at(-1)).toEqual({ ...emptyStatus(), node: "24.1.0" });
  });

  test("the third exit in a minute says the daemon keeps stopping, and a quiet minute clears it", async () => {
    const h = harness();
    await h.daemon.start();
    for (const wait of [1000, 2000]) {
      h.last().exit(1);
      await h.clock.advance(wait);
    }
    expect(h.daemon.status().error).toBeNull();
    h.last().exit(1);
    await h.clock.advance(4000);
    expect(h.daemon.status().error).toContain("keeps stopping (3 times in the last minute)");
    await h.clock.advance(60_000);
    expect(h.daemon.status().error).toBeNull();
    expect(h.daemon.status().node).toBe("24.1.0");
  });

  test("exit 3 holds and tries again every 30 seconds", async () => {
    const h = harness();
    await h.daemon.start();
    h.last().exit(3);
    await h.clock.advance(29_999);
    expect(h.requests).toHaveLength(1);
    await h.clock.advance(1);
    expect(h.requests).toHaveLength(2);
    h.last().exit(3);
    await h.clock.advance(30_000);
    expect(h.requests.map((r) => r.at)).toEqual([0, 30_000, 60_000]);
    expect(h.daemon.status().error).toBeNull();
  });

  test("exit 4 stops restarting and publishes the old-data note, and Try Again starts it once more", async () => {
    const h = harness();
    await h.daemon.start();
    h.last().exit(4);
    await h.clock.advance(120_000);
    expect(h.requests).toHaveLength(1);
    const status = must(h.published.at(-1), "a status");
    expect(status.error).toContain("2026.1116");
    expect(status.error).toContain("daemon.log");
    await h.daemon.retry();
    expect(h.requests).toHaveLength(2);
  });

  test("exit 0 after a dev restart starts the daemon again; exit 0 while quitting does not", async () => {
    const h = harness();
    await h.daemon.start();
    h.last().exit(0);
    await h.clock.advance(1000);
    expect(h.requests).toHaveLength(2);
    h.last().answersStop = true;
    await h.daemon.quit();
    await h.clock.advance(120_000);
    expect(h.requests).toHaveLength(2);
    expect(h.last().exited).toBe(true);
    await h.daemon.start();
    expect(h.requests).toHaveLength(2);
  });

  test("a quit sends the stop message before any kill, and kills only after three seconds without an exit", async () => {
    const h = harness();
    await h.daemon.start();
    const child = h.last();
    let quit = false;
    const quitting = h.daemon.quit().then(() => {
      quit = true;
    });
    await flush();
    expect(h.events).toEqual(["spawn 100", "send stop 100"]);
    await h.clock.advance(2999);
    expect(child.exited).toBe(false);
    expect(quit).toBe(false);
    await h.clock.advance(1);
    await quitting;
    expect(h.events).toEqual(["spawn 100", "send stop 100", "kill 100"]);

    const polite = harness();
    await polite.daemon.start();
    polite.last().answersStop = true;
    await polite.daemon.quit();
    await polite.clock.advance(5000);
    expect(polite.events).toEqual(["spawn 100", "send stop 100"]);
  });

  test("a stop for an update that then fails starts the daemon again", async () => {
    const h = harness();
    await h.daemon.start();
    h.last().answersStop = true;
    await h.daemon.quit();
    await h.daemon.start();
    expect(h.requests).toHaveLength(1);
    await h.daemon.resume();
    expect(h.requests).toHaveLength(2);
  });

  test("a quit while a restart waits cancels it", async () => {
    const h = harness();
    await h.daemon.start();
    h.last().exit(1);
    await flush();
    await h.daemon.quit();
    await h.clock.advance(60_000);
    expect(h.requests).toHaveLength(1);
  });

  test("a stop during a start ends the new child instead of keeping it", async () => {
    const h = harness();
    const open = h.hold();
    const starting = h.daemon.start();
    await flush();
    expect(h.requests).toHaveLength(1);
    await h.daemon.quit();
    open();
    await starting;
    const child = h.last();
    expect(h.events).toEqual(["spawn 100", "send stop 100"]);
    await h.clock.advance(3000);
    expect(child.exited).toBe(true);
    expect(h.events).toEqual(["spawn 100", "send stop 100", "kill 100"]);
    await h.clock.advance(60_000);
    expect(h.requests).toHaveLength(1);
  });
});

describe("before the daemon starts", () => {
  test("a leftover whose loki is gone is stopped before the daemon starts", async () => {
    const leftover: LockHolder = { kind: "leftover", pid: 4321, started: 99 };
    const h = harness({ lockHolder: () => Promise.resolve(leftover) });
    await h.daemon.start();
    expect(h.events).toEqual(["stop leftover 4321", "spawn 100"]);
    expect(h.daemon.status().otherLoki).toBeNull();
  });

  test("a daemon whose loki still runs is left serving, and the status names that loki", async () => {
    const serving: LockHolder = {
      kind: "serving",
      pid: 4321,
      loki: { pid: 55, parent: 1, started: 1, name: "loki", command: "/Applications/loki.app/Contents/MacOS/loki" },
    };
    const h = harness({ lockHolder: () => Promise.resolve(serving) });
    await h.daemon.start();
    expect(h.events).toEqual(["spawn 100"]);
    expect(h.daemon.status()).toEqual({ ...emptyStatus(), node: "24.1.0", otherLoki: { pid: 55, command: "/Applications/loki.app/Contents/MacOS/loki" } });
  });

  test("with no Node found the status carries needsNode and no daemon is spawned", async () => {
    const old = harness({ findNode: () => Promise.resolve({ found: false, old: { version: [20, 11, 1], at: "/usr/local/bin/node" } }) });
    await old.daemon.start();
    expect(old.requests).toHaveLength(0);
    const status = old.daemon.status();
    expect(status.needsNode).toEqual({ found: "20.11.1", at: "/usr/local/bin/node", needed: "22.19" });
    expect(status.node).toBeNull();
    expect(status.error).toContain("Node 20.11.1 at /usr/local/bin/node is older than 22.19");
    const none = harness({ findNode: () => Promise.resolve({ found: false, old: null }) });
    await none.daemon.start();
    expect(none.requests).toHaveLength(0);
    expect(none.daemon.status().needsNode).toEqual({ found: null, at: null, needed: "22.19" });
    expect(await none.daemon.retry()).toMatchObject({ needsNode: { needed: "22.19" } });
  });

  test("a Mac without the command line tools shows the tools step and starts nothing", async () => {
    const h = harness({ toolsMissing: () => Promise.resolve("macos") });
    await h.daemon.start();
    expect(h.requests).toHaveLength(0);
    expect(h.published).toEqual([{ ...emptyStatus(), toolsMissing: "macos" }]);
  });

  test("Windows without Git Bash shows PortableGit being fetched (its middle no more than every quarter second), then puts it on the daemon's PATH after Node", async () => {
    const h = harness({
      platform: "win32",
      env: { Path: "C:\\Windows" },
      findNode: () => Promise.resolve({ found: true, node: "C:\\nodejs\\node.exe", dir: "C:\\nodejs", version: [24, 1, 0] }),
      git: {
        missing: () => true,
        ensure: (progress) => {
          progress({ name: "git", version: "2.56.1", done: 0, total: null });
          progress({ name: "git", version: "2.56.1", done: 0, total: 100 });
          progress({ name: "git", version: "2.56.1", done: 50, total: 100 });
          progress({ name: "git", version: "2.56.1", done: 100, total: 100 });
          return Promise.resolve(["C:\\git\\cmd", "C:\\git\\bin"]);
        },
        prune: () => {},
      },
    });
    await h.daemon.start();
    const fetching = h.published.flatMap((s) => (s.preparing ? [s.preparing] : []));
    expect(fetching.map((p) => p.done)).toEqual([0, 0, 100]);
    expect(h.published.every((s) => s.toolsMissing === null && s.error === null)).toBe(true);
    expect(must(h.requests[0], "a spawn").request.env.PATH).toBe("C:\\nodejs;C:\\git\\cmd;C:\\git\\bin;C:\\Windows");
    expect(h.published.at(-1)).toEqual({ ...emptyStatus(), node: "24.1.0" });
  });

  test("a failed PortableGit download says what failed beside what was being fetched", async () => {
    const h = harness({
      platform: "win32",
      git: {
        missing: () => true,
        ensure: (progress) => {
          progress({ name: "git", version: "2.56.1", done: 0, total: null });
          return Promise.reject(new Error("could not download PortableGit-2.56.1-64-bit.7z.exe: connection reset"));
        },
        prune: () => {},
      },
    });
    await h.daemon.start();
    expect(h.requests).toHaveLength(0);
    expect(h.published.at(-1)).toEqual({
      ...emptyStatus(),
      error: "could not download PortableGit-2.56.1-64-bit.7z.exe: connection reset",
      preparing: { name: "git", version: "2.56.1", done: 0, total: null },
    });
  });
});

describe("a real child on the IPC channel", () => {
  test("stops on the stop message, its output in the log", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "logs"));
    const script = join(dir, "child.cjs");
    writeFileSync(
      script,
      'process.on("message", (m) => { if (m === "stop") { console.log("asked to stop"); process.exit(0); } }); console.log("ready"); process.send("up");',
    );
    const log = join(dir, "logs", "daemon.log");
    const fd = openDaemonLog(log);
    const child = spawn(process.execPath, [script], { stdio: ["ignore", fd, fd, "ipc"] });
    closeSync(fd);
    const up = new Promise<void>((resolve) => child.once("message", () => resolve()));
    const wrapped = wrapChild(child, process.platform, () => {});
    let readyCount = 0;
    const readyPromise = new Promise<void>((resolve) =>
      wrapped.onReady?.(() => {
        readyCount++;
        resolve();
      }),
    );
    await up;
    expect(readyCount).toBe(0);
    child.emit("message", "ready");
    await readyPromise;
    expect(readyCount).toBe(1);
    const code = new Promise<number | null>((resolve) => wrapped.onExit(resolve));
    expect(wrapped.send("stop")).toBe(true);
    expect(await code).toBe(0);
    expect(readFileSync(log, "utf8")).toBe("ready\nasked to stop\n");
    expect(wrapped.send("stop")).toBe(false);
  });
});
