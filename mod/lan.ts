import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { execFileSync } from "node:child_process";
import type { Scope } from "../core/desk-core.ts";
import type { DeviceStore } from "./devices.ts";
import type { PairingCodes } from "./pairing.ts";
import { DEFAULT_LAN_PORT } from "./paths.ts";
import { attachWs, closeServer, listenWithRetry, profileRoute, type Audience, type Authorize, type WsBridge, type WsHandlers } from "./server.ts";
import { uploadRoute } from "./uploads.ts";
import { chatImageRoute } from "./chat-images.ts";
import { buildIdOf, createStaticApp, resolveAppDist, type StaticHandler } from "./static.ts";
import type { Tailscale } from "./tailscale.ts";
import type { Peers } from "./peers.ts";
import { log } from "./log.ts";
import type { DeviceVia, LanStatus, LanVia, TailscaleStatus } from "../core/frame-types.ts";
import { isLanVia } from "../core/frames.ts";
import { serialQueue } from "../core/serial.ts";
import { messageOf } from "../core/errors.ts";
import { writeJsonAtomic } from "./json-file.ts";

export type LanChange = "status" | "devices";

export interface LanOptions {
  port?: number;
  stateFile: string;
  devices: DeviceStore;
  codes: PairingCodes;
  handlers: WsHandlers;
  desktopToken?: string;
  profile?: (agentId: string) => string | null;
  uploads?: string;
  chatImages?: { dir: string; fetchRemote: (name: string) => Promise<Buffer | null> };
  appDist?: string | null;
  health?: () => object;
  onChange?: (what: LanChange, status: LanStatus) => void;
  interfaces?: () => ReturnType<typeof networkInterfaces>;
  host?: () => string | null;
  now?: () => number;
  buildPollMs?: number;
  tailscale?: Tailscale | null;
  tailscalePollMs?: number;
  peers?: Peers | null;
  via?: (req: IncomingMessage) => DeviceVia;
}

export const HOST_TTL_MS = 60_000;

export const DEVICE_COOKIE = "loki_device";
const COOKIE_MAX_AGE = 365 * 24 * 3600;
const MAX_BODY = 64 * 1024;

export class LanListener {
  private readonly opts: LanOptions;
  private readonly configuredPort: number;
  private dist: string | null;
  private serveStatic: StaticHandler;
  private enabledFlag: boolean;
  private bonjour: { at: number; name: string | null } | null = null;
  private peersNeeded = false;
  private viaSetting: LanVia | undefined;
  private readonly tailscale: Tailscale | null;
  private lastTailscale: TailscaleStatus | null = null;
  private tailscalePoll: ReturnType<typeof setInterval> | null = null;
  private readonly attempts = new Attempts();
  private server: Server | null = null;
  private announcedBuild: string | null = null;
  private buildPoll: ReturnType<typeof setInterval> | null = null;
  private ws: WsBridge | null = null;
  private boundPort: number | null = null;
  private bindError: string | null = null;
  private readonly busy = serialQueue();

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

  enabled(): boolean {
    return this.enabledFlag;
  }

  status(): LanStatus {
    const addresses = lanAddresses(this.opts.interfaces).filter((a) => !isTailnetAddress(a));
    const listening = this.server !== null;
    const tailscale = this.tailscale?.cached() ?? null;
    return {
      enabled: this.enabledFlag,
      address: addresses[0] ?? null,
      addresses,
      host: this.host(),
      port: this.boundPort ?? this.configuredPort,
      app_served: this.dist !== null,
      error: this.bindError ?? (listening && addresses.length === 0 ? "no network interface with an IPv4 address" : null),
      via: this.viaSetting ?? (tailscale?.running ? "tailscale" : "lan"),
      tailscale,
    };
  }

  private host(): string | null {
    const now = (this.opts.now ?? Date.now)();
    if (!this.bonjour || now - this.bonjour.at >= HOST_TTL_MS) this.bonjour = { at: now, name: (this.opts.host ?? bonjourHost)() };
    return this.bonjour.name;
  }

  async refresh(): Promise<LanStatus> {
    if (this.tailscale) {
      const next = await this.tailscale.status();
      const prev = this.lastTailscale;
      this.lastTailscale = next;
      if (prev && (prev.running !== next.running || prev.name !== next.name || prev.serve_url !== next.serve_url)) {
        log("lan:tailscale", { running: next.running, name: next.name, serveUrl: next.serve_url, error: next.error });
        this.opts.onChange?.("status", this.status());
      }
    }
    return this.status();
  }

  pairUrl(code: string): string {
    const s = this.status();
    return `${this.origin(s)}/?code=${encodeURIComponent(code)}`;
  }

