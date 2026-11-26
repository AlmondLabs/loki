import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  commandWords,
  isOwnDaemon,
  listProcs,
  lockHolder,
  parsePs,
  parseWindowsProcs,
  readLockPid,
  splitWindows,
  stopLeftover,
  type Proc,
  type StopHost,
} from "../desktop/procs.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TOKEN = "/home/x/.loki/token";
const daemonLine = (extra = "") =>
  `/usr/local/bin/node --disable-warning=ExperimentalWarning /home/x/.loki/daemon/daemon.mjs --loki-daemon --dir /home/x/.loki --token-file ${TOKEN}${extra}`;
const daemon = (pid: number, parent: number | null, extra = ""): Proc => ({ pid, parent, started: 99_000, name: "node", command: daemonLine(extra) });
const proc = (pid: number, name: string, parent: number | null = 1, started = 1000): Proc => ({ pid, parent, started, name, command: `/bin/${name}` });

describe("which process holds the daemon's lock", () => {
  test("a daemon whose loki is gone is a leftover and one whose loki runs is left serving", () => {
    expect(lockHolder([daemon(40, 1), proc(1, "launchd", null)], 40, TOKEN, false)).toEqual({ kind: "leftover", pid: 40, started: 99_000 });
    const shell = proc(5, "loki");
    expect(lockHolder([daemon(40, 5), shell], 40, TOKEN, false)).toEqual({ kind: "serving", pid: 40, loki: shell });
    expect(lockHolder([daemon(40, 1)], 40, "/elsewhere/token", false)).toEqual({ kind: "none" });
    for (const [parent, procs] of [
      [900, [proc(900, "systemd")]],
      [4321, []],
      [null, []],
    ] as const) {
      expect(lockHolder([daemon(40, parent), ...procs], 40, TOKEN, false), String(parent)).toEqual({ kind: "leftover", pid: 40, started: 99_000 });
    }
    for (const name of ["loki", "loki.exe", "LOKI.EXE"]) {
      expect(lockHolder([daemon(40, 5), proc(5, name)], 40, TOKEN, false).kind, name).toBe("serving");
    }
  });

  test("a lock whose pid is dead is left to the daemon's own takeover, and no lock is nothing", () => {
    expect(lockHolder([proc(1, "launchd", null)], 40, TOKEN, false)).toEqual({ kind: "none" });
    expect(lockHolder([daemon(40, 1)], null, TOKEN, false)).toEqual({ kind: "none" });
  });

  test("a live pid without --loki-daemon is never a leftover", () => {
    const other: Proc = { pid: 41, parent: 1, started: 1, name: "node", command: `node x.mjs --token-file ${TOKEN}` };
    expect(lockHolder([other], 41, TOKEN, false)).toEqual({ kind: "none" });
    const browser = proc(41, "Safari");
    expect(lockHolder([browser], 41, TOKEN, false)).toEqual({ kind: "none" });
  });

  test("an Electron loki's daemon is judged by the pid it was given: alive is serving, gone or reused is a leftover", () => {
    const electron: Proc = { pid: 600, parent: 1, started: 50_000, name: "Electron", command: "/x/Electron.app/Contents/MacOS/Electron desktop/dist/main.cjs" };
    expect(lockHolder([daemon(40, 600, " --parent-pid 600"), electron], 40, TOKEN, false)).toEqual({ kind: "serving", pid: 40, loki: electron });
    expect(lockHolder([daemon(40, 1, " --parent-pid 600")], 40, TOKEN, false).kind).toBe("leftover");
    const reused = { ...electron, started: 200_000 };
    expect(lockHolder([daemon(40, 1, " --parent-pid 600"), reused], 40, TOKEN, false).kind).toBe("leftover");
  });

  test("a Windows command line is split the way programs read it", () => {
    const line =
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\some one\\.loki\\daemon\\daemon.mjs" --loki-daemon --token-file "C:\\Users\\some one\\.loki\\token" --parent-pid 600';
    const words = commandWords(line);
    expect(words[0]).toBe("C:\\Program Files\\nodejs\\node.exe");
    expect(words[1]).toBe("C:\\Users\\some one\\.loki\\daemon\\daemon.mjs");
    expect(words.at(-3)).toBe("C:\\Users\\some one\\.loki\\token");
    const p: Proc = { pid: 40, parent: 7, started: 5, name: "node.exe", command: line };
    expect(isOwnDaemon(p, "C:\\Users\\some one\\.loki\\token", true)).toBe(true);
    expect(isOwnDaemon(p, "c:/users/some one/.loki/token", true)).toBe(true);
    expect(isOwnDaemon(p, "C:\\Users\\other\\.loki\\token", true)).toBe(false);
    const loki: Proc = { pid: 600, parent: 1, started: 1, name: "loki.exe", command: '"C:\\Program Files\\loki\\loki.exe"' };
    expect(lockHolder([p, loki], 40, "C:\\Users\\some one\\.loki\\token", true).kind).toBe("serving");
    expect(lockHolder([p], 40, "C:\\Users\\some one\\.loki\\token", true).kind).toBe("leftover");
    expect(commandWords('node.exe "C:\\x\\token"')).toEqual(["node.exe", "C:\\x\\token"]);
    expect(splitWindows('a\\\\\\"b "c\\\\" d')).toEqual(['a\\"b', "c\\", "d"]);
    expect(commandWords("")).toEqual([]);
  });

  test("a Unix daemon's token file may hold spaces", () => {
    const p: Proc = {
      pid: 40,
      parent: 1,
      started: 5,
      name: "node",
      command: "node /x/daemon.mjs --loki-daemon --dir /Users/some one/.loki --token-file /Users/some one/.loki/token",
    };
    expect(isOwnDaemon(p, "/Users/some one/.loki/token", false)).toBe(true);
    expect(isOwnDaemon(p, "/Users/some one/.loki/tok", false)).toBe(false);
  });

  test("the lock file's pid is read, and anything else is no pid", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-procs-"));
    temps.push(dir);
    const file = join(dir, "daemon.lock");
    expect(readLockPid(file)).toBeNull();
    writeFileSync(file, "4321");
    expect(readLockPid(file)).toBe(4321);
    writeFileSync(file, "nope");
    expect(readLockPid(file)).toBeNull();
  });
});

