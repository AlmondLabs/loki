import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.ts";

/**
 * Tailscale, detected and read, never installed (plan Addendum 3). The phone listener asks this for
 * the tailnet's view of the Mac: is the daemon running, what MagicDNS name and 100.x address does it
 * have, and is `tailscale serve` fronting the listener with https. Everything comes from the CLI
 * (`tailscale status --json`, `tailscale serve status --json`), is cached for a few seconds, and never
 * throws: a missing binary, a stopped daemon or a CLI error all land in the returned status. Funnel
 * (public exposure) is never touched.
 */
export interface TailscaleStatus {
  /** A CLI binary was found. False → say how to install it. */
  installed: boolean;
  /** BackendState === "Running": the Mac is on the tailnet right now. */
  running: boolean;
  /** The 100.x address, or null. */
  ip: string | null;
  /** The MagicDNS name, lower-cased, no trailing dot: `deepaks-macbook-pro.tail1234.ts.net`. */
  name: string | null;
  /** `https://<name>` when `tailscale serve` proxies 443 to the listener; else null. */
  serveUrl: string | null;
  /** The CLI's complaint (trimmed, ≤ 400 chars), or null when all is well. */
  error: string | null;
}

export type TailscaleExec = (bin: string, args: string[], timeoutMs?: number) => Promise<string>;

export interface TailscaleOptions {
  /** The CLI path. undefined → findTailscale(); null → treat as not installed (tests). */
  bin?: string | null;
  /** The listener's port: what `serve` proxies to and what serveUrl must match. */
  port: number;
  /** Run the CLI; default execFile. Tests inject recorded output. */
  exec?: TailscaleExec;
  /** How long a status is trusted (default 10 s). */
  ttlMs?: number;
}

const STATUS_TIMEOUT = 3000;
const SERVE_TIMEOUT = 15_000;
const MAX_ERROR = 400;

/** First existing of LOKI_TAILSCALE_BIN, the app bundle's CLI, Homebrew, /usr/local, then PATH. */
export function findTailscale(): string | null {
  const onPath = (process.env.PATH ?? "").split(":").filter(Boolean).map((d) => join(d, "tailscale"));
  const candidates = [process.env.LOKI_TAILSCALE_BIN, "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale", ...onPath].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** `tailscale status --json` → running, the first IPv4 in Self.TailscaleIPs, Self.DNSName without the dot. */
export function parseStatus(json: string): { running: boolean; ip: string | null; name: string | null } {
  const none = { running: false, ip: null, name: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return none;
  }
  if (typeof parsed !== "object" || parsed === null) return none;
  const root = parsed as { BackendState?: unknown; Self?: { TailscaleIPs?: unknown; DNSName?: unknown } | null };
  const self = typeof root.Self === "object" && root.Self !== null ? root.Self : {};
  const ips = Array.isArray(self.TailscaleIPs) ? (self.TailscaleIPs as unknown[]).filter((x): x is string => typeof x === "string") : [];
  return {
    running: root.BackendState === "Running",
    ip: ips.find((x) => /^\d{1,3}(\.\d{1,3}){3}$/.test(x)) ?? null,
    name: dnsName(self.DNSName),
  };
}

/**
 * `tailscale serve status --json` (the ServeConfig) → `https://<name>` when `Web["<name>:443"]` has a `/`
 * handler proxying to loopback on `port` (any port when omitted). The `TCP["443"].HTTPS` entry that
 * accompanies it in real output is not required: the Web handler is the proof.
 */
export function parseServeStatus(json: string, name: string | null, port?: number): string | null {
  if (!name) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const web = (parsed as { Web?: unknown }).Web;
  if (typeof web !== "object" || web === null) return null;
  const want = `${name.toLowerCase()}:443`;
  for (const [key, site] of Object.entries(web as Record<string, unknown>)) {
    if (key.toLowerCase() !== want || typeof site !== "object" || site === null) continue;
    const handlers = (site as { Handlers?: unknown }).Handlers;
    if (typeof handlers !== "object" || handlers === null) continue;
    const root = (handlers as Record<string, unknown>)["/"];
    if (typeof root !== "object" || root === null) continue;
    const proxy = (root as { Proxy?: unknown }).Proxy;
    if (typeof proxy !== "string") continue;
    let target: URL;
    try {
      target = new URL(proxy);
    } catch {
      continue;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") continue;
    if (target.hostname !== "127.0.0.1" && target.hostname !== "localhost" && target.hostname !== "[::1]") continue;
    const targetPort = Number(target.port || (target.protocol === "https:" ? 443 : 80));
    if (port !== undefined && targetPort !== port) continue;
    return `https://${name.toLowerCase()}`;
  }
  return null;
}

function dnsName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const n = v.trim().replace(/\.$/, "").toLowerCase();
  return n || null;
}

const defaultExec: TailscaleExec = (bin, args, timeoutMs = STATUS_TIMEOUT) =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: process.env }, (err, stdout, stderr) => {
      if (err) {
        const said = `${String(stderr ?? "")}\n${String(stdout ?? "")}`.trim();
        return reject(new Error(said || err.message));
      }
      resolve(String(stdout));
    });
  });

