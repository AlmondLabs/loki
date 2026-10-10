import type { NewAgentOptions } from "../../../core/attention/chat-client.ts";


import type { ReflectionMerge, ReflectionSettings, ReflectionTrigger, Runtime } from "../../../core/attention/protocol.ts";
import type { GlobalSkill, LocalAgent, MemoryCommit, MemoryFile, MemorySkillInfo, ReflectionState, RefreshOutcome } from "../../../core/frame-types.ts";

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
  /** Install a skill from a source into the agent's memory, through the mod (mod/skills.ts); an error message or null. */
  installSkill: (agentId: string, source: string, force?: boolean) => Promise<string | null>;
  /** Fetch an installed skill's upstream and replace, stage for the agent to reconcile, or report it current (mod/skill-sources.ts). */
  refreshSkill: (agentId: string, name: string, source?: string) => Promise<RefreshOutcome | { error: string }>;
  /** The daemon's reflection counters per conversation and the last pass that changed memory (mod/reflection.ts). */
  reflection: (agentId: string) => Promise<ReflectionState | null>;
}

/** Reflection through loki's daemon (daemon/reflection.ts): its settings, and a pass by hand. */
export interface ReflectionControls {
  get: (rt: Runtime) => Promise<ReflectionSettings | null>;
  set: (rt: Runtime, s: { trigger: ReflectionTrigger; stepCount: number; merge: ReflectionMerge; mergeInstructions?: string }) => Promise<string | null>;
  /** Resolves to the harness's one-line answer ("Started a reflection pass…", "No new transcript content…"). */
  run: (rt: Runtime) => Promise<string>;
}

/** Writes through loki's daemon; each resolves to an error message or null. */
export interface AgentsWrite {
  createAgent: (opts: NewAgentOptions) => Promise<{ id: string } | { error: string }>;
  deleteAgent: (agentId: string) => Promise<string | null>;
  writeMemory: (agentId: string, path: string, content: string, message?: string) => Promise<string | null>;
  removeMemory: (agentId: string, path: string, message?: string) => Promise<string | null>;
}

/** An edit to the agent's identity, as the daemon takes it (chat_agent_update): any of name, description, model. */
export type AgentEdit = { name?: string; description?: string; model?: string };
