import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import type { MacIdentity, PeerSummary } from "../core/frame-types.ts";
import type { SecretBackend } from "../daemon/credentials.ts";
import { hashToken } from "./devices.ts";
import type { PairingCodes } from "./pairing.ts";
import { log } from "./log.ts";

/**
 * The other Macs this one is paired with (plan 023, U1, KTD1). Pairing is mutual: each Mac mints a token for the other
 * to present when it connects, keeps only that token's sha256 here (state/peers.json, mode 0600), and keeps the token
 * the other Mac minted for it in the keychain (PeerKeys). So neither file nor keychain alone lets a third party in, and
 * forgetting a Mac on either side ends the pairing for both.
 */

/**
 * The version of what Macs say to each other. Two Macs on different numbers stay paired but sync nothing (KTD12); it
 * goes up with any change one side could misread.
 */
export const PEER_PROTOCOL = 1;

/** What a Mac says about itself when pairing and when another Mac asks (`GET /peer/hello`). */
export interface PeerHello extends MacIdentity {
  /** Where other Macs reach it: its tailnet name and port. */
  host: string;
  build: string | null;
  protocol: number;
}

/** A paired Mac as state/peers.json keeps it. */
export interface PeerRecord extends PeerHello {
  /** sha256 hex of the token this Mac minted for it, which it presents when it connects. */
  token_hash: string;
  paired_at: string;
  last_seen_at: string;
  /** This Mac has taken over the chats of its agents from that Mac, once, after pairing (U9). */
  moves_done?: boolean;
}

const SEEN_WRITE_INTERVAL_MS = 60_000;
const TOKEN = /^[a-f0-9]{64}$/;
/** The shape of the install id daemon/providers.ts mints (a UUID); anything else is not a Mac this code made. */
const MAC_ID = /^[0-9a-f-]{36}$/i;

/** A new token for another Mac to present: 32 random bytes as hex, the same strength as a phone's. */
export const mintPeerToken = (): string => randomBytes(32).toString("hex");

/** Whether a string has the shape of a token this code mints. */
export const isPeerToken = (v: unknown): v is string => typeof v === "string" && TOKEN.test(v);

/** Another Mac's hello as sent over the network, or null when it is not one. */
export function parsePeerHello(v: unknown): PeerHello | null {
  if (typeof v !== "object" || v === null) return null;
  const m = v as Record<string, unknown>;
  if (typeof m.mac_id !== "string" || !MAC_ID.test(m.mac_id)) return null;
  if (typeof m.name !== "string" || !m.name.trim()) return null;
  if (typeof m.host !== "string" || !m.host.trim()) return null;
  if (typeof m.protocol !== "number" || !Number.isInteger(m.protocol)) return null;
  const build = typeof m.build === "string" ? m.build : null;
  return { mac_id: m.mac_id, name: m.name.trim().slice(0, 64), host: m.host.trim().slice(0, 255), build, protocol: m.protocol };
}

/**
 * The paired Macs, kept in state/peers.json and loaded once at start; an unreadable file means none. Writes are best
 * effort, as for phones: a failed one costs a re-pair, never a crash.
 */
export class PeerStore {
  private peers: PeerRecord[] = [];
  private readonly path: string;
  private readonly now: () => number;
  /** The Macs forgotten here on purpose (addendum D3), beside peers.json: never joined or invited again by themselves. */
  private forgotten = new Set<string>();
  private readonly forgottenPath: string;