export class Tailscale {
  private readonly port: number;
  private readonly exec: TailscaleExec;
  private readonly ttlMs: number;
  private readonly givenBin: string | null | undefined;
  private bin: string | null;
  private last: TailscaleStatus | null = null;
  private lastAt = 0;
  private inflight: Promise<TailscaleStatus> | null = null;

  constructor(opts: TailscaleOptions) {
    this.port = opts.port;
    this.exec = opts.exec ?? defaultExec;
    this.ttlMs = opts.ttlMs ?? 10_000;
    this.givenBin = opts.bin;
    this.bin = opts.bin === undefined ? findTailscale() : opts.bin;
  }

  /** The last status without asking the CLI; before the first status() an "unknown" with `installed` filled in. */
  cached(): TailscaleStatus {
    return this.last ?? { installed: this.bin !== null, running: false, ip: null, name: null, serveUrl: null, error: null };
  }

  /** Ask the CLI (or the cache, inside ttlMs). Never rejects. */
  status(): Promise<TailscaleStatus> {
    if (this.last && Date.now() - this.lastAt < this.ttlMs) return Promise.resolve(this.last);
    if (this.inflight) return this.inflight;
    this.inflight = this.read().then((s) => {
      this.last = s;
      this.lastAt = Date.now();
      this.inflight = null;
      return s;
    });
    return this.inflight;
  }

  /** Forget the cache: the next status() asks again. */
  invalidate(): void {
    this.last = null;
    this.lastAt = 0;
  }

  /**
   * `tailscale serve --bg --https=443 http://127.0.0.1:<port>`, or `serve --https=443 off`. The CLI's
   * complaint (not signed in, HTTPS not enabled on the tailnet, 443 taken …) comes back in `error`.
   */
  async setServe(enabled: boolean): Promise<TailscaleStatus> {
    this.invalidate();
    if (!this.bin) this.bin = this.givenBin === undefined ? findTailscale() : this.givenBin;
    if (!this.bin) return { ...this.cached(), error: "Tailscale is not installed" };
    const args = enabled ? ["serve", "--bg", "--https=443", `http://127.0.0.1:${this.port}`] : ["serve", "--https=443", "off"];
    let failure: string | null = null;
    try {
      await this.exec(this.bin, args, SERVE_TIMEOUT);
      log("tailscale:serve", { enabled, port: this.port });
    } catch (err) {
      failure = clip(err);
      log("tailscale:serve-failed", { enabled, error: failure });
    }
    const status = await this.status();
    return failure ? { ...status, error: failure } : status;
  }

  private async read(): Promise<TailscaleStatus> {
    if (!this.bin && this.givenBin === undefined) this.bin = findTailscale(); // installed since we last looked
    const bin = this.bin;
    if (!bin) return { installed: false, running: false, ip: null, name: null, serveUrl: null, error: null };
    let running = false;
    let ip: string | null = null;
    let name: string | null = null;
    try {
      ({ running, ip, name } = parseStatus(await this.exec(bin, ["status", "--json"], STATUS_TIMEOUT)));
    } catch (err) {
      return { installed: true, running: false, ip: null, name: null, serveUrl: null, error: clip(err) };
    }
    let serveUrl: string | null = null;
    let error: string | null = null;
    if (running) {
      try {
        serveUrl = parseServeStatus(await this.exec(bin, ["serve", "status", "--json"], STATUS_TIMEOUT), name, this.port);
      } catch (err) {
        error = clip(err);
      }
    }
    return { installed: true, running, ip, name, serveUrl, error };
  }
}

function clip(err: unknown): string {
  const text = (err instanceof Error ? err.message : String(err)).trim();
  return text.length > MAX_ERROR ? text.slice(0, MAX_ERROR) : text || "tailscale failed";
}
