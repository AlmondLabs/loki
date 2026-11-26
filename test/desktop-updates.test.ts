import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { linuxInstaller, macInstaller, nodeInstallFs, unsupportedReason, windowsInstaller, type InstallFs, type Run } from "../desktop/update/install.ts";
import { publicKeyFile, signatureFile } from "../desktop/update/minisign.ts";
import { githubRemote, newerRelease, platformKey, type Fetch, type PlatformKey } from "../desktop/update/remote.ts";
import { createUpdater, type UpdaterOptions } from "../desktop/update/updater.ts";
import {
  CHECK_EVERY_MS,
  checkDue,
  endpoint,
  installProblem,
  lastCheckAtLaunch,
  NIGHTLY_URL,
  progressStep,
  saveChannel,
  STABLE_URL,
  UpdateFailure,
  Updates,
  WAKE_EVERY_MS,
  type Found,
  type Remote,
  type UpdateState,
  type UpdateStatus,
} from "../desktop/update/updates.ts";
import type { Channel } from "../core/version.ts";

const quiet = () => {};
const made: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "loki-desktop-updates-"));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) {
    if (process.platform !== "win32") chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

interface FakeFoundOptions {
  version?: string;
  chunks?: number[];
  total?: number | null;
  end?: Uint8Array | UpdateFailure;
  install?: Error | null;
  problem?: string | null;
  gate?: Promise<void>;
}

function fakeFound(log: string[], o: FakeFoundOptions = {}): Found {
  const version = o.version ?? "2026.1120.0";
  return {
    version,
    installProblem: () => o.problem ?? null,
    download: async (onChunk) => {
      await o.gate;
      for (const c of o.chunks ?? [4, 4]) onChunk(c, o.total === undefined ? 8 : o.total);
      const end = o.end ?? Buffer.from("verified");
      if (end instanceof UpdateFailure) throw end;
      return end;
    },
    install: (bytes, relaunch) => {
      const raw = bytes instanceof Uint8Array ? Buffer.from(bytes) : readFileSync(bytes.path);
      log.push(`install ${version} ${raw.toString()} relaunch=${relaunch}`);
      return o.install ? Promise.reject(o.install) : Promise.resolve();
    },
  };
}

interface FakeRemote extends Remote {
  asked: string[];
}

function fakeRemote(answer: Found | null | Error): FakeRemote {
  const asked: string[] = [];
  let next: Found | null | Error = answer;
  return {
    asked,
    check: (url) => {
      asked.push(url);
      const now = next;
      next = null;
      return now instanceof Error ? Promise.reject(now) : Promise.resolve(now);
    },
  };
}

const updates = (channel: Channel = "stable") => new Updates({ current: "2026.1116.0", channel, log: quiet });

async function check(u: Updates, remote: Remote): Promise<UpdateState[]> {
  const seen: UpdateState[] = [];
  await u.check(remote, (s) => seen.push(s.state));
  return seen;
}

const saved = (dir: string): unknown => JSON.parse(readFileSync(join(dir, "updates.json"), "utf8"));
const launch = (dir: string, current: string) => Updates.open({ dir, current, log: quiet });

describe("the channel file, ~/.loki/updates.json", () => {
  test("starts on the running version's channel, and a set channel survives a restart", () => {
    const dir = join(temp(), ".loki");
    expect(launch(dir, "2026.1116.0-nightly.4821").status().channel).toBe("nightly");
    expect(saved(dir)).toEqual({ channel: "nightly" });
    saveChannel(dir, "stable");
    expect(launch(dir, "2026.1116.0-nightly.4821").status().channel).toBe("stable");
    const other = temp();
    expect(launch(other, "2026.1116.0").status().channel).toBe("stable");
    writeFileSync(join(other, "updates.json"), '{ "channel": "beta" }');
    expect(launch(other, "2026.1116.1-nightly.9").status().channel).toBe("nightly");
    expect(launch(other, "2026.1116.0").status().channel, "and that is the saved channel now").toBe("nightly");
  });

  test("a build that never checks reads the channel and writes nothing", () => {
    for (const reason of ["development", "package"] as const) {
      const dir = join(temp(), ".loki");
      const u = Updates.open({ dir, current: "2026.10.11", unsupported: reason, log: quiet });
      expect(u.status().channel).toBe("stable");
      expect(u.status().state).toEqual({ kind: "unsupported", reason });
      expect(existsSync(join(dir, "updates.json")), `${reason} wrote updates.json`).toBe(false);
      saveChannel(dir, "nightly");
      expect(Updates.open({ dir, current: "2026.10.11", unsupported: reason, log: quiet }).status().channel).toBe("nightly");
    }
  });

  test("an install that fails as loki quits is what About shows at the next launch", async () => {
    const dir = temp();
    const log: string[] = [];
    const u = launch(dir, "2026.1116.0");
    await check(u, fakeRemote(fakeFound(log, { install: new Error("Permission denied (os error 13)") })));
    await u.quit(quiet);
    expect(saved(dir)).toEqual({ channel: "stable", failed_install: { version: "2026.1120.0", message: "Permission denied (os error 13)" } });
    const failed: UpdateState = { kind: "failed", stage: "install", message: "Permission denied (os error 13)" };
    const next = launch(dir, "2026.1116.0");
    expect(next.status().state).toEqual(failed);
    const now = 1_800_000_000_000;
    expect(lastCheckAtLaunch(next.status().state, now)).toBe(now);
    expect(lastCheckAtLaunch({ kind: "idle" }, now)).toBeNull();
    expect(lastCheckAtLaunch({ kind: "failed", stage: "check", message: "offline" }, now)).toBeNull();
    saveChannel(dir, "nightly");
    expect(saved(dir)).toMatchObject({ channel: "nightly", failed_install: { version: "2026.1120.0" } });
    expect(launch(dir, "2026.1116.0").status().state).toEqual(failed);
  });

  test.each([
    ["2026.1120.0", "2026.1120.0", true],
    ["2026.1120.0", "2026.1121.0", true],
    ["2026.1120.0-nightly.9", "2026.1120.0", true],
    ["2026.1120.0-nightly.9", "2026.1120.0-nightly.10", true],
    ["2026.1120.0", "2026.1120.0-nightly.12", false],
    ["2026.1120.0-nightly.10", "2026.1120.0-nightly.9", false],
    ["2026.1120.0", "2026.999.0", false],
  ])("a failed install of %s, with %s running, is forgotten: %s", (recorded, running, forgotten) => {
    const dir = temp();
    writeFileSync(join(dir, "updates.json"), JSON.stringify({ channel: "nightly", failed_install: { version: recorded, message: "no" } }));
    const { state } = launch(dir, running).status();
    if (forgotten) {
      expect(state).toEqual({ kind: "idle" });
      expect(saved(dir)).toEqual({ channel: "nightly" });
    } else {
      expect(state).toEqual({ kind: "failed", stage: "install", message: "no" });
      expect(saved(dir)).toMatchObject({ failed_install: { version: recorded } });
    }
  });
});

describe("the Mac's app folder", () => {
  test("an update the Mac could install only as an administrator is never downloaded", async () => {
    const log: string[] = [];
    const u = updates();
    const message = "loki can't update itself in /Applications.";
    const stuck: Found = {
      ...fakeFound(log, { problem: message }),
      download: () => {
        log.push("downloaded");
        return Promise.resolve(Buffer.from("x"));
      },
    };
    const seen = await check(u, fakeRemote(stuck));
    expect(seen).toEqual([{ kind: "checking" }, { kind: "failed", stage: "install", message }]);
    await u.quit(quiet);
    expect(log, "no download, and nothing installs at quit").toEqual([]);
  });

  test("the folder that must be writable is the one holding the app bundle", () => {
    const exe = "/Applications/loki.app/Contents/MacOS/loki";
    const asked: string[] = [];
    const problem = installProblem(exe, (p) => {
      asked.push(p);
      return false;
    });
    expect(asked).toEqual(["/Applications"]);
    expect(problem).toBe("loki can't update itself in /Applications. Move it to a folder you can change, such as ~/Applications, to get updates.");
    expect(installProblem(exe, () => true)).toBeNull();
    expect(installProblem("/usr/local/bin/loki", () => false)).toBeNull();
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a folder is writable when this user may change it", () => {
    const dir = temp();
    expect(nodeInstallFs.writable(dir)).toBe(true);
    expect(nodeInstallFs.writable(join(dir, "missing"))).toBe(false);
    chmodSync(dir, 0o555);
    expect(nodeInstallFs.writable(dir)).toBe(false);
  });
});

describe("where loki checks", () => {
  test("Stable reads the latest release, Nightly the rolling one, and LOKI_UPDATE_URL overrides both", async () => {
    expect(endpoint("stable", null)).toBe("https://github.com/AlmondLabs/loki/releases/latest/download/desktop.json");
    expect(endpoint("nightly", null)).toBe("https://github.com/AlmondLabs/loki/releases/download/nightly/desktop.json");
    const mine = "https://github.com/AlmondLabs/loki/releases/download/try-b/desktop.json";
    expect(endpoint("stable", mine)).toBe(mine);
    expect(endpoint("nightly", mine)).toBe(mine);
    expect(endpoint("nightly", ""), "an empty variable is no override").toBe(NIGHTLY_URL);
    const u = updates("stable");
    u.setChannel("nightly");
    const remote = fakeRemote(null);
    await check(u, remote);
    expect(remote.asked).toEqual([NIGHTLY_URL]);
    const o = new Updates({ current: "2026.1116.0", channel: "stable", overrideUrl: mine, log: quiet });
    const other = fakeRemote(null);
    await check(o, other);
    expect(other.asked).toEqual([mine]);
  });
});

describe("a check", () => {
  test("a newer version downloads in the background and waits ready in memory", async () => {
    const log: string[] = [];
    const seen = await check(updates(), fakeRemote(fakeFound(log)));
    expect(seen).toEqual([
      { kind: "checking" },
      { kind: "downloading", done: 0, total: null },
      { kind: "downloading", done: 4, total: 8 },
      { kind: "downloading", done: 8, total: 8 },
      { kind: "ready", version: "2026.1120.0" },
    ]);
    expect(log, "nothing installs before loki quits").toEqual([]);
    expect(await check(updates(), fakeRemote(null))).toEqual([{ kind: "checking" }, { kind: "idle" }]);
  });

  test("a failed check is a status and the next check runs", async () => {
    const u = updates();
    expect(await check(u, fakeRemote(new Error("could not reach github.com")))).toEqual([
      { kind: "checking" },
      { kind: "failed", stage: "check", message: "could not reach github.com" },
    ]);
    const remote = fakeRemote(null);
    expect(await check(u, remote)).toEqual([{ kind: "checking" }, { kind: "idle" }]);
    expect(remote.asked).toHaveLength(1);
  });

  test.each([
    ["signature", "signature verification failed"],
    ["download", "connection reset"],
  ] as const)("a download that fails at the %s never reaches ready, and quitting installs nothing", async (stage, message) => {
    const log: string[] = [];
    const u = updates();
    const seen = await check(u, fakeRemote(fakeFound(log, { end: new UpdateFailure(stage, message) })));
    expect(seen.some((s) => s.kind === "ready")).toBe(false);
    expect(u.status().state).toEqual({ kind: "failed", stage, message });
    let stops = 0;
    await u.quit(() => {
      stops++;
    });
    expect(stops).toBe(1);
    expect(log, "nothing is replaced").toEqual([]);
    await expect(u.restart(false, quiet, quiet, quiet), "and there is nothing to restart into").rejects.toThrow("no update is ready");
  });

  test("a check while checking, downloading or with an update ready does nothing", async () => {
    const log: string[] = [];
    const u = updates();
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const first = check(u, fakeRemote(fakeFound(log, { gate })));
    const remote = fakeRemote(fakeFound(log));
    expect(await check(u, remote)).toEqual([]);
    open();
    await first;
    expect(u.status().state).toEqual({ kind: "ready", version: "2026.1120.0" });
    const again = fakeRemote(fakeFound(log, { version: "2026.1121.0" }));
    expect(await check(u, again)).toEqual([]);
    expect([...remote.asked, ...again.asked]).toEqual([]);
    expect(u.status().state).toEqual({ kind: "ready", version: "2026.1120.0" });
  });

  test("a long download sends whole percents, not every chunk", async () => {
    const seen = await check(updates(), fakeRemote(fakeFound([], { chunks: Array<number>(10_000).fill(1000), total: 10_000_000 })));
    const downloading = seen.filter((s) => s.kind === "downloading");
    expect(downloading, "the start, then each whole percent").toHaveLength(101);
    expect(downloading.at(-1)).toEqual({ kind: "downloading", done: 10_000_000, total: 10_000_000 });
    expect(progressStep(2 ** 20 - 1, null)).toBe(0);
    expect(progressStep(3 * 2 ** 20, null)).toBe(3);
  });

  test("a build that never checks does nothing when asked", async () => {
    const u = new Updates({ current: "2026.1116.0", channel: "stable", unsupported: "package", log: quiet });
    const remote = fakeRemote(null);
    expect(await check(u, remote)).toEqual([]);
    expect(remote.asked).toEqual([]);
    expect(u.status().state).toEqual({ kind: "unsupported", reason: "package" });
  });
});

describe("installing", () => {
  test("quitting with an update ready stops the daemon, then installs once; without one it installs nothing", async () => {
    const log: string[] = [];
    const u = updates();
    await check(u, fakeRemote(fakeFound(log)));
    const stop = () => {
      log.push("stop daemon");
    };
    await u.quit(stop);
    expect(log).toEqual(["stop daemon", "install 2026.1120.0 verified relaunch=false"]);
    await u.quit(stop);
    expect(log).toHaveLength(3);
    const idle: string[] = [];
    await updates().quit(() => {
      idle.push("stop daemon");
    });
    expect(idle).toEqual(["stop daemon"]);
  });

  test("Restart to Update relaunches and stops the daemon where each system needs", async () => {
    for (const [installsAfterQuit, expected] of [
      [false, ["install 2026.1120.0 verified relaunch=true", "stop daemon"]],
      [true, ["stop daemon", "install 2026.1120.0 verified relaunch=true"]],
    ] as const) {
      const log: string[] = [];
      const u = updates();
      await check(u, fakeRemote(fakeFound(log)));
      await u.restart(
        installsAfterQuit,
        () => {
          log.push("stop daemon");
        },
        () => {
          log.push("start daemon");
        },
        quiet,
      );
      expect(log).toEqual(expected);
    }
  });

  test("a restart whose install fails says so and leaves the daemon running", async () => {
    for (const installsAfterQuit of [false, true]) {
      const log: string[] = [];
      const u = updates();
      await check(u, fakeRemote(fakeFound(log, { install: new Error("could not start the installer") })));
      const seen: UpdateState[] = [];
      await expect(
        u.restart(
          installsAfterQuit,
          () => {
            log.push("stop daemon");
          },
          () => {
            log.push("start daemon");
          },
          (s) => seen.push(s.state),
        ),
      ).rejects.toThrow("could not start the installer");
      const failed: UpdateState = { kind: "failed", stage: "install", message: "could not start the installer" };
      expect(seen, "one status: the failure").toEqual([failed]);
      expect(u.status().state).toEqual(failed);
      expect(log).toEqual(
        installsAfterQuit ? ["stop daemon", "install 2026.1120.0 verified relaunch=true", "start daemon"] : ["install 2026.1120.0 verified relaunch=true"],
      );
    }
  });

  test("Linux checks only as an AppImage, and a development build never", () => {
    expect(unsupportedReason(true, "linux", undefined)).toBe("package");
    expect(unsupportedReason(true, "linux", "")).toBe("package");
    expect(unsupportedReason(true, "linux", "/home/a/loki.AppImage")).toBeNull();
    expect(unsupportedReason(true, "darwin", undefined)).toBeNull();
    expect(unsupportedReason(true, "win32", undefined)).toBeNull();
    expect(unsupportedReason(false, "darwin", undefined)).toBe("development");
    expect(unsupportedReason(false, "linux", "/home/a/loki.AppImage")).toBe("development");
  });
});

describe("the wall clock", () => {
  test("checks run at launch, then six hours after the last by the wall clock", () => {
    const t = 1_800_000_000_000;
    expect(checkDue(null, t)).toBe(true);
    expect(checkDue(t, t + 5 * 60 * 60 * 1000)).toBe(false);
    expect(checkDue(t, t + CHECK_EVERY_MS)).toBe(true);
    expect(checkDue(t, t - 60_000), "a clock set back does not hold checks off").toBe(true);
  });
});

describe("the status the page reads", () => {
  test("is snake_case JSON with the state named by kind", () => {
    expect(JSON.stringify(updates("nightly").status())).toBe('{"channel":"nightly","current":"2026.1116.0","state":{"kind":"idle"}}');
    const status = { channel: "nightly", current: "2026.1116.0-nightly.12" } as const;
    const wire = (state: UpdateState) => JSON.stringify({ ...status, state });
    expect(wire({ kind: "downloading", done: 5, total: null })).toContain('"state":{"kind":"downloading","done":5,"total":null}');
    expect(wire({ kind: "failed", stage: "signature", message: "bad" })).toContain('"state":{"kind":"failed","stage":"signature","message":"bad"}');
    expect(wire({ kind: "unsupported", reason: "package" })).toContain('"state":{"kind":"unsupported","reason":"package"}');
  });
});

const signer = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = randomBytes(8);
  return { privateKey, keyId, publicKey: publicKeyFile(publicKey, keyId) };
};
type Signer = ReturnType<typeof signer>;