  private origin(s: LanStatus): string {
    const ts = s.tailscale;
    if (s.via === "tailscale" && ts) {
      if (ts.serve_url) return ts.serve_url;
      if (ts.running && ts.name) return `http://${ts.name}:${s.port}`;
    }
    return `http://${s.host ?? s.address ?? "127.0.0.1"}:${s.port}`;
  }

  setEnabled(enabled: boolean): Promise<LanStatus> {
    this.enabledFlag = enabled;
    writeState(this.opts.stateFile, { enabled, via: this.viaSetting });
    if (!enabled) {
      const closed = this.ws?.closeDevices() ?? 0;
      if (closed) log("lan:phones-closed", { sockets: closed });
    }
    return enabled || this.peersNeeded ? this.start() : this.stop();
  }

  setPeersNeeded(needed: boolean): Promise<LanStatus> {
    this.peersNeeded = needed;
    return needed || this.enabledFlag ? this.start() : this.stop();
  }

  setVia(via: LanVia): LanStatus {
    this.viaSetting = via;
    writeState(this.opts.stateFile, { enabled: this.enabledFlag, via });
    const status = this.status();
    this.opts.onChange?.("status", status);
    return status;
  }

  async setServe(enabled: boolean): Promise<LanStatus> {
    if (!this.tailscale) return this.status();
    this.lastTailscale = await this.tailscale.setServe(enabled);
    const status = this.status();
    this.opts.onChange?.("status", status);
    return status;
  }

