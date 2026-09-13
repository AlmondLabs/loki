import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isAgentId, memoryLog, type MemoryCommit } from "./agents.ts";

/**
 * Letta's sleep-time reflection, read from the outside. After a turn, Letta may launch a Reflection Subagent over a
 * conversation's unreflected transcript; what it keeps lands in the memory repo as commits by that author. Letta
 * keeps a state file per conversation under its transcript root (`steps_since_last_successful_reflection`, the last
 * pass's times) — the counters its step-count trigger compares against. The settings themselves live in Letta's
 * settings.json, per agent, and are read and written through the app-server (core/attention/protocol.ts), not here.
 */
/** Letta's transcript root: its own env override, else ~/.letta/transcripts (Letta Code src/agent/transcript-paths.ts). */
export const transcriptRoot = (): string => process.env.LETTA_TRANSCRIPT_ROOT?.trim() || join(homedir(), ".letta", "transcripts");

export interface ReflectionConversation {
  conversationId: string;
  title: string | null;
  /** Steps since the last pass that succeeded: what the step-count trigger compares against. */
  stepsSince: number;
  totalSteps: number;
  lastStartedAt: string | null;
  lastSucceededAt: string | null;
}

export interface ReflectionState {
  /** Most steps since a pass first: the conversations nearest the next one. */
  conversations: ReflectionConversation[];
  /** The newest memory commit a reflection pass made, or null when no pass has changed memory. */
  lastCommit: MemoryCommit | null;
}

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

/** Letta commits a pass's changes as "Reflection Subagent"; the agent's own commits carry its name. */
export const isReflectionCommit = (c: MemoryCommit): boolean => /reflection/i.test(c.author);

export async function reflectionState(agentId: string, titleOf: (conversationId: string) => string | null, opts: { root?: string; log?: (agentId: string) => Promise<MemoryCommit[]> } = {}): Promise<ReflectionState> {
  const conversations = readReflectionConversations(agentId, titleOf, opts.root);
  const commits = await (opts.log ?? ((id: string) => memoryLog(id, { limit: 100 })))(agentId).catch(() => [] as MemoryCommit[]);
  return { conversations, lastCommit: commits.find(isReflectionCommit) ?? null };
}
