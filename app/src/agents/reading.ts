import type { MemoryCommit } from "../../../mod/agents.ts";
import type { MemorySkillInfo } from "../../../mod/skill-sources.ts";
import type { AgentPage } from "./pages";
import type { AgentDetails } from "./types";

/** What the reading pane shows: the memory file, the commit, or the skill's SKILL.md — by page. */
export type Reading = { kind: "file"; path: string } | { kind: "commit"; sha: string } | null;

/** The first agent's id: what shows with nothing picked (the list not here yet, or the picked agent just deleted). */
export function firstAgentId(agents: ReadonlyArray<{ id: string }>): string | null {
  return agents[0]?.id ?? null;
}

/** The skill the skills page shows: the one picked by name, else the first; null with no agent or no skills. */
export function shownSkillOf(d: AgentDetails | null | undefined, skillName: string | null): MemorySkillInfo | null {
  return d ? d.skills.find((x) => x.name === skillName) ?? d.skills[0] ?? null : null;
}

/** The commit the changes page shows: the one picked, else the newest; null with no commits. */
export function shownShaOf(sha: string | null, log: MemoryCommit[]): string | null {
  return sha ?? log[0]?.sha ?? null;
}

export function readingFor(page: AgentPage, filePath: string, shownSha: string | null, shownSkill: MemorySkillInfo | null): Reading {
  if (page === "memory") return { kind: "file", path: filePath };
  if (page === "changes") return shownSha ? { kind: "commit", sha: shownSha } : null;
  if (page === "skills") return shownSkill ? { kind: "file", path: shownSkill.path } : null;
  return null;
}
