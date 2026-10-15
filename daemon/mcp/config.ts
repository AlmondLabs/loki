import { readFileSync } from "node:fs";

/**
 * MCP servers as the person configures them: `<loki>/mcp.json`, in the `mcpServers` shape Claude Code, Claude Desktop
 * and Cursor use, so an entry copies across as it is. A local server is a command loki starts (stdio); a remote one is
 * a URL (Streamable HTTP) with headers for its token. `alwaysLoad` names the few tools that skip search.
 */

export type LocalServer = { kind: "local"; name: string; command: string; args: string[]; env: Record<string, string>; cwd: string | null; alwaysLoad: string[] };
export type RemoteServer = { kind: "remote"; name: string; url: string; headers: Record<string, string>; alwaysLoad: string[] };
export type ServerConfig = LocalServer | RemoteServer;

/** The config as read: the servers that parse, and a line for each entry that does not. */
export type McpConfig = { servers: ServerConfig[]; problems: string[] };

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
      servers.push({ kind: "local", name, command: v.command, args: strings(v.args), env: record(v.env), cwd: typeof v.cwd === "string" ? v.cwd : null, alwaysLoad });
    } else if (typeof v.url === "string" && v.url.trim()) {
      try {
        const url = new URL(v.url);
        if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("not http(s)");
        servers.push({ kind: "remote", name, url: url.href, headers: record(v.headers), alwaysLoad });
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
