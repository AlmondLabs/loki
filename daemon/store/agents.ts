import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { backendName } from "../../core/desk-core.ts";
import { isSubagent, readLocalAgent } from "../../mod/agents.ts";

/**
 * The daemon's agents (plan 017, U6), kept in the layout Letta's local backend used, under the daemon's own backend
 * folder: `agents/<base64 id>.json` for the record and `memfs/<id>/memory/` for the memory, a git repo. The mod's
 * readers (mod/agents.ts: the Agents page, memory, skills) read it by its folder, and the importer copies Letta's
 * agents in as they are (U14).
 */

const run = promisify(execFile);

/** `persona`: who the agent is and how it works, in the person's words, its memory's system/persona.md to start with. */
export type NewAgent = { name: string; description?: string; persona?: string; system?: string; model?: string };

/** A new agent's record and its memory repo, with a first commit; returns its id. */
export async function createAgent(backendDir: string, agent: NewAgent): Promise<string> {
  const id = `agent-local-${randomUUID()}`;
  const memory = join(backendDir, "memfs", id, "memory");
  mkdirSync(join(memory, "system"), { recursive: true });
  writeFileSync(join(memory, "system", "persona.md"), `${agent.persona?.trim() || `I am ${agent.name}.`}\n`);
  const git = (...args: string[]) => run("git", ["-C", memory, ...args]);
  await git("init", "--quiet");
  await git("add", "-A");
  await git("-c", `user.name=${agent.name}`, "-c", `user.email=${id}@loki.local`, "commit", "--quiet", "-m", "Begin memory");
  writeRecord(backendDir, id, {
    id,
    name: agent.name,
    description: agent.description ?? null,
    system: agent.system ?? "",
    tags: ["origin:loki"],
    model: agent.model ?? null,
    model_settings: {},
    hidden: false,
  });
  return id;
}

/** Write an agent's record atomically. */
export function writeRecord(backendDir: string, id: string, record: Record<string, unknown>): void {
  const dir = join(backendDir, "agents");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${backendName(id)}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(record, null, 2));
  renameSync(`${file}.tmp`, file);
}

/** The person's agents: those with a record and a memory folder, helper agents left out. */
export function listAgents(backendDir: string): string[] {
  let ids: string[];
  try {
    ids = readdirSync(join(backendDir, "memfs"));
  } catch {
    return [];
  }
  return ids.filter((id) => readLocalAgent(id, backendDir) && !isSubagent(id, backendDir));
}
