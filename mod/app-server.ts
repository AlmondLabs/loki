import { execFile } from "node:child_process";
import { WebSocket } from "./ws.ts";
import { readFileSync } from "node:fs";
import { log } from "./log.ts";
import { paths } from "./paths.ts";

/**
 * Headers for any socket the mod opens to an app-server. A harness started by
 * the loki app runs with `--ws-auth capability-token` keyed on loki's own token;
 * Desktop's harness has no auth and ignores the header.
 */
export function appServerHeaders(): Record<string, string> {
  try {
    const token = readFileSync(paths.token, "utf8").trim();
    return token ? { authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

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
    const ws = new WebSocket(url, { headers: appServerHeaders() });
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
        } else {
          log("app-server:probe-refused", { url, reply: String(raw).slice(0, 200) });
          finish(null);
        }
      } catch {
        finish(null);
      }
    });
    ws.on("error", (err) => {
      log("app-server:probe-error", { url, message: err instanceof Error ? err.message : String(err) });
      finish(null);
    });
    ws.on("unexpected-response", (_req, res) => log("app-server:probe-unexpected", { url, status: res.statusCode }));
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

/**
 * Minimal protocol client: request/response correlation by request_id,
 * runtime subscriptions that survive reconnects, and an event fan-out.
 */
