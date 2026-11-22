import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { isRecord } from "../tool-kinds.ts";

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

export const CLAUDE_ADAPTER_VERSION = "0.93.0";

export const CLAUDE_CODE: AcpAgentConfig = {
  id: "claude-code",
  name: "Claude Code",
  command: "npx",
  args: ["-y", `@agentclientprotocol/claude-agent-acp@${CLAUDE_ADAPTER_VERSION}`],
  login: "claude /login",
};

export const CURSOR: AcpAgentConfig = {
  id: "cursor",
  name: "Cursor",
  command: "cursor-agent",
  args: ["acp"],
  auth_method: "cursor_login",
  login: "cursor-agent login",
};

export const BUILT_IN_AGENTS: readonly AcpAgentConfig[] = [CLAUDE_CODE, CURSOR];

export function builtInAgent(id: string): AcpAgentConfig | undefined {
  return BUILT_IN_AGENTS.find((a) => a.id === id);
}

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

export function readAcpAgents(file: string | null): AcpAgentConfig[] {
  let listed: AcpAgentConfig[] = [];
  try {
    const parsed: unknown = file ? JSON.parse(readFileSync(file, "utf8")) : null;
    if (isRecord(parsed) && Array.isArray(parsed.agents)) listed = parsed.agents.map(parseAgent).filter((a): a is AcpAgentConfig => a !== null);
  } catch {}
  return [...BUILT_IN_AGENTS.map((b) => listed.find((a) => a.id === b.id) ?? b), ...listed.filter((a) => !builtInAgent(a.id))];
}

export function acpHandle(handle: string): { agent: string; model: string } | null {
  const m = /^acp:([a-z0-9][a-z0-9-]*)\/(.+)$/.exec(handle);
  return m ? { agent: m[1], model: m[2] } : null;
}

export function writeAcpAgents(file: string, agents: readonly AcpAgentConfig[]): void {
  const own = agents.filter((a) => JSON.stringify(a) !== JSON.stringify(builtInAgent(a.id)));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ agents: own }, null, 2)}\n`);
}

export function commandFound(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return commandPath(command, env) !== null;
}

export function commandPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) return existsSync(command) ? resolve(command) : null;
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [];
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs)
    // Outside (Windows): the runnable forms come first, as npm puts an extensionless `npx` (a shell script Windows cannot run) beside npx.cmd.
    for (const name of [...exts.map((e) => `${command}${e.toLowerCase()}`), ...exts.map((e) => `${command}${e}`), command])
      if (existsSync(join(dir, name))) return join(dir, name);
  return null;
}