const sigFor = (file: Uint8Array, key: Signer, version: string) =>
  signatureFile(file, { privateKey: key.privateKey, keyId: key.keyId, prehashed: true, trustedComment: `timestamp:1795000000\tfile:loki\tversion:${version}` });

const FILE_URL = "https://github.com/AlmondLabs/loki/releases/download/v2026.1125.0/loki-macos-arm64.app.tar.gz";

interface Served {
  fetch: Fetch;
  asked: string[];
}

function serve(routes: Record<string, () => Response>): Served {
  const asked: string[] = [];
  return {
    asked,
    fetch: (url) => {
      asked.push(url);
      const route = routes[url] as (() => Response) | undefined;
      return Promise.resolve(route ? route() : new Response("not found", { status: 404 }));
    },
  };
}

const streamOf = (chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

function release(file: Uint8Array, signature: string, version = "2026.1125.0", key: PlatformKey = "darwin-aarch64"): Record<string, () => Response> {
  const json = { version, notes: "", pub_date: "2026-11-25T00:00:00Z", platforms: { [key]: { url: FILE_URL, signature } } };
  return {
    [STABLE_URL]: () => Response.json(json),
    [NIGHTLY_URL]: () => Response.json(json),
    [FILE_URL]: () => new Response(streamOf([file.subarray(0, 1000), file.subarray(1000)]), { headers: { "content-length": String(file.length) } }),
  };
}

function remoteFor(served: Served, key: Signer, installed: string[], current = "2026.1120.0") {
  return githubRemote({
    fetch: served.fetch,
    current,
    platform: "darwin-aarch64",
    publicKey: key.publicKey,
    installer: {
      installsAfterQuit: false,
      problem: () => null,
      install: async (bytes) => {
        const raw = bytes instanceof Uint8Array ? Buffer.from(bytes) : readFileSync(bytes.path);
        installed.push(raw.toString("hex"));
        if (!(bytes instanceof Uint8Array)) await bytes.dispose();
      },
    },
  });
}

describe("desktop.json and the download", () => {
  test("a newer version on the chosen channel downloads, verifies and reaches ready, then installs those bytes", async () => {
    const key = signer();
    const file = randomBytes(5000);
    const served = serve(release(file, sigFor(file, key, "2026.1125.0")));
    const installed: string[] = [];
    const u = new Updates({ current: "2026.1120.0", channel: "nightly", log: quiet });
    const seen = await check(u, remoteFor(served, key, installed));
    expect(served.asked).toEqual([NIGHTLY_URL, FILE_URL]);
    expect(seen.at(-2)).toEqual({ kind: "downloading", done: 5000, total: 5000 });
    expect(seen.at(-1)).toEqual({ kind: "ready", version: "2026.1125.0" });
    await u.quit(quiet);
    expect(installed).toEqual([file.toString("hex")]);
  });

  test("a file that does not match its signature fails at the signature stage and installs nothing", async () => {
    const key = signer();
    const file = randomBytes(5000);
    const served = serve(release(Buffer.concat([file, Buffer.from("x")]), sigFor(file, key, "2026.1125.0")));
    const installed: string[] = [];
    const u = new Updates({ current: "2026.1120.0", channel: "stable", log: quiet });
    await check(u, remoteFor(served, key, installed));
    expect(u.status().state).toMatchObject({ kind: "failed", stage: "signature", message: "the update's signature does not match the downloaded file" });
    await u.quit(quiet);
    expect(installed).toEqual([]);
  });

  test("a signature from another key fails the same way", async () => {
    const [ours, theirs] = [signer(), signer()];
    const file = randomBytes(300);
    const u = new Updates({ current: "2026.1120.0", channel: "stable", log: quiet });
    await check(u, remoteFor(serve(release(file, sigFor(file, theirs, "2026.1125.0"))), ours, []));
    expect(u.status().state).toMatchObject({ kind: "failed", stage: "signature" });
  });

  test("a valid signature whose trusted comment names an older version fails at the signature stage", async () => {
    const key = signer();
    const file = randomBytes(300);
    const installed: string[] = [];
    const u = new Updates({ current: "2026.1120.0", channel: "stable", log: quiet });
    await check(u, remoteFor(serve(release(file, sigFor(file, key, "2026.1121.0"))), key, installed));
    expect(u.status().state).toEqual({
      kind: "failed",
      stage: "signature",
      message: "the signature is for version 2026.1121.0, but the release announces 2026.1125.0",
    });
    await u.quit(quiet);
    expect(installed).toEqual([]);
  });

  test("Nightly to Stable never offers an older version", async () => {
    const key = signer();
    const file = randomBytes(300);
    for (const [version, offered] of [
      ["2026.1119.0", false],
      ["2026.1120.0-nightly.4", false],
      ["2026.1120.0-nightly.5", false],
      ["2026.1120.0", true],
    ] as const) {
      const served = serve(release(file, sigFor(file, key, version), version));
      const u = new Updates({ current: "2026.1120.0-nightly.5", channel: "stable", log: quiet });
      await check(u, remoteFor(served, key, [], "2026.1120.0-nightly.5"));
      expect(u.status().state, version).toEqual(offered ? { kind: "ready", version } : { kind: "idle" });
      expect(served.asked, version).toEqual(offered ? [STABLE_URL, FILE_URL] : [STABLE_URL]);
    }
  });

  test("desktop.json that cannot be read, or has nothing for this system, fails the check", async () => {
    const key = signer();
    const missing = new Updates({ current: "2026.1120.0", channel: "stable", log: quiet });
    await check(missing, remoteFor(serve({}), key, []));
    expect(missing.status().state).toEqual({ kind: "failed", stage: "check", message: `${STABLE_URL} answered 404` });
    const windowsOnly = new Updates({ current: "2026.1120.0", channel: "stable", log: quiet });
    await check(windowsOnly, remoteFor(serve(release(Buffer.from("x"), "sig", "2026.1125.0", "windows-x86_64")), key, []));
    expect(windowsOnly.status().state).toEqual({ kind: "failed", stage: "check", message: "desktop.json has no darwin-aarch64 for this system" });
    expect(() => newerRelease({ platforms: {} }, "1.0.0", "linux-x86_64")).toThrow("desktop.json names no version");
    expect(newerRelease({ version: "1.0.0" }, "1.0.0", null), "nothing newer needs no platform").toBeNull();
  });

  test("a download the server refuses fails at the download stage", async () => {
    const key = signer();
    const file = randomBytes(300);
    const routes = { ...release(file, sigFor(file, key, "2026.1125.0")), [FILE_URL]: () => new Response("gone", { status: 410 }) };
    const u = new Updates({ current: "2026.1120.0", channel: "stable", log: quiet });
    await check(u, remoteFor(serve(routes), key, []));
    expect(u.status().state).toEqual({ kind: "failed", stage: "download", message: `${FILE_URL} answered 410` });
  });

  test("a download given a tempDir streams to disk, verifies its signature, passes the path to install, and cleans up", async () => {
    const key = signer();
    const file = randomBytes(5000);
    const dir = temp();
    const served = serve(release(file, sigFor(file, key, "2026.1125.0")));
    const installed: string[] = [];
    const remote = githubRemote({
      fetch: served.fetch,
      current: "2026.1120.0",
      platform: "darwin-aarch64",
      publicKey: key.publicKey,
      tempDir: dir,
      installer: {
        installsAfterQuit: false,
        problem: () => null,
        install: async (payload) => {
          expect(payload).not.toBeInstanceOf(Uint8Array);
          if (!(payload instanceof Uint8Array)) {
            installed.push(readFileSync(payload.path).toString("hex"));
            await payload.dispose();
          }
        },
      },
    });
    const u = new Updates({ current: "2026.1120.0", channel: "stable", log: quiet });
    await check(u, remote);
    expect(u.status().state).toEqual({ kind: "ready", version: "2026.1125.0" });
    await u.quit(quiet);
    expect(installed).toEqual([file.toString("hex")]);
    expect(readdirSync(dir)).toEqual([]);

    const bad = new Updates({ current: "2026.1120.0", channel: "stable", log: quiet });
    await check(
      bad,
      githubRemote({
        fetch: serve(release(Buffer.concat([file, Buffer.from("x")]), sigFor(file, key, "2026.1125.0"))).fetch,
        current: "2026.1120.0",
        platform: "darwin-aarch64",
        publicKey: key.publicKey,
        tempDir: dir,
        installer: linuxInstaller({ appImage: join(dir, "unused"), fs: nodeInstallFs }),
      }),
    );
    expect(bad.status().state).toMatchObject({ kind: "failed", stage: "signature" });
    expect(readdirSync(dir)).toEqual([]);
  });

  test("each system reads its own entry in desktop.json", () => {
    expect(platformKey("darwin", "arm64")).toBe("darwin-aarch64");
    expect(platformKey("win32", "x64")).toBe("windows-x86_64");
    expect(platformKey("linux", "x64")).toBe("linux-x86_64");
    expect(platformKey("darwin", "x64")).toBeNull();
  });
});

function failingRename(fs: InstallFs, fails: (from: string, to: string) => boolean): InstallFs {
  return { ...fs, rename: (from, to) => (fails(from, to) ? Promise.reject(new Error("EPERM: operation not permitted")) : fs.rename(from, to)) };
}

const fakeTar: Run = (command, args) => {
  expect(command).toBe("tar");
  const into = args[args.indexOf("-C") + 1];
  mkdirSync(join(into, "loki.app", "Contents"), { recursive: true });
  writeFileSync(join(into, "loki.app", "Contents", "version"), "new");
  return Promise.resolve();
};

function macApp() {
  const folder = temp();
  const app = join(folder, "loki.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(app, "Contents", "version"), "old");
  return { folder, app, exe: join(app, "Contents", "MacOS", "loki"), version: () => readFileSync(join(app, "Contents", "version"), "utf8") };
}

describe("the Mac install", () => {
  test("unpacks beside the running app and swaps it in, leaving nothing behind", async () => {
    const mac = macApp();
    await macInstaller({ exe: mac.exe, fs: nodeInstallFs, run: fakeTar }).install(Buffer.from("tar.gz"), false);
    expect(mac.version()).toBe("new");
    expect(readdirSync(mac.folder)).toEqual(["loki.app"]);
  });

  test("puts the old app back when moving the new one in fails", async () => {
    const mac = macApp();
    const fs = failingRename(nodeInstallFs, (from, to) => from.endsWith(join("", "loki.app")) && to === mac.app && from !== mac.app);
    const install = macInstaller({ exe: mac.exe, fs, run: fakeTar }).install(Buffer.from("tar.gz"), false);
    await expect(install).rejects.toThrow(`could not move the new loki into ${mac.folder}: EPERM`);
    expect(mac.version()).toBe("old");
    expect(readdirSync(mac.folder)).toEqual(["loki.app"]);
  });

  test("an archive without loki.app, or a tar that fails, leaves the running app alone", async () => {
    const mac = macApp();
    const empty = macInstaller({ exe: mac.exe, fs: nodeInstallFs, run: () => Promise.resolve() });
    await expect(empty.install(Buffer.from("x"), false)).rejects.toThrow("the update holds no loki.app");
    const broken = macInstaller({ exe: mac.exe, fs: nodeInstallFs, run: () => Promise.reject(new Error("tar failed: truncated")) });
    await expect(broken.install(Buffer.from("x"), false)).rejects.toThrow("tar failed: truncated");
    expect(mac.version()).toBe("old");
    expect(readdirSync(mac.folder)).toEqual(["loki.app"]);
  });
});

describe("the Windows and Linux installs", () => {
  test("Windows writes the installer to a temporary file and starts it silently, relaunching only when asked", async () => {
    const started: string[][] = [];
    const tempDir = temp();
    const installer = windowsInstaller({
      tempDir,
      fs: nodeInstallFs,
      spawn: (command, args) => {
        expect(readFileSync(command, "utf8")).toBe("setup");
        started.push(args);
        return Promise.resolve();
      },
    });
    expect(installer.installsAfterQuit).toBe(true);
    await installer.install(Buffer.from("setup"), true);
    await installer.install(Buffer.from("setup"), false);
    expect(started).toEqual([
      ["/S", "--updated", "--force-run"],
      ["/S", "--updated"],
    ]);
  });

  test("an AppImage is replaced in place by the new file, executable", async () => {
    const dir = temp();
    const appImage = join(dir, "loki.AppImage");
    writeFileSync(appImage, "old");
    await linuxInstaller({ appImage, fs: nodeInstallFs }).install(Buffer.from("new"), false);
    expect(readFileSync(appImage, "utf8")).toBe("new");
    if (process.platform !== "win32") expect(statSync(appImage).mode & 0o777).toBe(0o755);
    expect(readdirSync(dir)).toEqual(["loki.AppImage"]);
  });
});

interface Harness {
  options: UpdaterOptions;
  published: UpdateStatus[];
  log: string[];
  clock: { now: number };
  ticks: Array<() => void>;
  served: Served;
  waitFor: (done: () => boolean) => Promise<void>;
}

function harness(over: Partial<UpdaterOptions> = {}, routes: Record<string, () => Response> = {}): Harness {
  const served = serve(routes);
  const published: UpdateStatus[] = [];
  const log: string[] = [];
  const clock = { now: 1_800_000_000_000 };
  const ticks: Array<() => void> = [];
  const waiters = new Set<() => void>();
  const waitFor = (done: () => boolean): Promise<void> =>
    done()
      ? Promise.resolve()
      : new Promise((resolve) => {
          const check = () => {
            if (!done()) return;
            waiters.delete(check);
            resolve();
          };
          waiters.add(check);
        });
  const options: UpdaterOptions = {
    lokiDir: temp(),
    current: "2026.1120.0",
    packaged: true,
    platform: "linux",
    arch: "x64",
    exe: "/opt/loki/loki",
    appImage: "/home/a/loki.AppImage",
    overrideUrl: undefined,
    tempDir: temp(),
    fetch: served.fetch,
    publish: (s) => {
      published.push(s);
      for (const fn of [...waiters]) fn();
    },
    stopDaemon: () => {
      log.push("stop daemon");
    },
    startDaemon: () => {
      log.push("start daemon");
    },
    relaunch: () => log.push("relaunch"),
    exit: () => log.push("exit"),
    now: () => clock.now,
    every: (ms, tick) => {
      expect(ms).toBe(WAKE_EVERY_MS);
      ticks.push(tick);
      return () => log.push("loop stopped");
    },
    log: quiet,
    ...over,
  };
  return { options, published, log, clock, ticks, served, waitFor };
}

const settled = (h: Harness) => h.waitFor(() => h.published.at(-1)?.state.kind !== "checking" && h.published.at(-1)?.state.kind !== "downloading");

describe("the updater main wires", () => {
  test("checks on launch and again once six hours of wall clock have passed, counting sleep", async () => {
    const h = harness();
    const stop = createUpdater(h.options).start();
    await settled(h);
    expect(h.served.asked).toEqual([STABLE_URL]);
    h.clock.now += 5 * 60 * 60 * 1000;
    h.ticks[0]();
    expect(h.served.asked).toHaveLength(1);
    h.clock.now += 9 * 60 * 60 * 1000;
    h.ticks[0]();
    await settled(h);
    expect(h.served.asked, "a laptop that slept through the hours checks at its next wake").toEqual([STABLE_URL, STABLE_URL]);
    stop();
    expect(h.log).toEqual(["loop stopped"]);
  });

  test("a failed install shown at launch holds the launch check off for six hours", () => {
    const h = harness();
    writeFileSync(join(h.options.lokiDir, "updates.json"), JSON.stringify({ channel: "stable", failed_install: { version: "2026.1125.0", message: "no" } }));
    const updater = createUpdater(h.options);
    updater.start();
    expect(h.served.asked).toEqual([]);
    expect(updater.status().state).toEqual({ kind: "failed", stage: "install", message: "no" });
  });

  test("LOKI_UPDATE_URL replaces the endpoint", async () => {
    const mine = "https://example.test/try-b/desktop.json";
    const h = harness({ overrideUrl: mine });
    createUpdater(h.options).check();
    await settled(h);
    expect(h.served.asked).toEqual([mine]);
  });

  test("an unwritable Mac app folder reports the problem without downloading", async () => {
    const key = signer();
    const file = randomBytes(300);
    const fs: InstallFs = { ...nodeInstallFs, writable: () => false };
    const h = harness(
      { platform: "darwin", arch: "arm64", exe: "/Applications/loki.app/Contents/MacOS/loki", appImage: undefined, fs, publicKey: key.publicKey },
      release(file, sigFor(file, key, "2026.1125.0")),
    );
    const updater = createUpdater(h.options);
    updater.check();
    await settled(h);
    expect(updater.status().state).toEqual({
      kind: "failed",
      stage: "install",
      message: "loki can't update itself in /Applications. Move it to a folder you can change, such as ~/Applications, to get updates.",
    });
    expect(h.served.asked).toEqual([STABLE_URL]);
  });

  test("a development build and a Linux package never check", () => {
    for (const over of [{ packaged: false }, { appImage: undefined }]) {
      const h = harness(over);
      const updater = createUpdater(h.options);
      updater.start();
      updater.check();
      expect(h.ticks).toEqual([]);
      expect(h.served.asked).toEqual([]);
      expect(updater.status().state.kind).toBe("unsupported");
    }
  });

  test("set_update_channel saves and publishes the channel, and refuses anything else", () => {
    const h = harness();
    const updater = createUpdater(h.options);
    expect(updater.setChannel("nightly")).toMatchObject({ channel: "nightly" });
    expect(h.published.at(-1)?.channel).toBe("nightly");
    expect(saved(h.options.lokiDir)).toEqual({ channel: "nightly" });
    expect(() => updater.setChannel("beta")).toThrow("beta is not an update channel");
  });

  test("Restart to Update relaunches loki on Linux and leaves Windows to its installer", async () => {
    const key = signer();
    const file = randomBytes(300);
    const appDir = temp();
    const appImage = join(appDir, "loki.AppImage");
    writeFileSync(appImage, "old");
    const linux = harness({ appImage, publicKey: key.publicKey }, release(file, sigFor(file, key, "2026.1125.0"), "2026.1125.0", "linux-x86_64"));
    const onLinux = createUpdater(linux.options);
    onLinux.check();
    await settled(linux);
    expect(onLinux.status().state.kind).toBe("ready");
    await onLinux.restart();
    expect(readFileSync(appImage).equals(file)).toBe(true);
    expect(linux.log).toEqual(["stop daemon", "relaunch"]);

    const started: string[][] = [];
    const windows = harness(
      {
        platform: "win32",
        appImage: undefined,
        publicKey: key.publicKey,
        spawn: (_command, args) => {
          started.push(args);
          return Promise.resolve();
        },
      },
      release(file, sigFor(file, key, "2026.1125.0"), "2026.1125.0", "windows-x86_64"),
    );
    const onWindows = createUpdater(windows.options);
    onWindows.check();
    await settled(windows);
    expect(onWindows.status().state.kind).toBe("ready");
    await onWindows.restart();
    expect(windows.log).toEqual(["stop daemon", "exit"]);
    expect(started).toEqual([["/S", "--updated", "--force-run"]]);
    await expect(onWindows.restart()).rejects.toThrow("no update is ready");
  });
});
