import { type ChildProcess, spawn } from "node:child_process";
import { closeSync } from "node:fs";
import { join } from "node:path";
import { messageOf } from "../core/errors.ts";
import { Listeners } from "../core/listeners.ts";
import { alive } from "../daemon/parent-watch.ts";
import { killTree } from "../daemon/tree-kill.ts";
import { openDaemonLog } from "./daemon-log.ts";
import { pageOs } from "./env.ts";
import { devCheckout } from "./install.ts";
import { findNode, machineNodeHost, versionText, type NodeSearch, type Version } from "./node-search.ts";
import { listProcs, lockHolder, readLockPid, STOP_GRACE_MS, stopLeftover, type LockHolder, type StopHost } from "./procs.ts";
import {
  developerDir,
  ensurePortableGit,
  GIT_TARGET,
  gitManifest,
  gitMissing,
  installTools,
  prunePortableGit,
  runSelfExtracting,
  toolsMissing,
  type Preparing,
  type ToolsHost,
} from "./tools.ts";

export const EXIT_HELD = 3;
export const EXIT_OLD_DATA = 4;
export const CRASH_LOOP_EXITS = 3;
export const HELD_RETRY_MS = 30_000;
export const EXIT_WINDOW_MS = 60_000;
export const PROGRESS_EVERY_MS = 250;
export const RUNTIME_EVENT = "loki:runtime";

export interface NeedsNode {
  found: string | null;
  at: string | null;
  needed: "22.19";
}

export interface OtherLoki {
  pid: number;
  command: string;
}

export interface DaemonStatus {
  node: string | null;
  error: string | null;
  preparing: Preparing | null;
  toolsMissing: "macos" | "linux" | null;
  needsNode: NeedsNode | null;
  otherLoki: OtherLoki | null;
}

export const emptyStatus = (): DaemonStatus => ({ node: null, error: null, preparing: null, toolsMissing: null, needsNode: null, otherLoki: null });

export interface DaemonChild {
  readonly pid: number | undefined;
  send: (message: "stop") => boolean;
  signal: (signal: NodeJS.Signals) => void;
  kill: () => void;
  onExit: (listener: (code: number | null) => void) => void;
}

export interface SpawnRequest {
  command: string;
  args: string[];
  env: Record<string, string>;
  log: string;
}

export interface Clock {
  now: () => number;
  after: (ms: number, fn: () => void) => () => void;
}

export interface GitDeps {
  missing: () => boolean;
  ensure: (progress: (p: Preparing) => void) => Promise<string[]>;
  prune: () => void;
}

export interface DaemonDeps {
  lokiDir: string;
  platform: NodeJS.Platform;
  parentPid: number;
  env: NodeJS.ProcessEnv;
  entries: { entry: string; modEntry: string };
  findNode: () => Promise<NodeSearch>;
  git: GitDeps | null;
  toolsMissing: () => Promise<"macos" | "linux" | null>;
  installTools: () => Promise<void>;
  lockHolder: () => Promise<LockHolder>;
  stopLeftover: (pid: number, started: number) => Promise<boolean>;
  spawn: (request: SpawnRequest) => Promise<DaemonChild>;
  clock: Clock;
  publish: (status: DaemonStatus) => void;
  log: (line: string) => void;
}

export function restartDelay(recentExits: number): number {
  return Math.min(2 ** Math.min(recentExits, 5), 30) * 1000;
}

export function crashLoopNote(recentExits: number, log: string): string | null {
  return recentExits >= CRASH_LOOP_EXITS ? `loki's daemon keeps stopping (${recentExits} times in the last minute): its log is ${log}` : null;
}

export function oldDataNote(code: number | null, log: string): string | null {
  return code === EXIT_OLD_DATA
    ? `This loki folder needs loki 2026.1116 to finish converting it. Install loki 2026.1116, start it once, then update again. The daemon's log says what it found: ${log}`
    : null;
}

export function progressDue(last: number | null, now: number, p: Preparing): boolean {
  return p.done === 0 || p.total === p.done || last === null || now - last >= PROGRESS_EVERY_MS;
}

export function needsNodeOf(old: { version: Version; at: string } | null): NeedsNode {
  return { found: old ? versionText(old.version) : null, at: old?.at ?? null, needed: "22.19" };
}

export function nodeMissingMessage(n: NeedsNode): string {
  const what = n.found && n.at ? `Node ${n.found} at ${n.at} is older than ${n.needed}` : `no Node ${n.needed} or newer`;
  return `${what}: install Node ${n.needed} or newer, or set LOKI_NODE_BIN, then check again`;
}

