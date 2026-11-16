import { memoryLog } from "./agents.ts";
import type { MemoryCommit, ReflectionState } from "../core/frame-types.ts";

export const isReflectionCommit = (c: MemoryCommit): boolean => /reflection/i.test(c.author);

export async function reflectionState(agentId: string, opts: { log?: (agentId: string) => Promise<MemoryCommit[]> } = {}): Promise<ReflectionState> {
  const commits = await (opts.log ?? ((id: string) => memoryLog(id, { limit: 100 })))(agentId).catch(() => [] as MemoryCommit[]);
  return { last_commit: commits.find(isReflectionCommit) ?? null };
}
