import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { messageOf } from "../../core/errors.ts";
import { channelOf, compareVersions, type Channel } from "../../core/version.ts";

export const UPDATE_EVENT = "loki:update";
export const STABLE_URL = "https://github.com/AlmondLabs/loki/releases/latest/download/desktop.json";
export const NIGHTLY_URL = "https://github.com/AlmondLabs/loki/releases/download/nightly/desktop.json";
export const OVERRIDE_VAR = "LOKI_UPDATE_URL";
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
export const WAKE_EVERY_MS = 10 * 60 * 1000;

const CHANNEL_FILE = "updates.json";

export type Stage = "check" | "download" | "signature" | "install";
export type Unsupported = "development" | "package";

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "downloading"; done: number; total: number | null }
  | { kind: "ready"; version: string }
  | { kind: "failed"; stage: Stage; message: string }
  | { kind: "unsupported"; reason: Unsupported };

export interface UpdateStatus {
  channel: Channel;
  current: string;
  state: UpdateState;
  moved: boolean;
}

export interface FailedInstall {
  version: string;
  message: string;
}

interface UpdatesFile {
  channel: Channel;
  failed_install?: FailedInstall;
}

export class UpdateFailure extends Error {
  readonly stage: Stage;

  constructor(stage: Stage, message: string) {
    super(message);
    this.stage = stage;
  }
}

export interface Found {
  version: string;
  installProblem: () => string | null;
  download: (onChunk: (bytes: number, total: number | null) => void) => Promise<Uint8Array>;
  install: (bytes: Uint8Array, relaunch: boolean) => Promise<void>;
}

export interface Remote {
  check: (endpoint: string) => Promise<Found | null>;
}

export type Publish = (status: UpdateStatus) => void;
export type Log = (line: string) => void;

export const isChannel = (value: unknown): value is Channel => value === "stable" || value === "nightly";

export function endpoint(channel: Channel, overrideUrl: string | null | undefined): string {
  if (overrideUrl) return overrideUrl;
  return channel === "stable" ? STABLE_URL : NIGHTLY_URL;
}

export const fieldOf = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null && name in value ? (value as Record<string, unknown>)[name] : undefined;

function parseFailedInstall(value: unknown): FailedInstall | null | undefined {
  if (value === undefined || value === null) return null;
  const [version, message] = [fieldOf(value, "version"), fieldOf(value, "message")];
  return typeof version === "string" && typeof message === "string" ? { version, message } : undefined;
}

function readFile(dir: string): UpdatesFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, CHANNEL_FILE), "utf8"));
  } catch {
    return null;
  }
  const channel = fieldOf(parsed, "channel");
  const failedInstall = parseFailedInstall(fieldOf(parsed, "failed_install"));
  if (!isChannel(channel) || failedInstall === undefined) return null;
  return failedInstall ? { channel, failed_install: failedInstall } : { channel };
}

function writeFile(dir: string, file: UpdatesFile): void {
  const path = join(dir, CHANNEL_FILE);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  } catch (error) {
    throw new Error(`could not write ${path}: ${messageOf(error)}`, { cause: error });
  }
}

export function saveChannel(dir: string, channel: Channel): void {
  const failed = readFile(dir)?.failed_install;
  writeFile(dir, failed ? { channel, failed_install: failed } : { channel });
}

function installed(current: string, version: string): boolean {
  const order = compareVersions(current, version);
  return order === null || order >= 0;
}

export function progressStep(done: number, total: number | null): number {
  return total !== null && total > 0 ? Math.floor((done * 100) / total) : Math.floor(done / 2 ** 20);
}

export function checkDue(last: number | null, now: number): boolean {
  if (last === null) return true;
  const since = now - last;
  return since < 0 || since >= CHECK_EVERY_MS;
}

export function lastCheckAtLaunch(state: UpdateState, now: number): number | null {
  return state.kind === "failed" && state.stage === "install" ? now : null;
}

export function installProblem(exe: string, writable: (folder: string) => boolean): string | null {
  const macos = posix.dirname(exe);
  const contents = posix.dirname(macos);
  if (posix.basename(macos) !== "MacOS" || posix.basename(contents) !== "Contents") return null;
  const folder = posix.dirname(posix.dirname(contents));
  if (writable(folder)) return null;
  return `loki can't update itself in ${folder}. Move it to a folder you can change, such as ~/Applications, to get updates.`;
}

interface Held {
  found: Found;
  bytes: Uint8Array;
}

export interface UpdatesOptions {
  current: string;
  channel: Channel;
  overrideUrl?: string | null;
  unsupported?: Unsupported | null;
  dir?: string | null;
  log?: Log;
}

export interface OpenOptions {
  dir: string;
  current: string;
  overrideUrl?: string | null;
  unsupported?: Unsupported | null;
  log?: Log;
}

const stderrLog: Log = (line) => console.error(`loki: update: ${line}`);