export function daemonCommand(d: { node: string; entry: string; modEntry: string; dir: string; tokenFile: string; parentPid: number }): {
  command: string;
  args: string[];
} {
  return {
    command: d.node,
    args: [
      "--disable-warning=ExperimentalWarning",
      ...(d.entry.endsWith(".ts") ? ["--experimental-strip-types"] : []),
      d.entry,
      "--loki-daemon",
      "--dir",
      d.dir,
      "--mod",
      d.modEntry,
      "--token-file",
      d.tokenFile,
      "--parent-pid",
      String(d.parentPid),
    ],
  };
}

export function daemonEnv(inherited: NodeJS.ProcessEnv, front: readonly string[], platform: NodeJS.Platform): Record<string, string> {
  const windows = platform === "win32";
  const env: Record<string, string> = {};
  let path: string | undefined;
  for (const [key, value] of Object.entries(inherited)) {
    if (value === undefined) continue;
    const name = windows ? key.toUpperCase() : key;
    if (name.startsWith("ELECTRON_") || name === "NODE_OPTIONS") continue;
    if (name === "PATH") {
      path ??= value;
      continue;
    }
    env[key] = value;
  }
  const separator = windows ? ";" : ":";
  env.PATH = [...front, ...(path ?? "").split(separator).filter((d) => d !== "")].join(separator);
  return env;
}

export class DaemonSupervisor {
  private readonly deps: DaemonDeps;
  private current: DaemonStatus = emptyStatus();
  private running: DaemonChild | null = null;
  private request: SpawnRequest | null = null;
  private stops = 0;
  private quitting = false;
  private starting = false;
  private supervising = false;
  private held = false;
  private looping = false;
  private exits: number[] = [];
  private cancelRestart: (() => void) | null = null;
  private cancelQuiet: (() => void) | null = null;

  constructor(deps: DaemonDeps) {
    this.deps = deps;
  }

  status(): DaemonStatus {
    return { ...this.current };
  }

  get logFile(): string {
    return join(this.deps.lokiDir, "logs", "daemon.log");
  }

  async start(): Promise<void> {
    if (this.starting || this.quitting) return;
    this.starting = true;
    try {
      await this.startOnce();
    } catch (error) {
      this.deps.log(messageOf(error));
    } finally {
      this.starting = false;
    }
  }

  async retry(): Promise<DaemonStatus> {
    if (!this.supervising) await this.start();
    return this.status();
  }

  installTools(): Promise<void> {
    return this.deps.installTools();
  }

  async resume(): Promise<void> {
    this.quitting = false;
    await this.start();
  }

  async quit(): Promise<void> {
    this.quitting = true;
    this.stops++;
    this.cancelRestart?.();
    this.cancelQuiet?.();
    const child = this.running;
    this.running = null;
    if (child) await this.terminate(child);
  }

  private publish(next: DaemonStatus): void {
    this.current = next;
    this.deps.publish(this.status());
  }

  private restartAfter(ms: number, fn: () => void): void {
    this.cancelRestart?.();
    this.cancelRestart = this.deps.clock.after(ms, () => {
      this.cancelRestart = null;
      fn();
    });
  }

  private async prepareGit(): Promise<string[] | null> {
    const git = this.deps.git;
    if (!git?.missing()) return [];
    let preparing: Preparing | null = null;
    let sent: number | null = null;
    try {
      return await git.ensure((p) => {
        if (p.done === 0 && p.total === null) this.deps.log(`runtime: fetching git ${p.version}`);
        preparing = p;
        const now = this.deps.clock.now();
        if (progressDue(sent, now, p)) {
          sent = now;
          this.publish({ ...emptyStatus(), preparing: p });
        }
      });
    } catch (error) {
      this.deps.log(messageOf(error));
      this.publish({ ...emptyStatus(), error: messageOf(error), preparing });
      return null;
    }
  }

  private async checkLock(): Promise<OtherLoki | null> {
    let holder: LockHolder;
    try {
      holder = await this.deps.lockHolder();
    } catch (error) {
      this.deps.log(`daemon: could not read the process list: ${messageOf(error)}`);
      return null;
    }
    if (holder.kind === "serving") {
      this.deps.log(`daemon: another loki (pid ${holder.loki.pid}) is running its daemon (pid ${holder.pid}); leaving it serving`);
      return { pid: holder.loki.pid, command: holder.loki.command };
    }
    if (holder.kind === "leftover") {
      this.deps.log(`daemon: one left from an earlier run (pid ${holder.pid}); stopping it`);
      await this.deps.stopLeftover(holder.pid, holder.started);
    }
    return null;
  }

