import { WebSocket } from "./ws.ts";
import { log } from "./log.ts";
import { hostWithPort } from "./peers.ts";

/**
 * The peer link (plan 023, U2, KTD1): one socket from this Mac to each paired Mac's /ws, opened with the token that
 * Mac minted for this one. Over it this Mac asks (a request answered by its `request_id`) and hears (the other Mac's
 * pushes). It reconnects with the shell's backoff, one second doubling to thirty, and says at every change whether
 * the other Mac is reachable, out of reach, or on another peer protocol (paired, but nothing is asked of it).
 */

/** Where a link stands: opening, open and speaking this Mac's protocol, closed, or open but on another protocol. */
export type LinkStatus = "connecting" | "reachable" | "unreachable" | "outdated";

/** What a link is built from; the backoff and timeouts are shortened in tests. */
export interface PeerLinkOptions {
  macId: string;
  /** The other Mac's /ws URL, or null when its address is unknown. */
  url: () => string | null;
  /** The token the other Mac minted for this one, from the keychain. */
  token: () => Promise<string | null>;
  /** This Mac's peer protocol: the other Mac's answer to `peer_ping` must match it. */
  protocol: number;
  onStatus?: (status: LinkStatus) => void;
  /** A push from the other Mac. */
  onPush?: (frame: Record<string, unknown>) => void;
  /** The other Mac refused this one's token: it may have forgotten this Mac. */
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

/** One paired Mac's link. `start` opens it and keeps it open; `stop` closes it for good. */
export class PeerLink {
  private readonly opts: PeerLinkOptions;
  private ws: WebSocket | null = null;
  private current: LinkStatus = "connecting";
  private stopped = true;
  private backoff: number;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private nextId = 0;
  private readonly waiting = new Map<string, Waiting>();

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
    void this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.ws?.terminate();
    this.ws = null;
    this.failAll("the link to that Mac was closed");
  }

  /**
   * Ask the other Mac: resolves with its reply frame, or rejects with a message for the person when it is out of
   * reach, on another protocol, slow, or answers `error`.
   */
  request(frame: { type: string } & Record<string, unknown>, timeoutMs = this.opts.requestTimeoutMs ?? 15_000): Promise<Record<string, unknown>> {
    return this.ask(frame, timeoutMs, this.current === "reachable");
  }

  /** Tell the other Mac something that has no reply (a send); false when it cannot be told now. */
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

  private async open(): Promise<void> {
    const url = this.opts.url();
    const token = await this.opts.token();
    if (this.stopped) return;
    if (!url || !token) return this.closed();
    this.setStatus("connecting");
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` }, handshakeTimeout: 8000 });
    this.ws = ws;
    ws.on("unexpected-response", (_req, res) => {
      if (res.statusCode === 401) this.opts.onRefused?.();
      ws.terminate();
    });
    ws.on("error", () => {}); // a close follows; the error itself says nothing the status does not
    ws.on("open", () => {
      void this.ask({ type: "peer_ping" }, 8000, true).then(
        (pong) => {
          if (this.ws !== ws) return;
          this.backoff = this.opts.minBackoffMs ?? 1000;
          this.setStatus(pong.protocol === this.opts.protocol ? "reachable" : "outdated");
        },
        () => ws.terminate(),
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
      void this.open();
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

  private setStatus(status: LinkStatus): void {
    if (status === this.current) return;
    this.current = status;
    log("peers:link", { mac: this.opts.macId, status });
    this.opts.onStatus?.(status);
  }
}

/** What PeerLinks needs to know about each paired Mac. */
export interface LinkTarget {
  mac_id: string;
  host: string;
}

/** A paired Mac's error answer to a request, with the frame it sent: a redirect carries `moved_to` (addendum B3). */
export class PeerRefusal extends Error {
  readonly frame: Record<string, unknown>;
  constructor(frame: Record<string, unknown>) {
    super(typeof frame.message === "string" ? frame.message : "that Mac refused");
    this.frame = frame;
  }
}

/** What PeerLinks builds each link with, beyond the Mac it links to. */
export type LinkDefaults = Omit<PeerLinkOptions, "macId" | "url" | "token" | "onStatus" | "onPush" | "onRefused">;

/**
 * Every paired Mac's link, kept in step with the paired Macs: a link opens for a Mac paired, and closes for one
 * forgotten. Pushes and status changes come out tagged with the Mac they came from.
 */
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

  /** Open links to Macs newly paired (or moved to a new address), close links to Macs forgotten. */
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
        url: () => `ws://${hostWithPort(host)}/ws`,
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

  /** Whether the link to a Mac is open and speaking this Mac's protocol. */
  reachable(macId: string): boolean {
    return this.get(macId)?.status === "reachable";
  }

  stop(): void {
    for (const { link } of this.links.values()) link.stop();
    this.links.clear();
  }
}
