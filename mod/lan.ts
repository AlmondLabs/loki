import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import type { Scope } from "../packages/core/src/desk-core.ts";
import type { DeviceStore, DeviceVia } from "./devices.ts";
import type { PairingCodes } from "./pairing.ts";
import { DEFAULT_LAN_PORT } from "./paths.ts";
import { attachWs, closeServer, listenWithRetry, profileRoute, type Authorize, type WsBridge, type WsHandlers } from "./server.ts";
import { buildIdOf, createStaticApp, resolveAppDist, type StaticHandler } from "./static.ts";
import type { Tailscale, TailscaleStatus } from "./tailscale.ts";
import { log } from "./log.ts";

/**
 * The second listener, for phones on the same Wi‑Fi. Off by default; the setting in
 * state/lan.json survives /reload. Binds 0.0.0.0:41415 (LOKI_LAN_PORT) and speaks:
 *   GET  /health                       liveness, nothing else
 *   POST /pair  {code, name}           a pairing code → a device token in an HttpOnly cookie
 *   GET  /me                           {deviceId, name} or 401: is this browser paired?
 *   POST /unpair                       clears the cookie and forgets the device
 *   GET  /agents/<id>/profile.png      device auth (cookie or bearer), never ?t=
 *   /ws, /appserver                    the same bridge as loopback, device auth only
 *   everything else                    the built canvas as a single-page app (mod/static.ts)
 * The desktop token is refused here even when presented as a bearer.
 */
export interface LanStatus {
  /** The persisted setting. `error` says whether the listener is up when this is true. */
  enabled: boolean;
  /** First non-internal IPv4 (en0 preferred), or null when the machine is off the network. */
  address: string | null;
  /** Every Wi‑Fi/Ethernet address; the tailnet's 100.x address is in `tailscale.ip`, not here. */
  addresses: string[];
  /** The Mac's Bonjour name with `.local`: what the QR and the bookmark carry, because it survives a new address on a new network. */
  host: string | null;
  port: number;
  /** A built canvas was found to serve. */
  appServed: boolean;
  /** A bind error (EADDRINUSE …) or a missing network; null when all is well. */
  error: string | null;
  /** Which route the QR encodes: the tailnet (Addendum 3) or the Wi‑Fi. Persisted when the user chose; else tailscale iff it runs. */
  via: LanVia;
  /** The tailnet's view of the Mac (mod/tailscale.ts); null when the listener was built without Tailscale. */
  tailscale: TailscaleStatus | null;
}

export type LanVia = "tailscale" | "lan";
export const isLanVia = (v: unknown): v is LanVia => v === "tailscale" || v === "lan";

export type LanChange = "status" | "devices";

export interface LanOptions {
  /** Default LOKI_LAN_PORT or 41415. 0 picks an ephemeral port (tests). */
  port?: number;
  /** state/lan.json */
  stateFile: string;
  devices: DeviceStore;
  codes: PairingCodes;
  /** The same handlers the loopback bridge uses (mod/bridge.ts). */
  handlers: WsHandlers;
  /** The loopback capability token: refused on this listener. */
  desktopToken?: string;
  profile?: (agentId: string) => string | null;
  /** Override the canvas directory; default resolveAppDist() (LOKI_APP_DIST, installed layout, app/dist). */
  appDist?: string | null;
  health?: () => object;
  /** "status" after start/stop/bind error; "devices" after pair or a persisted last-seen. */
  onChange?: (what: LanChange, status: LanStatus) => void;
  /** For tests: the interface table. */
  interfaces?: () => ReturnType<typeof networkInterfaces>;
  /** For tests: the Bonjour host (default bonjourHost()). */
  host?: () => string | null;
  /** How often to look for a new canvas build while listening (default 5 s). */
  buildPollMs?: number;
  /** The tailnet reader; omit and status().tailscale is null (tests that do not care). */
  tailscale?: Tailscale | null;
  /** How often to re-read Tailscale while listening (default 60 s). */
  tailscalePollMs?: number;
}

export const DEVICE_COOKIE = "loki_device";
const COOKIE_MAX_AGE = 365 * 24 * 3600;
const MAX_BODY = 64 * 1024;

