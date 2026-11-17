import type {
  GlobalSkill,
  LocalAgent,
  MemoryCommit,
  MemoryFile,
  MemorySkill,
  MemorySkillInfo,
  ReflectionState,
  RefreshOutcome,
} from "../../core/frame-types.ts";
import { fail, reply, type FrameHandlers } from "./context.ts";

export interface AgentsDeps {
  agents?: {
    get: (agentId: string) => LocalAgent | null;
    tree: (agentId: string) => MemoryFile[];
    skills: (agentId: string) => MemorySkill[];
    hasProfile: (agentId: string) => boolean;
    read: (agentId: string, path: string) => string | null;
    log: (agentId: string, opts: { path?: string; limit?: number }) => Promise<MemoryCommit[]>;
    diff: (agentId: string, sha: string) => Promise<string>;
    reflection?: (agentId: string) => Promise<ReflectionState>;
    globalSkills?: () => GlobalSkill[];
    install?: (agentId: string, source: string, force: boolean) => Promise<string>;
    skillsInfo?: (agentId: string) => Promise<MemorySkillInfo[]>;
    refreshSkill?: (agentId: string, name: string, spec?: string) => Promise<RefreshOutcome>;
  };
}

export function agentsFrames({ agents: ag }: AgentsDeps): FrameHandlers {
  const off = () => fail("agents are not available in this mod");
  return {
    agent_get: async ({ agent_id: agentId }) => {
      if (!ag) return off();
      const agent = ag.get(agentId);
      if (!agent) return fail("no local record for this agent");
      const [last, skills] = await Promise.all([
        ag.log(agentId, { limit: 1 }).catch((): MemoryCommit[] => []),
        ag.skillsInfo ? ag.skillsInfo(agentId).catch(() => ag.skills(agentId)) : ag.skills(agentId),
      ]);
      return reply({ agent, files: ag.tree(agentId), skills, has_profile: ag.hasProfile(agentId), last_commit: last[0] ?? null });
    },
    memory_read: ({ agent_id: agentId, path }) => (ag ? reply({ agent_id: agentId, path, content: ag.read(agentId, path) }) : off()),
    memory_log: async ({ agent_id: agentId, path, limit }) => (ag ? reply({ agent_id: agentId, commits: await ag.log(agentId, { path, limit }) }) : off()),
    memory_diff: async ({ agent_id: agentId, sha }) => (ag ? reply({ agent_id: agentId, sha, diff: await ag.diff(agentId, sha) }) : off()),
    reflection_state: async ({ agent_id: agentId }) => {
      if (!ag?.reflection) return fail("reflection is not available in this mod");
      return reply({ agent_id: agentId, ...(await ag.reflection(agentId)) });
    },
    skills_global: () => reply({ skills: ag?.globalSkills?.() ?? [] }),
    skill_install: async ({ agent_id: agentId, source, force }) => {
      if (!ag?.install) return fail("skill install is not available in this mod");
      return reply({ agent_id: agentId, output: await ag.install(agentId, source, force) });
    },
    skill_refresh: async ({ agent_id: agentId, name, source }) => {
      if (!ag?.refreshSkill) return fail("skill refresh is not available in this mod");
      return reply({ agent_id: agentId, name, ...(await ag.refreshSkill(agentId, name, source)) });
    },
  };
}
