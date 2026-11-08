// The approach is ported from agent-slack (https://github.com/stablyai/agent-slack, src/auth/desktop.ts,
// src/auth/desktop-crypto.ts and src/auth/chromium-cookie.ts), itself inspired by slacktokens
// (https://github.com/hraftery/slacktokens):
//
// MIT License. Copyright (c) 2026 Stably. Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following
// conditions: The above copyright notice and this permission notice shall be included in all copies or substantial
// portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.

import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messageOf } from "../core/errors.ts";
import { log } from "./log.ts";
import { execProgram } from "./programs.ts";
import { readLevelDb } from "./slack-leveldb.ts";

/**
 * The Slack desktop app's sessions on this Mac (plan 067, U6, KTD7). For each workspace signed in there, Slack keeps a
 * desktop token (`xoxc-…`) in its Local Storage and one `d` cookie, encrypted with the "Slack Safe Storage" key in the
 * macOS keychain, that every workspace shares. loki reads both from the app's own files, so connecting Slack needs no
 * Slack app and no admin (R21). This is the one file that knows where Slack keeps them: a Slack update that moves them
 * breaks only this file, and shows as "Slack signed out" (R22).
 *
 * Sessions stay in memory. The only thing written to disk is a snapshot of Slack's files in a private temporary folder,
 * taken because Slack holds a lock on them while it runs, and removed as soon as it is read (KTD2).
 */

/** One signed-in workspace and what calling Slack as the person there takes; kept in memory only. */
export interface SlackSession {
  team_id: string;
  team_name: string;
  /** The workspace's own address, `https://<domain>.slack.com/`, where its calls go. */
  url: string;
  /** The person in that workspace, when the desktop app records it; auth.test always says. */
  user_id: string | null;
  /** The desktop token, `xoxc-…`. */
  token: string;
  /** The `d` cookie, `xoxd-…`, decoded; a request sends it encoded. */
  cookie: string;
}

/** A signed-in workspace as the person picks it when connecting: no token, no cookie. */
export interface SlackWorkspace {
  team_id: string;
  team_name: string;
  url: string;
  user_id: string | null;
}

/** Why the sessions could not be read: on this system at all, no Slack here, no workspace, the keychain, or the files. */
export type SlackSessionFailure = "not_supported" | "not_found" | "signed_out" | "keychain" | "unreadable";

/** A failure to read the desktop app's sessions, in words for the person, with its kind for the caller. */
export class SlackSessionError extends Error {
  readonly reason: SlackSessionFailure;

  constructor(message: string, reason: SlackSessionFailure) {
    super(message);
    this.name = "SlackSessionError";
    this.reason = reason;
  }
}

/** Reads one password from the macOS keychain by service (and account, when given); rejects when there is none or the person refuses. */
export type KeychainReader = (service: string, account?: string) => Promise<string>;

/** Runs a program and resolves to its stdout; rejects with what it said when it fails. */
export type SlackExec = (bin: string, args: string[], timeoutMs?: number) => Promise<string>;

/** What the session reader is built with; the home folder, the keychain and the temporary folder are injected so tests own them. */
export interface SlackSessionsOptions {
  /** The person's home folder, where Slack's data lives. */
  home: string;
  /** Default process.platform: only macOS is read. */
  platform?: NodeJS.Platform;
  /** Default: `security find-generic-password -w` through `exec`. */
  keychain?: KeychainReader;
  /** Runs `security` for the default keychain reader; default execFile. */
  exec?: SlackExec;
  /** Where the snapshot is taken; default the system's temporary folder. */
  tmp?: string;
}

const SAFE_STORAGE = "Slack Safe Storage";
/** The direct-download build and the Mac App Store build keep their keys under these accounts of one service. */
const KEYCHAIN_ACCOUNTS: Array<string | undefined> = ["Slack Key", "Slack App Store Key", undefined];
/** Long enough for the person to answer macOS's "allow loki to use Slack Safe Storage" prompt. */
const KEYCHAIN_TIMEOUT = 60_000;
const CONFIG_KEYS = [Buffer.from("localConfig_v2"), Buffer.from("localConfig_v3")];
const NOT_SUPPORTED = "connecting Slack works on a Mac only for now";

/** The folders Slack's data may be in, the direct download first; each has `Local Storage/leveldb` and a Cookies database. */
export function slackDataDirs(home: string): string[] {
  return [
    join(home, "Library", "Application Support", "Slack"),
    join(home, "Library", "Containers", "com.tinyspeck.slackmacgap", "Data", "Library", "Application Support", "Slack"),
  ];
}

const defaultExec: SlackExec = (bin, args, timeoutMs = KEYCHAIN_TIMEOUT) =>
  new Promise((resolve, reject) => {
    execProgram(bin, args, { timeout: timeoutMs, env: process.env }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr.trim() || err.message));
      resolve(stdout);
    });
  });

