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

export interface SlackSession {
  team_id: string;
  team_name: string;
  url: string;
  user_id: string | null;
  token: string;
  /** The `d` cookie, `xoxd-…`, decoded; a request sends it encoded. */
  cookie: string;
}

export interface SlackWorkspace {
  team_id: string;
  team_name: string;
  url: string;
  user_id: string | null;
}

export type SlackSessionFailure = "not_supported" | "not_found" | "signed_out" | "keychain" | "unreadable";

export class SlackSessionError extends Error {
  readonly reason: SlackSessionFailure;

  constructor(message: string, reason: SlackSessionFailure) {
    super(message);
    this.name = "SlackSessionError";
    this.reason = reason;
  }
}

export type KeychainReader = (service: string, account?: string) => Promise<string>;

export type SlackExec = (bin: string, args: string[], timeoutMs?: number) => Promise<string>;

export interface SlackSessionsOptions {
  home: string;
  platform?: NodeJS.Platform;
  keychain?: KeychainReader;
  exec?: SlackExec;
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

export class SlackSessions {
  private readonly opts: SlackSessionsOptions;
  private readonly keychain: KeychainReader;
  private cache = new Map<string, SlackSession>();
  private inflight: Promise<SlackSession[]> | null = null;

  constructor(opts: SlackSessionsOptions) {
    this.opts = opts;
    this.keychain = opts.keychain ?? securityKeychain(opts.exec);
  }

  available(): { supported: true } | { supported: false; reason: string } {
    return (this.opts.platform ?? process.platform) === "darwin" ? { supported: true } : { supported: false, reason: NOT_SUPPORTED };
  }

  async workspaces(): Promise<SlackWorkspace[]> {
    return (await this.read()).map((s) => ({ team_id: s.team_id, team_name: s.team_name, url: s.url, user_id: s.user_id }));
  }

  async get(teamId: string, fresh = false): Promise<SlackSession | null> {
    const known = this.cache.get(teamId);
    if (known && !fresh) return known;
    return (await this.read()).find((s) => s.team_id === teamId) ?? null;
  }

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
        log.error("slack:session-unreadable", { build: dir.includes("Containers") ? "app_store" : "direct_download", reason: error.reason });
        failure ??= error;
      }
    }
    if (!sessions.length && failure) throw failure;
    this.cache = new Map(sessions.map((s) => [s.team_id, s]));
    return sessions;
  }

  private async readDir(dir: string): Promise<SlackSession[]> {
    const snap = await mkdtemp(join(this.opts.tmp ?? tmpdir(), "loki-slack-"));
    try {
      await cp(join(dir, "Local Storage", "leveldb"), join(snap, "leveldb"), { recursive: true });
      const teams = await this.teams(join(snap, "leveldb"));
      const cookies = [join(dir, "Network", "Cookies"), join(dir, "Cookies")].find((f) => existsSync(f));
      if (!cookies) throw new SlackSessionError("cannot read Slack session: Slack keeps no cookies on this Mac", "unreadable");
      // Outside (SQLite): the write-ahead log carries Slack's latest writes; the shared-memory index is rebuilt from it on open.
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

  private async cookie(file: string): Promise<string> {
    // Outside (Node): imported here so Node's notice that SQLite is experimental shows only once Slack is used.
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
      } catch {}
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