  constructor(path: string, opts: { now?: () => number } = {}) {
    this.path = path;
    this.now = opts.now ?? Date.now;
    this.forgottenPath = path.replace(/\.json$/, "") + "-forgotten.json";
    try {
      const ids = JSON.parse(readFileSync(this.forgottenPath, "utf8")) as unknown;
      if (Array.isArray(ids)) this.forgotten = new Set(ids.filter((x): x is string => typeof x === "string"));
    } catch {
      this.forgotten = new Set();
    }
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (Array.isArray(parsed))
        this.peers = parsed.flatMap((r: unknown) => {
          const hello = parsePeerHello(r);
          const rec = r as Partial<PeerRecord>;
          return hello && isHex(rec.token_hash) && typeof rec.paired_at === "string" && typeof rec.last_seen_at === "string"
            ? [
                {
                  ...hello,
                  token_hash: rec.token_hash,
                  paired_at: rec.paired_at,
                  last_seen_at: rec.last_seen_at,
                  ...(rec.moves_done === true ? { moves_done: true } : {}),
                },
              ]
            : [];
        });
    } catch {
      this.peers = [];
    }
  }

  /** Pair with a Mac, or pair it again: `token` is the one this Mac minted for it, kept only as a hash. */
  add(hello: PeerHello, token: string): PeerRecord {
    const at = new Date(this.now()).toISOString();
    const record: PeerRecord = { ...hello, token_hash: hashToken(token), paired_at: at, last_seen_at: at };
    this.peers = [...this.peers.filter((p) => p.mac_id !== hello.mac_id), record];
    this.persist();
    // Paired again on purpose: it is part of the group again.
    if (this.forgotten.delete(hello.mac_id)) this.persistForgotten();
    return record;
  }

  /** The Mac a token belongs to, or null; refreshes when it was last seen, written at most once a minute. */
  verify(token: string): PeerRecord | null {
    if (!isPeerToken(token)) return null;
    const hash = hashToken(token);
    const peer = this.peers.find((p) => p.token_hash === hash);
    if (!peer) return null;
    this.touch(peer);
    return peer;
  }

  /** A Mac answered: keep what it now says about itself (its name, address, build, protocol) and when. */
  heard(hello: PeerHello): void {
    const peer = this.get(hello.mac_id);
    if (!peer) return;
    Object.assign(peer, { name: hello.name, host: hello.host, build: hello.build, protocol: hello.protocol });
    peer.last_seen_at = new Date(this.now()).toISOString();
    this.persist();
  }

  /** The chats of this Mac's agents have been taken over from that Mac: it is not asked again (U9). */
  markMovesDone(macId: string): void {
    const peer = this.get(macId);
    if (!peer || peer.moves_done) return;
    peer.moves_done = true;
    this.persist();
  }

  /** Forget a Mac; `onPurpose` (the person forgot it here) also keeps it from being joined or invited again. */
  forget(macId: string, onPurpose = false): boolean {
    if (onPurpose && !this.forgotten.has(macId)) {
      this.forgotten.add(macId);
      this.persistForgotten();
    }
    const before = this.peers.length;
    this.peers = this.peers.filter((p) => p.mac_id !== macId);
    if (this.peers.length === before) return false;
    this.persist();
    return true;
  }

  /** Whether the person forgot this Mac here on purpose (addendum D3). */
  isForgotten(macId: string): boolean {
    return this.forgotten.has(macId);
  }

  get(macId: string): PeerRecord | null {
    return this.peers.find((p) => p.mac_id === macId) ?? null;
  }

  size(): number {
    return this.peers.length;
  }

  /** The paired Macs as Settings shows them; `reachable` says which have an open peer link (U2), none when omitted. */
  list(reachable: (macId: string) => boolean = () => false): PeerSummary[] {
    return this.peers.map((p) => ({
      mac_id: p.mac_id,
      name: p.name,
      host: p.host,
      paired_at: p.paired_at,
      last_seen_at: p.last_seen_at,
      build: p.build,
      outdated: p.protocol !== PEER_PROTOCOL,
      reachable: reachable(p.mac_id),
    }));
  }

  private touch(peer: PeerRecord): void {
    const now = this.now();
    if (now - Date.parse(peer.last_seen_at) < SEEN_WRITE_INTERVAL_MS) return;
    peer.last_seen_at = new Date(now).toISOString();
    this.persist();
  }

  private persistForgotten(): void {
    try {
      mkdirSync(dirname(this.forgottenPath), { recursive: true });
      writeFileSync(this.forgottenPath, JSON.stringify([...this.forgotten], null, 2) + "\n", { mode: 0o600 });
    } catch {
      // best effort, as for peers.json
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.peers, null, 2) + "\n", { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch {
      // best effort: a failed write costs a re-pair, never a crash
    }
  }
}

