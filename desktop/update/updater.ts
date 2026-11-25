import { messageOf } from "../../core/errors.ts";
import { installerFor, unsupportedReason, type InstallFs, type Run, type SpawnDetached } from "./install.ts";
import { githubRemote, platformKey, type Fetch } from "./remote.ts";
import {
  checkDue,
  isChannel,
  lastCheckAtLaunch,
  OVERRIDE_VAR,
  saveChannel,
  Updates,
  WAKE_EVERY_MS,
  type Log,
  type Publish,
  type UpdateStatus,
} from "./updates.ts";

export interface UpdaterOptions {
  lokiDir: string;
  current: string;
  packaged: boolean;
  platform: NodeJS.Platform;
  arch: string;
  exe: string;
  appImage: string | undefined;
  overrideUrl: string | undefined;
  tempDir: string;
  fetch: Fetch;
  publish: Publish;
  stopDaemon: () => Promise<void> | void;
  startDaemon: () => Promise<void> | void;
  relaunch: () => void;
  exit: () => void;
  now?: () => number;
  every?: (ms: number, tick: () => void) => () => void;
  log?: Log;
  fs?: InstallFs;
  run?: Run;
  spawn?: SpawnDetached;
  publicKey?: string;
}

export interface Updater {
  status: () => UpdateStatus;
  check: () => void;
  setChannel: (channel: unknown) => UpdateStatus;
  restart: () => Promise<void>;
  quit: () => Promise<void>;
  start: () => () => void;
}

const everyInterval = (ms: number, tick: () => void) => {
  const timer = setInterval(tick, ms);
  return () => clearInterval(timer);
};

export function createUpdater(options: UpdaterOptions): Updater {
  const { lokiDir, current, publish, now = Date.now, every = everyInterval, log = (line: string) => console.error(`loki: update: ${line}`) } = options;
  const installer = installerFor(options);
  const unsupported = unsupportedReason(options.packaged, options.platform, options.appImage) ?? (installer ? null : "package");
  const overrideUrl = options.overrideUrl || null;
  if (overrideUrl && !unsupported) log(`checking ${overrideUrl} (${OVERRIDE_VAR})`);
  const updates = Updates.open({ dir: lokiDir, current, overrideUrl, unsupported, log });
  const remote = installer
    ? githubRemote({ fetch: options.fetch, current, platform: platformKey(options.platform, options.arch), installer, publicKey: options.publicKey })
    : null;

  const check = () => {
    if (!remote) return;
    updates.check(remote, publish).catch((error: unknown) => log(`check failed: ${messageOf(error)}`));
  };

  return {
    status: () => updates.status(),
    check,
    setChannel: (channel) => {
      if (!isChannel(channel)) throw new Error(`${String(channel)} is not an update channel`);
      saveChannel(lokiDir, channel);
      updates.setChannel(channel);
      const status = updates.status();
      publish(status);
      return status;
    },
    restart: async () => {
      const installsAfterQuit = installer?.installsAfterQuit ?? false;
      await updates.restart(installsAfterQuit, options.stopDaemon, options.startDaemon, publish);
      if (installsAfterQuit) options.exit();
      else options.relaunch();
    },
    quit: () => updates.quit(options.stopDaemon),
    start: () => {
      if (!remote || unsupported) return () => {};
      let last = lastCheckAtLaunch(updates.status().state, now());
      const tick = () => {
        const at = now();
        if (!checkDue(last, at)) return;
        last = at;
        check();
      };
      tick();
      return every(WAKE_EVERY_MS, tick);
    },
  };
}