  private allowedHosts(): string[] {
    const s = this.status();
    const out: string[] = [];
    const name = s.tailscale?.name;
    if (name) out.push(name, `${name}:443`, `${name}:${s.port}`);
    if (s.host) out.push(s.host, `${s.host}:${s.port}`);
    return out;
  }

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
      // A page on another site can open a WebSocket to this address, and the phone's cookie rides along:
      // an upgrade naming a foreign Origin is refused, as /uploads is.
      this.ws = attachWs(
        server,
        (req, url) => (crossOrigin(req, this.allowedHosts()) ? { ok: false, refusal: 403 } : this.authorize(req, url)),
        this.opts.handlers,
      );
      log("lan:listening", { port: this.boundPort, addresses: lanAddresses(this.opts.interfaces), appDist: this.dist });
      this.announcedBuild = buildIdOf(this.dist);
      this.buildPoll = setInterval(() => this.checkBuild(), this.opts.buildPollMs ?? 5000);
      if (this.tailscale) {
        await this.refresh();
        this.tailscalePoll = setInterval(() => void this.refresh(), this.opts.tailscalePollMs ?? 60_000);
      }
    });
  }

  checkBuild(): void {
    if (this.clientCount() === 0) return;
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

  private async serialized(fn: () => Promise<void>): Promise<LanStatus> {
    await this.busy(fn);
    const status = this.status();
    this.opts.onChange?.("status", status);
    return status;
  }

  broadcast(msg: object, scope?: Scope, to?: Audience): void {
    this.ws?.broadcast(msg, scope, to);
  }

  clientCount(): number {
    return this.ws?.clientCount() ?? 0;
  }

  closePeer(macId: string): number {
    return this.ws?.closePeer(macId) ?? 0;
  }

  forget(id: string): boolean {
    const gone = this.opts.devices.forget(id);
    const closed = this.ws?.closeDevice(id) ?? 0;
    if (gone || closed) log("lan:device-forgotten", { id, sockets: closed });
    return gone;
  }

  private readonly authorize: Authorize = (req) => {
    const token = deviceToken(req);
    if (!token || token === this.opts.desktopToken) return { ok: false };
    const via = this.via(req);
    if (this.enabledFlag) {
      const device = this.opts.devices.verify(token, via);
      if (device) return { ok: true, deviceId: device.id };
    }
    if (via !== "tailscale") return { ok: false, refusal: this.opts.peers ? 403 : 401 };
    const mac = this.opts.peers?.verify(token);
    return mac ? { ok: true, peerId: mac } : { ok: false };
  };

  private via(req: IncomingMessage): DeviceVia {
    if (this.opts.via) return this.opts.via(req);
    return requestVia(req, this.tailscale ? tailnetAddresses(this.opts.interfaces, this.tailscale.cached().ip) : undefined);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://0.0.0.0");
    } catch {
      return void res.writeHead(400).end();
    }
    try {
      if (url.pathname.startsWith("/peer/")) return this.peerRoute(req, res, url);
      if (!this.enabledFlag && url.pathname !== "/health") return json(res, 404, { error: "not found" });
      switch (url.pathname) {
        case "/health":
          return json(res, 200, { ok: true, build: buildIdOf(this.dist), ...(this.opts.health?.() ?? {}) });
        case "/pair": {
          if (req.method !== "POST") return json(res, 405, { error: "POST" });
          const refused = crossSite(req, this.allowedHosts());
          if (refused) return json(res, refused.status, { error: refused.error });
          return this.pair(req, res);
        }
        case "/me": {
          const who = this.authorize(req, url);
          const device = who.deviceId ? this.opts.devices.get(who.deviceId) : null;
          if (!device) return json(res, 401, { error: "not paired" });
          return json(res, 200, { device_id: device.id, name: device.name });
        }
        case "/unpair": {
          if (req.method !== "POST") return json(res, 405, { error: "POST" });
          const refused = crossSite(req, this.allowedHosts());
          if (refused) return json(res, refused.status, { error: refused.error });
          const who = this.authorize(req, url);
          if (who.deviceId) {
            this.forget(who.deviceId);
            this.opts.onChange?.("devices", this.status());
          }
          return json(res, 200, { ok: true }, { "set-cookie": clearCookie() });
        }
      }
      if (profileRoute(req, res, url, this.authorize, this.opts.profile, 401)) return;
      const images = this.opts.chatImages;
      if (
        images &&
        chatImageRoute({ prefix: "/chat-images/", dir: images.dir, authorize: this.authorize, denied: 401, fetchRemote: images.fetchRemote })(req, res, url)
      )
        return;
      if (
        this.opts.uploads &&
        uploadRoute(req, res, url, { authorize: this.authorize, dir: this.opts.uploads, denied: 401, guard: (r) => crossOrigin(r, this.allowedHosts()) })
      )
        return;
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
      log("lan:request-error", messageOf(err));
      if (!res.headersSent) res.writeHead(500).end();
    }
  }

  private peerRoute(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const peers = this.opts.peers;
    if (!peers) return json(res, 404, { error: "not found" });
    if (this.via(req) !== "tailscale") return json(res, 403, { error: "Macs pair over Tailscale only" });
    const bearer = () => {
      const token = deviceToken(req);
      return token && token !== this.opts.desktopToken ? peers.verify(token) : null;
    };
    const images = this.opts.chatImages;
    if (images && chatImageRoute({ prefix: "/peer/chat-images/", dir: images.dir, authorize: () => ({ ok: !!bearer() }), denied: 401 })(req, res, url)) return;
    switch (url.pathname) {
      case "/peer/pair": {
        if (req.method !== "POST") return json(res, 405, { error: "POST" });
        const ip = req.socket.remoteAddress ?? "?";
        if (this.attempts.blocked(ip)) return json(res, 429, { error: "too many wrong codes; wait a while" });
        if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return json(res, 415, { error: "send application/json" });
        void readJson(req)
          .then((body) => (this.attempts.blocked(ip) ? { status: 429, body: { error: "too many wrong codes; wait a while" } } : peers.accept(body)))
          .then(
            (answer) => {
              if (answer.status === 404) this.attempts.failed(ip);
              else if (answer.status === 200) this.attempts.clear(ip);
              json(res, answer.status, answer.body);
            },
            () => json(res, 400, { error: "bad request body" }),
          );
        return;
      }
      case "/peer/hello": {
        if (!bearer()) return json(res, 401, { error: "not paired" });
        return json(res, 200, peers.hello());
      }
      case "/peer/uploads": {
        if (!this.opts.uploads) return json(res, 404, { error: "not found" });
        const peerAuth: Authorize = () => ({ ok: !!bearer() });
        uploadRoute(req, res, new URL(`/uploads${url.search}`, "http://0.0.0.0"), { authorize: peerAuth, dir: this.opts.uploads, denied: 401 });
        return;
      }
      case "/peer/unpair": {
        if (req.method !== "POST") return json(res, 405, { error: "POST" });
        const mac = bearer();
        if (!mac) return json(res, 401, { error: "not paired" });
        const answer = peers.forgotBy(mac);
        return json(res, answer.status, answer.body);
      }
    }
    json(res, 404, { error: "not found" });
  }

  private pair(req: IncomingMessage, res: ServerResponse): void {
    const ip = req.socket.remoteAddress ?? "?";
    if (this.attempts.blocked(ip)) return json(res, 429, { error: "too many wrong codes; wait a while" });
    void readJson(req).then(
      (body) => {
        if (this.attempts.blocked(ip)) return json(res, 429, { error: "too many wrong codes; wait a while" });
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
        json(res, 200, { device_id: id, name: this.opts.devices.get(id)?.name ?? name }, { "set-cookie": setCookie(token) });
      },
      () => json(res, 400, { error: "bad request body" }),
    );
  }
}

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
  const type = (req.headers["content-type"] ?? "").toLowerCase();
  if (!type.startsWith("application/json")) return { status: 415, error: "send application/json" };
  return crossOrigin(req, allowedHosts);
}