const isHex = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);

/** The tokens other Macs minted for this one, which it presents to them: in the keychain, one entry per Mac. */
export class PeerKeys {
  private readonly secrets: SecretBackend;

  constructor(secrets: SecretBackend) {
    this.secrets = secrets;
  }

  private account(macId: string): string {
    return `peer:${macId}`;
  }

  async get(macId: string): Promise<string | null> {
    const token = await this.secrets.get(this.account(macId));
    return isPeerToken(token) ? token : null;
  }

  set(macId: string, token: string): Promise<void> {
    return this.secrets.set(this.account(macId), token);
  }

  async delete(macId: string): Promise<void> {
    try {
      await this.secrets.delete(this.account(macId));
    } catch {
      // nothing to delete
    }
  }
}

/**
 * The Mac's own name as the person set it (System Settings › General › About), from scutil, else the host name
 * without `.local`. "This Mac" when neither answers.
 */
export function macName(): string {
  try {
    const name = execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (name) return name.slice(0, 64);
  } catch {
    // not macOS, or scutil unavailable
  }
  try {
    return (
      hostname()
        .replace(/\.local\.?$/i, "")
        .trim() || "This Mac"
    );
  } catch {
    return "This Mac";
  }
}

/** The answer to an HTTP route the listener hands to Peers: a status and a JSON body. */
export interface PeerAnswer {
  status: number;
  body: object;
}

/** How a contact with a paired Mac went: it answered, it no longer knows this Mac, or it could not be reached. */
export type PeerContact = "ok" | "unpaired" | "unreachable";

/** What Peers is built from; `fetch` and the timeout are replaced in tests. */
export interface PeersOptions {
  store: PeerStore;
  keys: PeerKeys;
  /** Codes for pairing Macs only: a phone's code never pairs a Mac, nor the other way round. */
  codes: PairingCodes;
  /** This Mac's hello, read when needed (its tailnet name can change). */
  me: () => PeerHello;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** A Mac was paired, re-paired or forgotten. */
  onChange?: () => void;
  /** A Mac was forgotten: close its sockets. */
  onForget?: (macId: string) => void;
  now?: () => number;
}

/** How long an invite for a Mac being introduced lives (addendum D4). */
export const INVITE_TTL_MS = 2 * 60_000;

/**
 * Pairing between Macs, both sides of it. The Mac that shows a code answers `POST /peer/pair`; the Mac the person
 * types the code into calls `join`. Each side ends holding the other's token in its keychain and the hash of its own
 * in peers.json. `forget` tells the other Mac when it can, and `contact` notices when the other Mac forgot this one.
 */
export class Peers {
  private readonly opts: PeersOptions;
  private readonly fetch: typeof fetch;
  /** Invites for Macs being introduced (addendum D4): code → the Mac it is for, and when it lapses. In memory only. */
  private readonly invites = new Map<string, { mac_id: string; expires: number }>();

  constructor(opts: PeersOptions) {
    this.opts = opts;
    this.fetch = opts.fetch ?? fetch;
  }

  /** This Mac's hello. */
  hello(): PeerHello {
    return this.opts.me();
  }

  list(): PeerSummary[] {
    return this.opts.store.list();
  }

  /** The Mac a presented token belongs to, or null. */
  verify(token: string): string | null {
    return this.opts.store.verify(token)?.mac_id ?? null;
  }