/** The keychain reader over `security`, the macOS command that asks the person once before giving loki the key. */
export function securityKeychain(exec: SlackExec = defaultExec): KeychainReader {
  return async (service, account) =>
    (await exec("security", ["find-generic-password", "-w", "-s", service, ...(account ? ["-a", account] : [])], KEYCHAIN_TIMEOUT)).trim();
}

const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A Local Storage value as text: Chromium writes 0 then UTF-16, or 1 then Latin-1. */
function storageText(value: Buffer): string {
  if (value[0] === 0) return value.subarray(1).toString("utf16le");
  if (value[0] === 1) return value.subarray(1).toString("latin1");
  return value.toString("utf8");
}

/** The workspaces in a localConfig: entries with a desktop token and an address; other tokens are not a desktop session. */
function teamsOf(config: unknown): Array<Omit<SlackSession, "cookie">> {
  const out: Array<Omit<SlackSession, "cookie">> = [];
  for (const [key, value] of Object.entries(rec(rec(config).teams))) {
    const t = rec(value);
    const token = str(t.token);
    const url = str(t.url);
    if (!token.startsWith("xoxc-") || !url) continue;
    const teamId = str(t.id) || key;
    out.push({ team_id: teamId, team_name: str(t.name) || teamId, url, user_id: str(t.user_id) || null, token });
  }
  return out;
}

/**
 * The `d` cookie from one encrypted_value: "v10" then AES-128-CBC under a key made from the keychain password (PBKDF2,
 * "saltysalt", 1003 rounds, 16 bytes, a 16-space IV). Chromium's newer cookies (meta version 24 on) start the plain
 * text with the SHA-256 of their host, dropped here. Null when this password does not open it.
 */
function decryptCookie(encrypted: Buffer, host: string, password: string): string | null {
  const prefix = encrypted.subarray(0, 3).toString("latin1");
  if (prefix !== "v10" && prefix !== "v11") return null;
  let plain: Buffer;
  try {
    const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
    plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
  } catch {
    return null;
  }
  if (plain.length >= 32 && plain.subarray(0, 32).equals(createHash("sha256").update(host).digest())) plain = plain.subarray(32);
  const text = plain.toString("latin1");
  return /^xoxd-[A-Za-z0-9%/+_=.-]+$/.test(text) ? decodedCookie(text) : null;
}

