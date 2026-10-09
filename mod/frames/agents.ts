import type { GlobalSkill, LocalAgent, MemoryCommit, MemoryFile, MemorySkill, MemorySkillInfo, ReflectionState, RefreshOutcome } from "../../core/frame-types.ts";
import { fail, reply, type FrameHandlers } from "./context.ts";

export interface AgentsDeps {
  /** The Agents page: the local record and the memory filesystem (mod/agents.ts), read-only. */
  agents?: {
    get: (agentId: string) => LocalAgent | null;
    tree: (agentId: string) => MemoryFile[];
    skills: (agentId: string) => MemorySkill[];
    hasProfile: (agentId: string) => boolean;
    read: (agentId: string, path: string) => string | null;
    log: (agentId: string, opts: { path?: string; limit?: number }) => Promise<MemoryCommit[]>;
    diff: (agentId: string, sha: string) => Promise<string>;
    /** Letta's reflection counters per conversation and the last pass that changed memory (mod/reflection.ts). */
    reflection?: (agentId: string) => Promise<ReflectionState>;
    /** Skills outside memory (mod/skills.ts). */
    globalSkills?: () => GlobalSkill[];
    install?: (agentId: string, source: string, force: boolean) => Promise<string>;
    /** Memory skills with origin (self/other), edited, and source (mod/skill-sources.ts); agent_get prefers this over `skills`. */
    skillsInfo?: (agentId: string) => Promise<MemorySkillInfo[]>;
    /** Fetch an other skill's upstream and replace, stage for reconciliation, or report current. */
    refreshSkill?: (agentId: string, name: string, spec?: string) => Promise<RefreshOutcome>;
  };
}

/** The Agents pages: an agent's record, its memory files, history and diffs, reflection, and its skills. */
export function agentsFrames({ agents: ag }: AgentsDeps): FrameHandlers {
  const off = () => fail("agents are not available in this mod");
  return {
    agent_get: async ({ agentId }) => {
      if (!ag) return off();
      const agent = ag.get(agentId);
      if (!agent) return fail("no local record for this agent");
      const last = await ag.log(agentId, { limit: 1 }).catch((): MemoryCommit[] => []);
      const skills = await (ag.skillsInfo ? ag.skillsInfo(agentId).catch(() => ag.skills(agentId)) : ag.skills(agentId));
      return reply({ agent, files: ag.tree(agentId), skills, hasProfile: ag.hasProfile(agentId), lastCommit: last[0] ?? null });
    },
    memory_read: ({ agentId, path }) => (ag ? reply({ agentId, path, content: ag.read(agentId, path) }) : off()),
    memory_log: async ({ agentId, path, limit }) => (ag ? reply({ agentId, commits: await ag.log(agentId, { path, limit }) }) : off()),
    memory_diff: async ({ agentId, sha }) => (ag ? reply({ agentId, sha, diff: await ag.diff(agentId, sha) }) : off()),
    reflection_state: async ({ agentId }) => {
      if (!ag?.reflection) return fail("reflection is not available in this mod");
      return reply({ agentId, ...(await ag.reflection(agentId)) });
    },
    skills_global: () => reply({ skills: ag?.globalSkills?.() ?? [] }),
    skill_install: async ({ agentId, source, force }) => {
      if (!ag?.install) return fail("skill install is not available in this mod");
      return reply({ agentId, output: await ag.install(agentId, source, force) });
    },
    skill_refresh: async ({ agentId, name, source }) => {
      if (!ag?.refreshSkill) return fail("skill refresh is not available in this mod");
      return reply({ agentId, name, ...(await ag.refreshSkill(agentId, name, source)) });
    },
  };
}
