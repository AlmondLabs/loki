import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SlackSessionError, SlackSessions, securityKeychain, type KeychainReader } from "../mod/slack-session.ts";
import {
  COOKIE_DECODED,
  LOCAL_CONFIG,
  SAFE_STORAGE_PASSWORD,
  appStoreDir,
  directDownloadDir,
  levelLog,
  levelTable,
  storageKey,
  storageValue,
  writeSlackDir,
} from "./fixtures/slack.ts";

let root: string;
let home: string;
let tmp: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loki-slack-session-"));
  home = join(root, "home");
  tmp = join(root, "tmp");
  for (const d of [home, tmp]) mkdirSync(d);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A keychain that knows one password under one account, and records what it was asked. */
function keychain(password = SAFE_STORAGE_PASSWORD, account = "Slack Key") {
  const asked: Array<[string, string | undefined]> = [];
  const read: KeychainReader = (service, acct) => {
    asked.push([service, acct]);
    return service === "Slack Safe Storage" && acct === account ? Promise.resolve(password) : Promise.reject(new Error("not found"));
  };
  return { read, asked };
}

const sessionsFor = (read: KeychainReader, platform: NodeJS.Platform = "darwin") => new SlackSessions({ home, tmp, platform, keychain: read });

describe("reading the Slack desktop app's sessions", () => {
  test("a snapshot with two signed-in workspaces yields two sessions sharing the decrypted d cookie", async () => {
    writeSlackDir(directDownloadDir(home));
    const k = keychain();
    const sessions = sessionsFor(k.read);
    expect(await sessions.workspaces()).toEqual([
      { team_id: "T0ACME", team_name: "Acme", url: "https://acme.slack.com/", user_id: "U0ME" },
      { team_id: "T0BETA", team_name: "Beta Café", url: "https://beta-cafe.slack.com/", user_id: "U0YOU" },
    ]);
    expect(await sessions.get("T0BETA")).toEqual({
      team_id: "T0BETA",
      team_name: "Beta Café",
      url: "https://beta-cafe.slack.com/",
      user_id: "U0YOU",
      token: LOCAL_CONFIG.teams.T0BETA.token,
      cookie: COOKIE_DECODED,
    });
    expect(k.asked[0]).toEqual(["Slack Safe Storage", "Slack Key"]);
  });

  test("the snapshot is removed after reading, and Slack's own folder keeps its lock", async () => {
    writeSlackDir(directDownloadDir(home));
    await sessionsFor(keychain().read).workspaces();
    expect(readdirSync(tmp)).toEqual([]);
    expect(existsSync(join(directDownloadDir(home), "Local Storage", "leveldb", "LOCK"))).toBe(true);
  });

  test("the App Store build is found in its container, with its own keychain account", async () => {
    writeSlackDir(appStoreDir(home));
    const sessions = await sessionsFor(keychain(SAFE_STORAGE_PASSWORD, "Slack App Store Key").read).workspaces();
    expect(sessions.map((s) => s.team_id)).toEqual(["T0ACME", "T0BETA"]);
  });

  test("a localConfig larger than a log block, written in UTF-16, is read whole", async () => {
    const dir = directDownloadDir(home);
    writeSlackDir(dir);
    const big = {
      teams: { T0BIG: { id: "T0BIG", name: "Big ☃", url: "https://big.slack.com/", token: "xoxc-big", user_id: "U0B", notes: "n".repeat(40_000) } },
    };
    writeFileSync(
      join(dir, "Local Storage", "leveldb", "000009.log"),
      levelLog([[{ key: storageKey("localConfig_v3"), value: storageValue(JSON.stringify(big), "utf16") }]], 100),
    );
    expect(await sessionsFor(keychain().read).workspaces()).toEqual([{ team_id: "T0BIG", team_name: "Big ☃", url: "https://big.slack.com/", user_id: "U0B" }]);
  });

  test("an uncompressed table is read as well as a compressed one", async () => {
    const dir = directDownloadDir(home);
    writeSlackDir(dir);
    const one = { teams: { T0ONE: LOCAL_CONFIG.teams.T0ACME } };
    writeFileSync(
      join(dir, "Local Storage", "leveldb", "000007.ldb"),
      levelTable([{ key: storageKey("localConfig_v2"), value: storageValue(JSON.stringify(one)), seq: 70 }], { snappy: false }),
    );
    expect((await sessionsFor(keychain().read).workspaces()).map((w) => w.team_id)).toEqual(["T0ACME"]);
  });

  test("a localConfig deleted after it was written means Slack is signed in to no workspace", async () => {
    const dir = directDownloadDir(home);
    writeSlackDir(dir);
    writeFileSync(join(dir, "Local Storage", "leveldb", "000009.log"), levelLog([[{ key: storageKey("localConfig_v2"), value: null }]], 90));
    await expect(sessionsFor(keychain().read).workspaces()).rejects.toMatchObject({
      reason: "signed_out",
      message: expect.stringContaining("cannot read Slack session") as unknown,
    });
  });

  test("a wrong keychain key fails with a clear cause, not a crash", async () => {
    writeSlackDir(directDownloadDir(home));
    const failure = await sessionsFor(keychain("the-wrong-password").read)
      .workspaces()
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(SlackSessionError);
    expect(failure).toMatchObject({ reason: "keychain", message: "cannot read Slack session: the keychain's Slack key does not open Slack's cookie" });
    expect(readdirSync(tmp)).toEqual([]);
  });

  test("a keychain that gives no key says to allow it", async () => {
    writeSlackDir(directDownloadDir(home));
    const refuse: KeychainReader = () => Promise.reject(new Error("User canceled the operation."));
    await expect(sessionsFor(refuse).workspaces()).rejects.toMatchObject({
      reason: "keychain",
      message: expect.stringContaining("allow it when macOS asks") as unknown,
    });
  });

  test("no Slack data on this Mac", async () => {
    await expect(sessionsFor(keychain().read).workspaces()).rejects.toMatchObject({
      reason: "not_found",
      message: expect.stringContaining("cannot read Slack session") as unknown,
    });
  });

  test("Windows and Linux are not supported yet", async () => {
    writeSlackDir(directDownloadDir(home));
    for (const platform of ["win32", "linux"] as const) {
      const sessions = sessionsFor(keychain().read, platform);
      expect(sessions.available()).toEqual({ supported: false, reason: "connecting Slack works on a Mac only for now" });
      await expect(sessions.get("T0ACME")).rejects.toMatchObject({ reason: "not_supported" });
    }
    expect(sessionsFor(keychain().read).available()).toEqual({ supported: true });
  });

  test("a session is kept in memory until a fresh one is asked for, which sees a sign-out", async () => {
    const dir = directDownloadDir(home);
    writeSlackDir(dir);
    const k = keychain();
    const sessions = sessionsFor(k.read);
    expect((await sessions.get("T0BETA"))?.token).toBe(LOCAL_CONFIG.teams.T0BETA.token);
    const reads = k.asked.length;
    expect((await sessions.get("T0BETA"))?.token).toBe(LOCAL_CONFIG.teams.T0BETA.token);
    expect(k.asked.length).toBe(reads);
    // Signing out of Beta rewrites localConfig without it.
    writeFileSync(
      join(dir, "Local Storage", "leveldb", "000009.log"),
      levelLog([[{ key: storageKey("localConfig_v2"), value: storageValue(JSON.stringify({ teams: { T0ACME: LOCAL_CONFIG.teams.T0ACME } })) }]], 90),
    );
    expect(await sessions.get("T0BETA", true)).toBeNull();
    expect((await sessions.get("T0ACME"))?.team_name).toBe("Acme");
  });
});

describe("the default keychain reader", () => {
  test("asks security for the password alone, by service and account", async () => {
    const calls: string[][] = [];
    const read = securityKeychain((bin, args) => {
      calls.push([bin, ...args]);
      return Promise.resolve("secret\n");
    });
    expect(await read("Slack Safe Storage", "Slack Key")).toBe("secret");
    expect(await read("Slack Safe Storage")).toBe("secret");
    expect(calls).toEqual([
      ["security", "find-generic-password", "-w", "-s", "Slack Safe Storage", "-a", "Slack Key"],
      ["security", "find-generic-password", "-w", "-s", "Slack Safe Storage"],
    ]);
  });
});
