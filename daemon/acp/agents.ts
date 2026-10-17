import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

/**
 * The ACP agents a chat can run on (plan 020, KD1): programs loki starts and talks to over stdio, in the role an
 * editor plays. Claude Code is built in; the person can add any other agent that speaks ACP by its command, in
 * `~/.loki/state/acp.json`.
 */

/** One ACP agent: how loki starts it. `id` names it in a chat's engine and in model handles (`acp:<id>/<model>`). */
export interface AcpAgentConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** The Claude adapter's version loki runs; a loki release moves it (KD9). */
export const CLAUDE_ADAPTER_VERSION = "0.93.0";

/** Claude Code, through the ACP adapter, run with npx so nothing is bundled (KD9). It signs in as the `claude` CLI does. */
export const CLAUDE_CODE: AcpAgentConfig = {
  id: "claude-code",
  name: "Claude Code",
  command: "npx",
  args: ["-y", `@agentclientprotocol/claude-agent-acp@${CLAUDE_ADAPTER_VERSION}`],
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** One agent from the file, or null when it is not one: the file is the person's, so anything in it may be wrong. */
function parseAgent(v: unknown): AcpAgentConfig | null {
  if (!isRecord(v)) return null;
  const { id, name, command, args, env } = v;
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(id) || typeof command !== "string" || !command) return null;
  return {
    id,
    name: typeof name === "string" && name ? name : id,
    command,
    args: Array.isArray(args) ? args.filter((a): a is string => typeof a === "string") : [],
    ...(isRecord(env) ? { env: Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string")) } : {}),
  };
}

/**
 * The agents loki knows: Claude Code, then the file's (`{ "agents": [...] }`). One in the file with Claude Code's id
 * replaces the built-in one, so the person can pin another version or run their own install.
 */
export function readAcpAgents(file: string | null): AcpAgentConfig[] {
  let listed: AcpAgentConfig[] = [];
  try {
    const parsed: unknown = file ? JSON.parse(readFileSync(file, "utf8")) : null;
    if (isRecord(parsed) && Array.isArray(parsed.agents)) listed = parsed.agents.map(parseAgent).filter((a): a is AcpAgentConfig => a !== null);
  } catch {
    // No file yet, or one that is not JSON: only the built-in agent.
  }
  const own = listed.find((a) => a.id === CLAUDE_CODE.id);
  return [own ?? CLAUDE_CODE, ...listed.filter((a) => a.id !== CLAUDE_CODE.id)];
}

/** An ACP model handle, `acp:<agent>/<model>`, as its parts; null for any other handle. */
export function acpHandle(handle: string): { agent: string; model: string } | null {
  const m = /^acp:([a-z0-9][a-z0-9-]*)\/(.+)$/.exec(handle);
  return m ? { agent: m[1], model: m[2] } : null;
}

/**
 * Write the person's agents (`{ "agents": [...] }`): every agent but the built-in Claude Code as it ships. One with
 * Claude Code's id that differs from it is kept, as the override it is.
 */
export function writeAcpAgents(file: string, agents: readonly AcpAgentConfig[]): void {
  const own = agents.filter((a) => a.id !== CLAUDE_CODE.id || JSON.stringify(a) !== JSON.stringify(CLAUDE_CODE));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ agents: own }, null, 2)}\n`);
}

/**
 * Whether a command can be started: a path that exists, or a name found on the PATH (with Windows' extensions for a
 * bare name there). Only a check for Settings; starting it is the proof.
 */
export function commandFound(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) return existsSync(command);
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [];
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  return dirs.some((dir) =>
    [command, ...exts.map((e) => `${command}${e.toLowerCase()}`), ...exts.map((e) => `${command}${e}`)].some((name) => existsSync(join(dir, name))),
  );
}