export class LanListener {
  private readonly opts: LanOptions;
  private readonly configuredPort: number;
  private dist: string | null;
  private serveStatic: StaticHandler;
  private enabledFlag: boolean;
  /** The user's route choice, or undefined for the default (tailscale iff running). */
  private viaSetting: LanVia | undefined;
  private readonly tailscale: Tailscale | null;
  /** The Tailscale status the last refresh() saw, to notice a change worth broadcasting. */
  private lastTailscale: TailscaleStatus | null = null;
  private tailscalePoll: ReturnType<typeof setInterval> | null = null;
  /** Wrong pairing codes per remote address: ten in ten minutes and that address waits ten minutes. */
  private readonly attempts = new Attempts();
  private server: Server | null = null;
  /** While listening: the build id last announced, and the poll that watches for a new one. */
  private announcedBuild: string | null = null;
  private buildPoll: ReturnType<typeof setInterval> | null = null;
  private ws: WsBridge | null = null;
  private boundPort: number | null = null;
  private bindError: string | null = null;
  private busy: Promise<void> = Promise.resolve();

  constructor(opts: LanOptions) {
    this.opts = opts;
    this.configuredPort = opts.port ?? Number(process.env.LOKI_LAN_PORT ?? DEFAULT_LAN_PORT);
    this.dist = opts.appDist === undefined ? resolveAppDist() : opts.appDist;
    this.serveStatic = createStaticApp(this.dist);
    const state = readState(opts.stateFile);
    this.enabledFlag = state.enabled;
    this.viaSetting = state.via;
    this.tailscale = opts.tailscale ?? null;
    opts.devices.onSeen = () => this.opts.onChange?.("devices", this.status());
  }

  /** The persisted setting, whether or not the socket is up. */
  enabled(): boolean {
    return this.enabledFlag;
  }

  /** Synchronous: the Tailscale part is whatever the last refresh() (or the cache) said. */
  status(): LanStatus {
    const addresses = lanAddresses(this.opts.interfaces).filter((a) => !isTailnetAddress(a));
    const listening = this.server !== null;
    const tailscale = this.tailscale?.cached() ?? null;
    return {
      enabled: this.enabledFlag,
      address: addresses[0] ?? null,
      addresses,
      host: (this.opts.host ?? bonjourHost)(),
      port: this.boundPort ?? this.configuredPort,
      appServed: this.dist !== null,
      error: this.bindError ?? (listening && addresses.length === 0 ? "no network interface with an IPv4 address" : null),
      via: this.viaSetting ?? (tailscale?.running ? "tailscale" : "lan"),
      tailscale,
    };
  }

  /** Ask Tailscale again (cached inside its ttl), then status(). Broadcasts when the tailnet's answer changed. */
  async refresh(): Promise<LanStatus> {
    if (this.tailscale) {
      const next = await this.tailscale.status();
      const prev = this.lastTailscale;
      this.lastTailscale = next;
      if (prev && (prev.running !== next.running || prev.name !== next.name || prev.serveUrl !== next.serveUrl)) {
        log("lan:tailscale", { running: next.running, name: next.name, serveUrl: next.serveUrl, error: next.error });
        this.opts.onChange?.("status", this.status());
      }
    }
    return this.status();
  }

  /**
   * The QR's payload: the page redeems `code` on load (D4'). Off the Wi‑Fi first (Addendum 3): the https front
   * from `tailscale serve`, else the MagicDNS name; on the Wi‑Fi the Bonjour name, which survives a new address
   * on another network; else the address.
   */
  pairUrl(code: string): string {
    const s = this.status();
    return `${this.origin(s)}/?code=${encodeURIComponent(code)}`;
  }

  private origin(s: LanStatus): string {
    const ts = s.tailscale;
    if (s.via === "tailscale" && ts) {
      if (ts.serveUrl) return ts.serveUrl;
      if (ts.running && ts.name) return `http://${ts.name}:${s.port}`;
    }
    return `http://${s.host ?? s.address ?? "127.0.0.1"}:${s.port}`;
  }

  /** Persist first, then bind or close. Resolves with the status either way. */
  setEnabled(enabled: boolean): Promise<LanStatus> {
    this.enabledFlag = enabled;
    writeState(this.opts.stateFile, { enabled, via: this.viaSetting });
    return enabled ? this.start() : this.stop();
  }

  /** The user's route choice, persisted; every tab hears the new status. */
  setVia(via: LanVia): LanStatus {
    this.viaSetting = via;
    writeState(this.opts.stateFile, { enabled: this.enabledFlag, via });
    const status = this.status();
    this.opts.onChange?.("status", status);
    return status;
  }

  /** Turn `tailscale serve` on or off for this listener; a CLI complaint shows in status().tailscale.error. */
  async setServe(enabled: boolean): Promise<LanStatus> {
    if (!this.tailscale) return this.status();
    this.lastTailscale = await this.tailscale.setServe(enabled);
    const status = this.status();
    this.opts.onChange?.("status", status);
    return status;
  }