export class Updates {
  readonly #current: string;
  readonly #overrideUrl: string | null;
  readonly #dir: string | null;
  readonly #log: Log;
  #channel: Channel;
  #state: UpdateState;
  #held: Held | null = null;

  constructor({ current, channel, overrideUrl = null, unsupported = null, dir = null, log = stderrLog }: UpdatesOptions) {
    this.#current = current;
    this.#channel = channel;
    this.#overrideUrl = overrideUrl || null;
    this.#dir = dir;
    this.#log = log;
    this.#state = unsupported ? { kind: "unsupported", reason: unsupported } : { kind: "idle" };
  }

  static open({ dir, current, overrideUrl = null, unsupported = null, log = stderrLog }: OpenOptions): Updates {
    const file = readFile(dir);
    const channel = file?.channel ?? channelOf(current);
    if (unsupported) return new Updates({ current, channel, overrideUrl, unsupported, log });
    const failed = file?.failed_install ?? null;
    const remembered = failed && !installed(current, failed.version) ? failed : null;
    if (!file || (failed && !remembered)) {
      try {
        writeFile(dir, { channel });
      } catch (error) {
        log(messageOf(error));
      }
    }
    const updates = new Updates({ current, channel, overrideUrl, dir, log });
    if (remembered) updates.#state = { kind: "failed", stage: "install", message: remembered.message };
    return updates;
  }

  status(): UpdateStatus {
    return { channel: this.#channel, current: this.#current, state: this.#state, moved: false };
  }

  setChannel(channel: Channel): void {
    this.#channel = channel;
  }

  #settle(state: UpdateState, held: Held | null, publish: Publish): void {
    this.#state = state;
    this.#held = held;
    publish(this.status());
  }

  async check(remote: Remote, publish: Publish): Promise<void> {
    if (this.#state.kind !== "idle" && this.#state.kind !== "failed") return;
    const url = endpoint(this.#channel, this.#overrideUrl);
    this.#settle({ kind: "checking" }, null, publish);
    let found: Found | null;
    try {
      found = await remote.check(url);
    } catch (error) {
      const message = messageOf(error);
      this.#log(`check of ${url} failed: ${message}`);
      this.#settle({ kind: "failed", stage: "check", message }, null, publish);
      return;
    }
    if (!found) {
      this.#settle({ kind: "idle" }, null, publish);
      return;
    }
    const problem = found.installProblem();
    if (problem !== null) {
      this.#log(`not downloading ${found.version}: ${problem}`);
      this.#settle({ kind: "failed", stage: "install", message: problem }, null, publish);
      return;
    }
    this.#log(`downloading ${found.version}`);
    this.#settle({ kind: "downloading", done: 0, total: null }, null, publish);
    let done = 0;
    let shown = progressStep(0, null);
    try {
      const bytes = await found.download((chunk, total) => {
        done += chunk;
        const step = progressStep(done, total);
        if (step === shown) return;
        shown = step;
        this.#settle({ kind: "downloading", done, total }, null, publish);
      });
      this.#log(`${found.version} is ready and installs when loki quits`);
      this.#settle({ kind: "ready", version: found.version }, { found, bytes }, publish);
    } catch (error) {
      const stage = error instanceof UpdateFailure ? error.stage : "download";
      const message = messageOf(error);
      this.#log(`${found.version} failed at ${stage}: ${message}`);
      this.#settle({ kind: "failed", stage, message }, null, publish);
    }
  }

  #take(): Held | null {
    const held = this.#held;
    this.#held = null;
    return held;
  }

  async quit(stopDaemon: () => Promise<void> | void): Promise<void> {
    await stopDaemon();
    const held = this.#take();
    if (!held) return;
    const { version } = held.found;
    this.#log(`installing ${version} as loki quits`);
    try {
      await held.found.install(held.bytes, false);
    } catch (error) {
      const message = messageOf(error);
      this.#log(`could not install ${version}: ${message}`);
      if (this.#dir === null) return;
      try {
        writeFile(this.#dir, { channel: this.#channel, failed_install: { version, message } });
      } catch (writeError) {
        this.#log(messageOf(writeError));
      }
    }
  }

  async restart(installsAfterQuit: boolean, stopDaemon: () => Promise<void> | void, startDaemon: () => Promise<void> | void, publish: Publish): Promise<void> {
    const held = this.#take();
    if (!held) throw new Error("no update is ready");
    if (installsAfterQuit) await stopDaemon();
    try {
      await held.found.install(held.bytes, true);
    } catch (error) {
      const message = messageOf(error);
      this.#log(`could not install ${held.found.version}: ${message}`);
      if (installsAfterQuit) await startDaemon();
      this.#settle({ kind: "failed", stage: "install", message }, null, publish);
      throw new Error(message, { cause: error });
    }
    if (!installsAfterQuit) await stopDaemon();
  }
}
