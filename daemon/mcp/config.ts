import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * MCP servers as the person configures them: `<loki>/mcp.json`, in the `mcpServers` shape Claude Code, Claude Desktop
 * and Cursor use, so an entry copies across as it is. A local server is a command loki starts (stdio); a remote one is
 * a URL (Streamable HTTP) with headers for its token. `alwaysLoad` names the few tools that skip search.
 */

/** `entry` is the server's key as written in the file (`name` is it made safe for tool names), for edits to find it. */
export interface LocalServer {
  kind: "local";
  name: string;
  entry: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string | null;
  alwaysLoad: string[];
}
/** A remote server: a Streamable HTTP URL and the headers sent with it, a token among them often as a `${keychain:…}` reference. */
export interface RemoteServer {
  kind: "remote";
  name: string;
  entry: string;
  url: string;
  headers: Record<string, string>;
  alwaysLoad: string[];
}
/** One server from mcp.json, local or remote. */
export type ServerConfig = LocalServer | RemoteServer;

/** The config as read: the servers that parse, and a line for each entry that does not. */
export interface McpConfig {
  servers: ServerConfig[];
  problems: string[];
}

/** A server's name as it goes into tool names (`mcp__<name>__<tool>`): letters, digits, `_` and `-` only. */
export const serverKey = (name: string): string => name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "server";

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const record = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) if (typeof x === "string") out[k] = x;
  return out;
};