  /** Origins the cross-site check accepts besides the request's own Host: the tailnet name and the Bonjour name. */
  private allowedHosts(): string[] {
    const s = this.status();
    const out: string[] = [];
    const name = s.tailscale?.name;
    if (name) out.push(name, `${name}:443`, `${name}:${s.port}`);
    if (s.host) out.push(s.host, `${s.host}:${s.port}`);
    return out;
  }

  /** Bind. Failures land in status().error, never here. */
  start(): Promise<LanStatus> {
    return this.serialized(async () => {
      if (this.server) return;
      const server = createServer((req, res) => this.handle(req, res));
      try {
        await listenWithRetry(server, this.configuredPort, 3, "0.0.0.0");
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        this.bindError = `${e.code ?? "error"}: ${e.code === "EADDRINUSE" ? `port ${this.configuredPort} is already in use` : e.message}`;
        log("lan:bind-failed", { port: this.configuredPort, error: this.bindError });
        server.close();
        return;
      }
      this.server = server;
      this.bindError = null;
      this.boundPort = (server.address() as { port: number }).port;
      this.ws = attachWs(server, this.authorize, this.opts.handlers);
      log("lan:listening", { port: this.boundPort, addresses: lanAddresses(this.opts.interfaces), appDist: this.dist });
      // Phones cannot reload themselves from a menu: watch the build and tell them when it changes.
      this.announcedBuild = buildIdOf(this.dist);
      this.buildPoll = setInterval(() => this.checkBuild(), this.opts.buildPollMs ?? 5000);
      // The tailnet can come and go (sign-out, laptop lid): read it now, then once a minute.
      if (this.tailscale) {
        await this.refresh();
        this.tailscalePoll = setInterval(() => void this.refresh(), this.opts.tailscalePollMs ?? 60_000);
      }
    });
  }

  /** Announce a new canvas build to every phone (`app_build {build}`); they offer to reload. */
  checkBuild(): void {
    const build = buildIdOf(this.dist);
    if (!build || build === this.announcedBuild) return;
    this.announcedBuild = build;
    log("lan:app-build", { build });
    this.broadcast({ type: "app_build", build });
  }

  stop(): Promise<LanStatus> {
    return this.serialized(async () => {
      const server = this.server;
      if (this.buildPoll) clearInterval(this.buildPoll);
      this.buildPoll = null;
      if (this.tailscalePoll) clearInterval(this.tailscalePoll);
      this.tailscalePoll = null;
      this.ws?.close();
      this.ws = null;
      this.server = null;
      this.boundPort = null;
      this.bindError = null;
      if (server) {
        await closeServer(server);
        log("lan:closed");
      }
    });
  }

  /** Runs `fn` after any start/stop in flight, then reports the status change. */
  private async serialized(fn: () => Promise<void>): Promise<LanStatus> {
    const run = this.busy.then(fn, fn);
    this.busy = run.catch(() => {});
    await run;
    const status = this.status();
    this.opts.onChange?.("status", status);
    return status;
  }

  broadcast(msg: object, scope?: Scope): void {
    this.ws?.broadcast(msg, scope);
  }

  clientCount(): number {
    return this.ws?.clientCount() ?? 0;
  }

  /** Forget a device and close its live sockets. */
  forget(id: string): boolean {
    const gone = this.opts.devices.forget(id);
    const closed = this.ws?.closeDevice(id) ?? 0;
    if (gone || closed) log("lan:device-forgotten", { id, sockets: closed });
    return gone;
  }

  // --- auth -----------------------------------------------------------------------------------
  private readonly authorize: Authorize = (req) => {
    const token = deviceToken(req);
    if (!token || token === this.opts.desktopToken) return { ok: false };
    const device = this.opts.devices.verify(token, requestVia(req));
    return device ? { ok: true, deviceId: device.id } : { ok: false };
  };

