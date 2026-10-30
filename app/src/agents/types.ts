import type { NewAgentOptions } from "../../../core/attention/chat-client.ts";

import type { PassSettings, PassSettingsChange, Runtime } from "../../../core/attention/protocol.ts";
import type {
  GlobalSkill,
  LocalAgent,
  MemoryCommit,
  MemoryFile,
  MemorySkill,
  ReflectionState,
  RefreshOutcome,
  SkillProvenance,
} from "../../../core/frame-types.ts";

/**
 * A memory skill as agent_get sends it: with its provenance when the mod could work it out, else the bare skill
 * (mod/frames/agents.ts falls back to `skills` when `skillsInfo` is missing or fails).
 */
export type AgentSkill = MemorySkill & Partial<SkillProvenance>;

/** One agent as agent_get sends it: its record, its memory files and skills, whether it has a profile, and the last memory commit. */
export interface AgentDetails {
  agent: LocalAgent;
  files: MemoryFile[];
  skills: AgentSkill[];
  hasProfile: boolean;
  lastCommit: MemoryCommit | null;
}

/**
 * What the Agents section reads through the mod: an agent, its memory files and their history, the global skills, and
 * the skill and reflection reads and writes.
 */
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
  /** The background passes' settings (daemon/passes-state.ts): reflection and Learn on or off, Learn's cards a day, and their ACP fallback. */
  get: () => Promise<PassSettings | null>;
  set: (s: PassSettingsChange) => Promise<string | null>;
  /** Resolves to the harness's one-line answer ("Started a reflection pass…", "No new transcript content…"). */
  run: (rt: Runtime) => Promise<string>;
}

/** Writes through loki's daemon; each resolves to an error message or null. */
export interface AgentsWrite {
  createAgent: (opts: NewAgentOptions) => Promise<{ id: string } | { error: string }>;
  deleteAgent: (agentId: string) => Promise<string | null>;
  writeMemory: (agentId: string, path: string, content: string, message?: string) => Promise<string | null>;
  removeMemory: (agentId: string, path: string, message?: string) => Promise<string | null>;
  /** Undo one memory commit, by a new commit as yours. */
  revertMemory: (agentId: string, sha: string) => Promise<string | null>;
}

/** An edit to the agent's identity, as the daemon takes it (chat_agent_update): any of name, description, model. */
export interface AgentEdit {
  name?: string;
  description?: string;
  model?: string;
  /** The Mac the agent lives on (plan 023): new chats start there. */
  home_mac?: string;
}
