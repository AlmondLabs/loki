import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { log } from "./log.ts";

/**
 * Letta's harness hosts an "app-server": one WebSocket speaking a documented
 * JSON protocol (runtime_start, input, stream_delta, update_loop_status…).
 * A client subscribed to {agent, conversation} sees every turn on it, however
 * it was started, token by token. This is what lets the canvas mirror the
 * shared transcript live. Docs: https://docs.letta.com/platform/app-server
 */

export interface Runtime {
  agent_id: string;
  conversation_id: string;
}

export type AppServerEvent = Record<string, unknown> & { type: string; runtime?: Runtime };
export type EventListener = (event: AppServerEvent) => void;

export interface AppServerInfo {
  protocol_version: number;
  backend: string;
  letta_code_version?: string;
  capabilities?: Record<string, boolean>;
}

const PROBE_TIMEOUT_MS = 1500;

/** Ask a candidate URL for app_server_info; null if it is not an app-server. */
export function probeAppServer(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<AppServerInfo | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: AppServerInfo | null) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve(v);
    };
    const t = setTimeout(() => finish(null), timeoutMs);
    const ws = new WebSocket(url);
    ws.on("open", () => ws.send(JSON.stringify({ type: "app_server_info", request_id: "probe" })));
    ws.on("message", (raw) => {
      try {
        const m = JSON.parse(String(raw)) as Record<string, unknown>;
        // The server may push replayed state (e.g. a pending control_request) before it answers us.
        if (m.request_id !== "probe") return;
        if (m.type === "app_server_info_response" && typeof m.protocol_version === "number") {
          finish({
            protocol_version: m.protocol_version,
            backend: String(m.backend ?? ""),
            letta_code_version: typeof m.letta_code_version === "string" ? m.letta_code_version : undefined,
            capabilities: (m.capabilities as Record<string, boolean>) ?? {},
          });
        } else finish(null);
      } catch {
        finish(null);
      }
    });
    ws.on("error", () => finish(null));
  });
}

/** TCP ports this process is listening on (macOS/Linux, via lsof). GUI apps often lack /usr/sbin on PATH. */
export function listeningPorts(pid = process.pid): Promise<number[]> {
  const bins = ["/usr/sbin/lsof", "lsof"];
  const attempt = (i: number): Promise<number[]> =>
    new Promise((resolve) => {
      if (i >= bins.length) return resolve([]);
      execFile(bins[i], ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], { timeout: 4000 }, (err, stdout) => {
        if (err && !stdout) return resolve(attempt(i + 1));
        resolve(parseLsofPorts(String(stdout)));
      });
    });
  return attempt(0);
}

export function parseLsofPorts(stdout: string): number[] {
  const ports = new Set<number>();
  for (const line of stdout.split("\n")) {
    const m = /^n.*:(\d+)$/.exec(line.trim());
    if (m) ports.add(Number(m[1]));
  }
  return [...ports];
}

/**
 * Second route: Letta launches its channel gateway with `--app-server-url ws://127.0.0.1:<port>/ws`
 * on the command line, and `ps` is always on PATH.
 */
export function gatewayAppServerUrls(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile("/bin/ps", ["-axo", "command"], { timeout: 4000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return resolve([]);
      resolve(parseGatewayUrls(String(stdout)));
    });
  });
}

export function parseGatewayUrls(psOutput: string): string[] {
  const out = new Set<string>();
  for (const m of psOutput.matchAll(/channel-gateway\s+--app-server-url\s+(ws:\/\/[^\s]+)/g)) out.add(m[1]);
  return [...out];
}

/**
 * The mod runs inside the harness process that hosts the app-server, so the
 * server's random loopback port is one of our own listening ports. Probe them.
 */
export async function discoverAppServer(opts: { exclude?: number[]; explicitUrl?: string; pid?: number } = {}): Promise<string | null> {
  if (opts.explicitUrl) return (await probeAppServer(opts.explicitUrl)) ? opts.explicitUrl : null;
  const ports = (await listeningPorts(opts.pid)).filter((p) => !(opts.exclude ?? []).includes(p));
  const candidates = [...ports.map((port) => `ws://127.0.0.1:${port}/ws`), ...(await gatewayAppServerUrls())];
  log("app-server:candidates", candidates);
  for (const url of new Set(candidates)) {
    const info = await probeAppServer(url);
    if (info) {
      log("app-server:discovered", { url, ...info });
      return url;
    }
  }
  return null;
}

