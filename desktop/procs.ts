import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";

export const STOP_GRACE_MS = 3000;
const POLL_MS = 100;

export interface Proc {
  pid: number;
  parent: number | null;
  started: number | null;
  name: string;
  command: string;
}

export type LockHolder = { kind: "leftover"; pid: number; started: number } | { kind: "serving"; pid: number; loki: Proc } | { kind: "none" };

export function splitWindows(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let any = false;
  let i = 0;
  while (i < line.length) {
    const c = line.charAt(i);
    if (c === "\\") {
      let n = 0;
      while (line.charAt(i + n) === "\\") n++;
      if (line.charAt(i + n) === '"') {
        current += "\\".repeat(Math.floor(n / 2));
        if (n % 2 === 1) {
          current += '"';
          i += n + 1;
        } else {
          i += n;
        }
      } else {
        current += "\\".repeat(n);
        i += n;
      }
      any = true;
      continue;
    }
    if (c === '"') {
      quoted = !quoted;
      any = true;
    } else if (/\s/.test(c) && !quoted) {
      if (any) out.push(current);
      current = "";
      any = false;
    } else {
      current += c;
      any = true;
    }
    i++;
  }
  if (any) out.push(current);
  return out;
}

const unquote = (word: string) => (word.length >= 2 && word.startsWith('"') && word.endsWith('"') ? word.slice(1, -1) : word);

export function commandWords(line: string): string[] {
  return splitWindows(line)
    .map(unquote)
    .filter((w) => w !== "");
}

const samePath = (a: string, b: string, windows: boolean) => {
  if (!windows) return a === b;
  const norm = (p: string) => p.replaceAll("/", "\\").toLowerCase();
  return norm(a) === norm(b);
};

export function isOwnDaemon(p: Proc, tokenFile: string, windows: boolean): boolean {
  if (!windows) {
    const padded = ` ${p.command} `;
    return padded.includes(" --loki-daemon ") && padded.includes(` --token-file ${tokenFile} `);
  }
  const words = commandWords(p.command);
  const at = words.indexOf("--token-file");
  const file = at >= 0 ? words[at + 1] : undefined;
  return words.includes("--loki-daemon") && file !== undefined && samePath(file, tokenFile, true);
}

function namedParent(p: Proc, windows: boolean): number | null {
  if (windows) {
    const words = commandWords(p.command);
    const at = words.indexOf("--parent-pid");
    const pid = Number(at >= 0 ? words[at + 1] : NaN);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }
  const match = /\s--parent-pid\s+(\d+)(?:\s|$)/.exec(p.command);
  return match?.[1] ? Number(match[1]) : null;
}

export function isLokiShell(name: string): boolean {
  const n = name.toLowerCase();
  return n === "loki" || n === "loki.exe";
}

export function liveLokiParent(procs: readonly Proc[], p: Proc, windows: boolean): Proc | null {
  const named = namedParent(p, windows);
  if (named !== null) {
    const q = procs.find((x) => x.pid === named);
    if (!q) return null;
    return q.started === null || p.started === null || q.started <= p.started ? q : null;
  }
  if (p.parent === null) return null;
  return procs.find((q) => q.pid === p.parent && isLokiShell(q.name)) ?? null;
}

export function lockHolder(procs: readonly Proc[], lockPid: number | null, tokenFile: string, windows: boolean): LockHolder {
  if (lockPid === null) return { kind: "none" };
  const p = procs.find((x) => x.pid === lockPid);
  if (!p || !isOwnDaemon(p, tokenFile, windows)) return { kind: "none" };
  const loki = liveLokiParent(procs, p, windows);
  if (loki) return { kind: "serving", pid: p.pid, loki };
  return p.started === null ? { kind: "none" } : { kind: "leftover", pid: p.pid, started: p.started };
}

export function readLockPid(file: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(file, "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;

const shellName = (command: string) => posix.basename(command.split(" -").at(0)?.trimEnd() ?? "");

export function parsePs(out: string): Proc[] {
  const procs: Proc[] = [];
  for (const line of out.split("\n")) {
    const m = PS_LINE.exec(line);
    if (!m?.[1] || !m[2] || !m[3]) continue;
    const started = Date.parse(m[3]);
    const command = m[4];
    procs.push({ pid: Number(m[1]), parent: Number(m[2]) || null, started: Number.isNaN(started) ? null : started, name: shellName(command), command });
  }
  return procs;
}

const field = (o: Record<string, unknown>, key: string): unknown => o[key];
const asNumber = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function parseWindowsProcs(json: string): Proc[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const rows: unknown[] = Array.isArray(data) ? data : [data];
  const procs: Proc[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const o = row as Record<string, unknown>;
    const pid = asNumber(field(o, "ProcessId"));
    if (pid === null) continue;
    const name = field(o, "Name");
    const command = field(o, "CommandLine");
    procs.push({
      pid,
      parent: asNumber(field(o, "ParentProcessId")),
      started: asNumber(field(o, "Started")),
      name: typeof name === "string" ? name : "",
      command: typeof command === "string" ? command : "",
    });
  }
  return procs;
}

const WINDOWS_LIST = [
  "Get-CimInstance Win32_Process",
  "Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n='Started';e={if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }}}",
  "ConvertTo-Json -Compress",
].join(" | ");

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, env }, (error, stdout) => {
      if (error) reject(new Error(`${command} failed: ${error.message}`, { cause: error }));
      else resolve(stdout);
    });
  });
}

export async function listProcs(platform: NodeJS.Platform = process.platform): Promise<Proc[]> {
  if (platform === "win32") return parseWindowsProcs(await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_LIST]));
  return parsePs(await run("ps", ["-A", "-o", "pid=,ppid=,lstart=,command="], { ...process.env, LC_ALL: "C" }));
}

export interface StopHost {
  windows: boolean;
  list: () => Promise<Proc[]>;
  alive: (pid: number) => boolean;
  signal: (pid: number, signal: NodeJS.Signals) => void;
  killTree: (pid: number) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

async function startedAt(h: StopHost, pid: number): Promise<number | null> {
  return (await h.list()).find((p) => p.pid === pid)?.started ?? null;
}

async function goneWithin(h: StopHost, pid: number, ms: number): Promise<boolean> {
  const until = h.now() + ms;
  while (h.alive(pid)) {
    if (h.now() >= until) return false;
    await h.sleep(POLL_MS);
  }
  return true;
}

export async function stopLeftover(h: StopHost, pid: number, started: number, grace = STOP_GRACE_MS): Promise<boolean> {
  if ((await startedAt(h, pid)) !== started) return false;
  if (h.windows) {
    h.killTree(pid);
    return goneWithin(h, pid, grace);
  }
  try {
    h.signal(pid, "SIGTERM");
  } catch {
    return !h.alive(pid);
  }
  if (await goneWithin(h, pid, grace)) return true;
  if ((await startedAt(h, pid)) !== started) return true;
  try {
    h.signal(pid, "SIGKILL");
  } catch {
    return !h.alive(pid);
  }
  return goneWithin(h, pid, grace);
}
