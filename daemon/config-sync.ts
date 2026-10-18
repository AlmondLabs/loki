import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/**
 * loki's own config the same on every paired Mac (plan 023, U10, KTD10, R20): the MCP servers in mcp.json, entry by
 * entry, and the mods folder, file by file (mod/recall-sync.ts filesSnapshot). An entry's last change is noticed by
 * comparing it with what this Mac saw last (a manifest beside the state), so an edit by hand counts like one in
 * Settings, and the later change wins on every Mac; a server removed on one Mac is removed on the others. Secrets stay
 * `${keychain:…}` references, so a server whose secret a Mac lacks is listed as missing there (R21), never copied.
 * The "always allow" list (state/approvals.json) is not here: a command allowed on one Mac's files is not on another's.
 */

/** One server entry as it travels, and when it last changed (ISO). */
export interface McpEntry {
  value: unknown;
  at: string;
}

/** A Mac's MCP servers for another, and the ones it removed (entry → when). */
export interface McpSnapshot {
  servers: Record<string, McpEntry>;
  removed: Record<string, string>;
}

interface Manifest {
  /** Each entry's content as last seen here (a hash), to notice a change made since. */
  seen: Record<string, string>;
  changed: Record<string, string>;
  removed: Record<string, string>;
}

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

function readRaw(path: string): Record<string, unknown> & { mcpServers: Record<string, unknown> } {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const servers = raw.mcpServers && typeof raw.mcpServers === "object" ? (raw.mcpServers as Record<string, unknown>) : {};
    return { ...raw, mcpServers: servers };
  } catch {
    return { mcpServers: {} };
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

function readManifest(path: string): Manifest {
  try {
    const m = JSON.parse(readFileSync(path, "utf8")) as Partial<Manifest>;
    return { seen: m.seen ?? {}, changed: m.changed ?? {}, removed: m.removed ?? {} };
  } catch {
    return { seen: {}, changed: {}, removed: {} };
  }
}

/** Look again: an entry new or different since last seen changed now, one gone was removed now. */
function refresh(configPath: string, manifestPath: string, now: string) {
  const raw = readRaw(configPath);
  const m = readManifest(manifestPath);
  for (const [entry, value] of Object.entries(raw.mcpServers)) {
    const h = hash(value);
    if (m.seen[entry] !== h) {
      m.seen[entry] = h;
      m.changed[entry] = now;
      m.removed = Object.fromEntries(Object.entries(m.removed).filter(([k]) => k !== entry));
    }
  }
  for (const entry of Object.keys(m.seen))
    if (!(entry in raw.mcpServers)) {
      m.seen = Object.fromEntries(Object.entries(m.seen).filter(([k]) => k !== entry));
      m.removed[entry] = now;
    }
  writeJson(manifestPath, m);
  return { raw, m };
}

/** This Mac's MCP servers and removals, for a paired Mac. */
export function mcpSnapshot(configPath: string, manifestPath: string, now = new Date().toISOString()): McpSnapshot {
  const { raw, m } = refresh(configPath, manifestPath, now);
  const servers: Record<string, McpEntry> = {};
  for (const [entry, value] of Object.entries(raw.mcpServers)) servers[entry] = { value, at: m.changed[entry] ?? now };
  return { servers, removed: { ...m.removed } };
}

/** Take a paired Mac's servers: each entry changed or removed there later is written here. True when mcp.json moved. */
export function applyMcp(configPath: string, manifestPath: string, theirs: McpSnapshot, now = new Date().toISOString()): boolean {
  const { raw, m } = refresh(configPath, manifestPath, now);
  const mine = (entry: string) =>
    [m.changed[entry], m.removed[entry]]
      .filter((x): x is string => !!x)
      .sort()
      .at(-1) ?? "";
  let moved = false;
  for (const [entry, e] of Object.entries(theirs.servers)) {
    if (typeof e.at !== "string" || e.at <= mine(entry) || typeof e.value !== "object" || e.value === null) continue;
    raw.mcpServers[entry] = e.value;
    m.seen[entry] = hash(e.value);
    m.changed[entry] = e.at;
    m.removed = Object.fromEntries(Object.entries(m.removed).filter(([k]) => k !== entry));
    moved = true;
  }
  for (const [entry, at] of Object.entries(theirs.removed)) {
    if (typeof at !== "string" || at <= mine(entry) || !(entry in raw.mcpServers)) continue;
    raw.mcpServers = Object.fromEntries(Object.entries(raw.mcpServers).filter(([k]) => k !== entry));
    m.seen = Object.fromEntries(Object.entries(m.seen).filter(([k]) => k !== entry));
    m.removed[entry] = at;
    moved = true;
  }
  if (moved) writeJson(configPath, raw);
  writeJson(manifestPath, m);
  return moved;
}

/** loki's mods folder as files: everything but node_modules and dotfiles, by path under the folder. */
export function listModFiles(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else out[relative(dir, full).split(sep).join("/")] = Math.floor(st.mtimeMs);
    }
  };
  walk(dir);
  return out;
}

/** Whether a mod file path may be written: inside the folder, no dotfiles, no node_modules. */
export const isModPath = (path: string): boolean =>
  !!path && !path.startsWith("/") && path.split("/").every((p) => p !== "" && p !== ".." && !p.startsWith(".") && p !== "node_modules");
