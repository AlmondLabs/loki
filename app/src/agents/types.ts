import type { LocalAgent, MemoryCommit, MemoryFile } from "../../../mod/agents.ts";
import type { GlobalSkill } from "../../../mod/skills.ts";
import type { MemorySkillInfo, RefreshOutcome } from "../../../mod/skill-sources.ts";
import type { Personality } from "../../../packages/core/src/attention/protocol.ts";

export interface AgentDetails {
  agent: LocalAgent;
  files: MemoryFile[];
  skills: MemorySkillInfo[];
  hasProfile: boolean;
  lastCommit: MemoryCommit | null;
}

export interface AgentsApi {
  get: (agentId: string) => Promise<AgentDetails | null>;
  read: (agentId: string, path: string) => Promise<string | null>;
  log: (agentId: string, path?: string, limit?: number) => Promise<MemoryCommit[]>;
  diff: (agentId: string, sha: string) => Promise<string | null>;
  globalSkills: () => Promise<GlobalSkill[]>;
  /** `letta install <source> --agent <id>` through the mod; an error message or null. */
  installSkill: (agentId: string, source: string, force?: boolean) => Promise<string | null>;
  /** Fetch an installed skill's upstream and replace, stage for the agent to reconcile, or report it current (mod/skill-sources.ts). */
  refreshSkill: (agentId: string, name: string, source?: string) => Promise<RefreshOutcome | { error: string }>;
}

/** Writes through the app-server; each resolves to an error message or null. */
export interface AgentsWrite {
  createAgent: (opts: { personality: Personality; name: string; description?: string; model?: string }) => Promise<{ id: string } | { error: string }>;
  deleteAgent: (agentId: string) => Promise<string | null>;
  writeMemory: (agentId: string, path: string, content: string, message?: string) => Promise<string | null>;
  removeMemory: (agentId: string, path: string, message?: string) => Promise<string | null>;
}

/** An edit to the agent's identity, as the app-server takes it: any of name, description, model. */
export type AgentEdit = { name?: string; description?: string; model?: string };
