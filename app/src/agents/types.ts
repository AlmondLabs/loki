import type { NewAgentOptions } from "../../../core/attention/chat-client.ts";
import type { ModelEntry } from "../../../core/models.ts";

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

export type AgentSkill = MemorySkill & Partial<SkillProvenance>;

export interface AgentDetails {
  agent: LocalAgent;
  files: MemoryFile[];
  skills: AgentSkill[];
  hasProfile: boolean;
  lastCommit: MemoryCommit | null;
}

export interface AgentsApi {
  get: (agentId: string) => Promise<AgentDetails | null>;
  read: (agentId: string, path: string) => Promise<string | null>;
  log: (agentId: string, path?: string, limit?: number) => Promise<MemoryCommit[]>;
  diff: (agentId: string, sha: string) => Promise<string | null>;
  globalSkills: () => Promise<GlobalSkill[]>;
  installSkill: (agentId: string, source: string, force?: boolean) => Promise<string | null>;
  refreshSkill: (agentId: string, name: string, source?: string) => Promise<RefreshOutcome | { error: string }>;
  reflection: (agentId: string) => Promise<ReflectionState | null>;
}

export interface ReflectionControls {
  get: () => Promise<PassSettings | null>;
  set: (s: PassSettingsChange) => Promise<string | null>;
  run: (rt: Runtime) => Promise<string>;
}

export interface AgentsWrite {
  createAgent: (opts: NewAgentOptions) => Promise<{ id: string } | { error: string }>;
  deleteAgent: (agentId: string) => Promise<string | null>;
  writeMemory: (agentId: string, path: string, content: string, message?: string) => Promise<string | null>;
  removeMemory: (agentId: string, path: string, message?: string) => Promise<string | null>;
  revertMemory: (agentId: string, sha: string) => Promise<string | null>;
}

export type ModelChoice = Pick<ModelEntry, "handle" | "reasoning_effort">;

export interface AgentEdit {
  name?: string;
  description?: string;
  model?: string;
  home_mac?: string;
}
