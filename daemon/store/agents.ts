import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { backendName } from "../../core/chat-scope.ts";
import { readLocalAgent } from "../../mod/agents.ts";
import { writeJsonAtomic } from "../../mod/json-file.ts";

const run = promisify(execFile);

export interface NewAgent {
  name: string;
  description?: string;
  persona?: string;
  system?: string;
  model?: string;
  home_mac?: string;
}

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
    ...(agent.home_mac ? { home_mac: agent.home_mac } : {}),
  });
  return id;
}

export function writeRecord(backendDir: string, id: string, record: Record<string, unknown>): void {
  writeJsonAtomic(join(backendDir, "agents", `${backendName(id)}.json`), record, { pretty: true });
}

export function listAgents(backendDir: string): string[] {
  let ids: string[];
  try {
    ids = readdirSync(join(backendDir, "memfs"));
  } catch {
    return [];
  }
  return ids.filter((id) => readLocalAgent(id, backendDir));
}
