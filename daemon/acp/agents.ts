import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

/**
 * The ACP agents a chat can run on (plan 020, KD1): programs loki starts and talks to over stdio, in the role an
 * editor plays. Claude Code and Cursor are built in; the person can add any other agent that speaks ACP by its command,
 * in `~/.loki/state/acp.json`.
 */

/** One ACP agent: how loki starts it. `id` names it in a chat's engine and in model handles (`acp:<id>/<model>`). */
export interface AcpAgentConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /**
   * The method loki asks the agent to sign in with (ACP `authenticate`) right after it starts, for an agent that opens
   * no session until it is asked (Cursor's `cursor_login`, plan 048); absent, loki never asks.
   */
  auth_method?: string;
  /** The command the person runs to sign in, shown when the agent says it is signed out; absent, a general hint. */
  login?: string;
}

/** The Claude adapter's version loki runs; a loki release moves it (KD9). */
export const CLAUDE_ADAPTER_VERSION = "0.93.0";

/** Claude Code, through the ACP adapter, run with npx so nothing is bundled (KD9). It signs in as the `claude` CLI does. */
export const CLAUDE_CODE: AcpAgentConfig = {
  id: "claude-code",
  name: "Claude Code",
  command: "npx",
  args: ["-y", `@agentclientprotocol/claude-agent-acp@${CLAUDE_ADAPTER_VERSION}`],
  login: "claude /login",
};

/**
 * Cursor's own CLI, whose `acp` command is its ACP server (plan 048). It is not bundled: the person installs Cursor's
 * CLI and signs in with it, and loki asks it to use that login.
 */
export const CURSOR: AcpAgentConfig = {
  id: "cursor",
  name: "Cursor",
  command: "cursor-agent",
  args: ["acp"],
  auth_method: "cursor_login",
  login: "cursor-agent login",
};

/** The agents loki ships, in the order Settings and the picker show them. */
export const BUILT_IN_AGENTS: readonly AcpAgentConfig[] = [CLAUDE_CODE, CURSOR];

/** The agent loki ships with this id, if it ships one. */
export function builtInAgent(id: string): AcpAgentConfig | undefined {
  return BUILT_IN_AGENTS.find((a) => a.id === id);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** One agent from the file, or null when it is not one: the file is the person's, so anything in it may be wrong. */
function parseAgent(v: unknown): AcpAgentConfig | null {
  if (!isRecord(v)) return null;
  const { id, name, command, args, env, auth_method, login } = v;
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(id) || typeof command !== "string" || !command) return null;
  return {
    id,
    name: typeof name === "string" && name ? name : id,
    command,
    args: Array.isArray(args) ? args.filter((a): a is string => typeof a === "string") : [],
    ...(isRecord(env) ? { env: Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string")) } : {}),
    ...(typeof auth_method === "string" && auth_method ? { auth_method } : {}),
    ...(typeof login === "string" && login ? { login } : {}),
  };
}

/**
 * The agents loki knows: the built-in ones, then the file's (`{ "agents": [...] }`). One in the file with a built-in
 * one's id replaces it, so the person can pin another version or run their own install.
 */
export function readAcpAgents(file: string | null): AcpAgentConfig[] {
  let listed: AcpAgentConfig[] = [];
  try {
    const parsed: unknown = file ? JSON.parse(readFileSync(file, "utf8")) : null;
    if (isRecord(parsed) && Array.isArray(parsed.agents)) listed = parsed.agents.map(parseAgent).filter((a): a is AcpAgentConfig => a !== null);
  } catch {
    // No file yet, or one that is not JSON: only the built-in agents.
  }
  return [...BUILT_IN_AGENTS.map((b) => listed.find((a) => a.id === b.id) ?? b), ...listed.filter((a) => !builtInAgent(a.id))];
}

/** An ACP model handle, `acp:<agent>/<model>`, as its parts; null for any other handle. */
export function acpHandle(handle: string): { agent: string; model: string } | null {
  const m = /^acp:([a-z0-9][a-z0-9-]*)\/(.+)$/.exec(handle);
  return m ? { agent: m[1], model: m[2] } : null;
}

/**
 * Write the person's agents (`{ "agents": [...] }`): every agent but the built-in ones as they ship. One with a
 * built-in one's id that differs from it is kept, as the override it is.
 */
export function writeAcpAgents(file: string, agents: readonly AcpAgentConfig[]): void {
  const own = agents.filter((a) => JSON.stringify(a) !== JSON.stringify(builtInAgent(a.id)));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ agents: own }, null, 2)}\n`);
}

/**
 * Whether a command can be started: a path that exists, or a name found on the PATH (with Windows' extensions for a
 * bare name there). Only a check for Settings; starting it is the proof.
 */
export function commandFound(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return commandPath(command, env) !== null;
}

/** Where a command is, as a full path: as given when it names a file, else the first match on PATH; null when nowhere. */
export function commandPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) return existsSync(command) ? resolve(command) : null;
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [];
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs)
    for (const name of [command, ...exts.map((e) => `${command}${e.toLowerCase()}`), ...exts.map((e) => `${command}${e}`)])
      if (existsSync(join(dir, name))) return join(dir, name);
  return null;
}
