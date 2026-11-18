import type { AgentPage } from "./pages";
import type { AgentDetails, AgentSkill } from "./types";
import type { MemoryCommit } from "../../../core/frame-types.ts";

export type Reading = { kind: "file"; path: string } | { kind: "commit"; sha: string } | null;

export function firstAgentId(agents: ReadonlyArray<{ id: string }>): string | null {
  return agents[0]?.id ?? null;
}

export function shownSkillOf(d: AgentDetails | null, skillName: string | null): AgentSkill | null {
  return d ? (d.skills.find((x) => x.name === skillName) ?? d.skills.at(0) ?? null) : null;
}

export function shownShaOf(sha: string | null, log: MemoryCommit[]): string | null {
  return sha ?? log.at(0)?.sha ?? null;
}

export function readingFor(page: AgentPage, filePath: string, shownSha: string | null, shownSkill: AgentSkill | null, shownRun: string | null = null): Reading {
  if (page === "memory") return { kind: "file", path: filePath };
  if (page === "changes") return shownSha ? { kind: "commit", sha: shownSha } : null;
  if (page === "reflection") return shownRun ? { kind: "commit", sha: shownRun } : null;
  if (page === "skills") return shownSkill ? { kind: "file", path: shownSkill.path } : null;
  return null;
}