/** The config file's text as servers; a broken file is no servers and one problem, never a throw. */
export function parseConfig(text: string): McpConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { servers: [], problems: [`mcp.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const entries = raw && typeof raw === "object" ? (raw as { mcpServers?: unknown }).mcpServers : undefined;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) return { servers: [], problems: raw ? ['mcp.json has no "mcpServers" object'] : [] };
  const servers: ServerConfig[] = [];
  const problems: string[] = [];
  const taken = new Set<string>();
  for (const [given, value] of Object.entries(entries as Record<string, unknown>)) {
    const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    if (v.disabled === true) continue;
    const name = serverKey(given);
    if (taken.has(name)) {
      problems.push(`${given}: another server already has the name ${name}`);
      continue;
    }
    const alwaysLoad = strings(v.alwaysLoad);
    if (typeof v.command === "string" && v.command.trim()) {
      servers.push({
        kind: "local",
        name,
        entry: given,
        command: v.command,
        args: strings(v.args),
        env: record(v.env),
        cwd: typeof v.cwd === "string" ? v.cwd : null,
        alwaysLoad,
      });
    } else if (typeof v.url === "string" && v.url.trim()) {
      try {
        const url = new URL(v.url);
        if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("not http(s)");
        servers.push({ kind: "remote", name, entry: given, url: url.href, headers: record(v.headers), alwaysLoad });
      } catch {
        problems.push(`${given}: "${v.url}" is not an http(s) URL`);
        continue;
      }
    } else {
      problems.push(`${given}: needs a "command" (a local server) or a "url" (a remote one)`);
      continue;
    }
    taken.add(name);
  }
  return { servers, problems };
}

/** The file at `path`; a missing file is no servers and no problem. */
export function readConfig(path: string): McpConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { servers: [], problems: [] };
    return { servers: [], problems: [`could not read ${path}: ${error instanceof Error ? error.message : String(error)}`] };
  }
  return parseConfig(text);
}

/** Whether two configs of a server would connect the same way: an unchanged server is not restarted on a reload. */
export const sameServer = (a: ServerConfig, b: ServerConfig): boolean => JSON.stringify(a) === JSON.stringify(b);

/** What Settings edits about a server: the fields loki knows. Anything else in the entry is kept as it is. */
export type ServerEdit =
  { command: string; args: string[]; env: Record<string, string>; cwd: string | null } | { url: string; headers: Record<string, string> };

/** The file's JSON as an object, or a fresh one; a file that is not JSON is refused rather than overwritten. */
function readRaw(path: string): Record<string, unknown> {
  if (!existsSync(path)) return { mcpServers: {} };
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("mcp.json is not a JSON object; fix it by hand first");
  const out = raw as Record<string, unknown>;
  if (!out.mcpServers || typeof out.mcpServers !== "object" || Array.isArray(out.mcpServers)) out.mcpServers = {};
  return out;
}

/** Write the file whole (beside it, then moved into place), readable by you alone: it can hold tokens. */
function writeRaw(path: string, raw: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows has no such modes; the file is in the user's own folder.
  }
}

/**
 * Add, change, rename or remove one server in the file (`edit` null removes it). Fields loki does not know, in the
 * entry and in the file, are kept: the file may be shared with notes or settings of another tool's.
 */
export function editServer(path: string, entry: string, edit: ServerEdit | null, opts: { rename?: string } = {}): void {
  const raw = readRaw(path);
  // The file's entries are whatever it holds: any name may be missing, and an entry may not be an object.
  const servers = raw.mcpServers as Partial<Record<string, unknown>>;
  const found = servers[entry];
  const before = found && typeof found === "object" ? (found as Record<string, unknown>) : {};
  const key = opts.rename?.trim() || entry;
  if (!key) throw new Error("a server needs a name");
  if (key !== entry && servers[key]) throw new Error(`there is already a server named ${key}`);
  const { [entry]: _old, ...others } = servers;
  raw.mcpServers = others;
  if (edit) {
    const { command: _c, args: _a, env: _e, cwd: _w, url: _u, headers: _h, ...kept } = before;
    const next: Record<string, unknown> = { ...kept };
    if ("command" in edit) {
      if (!edit.command.trim()) throw new Error("a local server needs a command");
      Object.assign(next, {
        command: edit.command.trim(),
        ...(edit.args.length ? { args: edit.args } : {}),
        ...(Object.keys(edit.env).length ? { env: edit.env } : {}),
        ...(edit.cwd ? { cwd: edit.cwd } : {}),
      });
    } else {
      const url = new URL(edit.url);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`"${edit.url}" is not an http(s) URL`);
      Object.assign(next, { url: url.href, ...(Object.keys(edit.headers).length ? { headers: edit.headers } : {}) });
    }
    others[key] = next;
  }
  writeRaw(path, raw);
}

/** Set the tools of a server that skip the search (`alwaysLoad`); none removes the field. */
export function setAlwaysLoad(path: string, entry: string, tools: string[]): void {
  const raw = readRaw(path);
  const server = (raw.mcpServers as Partial<Record<string, Record<string, unknown>>>)[entry];
  if (!server) throw new Error(`no server named ${entry}`);
  if (tools.length) server.alwaysLoad = [...new Set(tools)];
  else delete server.alwaysLoad;
  writeRaw(path, raw);
}

/** `${keychain:<name>}`: a value kept in the keychain, which the file names instead of holding. */
export const KEYCHAIN_REF = /\$\{keychain:([A-Za-z0-9_.-]+)\}/g;
/** The `${keychain:<name>}` reference to write into mcp.json in place of a secret kept under `name`. */
export const keychainRef = (name: string): string => `\${keychain:${name}}`;

/** The server with every `${keychain:…}` in its env and headers replaced by the secret; a missing one is an error. */
export async function withSecrets(config: ServerConfig, get: (name: string) => Promise<string | null>): Promise<ServerConfig> {
  // Every reference in every value is read at once (the reads do not depend on each other), then put in its place.
  const names = [
    ...new Set(Object.values(config.kind === "local" ? config.env : config.headers).flatMap((v) => [...v.matchAll(KEYCHAIN_REF)].map((m) => m[1]))),
  ];
  const found = new Map(await Promise.all(names.map(async (n) => [n, await get(n)] as const)));
  const fill = (values: Record<string, string>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(values).map(([k, v]) => [
        k,
        v.replace(KEYCHAIN_REF, (_ref, name: string) => {
          const secret = found.get(name);
          if (secret === null || secret === undefined) throw new Error(`the keychain has no secret named ${name} (for ${k})`);
          return secret;
        }),
      ]),
    );
  return config.kind === "local" ? { ...config, env: fill(config.env) } : { ...config, headers: fill(config.headers) };
}