type Pending = { resolve: (v: AppServerEvent) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

/**
 * Minimal protocol client: request/response correlation by request_id,
 * runtime subscriptions that survive reconnects, and an event fan-out.
 */
export class AppServerClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private listeners = new Set<EventListener>();
  private runtimes = new Map<string, Runtime>();
  private closed = false;
  private retryMs = 500;
  private openPromise: Promise<void> | null = null;

  readonly url: string;
  private readonly clientInfo: { name: string; title: string; version: string };

  constructor(url: string, clientInfo = { name: "loci", title: "loci canvas", version: "0.2.0" }) {
    this.url = url;
    this.clientInfo = clientInfo;
  }

  on(fn: EventListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  connect(): Promise<void> {
    if (this.openPromise) return this.openPromise;
    this.openPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let settled = false;
      ws.on("open", () => {
        settled = true;
        this.retryMs = 500;
        log("app-server:connected", { url: this.url });
        resolve();
        // re-subscribe after a reconnect
        for (const rt of this.runtimes.values()) void this.runtimeStart(rt).catch(() => {});
      });
      ws.on("message", (raw) => this.onMessage(String(raw)));
      ws.on("error", (err) => {
        log("app-server:error", err.message);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      ws.on("close", () => {
        this.ws = null;
        this.openPromise = null;
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error("app-server connection closed"));
        }
        this.pending.clear();
        if (this.closed) return;
        setTimeout(() => void this.connect().catch(() => {}), this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, 8000);
      });
    });
    return this.openPromise;
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  private onMessage(raw: string): void {
    let m: AppServerEvent;
    try {
      m = JSON.parse(raw) as AppServerEvent;
    } catch {
      return;
    }
    // Replies echo our request_id (e.g. runtime_start_response, input_accepted); events never carry one of ours.
    const rid = typeof m.request_id === "string" ? m.request_id : null;
    if (rid && this.pending.has(rid)) {
      const p = this.pending.get(rid)!;
      this.pending.delete(rid);
      clearTimeout(p.timer);
      p.resolve(m);
      return;
    }
    for (const fn of this.listeners) {
      try {
        fn(m);
      } catch (err) {
        log("app-server:listener-error", err instanceof Error ? err.message : String(err));
      }
    }
  }

  async request(type: string, payload: Record<string, unknown>, timeoutMs = 15_000): Promise<AppServerEvent> {
    await this.connect();
    const request_id = `${type}-${randomUUID().slice(0, 8)}`;
    return new Promise<AppServerEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request_id);
        reject(new Error(`${type} timed out`));
      }, timeoutMs);
      this.pending.set(request_id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ type, request_id, ...payload }));
    });
  }

  /** Fire-and-forget send (for messages whose reply is not correlated). */
  async send(message: Record<string, unknown>): Promise<void> {
    await this.connect();
    this.ws!.send(JSON.stringify(message));
  }

  /** Subscribe to a runtime (idempotent); replays state on the connection. */
  async runtimeStart(rt: Runtime, cwd?: string): Promise<AppServerEvent> {
    const key = `${rt.agent_id}/${rt.conversation_id}`;
    this.runtimes.set(key, rt);
    const res = await this.request("runtime_start", {
      agent_id: rt.agent_id,
      conversation_id: rt.conversation_id,
      ...(cwd ? { cwd } : {}),
      // No `mode`: a runtime_start that names one resets the conversation's
      // permission mode in Desktop. loci only observes; the user's choice stands.
      client_info: this.clientInfo,
      recover_approvals: false,
    });
    if (res.success === false) {
      this.runtimes.delete(key);
      throw new Error(typeof res.error === "string" ? res.error : "runtime_start failed");
    }
    return res;
  }

  isSubscribed(rt: Runtime): boolean {
    return this.runtimes.has(`${rt.agent_id}/${rt.conversation_id}`);
  }

  /** Submit a user message. Letta queues it if the conversation is mid-turn. */
  async sendUserMessage(rt: Runtime, text: string, clientMessageId: string = randomUUID()): Promise<{ accepted: boolean; disposition?: string }> {
    const res = await this.request("input", {
      runtime: rt,
      payload: {
        kind: "create_message",
        messages: [{ role: "user", content: text, client_message_id: clientMessageId }],
      },
    });
    return {
      accepted: res.accepted !== false && res.success !== false,
      disposition: typeof res.disposition === "string" ? res.disposition : undefined,
    };
  }
}

/** Text of a stream_delta assistant/user message chunk, if any. */
export function deltaText(delta: Record<string, unknown> | undefined): string {
  if (!delta) return "";
  const c = delta.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => (typeof p === "object" && p !== null && (p as { type?: string }).type === "text" ? String((p as { text?: string }).text ?? "") : ""))
      .join("");
  }
  return "";
}
