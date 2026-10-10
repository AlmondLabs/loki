import { memoryLog } from "./agents.ts";
import type { MemoryCommit, ReflectionState } from "../core/frame-types.ts";

/**
 * Reflection, read for the Agents page. Reflection is one of the daemon's background passes (daemon/passes.ts,
 * daemon/reflection.ts); what it keeps lands in the memory repo as commits by "Reflection". Whether it runs is the
 * daemon's setting, read and written through the mod's chat frames, not here.
 */

/** A pass's commits are by "Reflection" (by "Reflection Subagent" in history imported from Letta); the agent's own carry its name. */
export const isReflectionCommit = (c: MemoryCommit): boolean => /reflection/i.test(c.author);

export async function reflectionState(agentId: string, opts: { log?: (agentId: string) => Promise<MemoryCommit[]> } = {}): Promise<ReflectionState> {
  const commits = await (opts.log ?? ((id: string) => memoryLog(id, { limit: 100 })))(agentId).catch(() => [] as MemoryCommit[]);
  return { lastCommit: commits.find(isReflectionCommit) ?? null };
}
