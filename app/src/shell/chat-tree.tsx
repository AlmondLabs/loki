import type { ChatSummary } from "../../../core/frame-types.ts";

export function agentChips(agents: Array<{ id: string; name: string }>, desks: ChatSummary[]): Array<{ id: string; name: string | null; count: number }> {
  const byId = new Map<string, { id: string; name: string | null; count: number }>();
  for (const a of agents) byId.set(a.id, { id: a.id, name: a.name, count: 0 });
  for (const d of desks) {
    if (d.status !== "live" || !d.agent_id) continue;
    const chip = byId.get(d.agent_id);
    if (chip) chip.count++;
    else byId.set(d.agent_id, { id: d.agent_id, name: d.agent_name, count: 1 });
  }
  return [...byId.values()];
}

export function deskMatches(d: ChatSummary, agentFilter: string | null, q: string): boolean {
  return (
    (!agentFilter || d.agent_id === agentFilter) &&
    (!q || (d.title ?? "").toLowerCase().includes(q) || d.scope.toLowerCase().includes(q) || (d.agent_name ?? "").toLowerCase().includes(q))
  );
}

export function liveDesks(desks: ChatSummary[], agentFilter: string | null, q: string): ChatSummary[] {
  return desks
    .filter((d) => d.status === "live" && d.scope !== "shared" && deskMatches(d, agentFilter, q))
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (b.last_active ?? "").localeCompare(a.last_active ?? ""));
}

export function archivedDesks(desks: ChatSummary[], agentFilter: string | null, q: string): ChatSummary[] {
  return desks.filter((d) => d.status !== "live" && deskMatches(d, agentFilter, q));
}
