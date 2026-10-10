import { lokiDir } from "./paths.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { memoryLog } from "./agents.ts";
import { isAgentId } from "../core/frames.ts";
import type { MemoryCommit, ReflectionConversation, ReflectionState } from "../core/frame-types.ts";

/**
 * Reflection, read for the Agents page. Once a chat has been quiet, the daemon may run a reflection pass over what
 * it has not yet reflected on (daemon/reflection.ts); what it keeps lands in the memory repo as commits by
 * "Reflection". The daemon keeps a state file per chat under its transcript root
 * (`steps_since_last_successful_reflection`, the last pass's times, in the shape Letta used so imported counters
 * carry over) — the counters its step-count trigger compares against. The settings themselves are the daemon's, read
 * and written through the mod's chat frames (core/attention/protocol.ts has their shape), not here.
 */
/** Where the daemon keeps each chat's reflection counters (daemon/reflection.ts): <loki>/reflection. */
export const transcriptRoot = (): string => process.env.LOKI_REFLECTION_DIR?.trim() || join(lokiDir(), "reflection");

const isoOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);

/** Every conversation of the agent that has a state file, most steps since a pass first. Unreadable files are skipped. */
export function readReflectionConversations(agentId: string, titleOf: (conversationId: string) => string | null, root = transcriptRoot()): ReflectionConversation[] {
  if (!isAgentId(agentId)) return [];
  const dir = join(root, agentId);
  if (!existsSync(dir)) return [];
  const out: ReflectionConversation[] = [];
  for (const name of readdirSync(dir)) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(readFileSync(join(dir, name, "state.json"), "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    out.push({
      conversationId: name,
      title: titleOf(name),
      stepsSince: count(raw.steps_since_last_successful_reflection),
      totalSteps: count(raw.total_completed_steps),
      lastStartedAt: isoOrNull(raw.last_reflection_started_at),
      lastSucceededAt: isoOrNull(raw.last_reflection_succeeded_at),
    });
  }
  return out.sort((a, b) => b.stepsSince - a.stepsSince || (b.lastSucceededAt ?? "").localeCompare(a.lastSucceededAt ?? ""));
}

/** A pass's commits are by "Reflection" (by "Reflection Subagent" in history imported from Letta); the agent's own carry its name. */
export const isReflectionCommit = (c: MemoryCommit): boolean => /reflection/i.test(c.author);

export async function reflectionState(agentId: string, titleOf: (conversationId: string) => string | null, opts: { root?: string; log?: (agentId: string) => Promise<MemoryCommit[]> } = {}): Promise<ReflectionState> {
  const conversations = readReflectionConversations(agentId, titleOf, opts.root);
  const commits = await (opts.log ?? ((id: string) => memoryLog(id, { limit: 100 })))(agentId).catch(() => [] as MemoryCommit[]);
  return { conversations, lastCommit: commits.find(isReflectionCommit) ?? null };
}