describe("the process list", () => {
  test("ps output is read with its start times and whole command lines", () => {
    const out = [
      "    1     0 Mon Nov 23 09:59:48 2026     /sbin/launchd",
      "  600     1 Tue Nov  5 10:00:09 2026     /Applications/My Apps/loki.app/Contents/MacOS/loki",
      `  640   600 Tue Nov 25 10:29:00 2026     ${daemonLine()}`,
      "garbage",
      "",
    ].join("\n");
    const procs = parsePs(out);
    expect(procs.map((p) => [p.pid, p.parent, p.name])).toEqual([
      [1, null, "launchd"],
      [600, 1, "loki"],
      [640, 600, "node"],
    ]);
    expect(procs[2]?.command).toBe(daemonLine());
    expect(procs[1]?.started).toBe(new Date(2026, 10, 5, 10, 0, 9).getTime());
    expect(lockHolder(procs, 640, TOKEN, false).kind).toBe("serving");
  });

  test("PowerShell's list is read whether it holds many processes or one", () => {
    const many = JSON.stringify([
      { ProcessId: 0, ParentProcessId: 0, Name: "System Idle Process", CommandLine: null, Started: null },
      { ProcessId: 600, ParentProcessId: 4, Name: "loki.exe", CommandLine: '"C:\\Program Files\\loki\\loki.exe"', Started: 1_795_500_000_000 },
    ]);
    expect(parseWindowsProcs(many)).toEqual([
      { pid: 0, parent: 0, started: null, name: "System Idle Process", command: "" },
      { pid: 600, parent: 4, started: 1_795_500_000_000, name: "loki.exe", command: '"C:\\Program Files\\loki\\loki.exe"' },
    ]);
    expect(parseWindowsProcs(JSON.stringify({ ProcessId: 9, ParentProcessId: 1, Name: "node.exe", CommandLine: "node", Started: 5 }))).toHaveLength(1);
    expect(parseWindowsProcs("not json")).toEqual([]);
  });

  test("the system's reader lists this process with its command line", { timeout: 30_000 }, async () => {
    const procs = await listProcs();
    const mine = procs.find((p) => p.pid === process.pid);
    expect(mine?.command).not.toBe("");
    expect(mine?.started).toBeTypeOf("number");
  });
});

function stopHost(opts: { windows?: boolean; started?: number; ignoresTerm?: boolean }) {
  const events: string[] = [];
  let now = 0;
  let running = true;
  const host: StopHost = {
    windows: opts.windows ?? false,
    list: () => Promise.resolve(running ? [{ pid: 40, parent: 1, started: opts.started ?? 99, name: "node", command: daemonLine() }] : []),
    alive: () => running,
    signal: (pid, signal) => {
      events.push(`${signal} ${pid} at ${now}`);
      if (signal === "SIGKILL" || !opts.ignoresTerm) running = false;
    },
    killTree: (pid) => {
      events.push(`tree ${pid} at ${now}`);
      running = false;
    },
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    now: () => now,
  };
  return { host, events };
}

describe("stopping a leftover", () => {
  test("it is asked to close first and killed only after three seconds of ignoring that", async () => {
    const polite = stopHost({});
    expect(await stopLeftover(polite.host, 40, 99)).toBe(true);
    expect(polite.events).toEqual(["SIGTERM 40 at 0"]);
    const stubborn = stopHost({ ignoresTerm: true });
    expect(await stopLeftover(stubborn.host, 40, 99)).toBe(true);
    expect(stubborn.events).toEqual(["SIGTERM 40 at 0", "SIGKILL 40 at 3000"]);
  });

  test("a different start time is a different process: left alone", async () => {
    const reused = stopHost({ started: 12_345 });
    expect(await stopLeftover(reused.host, 40, 99)).toBe(false);
    expect(reused.events).toEqual([]);
  });

  test("on Windows its tree is ended", async () => {
    const windows = stopHost({ windows: true });
    expect(await stopLeftover(windows.host, 40, 99)).toBe(true);
    expect(windows.events).toEqual(["tree 40 at 0"]);
  });
});