  /**
   * An invite for `macId`, which a Mac paired with this one is introducing (addendum D4): 32 random bytes, for that Mac
   * only, once, for two minutes; with this Mac's tailnet address to redeem it at. Null for a Mac forgotten here on
   * purpose, or for this Mac itself.
   */
  invite(macId: string): { code: string; host: string } | null {
    const me = this.hello();
    if (macId === me.mac_id || this.opts.store.isForgotten(macId) || !me.host) return null;
    const now = this.now();
    for (const [code, inv] of this.invites) if (inv.expires <= now) this.invites.delete(code);
    const code = mintPeerToken();
    this.invites.set(code, { mac_id: macId, expires: now + INVITE_TTL_MS });
    log("peers:invite", { for: macId });
    return { code, host: me.host };
  }

  /**
   * `POST /peer/pair` on the Mac showing the code: `body` is the joining Mac's code (or invite), hello and the token it
   * minted for this one.
   */
  async accept(body: Record<string, unknown> | null): Promise<PeerAnswer> {
    const hello = parsePeerHello(body?.hello);
    const token = body?.token;
    if (!body || typeof body.code !== "string" || !hello || !isPeerToken(token)) return { status: 400, body: { error: "expected {code, hello, token}" } };
    // An invite is spent by its first use, whoever brings it.
    const invite = this.invites.get(body.code);
    this.invites.delete(body.code);
    const invited = !!invite && invite.mac_id === hello.mac_id && invite.expires > this.now();
    if (!invited && !this.opts.codes.redeem(body.code)) return { status: 404, body: { error: "unknown or expired code" } };
    const me = this.hello();
    if (hello.mac_id === me.mac_id) return { status: 409, body: { error: "that code is this Mac's own" } };
    const mine = mintPeerToken();
    await this.opts.keys.set(hello.mac_id, token);
    this.opts.store.add(hello, mine);
    log("peers:paired", { mac: hello.mac_id, name: hello.name, by: invited ? "invite" : "code" });
    this.opts.onChange?.();
    return { status: 200, body: { hello: me, token: mine } };
  }