/** Slack stores the cookie URL-encoded; one that does not decode is kept as it is. */
function decodedCookie(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** The desktop app's sessions, read from its files when asked and kept in memory. */
export class SlackSessions {
  private readonly opts: SlackSessionsOptions;
  private readonly keychain: KeychainReader;
  private cache = new Map<string, SlackSession>();
  private inflight: Promise<SlackSession[]> | null = null;

  constructor(opts: SlackSessionsOptions) {
    this.opts = opts;
    this.keychain = opts.keychain ?? securityKeychain(opts.exec);
  }

  /** Whether Slack can be connected on this system; on Windows and Linux it says why not, in words for the person. */
  available(): { supported: true } | { supported: false; reason: string } {
    return (this.opts.platform ?? process.platform) === "darwin" ? { supported: true } : { supported: false, reason: NOT_SUPPORTED };
  }

  /** The workspaces signed in to the desktop app now, read afresh, for the person to pick one to connect. */
  async workspaces(): Promise<SlackWorkspace[]> {
    return (await this.read()).map((s) => ({ team_id: s.team_id, team_name: s.team_name, url: s.url, user_id: s.user_id }));
  }

  /**
   * One workspace's session, from memory unless `fresh`; null when the desktop app is no longer signed in to it. A
   * client asks for a fresh one after Slack refuses the one it has.
   */
  async get(teamId: string, fresh = false): Promise<SlackSession | null> {
    const known = this.cache.get(teamId);
    if (known && !fresh) return known;
    return (await this.read()).find((s) => s.team_id === teamId) ?? null;
  }

  /** Every session, read afresh; calls made while a read is under way share it. */
  private read(): Promise<SlackSession[]> {
    this.inflight ??= this.readAll().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async readAll(): Promise<SlackSession[]> {
    if (!this.available().supported) throw new SlackSessionError(NOT_SUPPORTED, "not_supported");
    const dirs = slackDataDirs(this.opts.home).filter((d) => existsSync(join(d, "Local Storage", "leveldb")));
    if (!dirs.length)
      throw new SlackSessionError("cannot read Slack session: the Slack desktop app is not installed or not signed in on this Mac", "not_found");
    const sessions: SlackSession[] = [];
    let failure: SlackSessionError | null = null;
    for (const dir of dirs) {
      try {
        for (const s of await this.readDir(dir)) if (!sessions.some((o) => o.team_id === s.team_id)) sessions.push(s);
      } catch (err) {
        const error = err instanceof SlackSessionError ? err : new SlackSessionError(`cannot read Slack session: ${messageOf(err)}`, "unreadable");
        log("slack:session-unreadable", { build: dir.includes("Containers") ? "app_store" : "direct_download", reason: error.reason });
        failure ??= error;
      }
    }
    if (!sessions.length && failure) throw failure;
    this.cache = new Map(sessions.map((s) => [s.team_id, s]));
    return sessions;
  }

  /** One data folder's sessions, from a snapshot that is removed whatever happens. */
  private async readDir(dir: string): Promise<SlackSession[]> {
    const snap = await mkdtemp(join(this.opts.tmp ?? tmpdir(), "loki-slack-"));
    try {
      await cp(join(dir, "Local Storage", "leveldb"), join(snap, "leveldb"), { recursive: true });
      const teams = await this.teams(join(snap, "leveldb"));
      const cookies = [join(dir, "Network", "Cookies"), join(dir, "Cookies")].find((f) => existsSync(f));
      if (!cookies) throw new SlackSessionError("cannot read Slack session: Slack keeps no cookies on this Mac", "unreadable");
      // The write-ahead log carries Slack's latest writes; the shared-memory index is rebuilt from it on open.
      for (const suffix of ["", "-wal", "-journal"]) if (existsSync(cookies + suffix)) await copyFile(cookies + suffix, join(snap, `Cookies${suffix}`));
      const cookie = await this.cookie(join(snap, "Cookies"));
      return teams.map((t) => ({ ...t, cookie }));
    } finally {
      await rm(snap, { recursive: true, force: true });
    }
  }

  /** The workspaces in the newest localConfig write; a deleted or empty one means Slack is signed in to none. */
  private async teams(leveldb: string): Promise<Array<Omit<SlackSession, "cookie">>> {
    const entries = (await readLevelDb(leveldb, Buffer.from("localConfig_v"))).filter((e) => CONFIG_KEYS.some((k) => e.key.includes(k)));
    const newest = entries.reduce<(typeof entries)[number] | null>((best, e) => (!best || e.seq > best.seq ? e : best), null);
    if (!newest?.value?.length) throw new SlackSessionError("cannot read Slack session: the Slack desktop app is signed in to no workspace", "signed_out");
    let config: unknown;
    try {
      config = JSON.parse(storageText(newest.value));
    } catch {
      throw new SlackSessionError("cannot read Slack session: Slack's saved settings are not in a form loki knows", "unreadable");
    }
    const teams = teamsOf(config);
    if (!teams.length) throw new SlackSessionError("cannot read Slack session: the Slack desktop app is signed in to no workspace", "signed_out");
    return teams;
  }

  /** The `d` cookie, decrypted with whichever of Slack's keychain keys opens it. */
  private async cookie(file: string): Promise<string> {
    // Imported here so Node's notice that SQLite is experimental shows only once Slack is used.
    const { DatabaseSync } = await import("node:sqlite");
    let rows: Array<{ host: string; value: string; encrypted: Buffer }>;
    const db = new DatabaseSync(file);
    try {
      rows = db
        .prepare(
          "SELECT host_key, value, encrypted_value FROM cookies WHERE name = 'd' AND (host_key = 'slack.com' OR host_key LIKE '%.slack.com') ORDER BY length(encrypted_value) DESC",
        )
        .all()
        .map((r) => ({
          host: str(r.host_key),
          value: str(r.value),
          encrypted: r.encrypted_value instanceof Uint8Array ? Buffer.from(r.encrypted_value) : Buffer.alloc(0),
        }));
    } catch (err) {
      throw new SlackSessionError(`cannot read Slack session: Slack's cookies could not be read (${messageOf(err)})`, "unreadable");
    } finally {
      db.close();
    }
    const plain = rows.find((r) => r.value.startsWith("xoxd-"));
    if (plain) return decodedCookie(plain.value);
    if (!rows.length) throw new SlackSessionError("cannot read Slack session: the Slack desktop app is signed in to no workspace", "signed_out");
    const passwords: string[] = [];
    for (const account of KEYCHAIN_ACCOUNTS) {
      try {
        const password = await this.keychain(SAFE_STORAGE, account);
        if (password && !passwords.includes(password)) passwords.push(password);
      } catch {
        // The other build's account, or none: the next lookup may still find the key.
      }
    }
    if (!passwords.length)
      throw new SlackSessionError("cannot read Slack session: the keychain did not give loki Slack's key; allow it when macOS asks", "keychain");
    for (const row of rows) {
      for (const password of passwords) {
        const cookie = decryptCookie(row.encrypted, row.host, password);
        if (cookie) return cookie;
      }
    }
    throw new SlackSessionError("cannot read Slack session: the keychain's Slack key does not open Slack's cookie", "keychain");
  }
}