/** A request from a page on another site (its Origin names another host): refused, since the cookie would ride along. */
export function crossOrigin(req: IncomingMessage, allowedHosts: string[] = []): { status: number; error: string } | null {
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
 *
 * The 100.x range is not Tailscale's alone: a carrier or a Wi‑Fi may hand out the same addresses. So when the caller
 * knows this Mac's tailnet addresses (`tailnetIps`, from tailnetAddresses; empty for "not on a tailnet"), a 100.x
 * peer counts only if it reached one of them, which only the tailnet's interface has. Left out, the peer's address
 * alone decides.
 */
export function requestVia(
  req: Pick<IncomingMessage, "headers"> & { socket?: { remoteAddress?: string | null; localAddress?: string | null } },
  tailnetIps?: readonly string[],
): DeviceVia {
  const remote = (req.socket?.remoteAddress ?? "").replace(/^::ffff:/i, "");
  if (isTailnetAddress(remote)) {
    if (tailnetIps === undefined) return "tailscale";
    return tailnetIps.includes((req.socket?.localAddress ?? "").replace(/^::ffff:/i, "")) ? "tailscale" : "lan";
  }
  const forwarded = req.headers["x-forwarded-for"];
  const peer = (Array.isArray(forwarded) ? forwarded[0] : (forwarded ?? "")).split(",")[0]?.trim() ?? "";
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

/** An interface Tailscale names after itself: `tailscale0` on Linux, `Tailscale` on Windows. */
const TAILSCALE_NAMED = /^tailscale\d*$/i;
/** A tunnel on the Mac. Every VPN's is a `utun`, so a name alone does not say whose it is. */
const MAC_TUNNEL = /^utun\d+$/i;
/** Tailscale's own IPv6 prefix, fd7a:115c:a1e0::/48, which its tunnel always holds beside its 100.x address. */
const TAILSCALE_ULA = /^fd7a:115c:a1e0:/i;

/**
 * This machine's tailnet addresses: the 100.64/10 addresses Tailscale's interface holds, and the address the CLI last
 * reported (`cliIp`, null when it has not answered). On the Mac, Tailscale's `utun` is the one that also holds an
 * address in Tailscale's IPv6 prefix; another VPN's tunnel (WARP, NetBird) and a Wi‑Fi's 100.x address from a
 * carrier's NAT are not.
 */
export function tailnetAddresses(interfaces: () => ReturnType<typeof networkInterfaces> = networkInterfaces, cliIp: string | null = null): string[] {
  const out = new Set<string>(cliIp ? [cliIp] : []);
  let table: ReturnType<typeof networkInterfaces>;
  try {
    table = interfaces();
  } catch {
    return [...out];
  }
  for (const [name, infos = []] of Object.entries(table)) {
    const tailscales = TAILSCALE_NAMED.test(name) || (MAC_TUNNEL.test(name) && infos.some((info) => TAILSCALE_ULA.test(info.address)));
    if (tailscales) for (const info of infos) if (!info.internal && isTailnetAddress(info.address)) out.add(info.address);
  }
  return [...out];
}

const isLoopback = (ip: string) => ip === "127.0.0.1" || ip === "::1";

export function lanAddresses(interfaces: () => ReturnType<typeof networkInterfaces> = networkInterfaces): string[] {
  let table: ReturnType<typeof networkInterfaces>;
  try {
    table = interfaces();
  } catch {
    return [];
  }
  const names = Object.keys(table).sort((a, b) => Number(b === "en0") - Number(a === "en0") || a.localeCompare(b));
  const out: string[] = [];
  for (const name of names)
    for (const info of table[name] ?? []) if (!info.internal && (info.family === "IPv4" || (info.family as unknown) === 4)) out.push(info.address);
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
    name =
      execFileSync("/usr/sbin/scutil", ["--get", "LocalHostName"], { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {}
  if (!name) {
    try {
      name =
        hostname()
          .replace(/\.local\.?$/i, "")
          .trim() || null;
    } catch {
      return null;
    }
  }
  if (!name || !/^[A-Za-z0-9-]+$/.test(name)) return null;
  return `${name.toLowerCase()}.local`;
}

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
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on("error", reject);
  });
}

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
    writeJsonAtomic(file, state.via ? state : { enabled: state.enabled }, { pretty: true, newline: true, pidTemp: true });
  } catch (err) {
    log("lan:state-write-failed", messageOf(err));
  }
}