  /** Pair with the Mac at `host` (its tailnet name, with a port or not) using the code it shows. Throws a message for the person. */
  async join(host: string, code: string): Promise<PeerSummary> {
    const base = peerBase(host);
    if (!base) throw new Error("type the other Mac's tailnet name, as its Preferences › Macs shows it");
    const mine = mintPeerToken();
    const me = this.hello();
    const res = await this.call(`${base}/peer/pair`, { method: "POST", body: JSON.stringify({ code, hello: me, token: mine }) });
    if (!res) throw new Error(`could not reach ${host}: is loki open there, and Tailscale on both Macs?`);
    const answer = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) throw new Error(typeof answer?.error === "string" ? answer.error : `the other Mac answered ${res.status}`);
    const hello = parsePeerHello(answer?.hello);
    const token = answer?.token;
    if (!hello || !isPeerToken(token)) throw new Error("the other Mac's answer was not one loki understands: update loki on both Macs");
    if (hello.mac_id === me.mac_id) throw new Error("that address is this Mac");
    await this.opts.keys.set(hello.mac_id, token);
    // The address the person typed reached it, so it is the one to keep.
    this.opts.store.add({ ...hello, host: hostWithPort(host) }, mine);
    log("peers:paired", { mac: hello.mac_id, name: hello.name, by: "join" });
    this.opts.onChange?.();
    const summary = this.opts.store.list().find((p) => p.mac_id === hello.mac_id);
    if (!summary) throw new Error("the pairing could not be saved");
    return summary;
  }

  /** Forget a Mac here, telling it first when it can be reached, so it forgets this one too. */
  async forget(macId: string): Promise<boolean> {
    const peer = this.opts.store.get(macId);
    if (!peer) return false;
    const token = await this.opts.keys.get(macId);
    const base = peerBase(peer.host);
    if (token && base) await this.call(`${base}/peer/unpair`, { method: "POST", token, body: "{}" });
    return this.drop(macId, "here");
  }

  /** `POST /peer/unpair` from a Mac that forgot this one: forget it too. */
  forgotBy(macId: string): PeerAnswer {
    void this.drop(macId, "there");
    return { status: 200, body: { ok: true } };
  }

  /** Ask a paired Mac for its hello: it answers (and its record is refreshed), it no longer knows this Mac (forgotten here too), or it is out of reach. */
  async contact(macId: string): Promise<PeerContact> {
    const peer = this.opts.store.get(macId);
    const token = await this.opts.keys.get(macId);
    const base = peer ? peerBase(peer.host) : null;
    if (!peer || !base || !token) return "unreachable";
    const res = await this.call(`${base}/peer/hello`, { method: "GET", token });
    if (!res) return "unreachable";
    if (res.status === 401) {
      await this.drop(macId, "there");
      return "unpaired";
    }
    const hello = res.ok ? parsePeerHello(await res.json().catch(() => null)) : null;
    if (hello?.mac_id !== macId) return "unreachable";
    this.opts.store.heard({ ...hello, host: peer.host });
    return "ok";
  }

  /**
   * Send a file this Mac holds to a paired Mac's uploads (U5), for a chat that lives there; resolves to its path on
   * that Mac, or null when it could not be sent.
   */
  /** A picture in a message, by its name, from a paired Mac that holds it (plan 029); null when it does not. */
  async chatImage(macId: string, name: string): Promise<Buffer | null> {
    const peer = this.opts.store.get(macId);
    const token = await this.opts.keys.get(macId);
    const base = peer ? peerBase(peer.host) : null;
    if (!base || !token) return null;
    try {
      const res = await this.fetch(`${base}/peer/chat-images/${encodeURIComponent(name)}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20_000),
      });
      return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
    } catch {
      return null;
    }
  }

  async upload(macId: string, file: { path: string; name: string; mime: string }): Promise<string | null> {
    const peer = this.opts.store.get(macId);
    const token = await this.opts.keys.get(macId);
    const base = peer ? peerBase(peer.host) : null;
    if (!base || !token) return null;
    let body: Buffer;
    try {
      body = readFileSync(file.path);
    } catch {
      return null;
    }
    try {
      const q = new URLSearchParams({ name: file.name, type: file.mime });
      const res = await this.fetch(`${base}/peer/uploads?${q.toString()}`, {
        method: "POST",
        headers: { "content-type": file.mime, authorization: `Bearer ${token}` },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(60_000),
      });
      const answer = (await res.json().catch(() => null)) as { path?: unknown } | null;
      return res.ok && typeof answer?.path === "string" ? answer.path : null;
    } catch {
      return null;
    }
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private async drop(macId: string, where: "here" | "there"): Promise<boolean> {
    const gone = this.opts.store.forget(macId, where === "here");
    await this.opts.keys.delete(macId);
    this.opts.onForget?.(macId);
    if (gone) {
      log("peers:forgotten", { mac: macId, where });
      this.opts.onChange?.();
    }
    return gone;
  }

  /** One request to another Mac, or null when it could not be reached in time. */
  private async call(url: string, init: { method: string; body?: string; token?: string }): Promise<Response | null> {
    try {
      return await this.fetch(url, {
        method: init.method,
        headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8000),
      });
    } catch {
      return null;
    }
  }
}

/** The listener port a typed host means when it names none. */
const PEER_PORT = 41415;

/** A host as typed, with the listener's port added when it has none. */
export function hostWithPort(host: string): string {
  const h = host
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "");
  return /:\d+$/.test(h) ? h : `${h}:${PEER_PORT}`;
}

/** The base URL for a peer's host, or null when the text cannot be one (a path, spaces, nothing). */
export function peerBase(host: string): string | null {
  const h = hostWithPort(host);
  return /^[A-Za-z0-9.-]+:\d+$/.test(h) || /^\[[0-9a-f:]+\]:\d+$/i.test(h) ? `http://${h}` : null;
}