  private async startOnce(): Promise<void> {
    const gitPath = await this.prepareGit();
    if (gitPath === null) return;
    const tools = await this.deps.toolsMissing();
    if (tools) {
      this.publish({ ...emptyStatus(), toolsMissing: tools });
      return;
    }
    const search = await this.deps.findNode();
    if (!search.found) {
      const needsNode = needsNodeOf(search.old);
      this.deps.log(nodeMissingMessage(needsNode));
      this.publish({ ...emptyStatus(), error: nodeMissingMessage(needsNode), needsNode });
      return;
    }
    const nodeShown = versionText(search.version);
    const otherLoki = await this.checkLock();
    const { command, args } = daemonCommand({
      node: search.node,
      entry: this.deps.entries.entry,
      modEntry: this.deps.entries.modEntry,
      dir: this.deps.lokiDir,
      tokenFile: join(this.deps.lokiDir, "token"),
      parentPid: this.deps.parentPid,
    });
    this.request = { command, args, env: daemonEnv(this.deps.env, [search.dir, ...gitPath], this.deps.platform), log: this.logFile };
    const failed = await this.launch();
    if (failed) {
      this.deps.log(failed);
      this.publish({ ...emptyStatus(), node: nodeShown, error: failed, otherLoki });
      return;
    }
    this.deps.log(`daemon on ${search.node} (${nodeShown})`);
    this.deps.git?.prune();
    this.exits = [];
    this.held = false;
    this.looping = false;
    this.supervising = true;
    this.publish({ ...emptyStatus(), node: nodeShown, otherLoki });
  }

  private async launch(): Promise<string | null> {
    const request = this.request;
    if (!request || this.quitting) return "the daemon was stopped while it started";
    const stops = this.stops;
    let child: DaemonChild;
    try {
      child = await this.deps.spawn(request);
    } catch (error) {
      return `could not start node: ${messageOf(error)}`;
    }
    if (this.stops !== stops) {
      void this.terminate(child);
      return "the daemon was stopped while it started";
    }
    const previous = this.running;
    this.running = child;
    child.onExit((code) => this.exited(child, code));
    if (previous) void this.terminate(previous);
    return null;
  }

  private terminate(child: DaemonChild): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      let cancel = () => {};
      const settled = () => done;
      const finish = () => {
        if (done) return;
        done = true;
        cancel();
        resolve();
      };
      child.onExit(finish);
      if (settled()) return;
      let sent = false;
      try {
        sent = child.send("stop");
      } catch {}
      if (!sent && this.deps.platform !== "win32") {
        try {
          child.signal("SIGTERM");
        } catch {}
      }
      cancel = this.deps.clock.after(STOP_GRACE_MS, () => {
        if (settled()) return;
        child.kill();
        finish();
      });
    });
  }

  private exited(child: DaemonChild, code: number | null): void {
    if (this.running !== child) return;
    this.running = null;
    if (this.quitting) return;
    this.supervise(code);
  }

  private supervise(code: number | null): void {
    if (code === EXIT_HELD) {
      if (!this.held) this.deps.log(`daemon: another daemon is already serving; using that one, and trying again every ${HELD_RETRY_MS / 1000} s`);
      this.held = true;
      this.restartAfter(HELD_RETRY_MS, () => void this.heldRetry());
      return;
    }
    this.held = false;
    const note = oldDataNote(code, this.logFile);
    if (note) {
      this.deps.log(`daemon: ${note}`);
      this.supervising = false;
      this.publish({ ...this.current, error: note });
      return;
    }
    const now = this.deps.clock.now();
    this.exits = this.exits.filter((t) => now - t < EXIT_WINDOW_MS);
    const delay = restartDelay(this.exits.length);
    this.exits.push(now);
    this.deps.log(`daemon exited (${code ?? "signal"}); restarting in ${delay / 1000} s`);
    this.restartAfter(delay, () => void this.restart());
  }

  private async restart(): Promise<void> {
    const failed = await this.launch();
    if (this.quitting) return;
    if (failed) this.deps.log(`daemon restart failed: ${failed}`);
    const note = crashLoopNote(this.exits.length, this.logFile);
    this.looping = note !== null;
    this.publish({ ...this.current, error: failed ?? note });
    if (this.looping) this.clearWhenQuiet();
    if (failed) this.supervise(null);
  }

  private clearWhenQuiet(): void {
    const last = this.exits.at(-1) ?? this.deps.clock.now();
    this.cancelQuiet?.();
    this.cancelQuiet = this.deps.clock.after(Math.max(0, last + EXIT_WINDOW_MS - this.deps.clock.now()), () => {
      this.cancelQuiet = null;
      const latest = this.exits.at(-1) ?? last;
      if (!this.looping || this.quitting) return;
      if (this.deps.clock.now() - latest < EXIT_WINDOW_MS) return this.clearWhenQuiet();
      this.looping = false;
      this.publish({ ...this.current, error: null });
    });
  }

  private async heldRetry(): Promise<void> {
    const otherLoki = await this.checkLock();
    if (otherLoki?.pid !== this.current.otherLoki?.pid) this.publish({ ...this.current, otherLoki });
    const failed = await this.launch();
    if (this.quitting || !failed) return;
    this.deps.log(`daemon start failed: ${failed}`);
    this.supervise(EXIT_HELD);
  }
}

