import type { AttentionItem } from "../../../core/attention/model.ts";
import { catchUpQueue } from "../../../core/attention/queue.ts";

export function liveDeskCount(desks: Array<{ agent_id: string | null; status: string }>, agentId: string): number {
  return desks.filter((d) => d.agent_id === agentId && d.status === "live").length;
}

export function liveDesksLabel(n: number): string {
  return n === 0 ? "No chats live" : `${n} chat${n === 1 ? "" : "s"} live`;
}

export function stripFrontmatter(md: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(md);
  return m ? md.slice(m[0].length) : md;
}

export interface AgentRowModel {
  id: string;
  name: string;
  live: number;
  running: boolean;
  waiting: number;
}

export function agentRows(
  agents: Array<{ id: string; name: string }>,
  desks: Array<{ agent_id: string | null; status: string }>,
  items: AttentionItem[],
): AgentRowModel[] {
  const ready = catchUpQueue(items);
  return agents.map((a) => ({
    id: a.id,
    name: a.name,
    live: liveDeskCount(desks, a.id),
    running: items.some((i) => i.agent_id === a.id && i.status === "running"),
    waiting: ready.filter((i) => i.agent_id === a.id).length,
  }));
}
