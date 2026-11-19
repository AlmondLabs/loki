import { WebSocket } from "./ws.ts";
import { log } from "./log.ts";
import { peerBase } from "./peers.ts";
import { messageOf } from "../core/errors.ts";

export type LinkStatus = "connecting" | "reachable" | "unreachable" | "outdated";

export interface PeerLinkOptions {
  macId: string;
  url: () => string | null;
  token: () => Promise<string | null>;
  protocol: number;
  onStatus?: (status: LinkStatus) => void;
  onPush?: (frame: Record<string, unknown>) => void;
  onRefused?: () => void;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  requestTimeoutMs?: number;
}

interface Waiting {
  resolve: (frame: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PeerLink {
  private readonly opts: PeerLinkOptions;
  private ws: WebSocket | null = null;
  private current: LinkStatus = "connecting";
  private stopped = true;
  private backoff: number;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private nextId = 0;
  private readonly waiting = new Map<string, Waiting>();
  private lastFailure: string | null = null;

  constructor(opts: PeerLinkOptions) {
    this.opts = opts;
    this.backoff = opts.minBackoffMs ?? 1000;
  }

  get status(): LinkStatus {
    return this.current;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.ws?.terminate();
    this.ws = null;
    this.failAll("the link to that Mac was closed");
  }

  request(frame: { type: string } & Record<string, unknown>, timeoutMs = this.opts.requestTimeoutMs ?? 15_000): Promise<Record<string, unknown>> {
    return this.ask(frame, timeoutMs, this.current === "reachable");
  }

  send(frame: { type: string } & Record<string, unknown>): boolean {
    const ws = this.ws;
    if (this.current !== "reachable" || ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(frame));
    return true;
  }

  private ask(frame: { type: string } & Record<string, unknown>, timeoutMs: number, allowed: boolean): Promise<Record<string, unknown>> {
    const ws = this.ws;
    if (!allowed || ws?.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new Error(this.current === "outdated" ? "that Mac runs another loki version: update loki on both Macs" : "that Mac is out of reach"),
      );
    }
    const id = `peer-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error("that Mac did not answer in time"));
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ ...frame, request_id: id }));
    });
  }

  private open(): void {
    this.connect().catch((err: unknown) => {
      this.failed(messageOf(err));
      if (!this.stopped) this.closed();
    });
  }

  private async connect(): Promise<void> {
    const url = this.opts.url();
    const token = await this.opts.token();
    if (this.stopped) return;
    if (!url || !token) {
      this.failed(!url ? "no address for that Mac" : "no token for that Mac in the keychain: pair the two Macs again");
      return this.closed();
    }
    if (this.current !== "unreachable") this.setStatus("connecting");
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` }, handshakeTimeout: 8000 });
    this.ws = ws;
    // The first reason this attempt fails is its reason: the socket's own "closed before it opened" follows a refusal.
    let said = false;
    const fail = (reason: string) => {
      if (said) return;
      said = true;
      this.failed(reason);
    };
    ws.on("unexpected-response", (_req, res) => {
      const status = res.statusCode ?? 0;
      fail(`that Mac answered ${status}${REFUSALS.get(status) ?? ""}`);
      if (status === 401) this.opts.onRefused?.();
      ws.terminate();
    });
    // A close follows, which retries; the error is only the reason (a timeout, a refused or unreachable address).
    ws.on("error", (err) => fail(messageOf(err)));
    ws.on("open", () => {
      void this.ask({ type: "peer_ping" }, 8000, true).then(
        (pong) => {
          if (this.ws !== ws) return;
          this.backoff = this.opts.minBackoffMs ?? 1000;
          this.setStatus(pong.protocol === this.opts.protocol ? "reachable" : "outdated");
        },
        (err: unknown) => {
          fail(`that Mac did not answer its first ping: ${messageOf(err)}`);
          ws.terminate();
        },
      );
    });
    ws.on("message", (raw) => this.message(raw));
    ws.on("close", () => {
      if (this.ws === ws) this.closed();
    });
  }

  private message(raw: WebSocket.RawData): void {
    let frame: unknown;
    try {
      frame = JSON.parse((Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer)).toString("utf8"));
    } catch {
      return;
    }
    if (typeof frame !== "object" || frame === null) return;
    const f = frame as Record<string, unknown>;
    const waiting = typeof f.request_id === "string" ? this.waiting.get(f.request_id) : undefined;
    if (waiting && typeof f.request_id === "string") {
      this.waiting.delete(f.request_id);
      clearTimeout(waiting.timer);
      if (f.type === "error") waiting.reject(new PeerRefusal(f));
      else waiting.resolve(f);
      return;
    }
    this.opts.onPush?.(f);
  }

  private closed(): void {
    this.ws = null;
    this.failAll("that Mac went out of reach");
    this.setStatus("unreachable");
    if (this.stopped) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs ?? 30_000);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.open();
    }, wait);
    this.retry.unref();
  }

  private failAll(message: string): void {
    for (const [id, w] of this.waiting) {
      clearTimeout(w.timer);
      w.reject(new Error(message));
      this.waiting.delete(id);
    }
  }

  /**
   * Log why the link failed, unless that is the reason last logged. A link stopped on purpose (its Mac forgotten, the
   * mod reloading) did not fail: closing its socket mid-handshake says so as an error, which is not logged.
   */
  private failed(reason: string): void {
    if (this.stopped || reason === this.lastFailure) return;
    this.lastFailure = reason;
    log("peers:link_failed", { mac: this.opts.macId, reason });
  }

  private setStatus(status: LinkStatus): void {
    if (status === "reachable") this.lastFailure = null;
    if (status === this.current) return;
    this.current = status;
    log("peers:link", { mac: this.opts.macId, status });
    try {
      this.opts.onStatus?.(status);
    } catch (err) {
      log("peers:status_listener_failed", { mac: this.opts.macId, status, reason: messageOf(err) });
    }
  }
}