export function wrapChild(child: ChildProcess, platform: NodeJS.Platform, warn: (line: string) => void): DaemonChild {
  const exit: { code: number | null; done: boolean } = { code: null, done: false };
  const listeners = new Listeners<[code: number | null]>();
  child.on("error", (error) => warn(`daemon: ${error.message}`));
  child.once("exit", (code) => {
    exit.code = code;
    exit.done = true;
    listeners.emit(code);
    listeners.clear();
  });
  return {
    pid: child.pid,
    send: (message) => child.connected && child.send(message),
    signal: (signal) => {
      child.kill(signal);
    },
    kill: () => {
      if (platform === "win32" && child.pid !== undefined) killTree(child.pid);
      else child.kill("SIGKILL");
    },
    onExit: (listener) => {
      if (exit.done) listener(exit.code);
      else listeners.add(listener);
    },
  };
}

export function spawnDaemon(request: SpawnRequest, platform: NodeJS.Platform, warn: (line: string) => void): Promise<DaemonChild> {
  const fd = openDaemonLog(request.log, { warn });
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    closeSync(fd);
  };
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(request.command, request.args, { stdio: ["ignore", fd, fd, "ipc"], env: request.env, windowsHide: true });
    } catch (error) {
      close();
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    child.once("spawn", () => {
      close();
      resolve(wrapChild(child, platform, warn));
    });
    child.once("error", (error) => {
      close();
      reject(error);
    });
  });
}

export const realClock: Clock = {
  now: () => Date.now(),
  after: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

export interface MachineDaemonOptions {
  home: string;
  lokiDir: string;
  packaged: boolean;
  checkout: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  pid: number;
  publish: (status: DaemonStatus) => void;
  log: (line: string) => void;
}

export function daemonEntries(lokiDir: string, checkout: string | null): { entry: string; modEntry: string } {
  return checkout
    ? { entry: join(checkout, "daemon", "main.ts"), modEntry: join(checkout, "mod", "boot.ts") }
    : { entry: join(lokiDir, "daemon", "daemon.mjs"), modEntry: join(lokiDir, "mod", "loki-mod.mjs") };
}

export function machineDaemon(o: MachineDaemonOptions): DaemonSupervisor {
  const os = pageOs(o.platform);
  const windows = o.platform === "win32";
  const nodeHost = () => machineNodeHost(os, o.home, o.env);
  const toolsHost = (): ToolsHost => {
    const h = nodeHost();
    return { os, path: h.path, env: h.env, isFile: h.isFile };
  };
  const gitHost = {
    root: join(o.lokiDir, "runtime"),
    target: GIT_TARGET,
    manifest: gitManifest(),
    fetch: (url: string, init: { signal: AbortSignal }) => fetch(url, init),
    extract: runSelfExtracting,
  };
  const stopHost: StopHost = {
    windows,
    list: () => listProcs(o.platform),
    alive: (pid) => alive(pid),
    signal: (pid, signal) => process.kill(pid, signal),
    killTree: (pid) => killTree(pid),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
  return new DaemonSupervisor({
    lokiDir: o.lokiDir,
    platform: o.platform,
    parentPid: o.pid,
    env: o.env,
    entries: daemonEntries(o.lokiDir, devCheckout(o.packaged, o.env, o.checkout)),
    findNode: () => findNode(nodeHost()),
    git:
      o.packaged && windows
        ? { missing: () => gitMissing(toolsHost()), ensure: (progress) => ensurePortableGit(gitHost, progress), prune: () => prunePortableGit(gitHost, o.log) }
        : null,
    toolsMissing: () => toolsMissing(toolsHost(), () => developerDir(o.platform)),
    installTools: () => installTools(o.platform),
    lockHolder: async () => lockHolder(await listProcs(o.platform), readLockPid(join(o.lokiDir, "daemon.lock")), join(o.lokiDir, "token"), windows),
    stopLeftover: (pid, started) => stopLeftover(stopHost, pid, started),
    spawn: (request) => spawnDaemon(request, o.platform, o.log),
    clock: realClock,
    publish: o.publish,
    log: o.log,
  });
}