  // --- http -----------------------------------------------------------------------------------
  private handle(req: IncomingMessage, res: ServerResponse): void {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://0.0.0.0");
    } catch {
      return void res.writeHead(400).end();
    }
    try {
      switch (url.pathname) {
        case "/health":
          return void json(res, 200, { ok: true, build: buildIdOf(this.dist), ...(this.opts.health?.() ?? {}) });
        case "/pair": {
          if (req.method !== "POST") return void json(res, 405, { error: "POST" });
          const refused = crossSite(req, this.allowedHosts());
          if (refused) return void json(res, refused.status, { error: refused.error });
          return void this.pair(req, res);
        }
        case "/me": {
          const who = this.authorize(req, url);
          const device = who.deviceId ? this.opts.devices.get(who.deviceId) : null;
          if (!device) return void json(res, 401, { error: "not paired" });
          return void json(res, 200, { deviceId: device.id, name: device.name });
        }
        case "/unpair": {
          if (req.method !== "POST") return void json(res, 405, { error: "POST" });
          const refused = crossSite(req, this.allowedHosts());
          if (refused) return void json(res, refused.status, { error: refused.error });
          const who = this.authorize(req, url);
          if (who.deviceId) {
            this.forget(who.deviceId);
            this.opts.onChange?.("devices", this.status());
          }
          return void json(res, 200, { ok: true }, { "set-cookie": clearCookie() });
        }
      }
      if (profileRoute(req, res, url, this.authorize, this.opts.profile, 401)) return;
      // The canvas build can land after the mod started (the app installs it on launch; a developer runs
      // build:app later): look again while it is missing, so phones stop seeing the 503 without a /reload.
      if (this.dist === null && this.opts.appDist === undefined) {
        const found = resolveAppDist();
        if (found) {
          this.dist = found;
          this.serveStatic = createStaticApp(found);
          log("lan:app-dist", { dist: found });
          this.opts.onChange?.("status", this.status());
        }
      }
      this.serveStatic(req, res, url);
    } catch (err) {
      log("lan:request-error", err instanceof Error ? err.message : String(err));
      if (!res.headersSent) res.writeHead(500).end();
    }
  }

  private pair(req: IncomingMessage, res: ServerResponse): void {
    const ip = req.socket.remoteAddress ?? "?";
    if (this.attempts.blocked(ip)) return void json(res, 429, { error: "too many wrong codes; wait a while" });
    void readJson(req).then((body) => {
      if (!body || typeof body.code !== "string") return json(res, 400, { error: "expected {code, name}" });
      if (!this.opts.codes.redeem(body.code)) {
        this.attempts.failed(ip);
        return json(res, 404, { error: "unknown or expired code" });
      }
      this.attempts.clear(ip);
      const name = typeof body.name === "string" && body.name.trim() ? body.name : "Phone";
      const { id, token } = this.opts.devices.mint(name);
      log("lan:paired", { id, name });
      this.opts.onChange?.("devices", this.status());
      json(res, 200, { deviceId: id, name: this.opts.devices.get(id)?.name ?? name }, { "set-cookie": setCookie(token) });
    }, () => json(res, 400, { error: "bad request body" }));
  }
}

// --- helpers ------------------------------------------------------------------------------------

/**
 * `/pair` and `/unpair` set or clear the device cookie, and a browser applies Set-Cookie even from a
 * cross-site no-cors POST. So: the body must be declared JSON (a form or text/plain post cannot be),
 * and when the browser names an Origin it must be this listener's own. Fetches from the served page
 * are same-origin; a QR-reading camera app never posts. Codes can also be guessed: see Attempts.
 * Behind `tailscale serve` the request arrives from loopback with the tailnet's Host (or it in
 * X-Forwarded-Host), so an Origin matching either, or one of `allowedHosts` (the tailnet name, the
 * Bonjour name), is also the listener's own.
 */
export function crossSite(req: IncomingMessage, allowedHosts: string[] = []): { status: number; error: string } | null {
  const type = String(req.headers["content-type"] ?? "").toLowerCase();
  if (!type.startsWith("application/json")) return { status: 415, error: "send application/json" };
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin !== "null") {
    let host: string;
    try {
      host = new URL(origin).host.toLowerCase();
    } catch {
      return { status: 403, error: "bad origin" };
    }
    const ok = new Set<string>();
    if (typeof req.headers.host === "string") ok.add(req.headers.host.toLowerCase());
    const forwarded = req.headers["x-forwarded-host"];
    for (const h of (Array.isArray(forwarded) ? forwarded : [forwarded ?? ""]).flatMap((v) => v.split(","))) if (h.trim()) ok.add(h.trim().toLowerCase());
    for (const h of allowedHosts) ok.add(h.toLowerCase());
    if (!ok.has(host)) return { status: 403, error: "cross-site request refused" };
  }
  return null;
}

