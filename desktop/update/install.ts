import { execFile, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { chmod, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { messageOf } from "../../core/errors.ts";
import { installProblem, type Unsupported } from "./updates.ts";

export const MAC_UPDATE_APP = "loki.app";

export interface InstallFs {
  mkdtemp: (prefix: string) => Promise<string>;
  writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
  chmod: (path: string, mode: number) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
  isDirectory: (path: string) => Promise<boolean>;
  writable: (folder: string) => boolean;
}

export type Run = (command: string, args: string[]) => Promise<void>;
export type SpawnDetached = (command: string, args: string[]) => Promise<void>;

export interface Installer {
  installsAfterQuit: boolean;
  problem: () => string | null;
  install: (bytes: Uint8Array, relaunch: boolean) => Promise<void>;
}

export const nodeInstallFs: InstallFs = {
  mkdtemp: (prefix) => mkdtemp(prefix),
  writeFile: (path, bytes) => writeFile(path, bytes),
  chmod: (path, mode) => chmod(path, mode),
  rename: (from, to) => rename(from, to),
  remove: (path) => rm(path, { recursive: true, force: true }),
  isDirectory: (path) =>
    stat(path).then(
      (s) => s.isDirectory(),
      () => false,
    ),
  writable: (folder) => {
    try {
      accessSync(folder, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
};

export const runQuietly: Run = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, (error, _stdout, stderr) => {
      if (error) reject(new Error(`${command} failed: ${stderr.trim() || error.message}`, { cause: error }));
      else resolve();
    });
  });

export const spawnDetached: SpawnDetached = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", (error) => reject(new Error(`could not start the installer: ${error.message}`, { cause: error })));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });

export function unsupportedReason(packaged: boolean, platform: NodeJS.Platform, appImage: string | undefined): Unsupported | null {
  if (!packaged) return "development";
  if (platform === "linux" && !appImage) return "package";
  return null;
}

export function appBundleOf(exe: string): string | null {
  const macos = dirname(exe);
  const contents = dirname(macos);
  return basename(macos) === "MacOS" && basename(contents) === "Contents" ? dirname(contents) : null;
}

async function removeQuietly(fs: InstallFs, path: string): Promise<void> {
  try {
    await fs.remove(path);
  } catch {
    return;
  }
}

async function putBack(fs: InstallFs, aside: string, app: string, why: unknown): Promise<void> {
  try {
    await fs.rename(aside, app);
  } catch (error) {
    throw new Error(`could not move the new loki into place (${messageOf(why)}), nor the old one back from ${aside}: ${messageOf(error)}`, { cause: error });
  }
}

export function macInstaller({ exe, fs, run }: { exe: string; fs: InstallFs; run: Run }): Installer {
  return {
    installsAfterQuit: false,
    problem: () => installProblem(exe, fs.writable),
    install: async (bytes) => {
      const app = appBundleOf(exe);
      if (!app) throw new Error(`loki is not running from an app bundle (${exe})`);
      const folder = dirname(app);
      const unpacked = await fs.mkdtemp(join(folder, ".loki-update-"));
      const fresh = join(unpacked, MAC_UPDATE_APP);
      const aside = join(unpacked, "previous.app");
      try {
        const archive = join(unpacked, "update.tar.gz");
        await fs.writeFile(archive, bytes);
        await run("tar", ["-xzf", archive, "-C", unpacked]);
        if (!(await fs.isDirectory(fresh))) throw new Error(`the update holds no ${MAC_UPDATE_APP}`);
        await fs.rename(app, aside);
      } catch (error) {
        await removeQuietly(fs, unpacked);
        throw error;
      }
      try {
        await fs.rename(fresh, app);
      } catch (error) {
        await putBack(fs, aside, app, error);
        await removeQuietly(fs, unpacked);
        throw new Error(`could not move the new loki into ${folder}: ${messageOf(error)}`, { cause: error });
      }
      await removeQuietly(fs, unpacked);
    },
  };
}

export function windowsInstaller({ tempDir, fs, spawn: start }: { tempDir: string; fs: InstallFs; spawn: SpawnDetached }): Installer {
  return {
    installsAfterQuit: true,
    problem: () => null,
    install: async (bytes, relaunch) => {
      const folder = await fs.mkdtemp(join(tempDir, "loki-update-"));
      const installer = join(folder, "loki-setup.exe");
      await fs.writeFile(installer, bytes);
      await start(installer, ["/S", "--updated", ...(relaunch ? ["--force-run"] : [])]);
    },
  };
}

export function linuxInstaller({ appImage, fs }: { appImage: string; fs: InstallFs }): Installer {
  return {
    installsAfterQuit: false,
    problem: () => null,
    install: async (bytes) => {
      const next = `${appImage}.update`;
      try {
        await fs.writeFile(next, bytes);
        await fs.chmod(next, 0o755);
        await fs.rename(next, appImage);
      } catch (error) {
        await removeQuietly(fs, next);
        throw error;
      }
    },
  };
}

export interface InstallerOptions {
  platform: NodeJS.Platform;
  exe: string;
  appImage: string | undefined;
  tempDir: string;
  fs?: InstallFs;
  run?: Run;
  spawn?: SpawnDetached;
}

export function installerFor({
  platform,
  exe,
  appImage,
  tempDir,
  fs = nodeInstallFs,
  run = runQuietly,
  spawn: start = spawnDetached,
}: InstallerOptions): Installer | null {
  if (platform === "darwin") return macInstaller({ exe, fs, run });
  if (platform === "win32") return windowsInstaller({ tempDir, fs, spawn: start });
  if (platform === "linux" && appImage) return linuxInstaller({ appImage, fs });
  return null;
}