const REFUSALS = new Map<number, string>([
  [401, ": it does not know this Mac's token"],
  [403, ": it took this Mac for a caller off the tailnet"],
]);

export interface LinkTarget {
  mac_id: string;
  host: string;
}

export class PeerRefusal extends Error {
  readonly frame: Record<string, unknown>;
  constructor(frame: Record<string, unknown>) {
    super(typeof frame.message === "string" ? frame.message : "that Mac refused");
    this.frame = frame;
  }
}

export type LinkDefaults = Omit<PeerLinkOptions, "macId" | "url" | "token" | "onStatus" | "onPush" | "onRefused">;

export class PeerLinks {
  private readonly links = new Map<string, { link: PeerLink; host: string }>();
  private readonly opts: {
    token: (macId: string) => Promise<string | null>;
    defaults: LinkDefaults;
    onStatus?: (macId: string, status: LinkStatus) => void;
    onPush?: (macId: string, frame: Record<string, unknown>) => void;
    onRefused?: (macId: string) => void;
  };

  constructor(opts: PeerLinks["opts"]) {
    this.opts = opts;
  }

  sync(targets: LinkTarget[]): void {
    const wanted = new Map(targets.map((t) => [t.mac_id, t.host]));
    for (const [macId, entry] of this.links) {
      if (wanted.get(macId) === entry.host) continue;
      entry.link.stop();
      this.links.delete(macId);
    }
    for (const [macId, host] of wanted) {
      if (this.links.has(macId)) continue;
      const link = new PeerLink({
        ...this.opts.defaults,
        macId,
        url: () => {
          const base = peerBase(host);
          return base ? `${base.replace(/^http:/, "ws:")}/ws` : null;
        },
        token: () => this.opts.token(macId),
        onStatus: (status) => this.opts.onStatus?.(macId, status),
        onPush: (frame) => this.opts.onPush?.(macId, frame),
        onRefused: () => this.opts.onRefused?.(macId),
      });
      this.links.set(macId, { link, host });
      link.start();
    }
  }

  get(macId: string): PeerLink | null {
    return this.links.get(macId)?.link ?? null;
  }

  reachable(macId: string): boolean {
    return this.get(macId)?.status === "reachable";
  }

  stop(): void {
    for (const { link } of this.links.values()) link.stop();
    this.links.clear();
  }
}
