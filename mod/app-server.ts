import { execFile } from "node:child_process";
import { WebSocket } from "./ws.ts";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
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

/**
 * TCP ports a process is listening on: `lsof` on the Mac (GUI apps often lack /usr/sbin on PATH), /proc on
 * Linux, `netstat -ano` on Windows. Only for a harness loki did not start: loki's own tells the mod its
 * address in LOKI_APP_SERVER_URL.
 */
export function listeningPorts(pid = process.pid, platform: NodeJS.Platform = process.platform): Promise<number[]> {
  if (platform === "linux") return Promise.resolve(procListeningPorts(pid));
  if (platform === "win32") return netstatPorts(pid);
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

/** Linux: the process's sockets (fd links `socket:[inode]`) that its net/tcp{,6} lists as listening. */
export function procListeningPorts(pid: number, root = "/proc"): number[] {
  const fdDir = join(root, String(pid), "fd");
  let links: string[];
  try {
    links = readdirSync(fdDir).map((fd) => {
      try {
        return readlinkSync(join(fdDir, fd));
      } catch {
        return ""; // closed while we looked
      }
    });
  } catch {
    return [];
  }
  const inodes = new Set(links.map((l) => /^socket:\[(\d+)\]$/.exec(l)?.[1]).filter((i): i is string => !!i));
  const tables = ["tcp", "tcp6"].map((t) => {
    try {
      return readFileSync(join(root, String(pid), "net", t), "utf8");
    } catch {
      return "";
    }
  });
  return parseProcNetTcp(tables.join("\n"), inodes);
}

/** Rows of /proc/net/tcp{,6} in state 0A (LISTEN) whose inode is in `inodes`: their local ports. */
export function parseProcNetTcp(text: string, inodes: Set<string>): number[] {
  const ports = new Set<number>();
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || !/^\d+:$/.test(f[0]) || f[3] !== "0A" || !inodes.has(f[9])) continue;
    const port = parseInt(f[1].split(":").pop() ?? "", 16);
    if (port > 0) ports.add(port);
  }
  return [...ports];
}

/** Windows: `netstat -ano`, from System32 (then PATH). */
function netstatPorts(pid: number): Promise<number[]> {
  const bins = [join(process.env.SystemRoot ?? "C:\\Windows", "System32", "netstat.exe"), "netstat"];
  const attempt = (i: number): Promise<number[]> =>
    new Promise((resolve) => {
      if (i >= bins.length) return resolve([]);
      execFile(bins[i], ["-ano"], { timeout: 4000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
        if (err && !stdout) return resolve(attempt(i + 1));
        resolve(parseNetstatPorts(String(stdout), pid));
      });
    });
  return attempt(0);
}

/**
 * `netstat -ano` rows for `pid` that listen. The state column is in the system's language (LISTENING,
 * ABHÖREN…), so a listener is the TCP row with no remote end: `0.0.0.0:0` or `[::]:0`.
 */
export function parseNetstatPorts(stdout: string, pid: number): number[] {
  const ports = new Set<number>();
  for (const line of stdout.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5 || f[0].toUpperCase() !== "TCP" || Number(f[f.length - 1]) !== pid || !/:0$/.test(f[2])) continue;
    const m = /:(\d+)$/.exec(f[1]);
    if (m) ports.add(Number(m[1]));
  }
  return [...ports];
}

/**
 * Second route: Letta launches its channel gateway with `--app-server-url ws://127.0.0.1:<port>/ws` on
 * its command line: from `ps` on the Mac (always at /bin/ps), each /proc/<pid>/cmdline on Linux, a CIM query on Windows.
 */
export function gatewayAppServerUrls(platform: NodeJS.Platform = process.platform): Promise<string[]> {
  if (platform === "linux") return Promise.resolve(parseGatewayUrls(procCommandLines().join("\n")));
  const [bin, args] = platform === "win32" ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), POWERSHELL_GATEWAY_ARGS] : ["/bin/ps", ["-axo", "command"]];
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: platform === "win32" ? 10_000 : 4000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err && !stdout) return resolve([]);
      resolve(parseGatewayUrls(String(stdout)));
    });
  });
}

/** Windows: the command lines of processes that mention the gateway. Single quotes only, so Node's own quoting of the argument leaves it whole. */
export const POWERSHELL_GATEWAY_ARGS = ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance -ClassName Win32_Process -Filter 'CommandLine LIKE ''%channel-gateway%''' | ForEach-Object { $_.CommandLine }"];

/** Linux: every readable /proc/<pid>/cmdline, its NUL-separated arguments joined by spaces. */
export function procCommandLines(root = "/proc"): string[] {
  let pids: string[];
  try {
    pids = readdirSync(root).filter((d) => /^\d+$/.test(d));
  } catch {
    return [];
  }
  const lines: string[] = [];
  for (const pid of pids) {
    try {
      const line = readFileSync(join(root, pid, "cmdline"), "utf8").split("\0").filter(Boolean).join(" ");
      if (line) lines.push(line);
    } catch {
      // exited, or not ours to read
    }
  }
  return lines;
}

export function parseGatewayUrls(psOutput: string): string[] {
  const out = new Set<string>();
  // Windows quotes arguments: `--app-server-url "ws://…"`.
  for (const m of psOutput.matchAll(/channel-gateway\s+--app-server-url\s+"?(ws:\/\/[^\s"]+)/g)) out.add(m[1]);
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
