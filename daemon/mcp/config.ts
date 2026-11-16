import { chmodSync, existsSync, readFileSync } from "node:fs";
import { messageOf } from "../../core/errors.ts";
import { writeJsonAtomic } from "../../mod/json-file.ts";

/**
 * MCP servers as the person configures them: `<loki>/mcp.json`, in the `mcpServers` shape Claude Code, Claude Desktop
 * and Cursor use, so an entry copies across as it is. A local server is a command loki starts (stdio); a remote one is
 * a URL (Streamable HTTP) with headers for its token. `alwaysLoad` names the few tools that skip search.
 */

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
export interface RemoteServer {
  kind: "remote";
  name: string;
  entry: string;
  url: string;
  headers: Record<string, string>;
  alwaysLoad: string[];
}
export type ServerConfig = LocalServer | RemoteServer;

export interface McpConfig {
  servers: ServerConfig[];
  problems: string[];
}

export const serverKey = (name: string): string => name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "server";

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const record = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) if (typeof x === "string") out[k] = x;
  return out;
};

export function parseConfig(text: string): McpConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { servers: [], problems: [`mcp.json is not valid JSON: ${messageOf(error)}`] };
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

export function readConfig(path: string): McpConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { servers: [], problems: [] };
    return { servers: [], problems: [`could not read ${path}: ${messageOf(error)}`] };
  }
  return parseConfig(text);
}

export const sameServer = (a: ServerConfig, b: ServerConfig): boolean => JSON.stringify(a) === JSON.stringify(b);

export type ServerEdit =
  { command: string; args: string[]; env: Record<string, string>; cwd: string | null } | { url: string; headers: Record<string, string> };

function readRaw(path: string): Record<string, unknown> {
  if (!existsSync(path)) return { mcpServers: {} };
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("mcp.json is not a JSON object; fix it by hand first");
  const out = raw as Record<string, unknown>;
  if (!out.mcpServers || typeof out.mcpServers !== "object" || Array.isArray(out.mcpServers)) out.mcpServers = {};
  return out;
}

function writeRaw(path: string, raw: Record<string, unknown>): void {
  writeJsonAtomic(path, raw, { pretty: true, newline: true, mode: 0o600, pidTemp: true });
  try {
    chmodSync(path, 0o600);
  } catch {}
}

export function editServer(path: string, entry: string, edit: ServerEdit | null, opts: { rename?: string } = {}): void {
  const raw = readRaw(path);
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
export const keychainRef = (name: string): string => `\${keychain:${name}}`;

export async function withSecrets(config: ServerConfig, get: (name: string) => Promise<string | null>): Promise<ServerConfig> {
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
