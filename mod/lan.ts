import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname } from "node:path";
import type { Scope } from "../packages/core/src/desk-core.ts";
import type { DeviceStore } from "./devices.ts";
import type { PairingCodes } from "./pairing.ts";
import { DEFAULT_LAN_PORT } from "./paths.ts";
import { attachWs, closeServer, listenWithRetry, profileRoute, type Authorize, type WsBridge, type WsHandlers } from "./server.ts";
import { createStaticApp, resolveAppDist, type StaticHandler } from "./static.ts";
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
  addresses: string[];
  port: number;
  /** A built canvas was found to serve. */
  appServed: boolean;
  /** A bind error (EADDRINUSE …) or a missing network; null when all is well. */
  error: string | null;
}

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
}

export const DEVICE_COOKIE = "loki_device";
const COOKIE_MAX_AGE = 365 * 24 * 3600;
const MAX_BODY = 64 * 1024;

export class LanListener {
  private readonly opts: LanOptions;
  private readonly configuredPort: number;
  private readonly dist: string | null;
  private readonly serveStatic: StaticHandler;
  private enabledFlag: boolean;
  private server: Server | null = null;
  private ws: WsBridge | null = null;
  private boundPort: number | null = null;
  private bindError: string | null = null;
  private busy: Promise<void> = Promise.resolve();

  constructor(opts: LanOptions) {
    this.opts = opts;
    this.configuredPort = opts.port ?? Number(process.env.LOKI_LAN_PORT ?? DEFAULT_LAN_PORT);
    this.dist = opts.appDist === undefined ? resolveAppDist() : opts.appDist;
    this.serveStatic = createStaticApp(this.dist);
    this.enabledFlag = readEnabled(opts.stateFile);
    opts.devices.onSeen = () => this.opts.onChange?.("devices", this.status());
  }

  /** The persisted setting, whether or not the socket is up. */
  enabled(): boolean {
    return this.enabledFlag;
  }

  status(): LanStatus {
    const addresses = lanAddresses(this.opts.interfaces);
    const listening = this.server !== null;
    return {
      enabled: this.enabledFlag,
      address: addresses[0] ?? null,
      addresses,
      port: this.boundPort ?? this.configuredPort,
      appServed: this.dist !== null,
      error: this.bindError ?? (listening && addresses.length === 0 ? "no network interface with an IPv4 address" : null),
    };
  }

  /** The QR's payload: the page redeems `code` on load (D4'). */
  pairUrl(code: string): string {
    const s = this.status();
    return `http://${s.address ?? "127.0.0.1"}:${s.port}/?code=${encodeURIComponent(code)}`;
  }

  /** Persist first, then bind or close. Resolves with the status either way. */
  setEnabled(enabled: boolean): Promise<LanStatus> {
    this.enabledFlag = enabled;
    writeEnabled(this.opts.stateFile, enabled);
    return enabled ? this.start() : this.stop();
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
    });
  }

  stop(): Promise<LanStatus> {
    return this.serialized(async () => {
      const server = this.server;
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
    const device = this.opts.devices.verify(token);
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
          return void json(res, 200, { ok: true, ...(this.opts.health?.() ?? {}) });
        case "/pair":
          if (req.method !== "POST") return void json(res, 405, { error: "POST" });
          return void this.pair(req, res);
        case "/me": {
          const who = this.authorize(req, url);
          const device = who.deviceId ? this.opts.devices.get(who.deviceId) : null;
          if (!device) return void json(res, 401, { error: "not paired" });
          return void json(res, 200, { deviceId: device.id, name: device.name });
        }
        case "/unpair": {
          if (req.method !== "POST") return void json(res, 405, { error: "POST" });
          const who = this.authorize(req, url);
          if (who.deviceId) {
            this.forget(who.deviceId);
            this.opts.onChange?.("devices", this.status());
          }
          return void json(res, 200, { ok: true }, { "set-cookie": clearCookie() });
        }
      }
      if (profileRoute(req, res, url, this.authorize, this.opts.profile, 401)) return;
      this.serveStatic(req, res, url);
    } catch (err) {
      log("lan:request-error", err instanceof Error ? err.message : String(err));
      if (!res.headersSent) res.writeHead(500).end();
    }
  }

  private pair(req: IncomingMessage, res: ServerResponse): void {
    void readJson(req).then((body) => {
      if (!body || typeof body.code !== "string") return json(res, 400, { error: "expected {code, name}" });
      if (!this.opts.codes.redeem(body.code)) return json(res, 404, { error: "unknown or expired code" });
      const name = typeof body.name === "string" && body.name.trim() ? body.name : "Phone";
      const { id, token } = this.opts.devices.mint(name);
      log("lan:paired", { id, name });
      this.opts.onChange?.("devices", this.status());
      json(res, 200, { deviceId: id, name: this.opts.devices.get(id)?.name ?? name }, { "set-cookie": setCookie(token) });
    }, () => json(res, 400, { error: "bad request body" }));
  }
}

// --- helpers ------------------------------------------------------------------------------------

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

function readEnabled(file: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { enabled?: unknown };
    return parsed?.enabled === true;
  } catch {
    return false;
  }
}

function writeEnabled(file: string, enabled: boolean): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ enabled }, null, 2) + "\n");
    renameSync(tmp, file);
  } catch (err) {
    log("lan:state-write-failed", err instanceof Error ? err.message : String(err));
  }
}