/** Wrong-code counter per address. Codes have 32^6 values; ten guesses in ten minutes is plenty for a human. */
export class Attempts {
  private readonly byIp = new Map<string, { count: number; first: number; until: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  constructor(limit = 10, windowMs = 10 * 60_000, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }
  blocked(ip: string): boolean {
    const rec = this.byIp.get(ip);
    if (!rec) return false;
    if (rec.until > this.now()) return true;
    if (this.now() - rec.first > this.windowMs) this.byIp.delete(ip);
    return false;
  }
  failed(ip: string): void {
    const t = this.now();
    const rec = this.byIp.get(ip);
    if (!rec || t - rec.first > this.windowMs) {
      this.byIp.set(ip, { count: 1, first: t, until: 0 });
      return;
    }
    rec.count += 1;
    if (rec.count >= this.limit) rec.until = t + this.windowMs;
  }
  clear(ip: string): void {
    this.byIp.delete(ip);
  }
}

/**
 * Which way a request reached the listener, so Settings can say "via Tailscale" next to a phone. A peer
 * on the tailnet arrives from a 100.64.0.0/10 address; behind `tailscale serve` the proxy connects from
 * loopback and names the peer in X-Forwarded-For (and the tailnet in Host). Everything else is the Wi‑Fi.
 */
export function requestVia(req: Pick<IncomingMessage, "headers"> & { socket?: { remoteAddress?: string | null } }): DeviceVia {
  const remote = (req.socket?.remoteAddress ?? "").replace(/^::ffff:/i, "");
  if (isTailnetAddress(remote)) return "tailscale";
  const forwarded = req.headers["x-forwarded-for"];
  const peer = (Array.isArray(forwarded) ? forwarded[0] : forwarded ?? "").split(",")[0]?.trim() ?? "";
  if (isLoopback(remote) && isTailnetAddress(peer)) return "tailscale";
  const host = typeof req.headers.host === "string" ? req.headers.host.toLowerCase() : "";
  if (isLoopback(remote) && /\.ts\.net(:\d+)?$/.test(host)) return "tailscale";
  return "lan";
}

/** Tailscale hands every node an address in the CGNAT range 100.64.0.0/10 (100.64–100.127). */
export function isTailnetAddress(ip: string): boolean {
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip);
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

const isLoopback = (ip: string) => ip === "127.0.0.1" || ip === "::1";

/** Non-internal IPv4 addresses, en0 (the Mac's Wi‑Fi) first. */
export function lanAddresses(interfaces: () => ReturnType<typeof networkInterfaces> = networkInterfaces): string[] {
  let table: ReturnType<typeof networkInterfaces>;
  try {
    table = interfaces();
  } catch {
    return [];
  }
  const names = Object.keys(table).sort((a, b) => Number(b === "en0") - Number(a === "en0") || a.localeCompare(b));
  const out: string[] = [];
  for (const name of names) for (const info of table[name] ?? []) if (!info.internal && (info.family === "IPv4" || (info.family as unknown) === 4)) out.push(info.address);
  return out;
}

/**
 * The Mac's Bonjour name, `<LocalHostName>.local`, which iOS resolves on the LAN without DNS. macOS keeps it in
 * scutil; os.hostname() is the fallback (it may already carry .local, or be a DHCP-assigned name). Lower-cased:
 * mDNS is case-insensitive and lower reads better in a URL. Null when neither answers.
 */
export function bonjourHost(): string | null {
  let name: string | null = null;
  try {
    name = execFileSync("/usr/sbin/scutil", ["--get", "LocalHostName"], { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    // not macOS, or scutil unavailable
  }
  if (!name) {
    try {
      name = hostname().replace(/\.local\.?$/i, "").trim() || null;
    } catch {
      return null;
    }
  }
  if (!name || !/^[A-Za-z0-9-]+$/.test(name)) return null;
  return `${name.toLowerCase()}.local`;
}

/** The device token from the cookie or an Authorization: Bearer header; `?t=` is never read here. */
export function deviceToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === "string") {
    const m = /^Bearer\s+([A-Za-z0-9._~+/=-]+)\s*$/.exec(auth);
    if (m) return m[1];
  }
  const cookie = req.headers.cookie;
  if (typeof cookie === "string") {
    for (const part of cookie.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() === DEVICE_COOKIE) return part.slice(eq + 1).trim();
    }
  }
  return null;
}

const setCookie = (token: string) => `${DEVICE_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`;
const clearCookie = () => `${DEVICE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

function json(res: ServerResponse, status: number, body: object, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") as unknown;
        resolve(typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/** state/lan.json: `{ enabled, via? }`. Files from before Addendum 3 have no `via`: the default applies. */
interface LanState {
  enabled: boolean;
  via?: LanVia;
}

function readState(file: string): LanState {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { enabled?: unknown; via?: unknown } | null;
    return { enabled: parsed?.enabled === true, via: isLanVia(parsed?.via) ? parsed.via : undefined };
  } catch {
    return { enabled: false };
  }
}

function writeState(file: string, state: LanState): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state.via ? state : { enabled: state.enabled }, null, 2) + "\n");
    renameSync(tmp, file);
  } catch (err) {
    log("lan:state-write-failed", err instanceof Error ? err.message : String(err));
  }
}
