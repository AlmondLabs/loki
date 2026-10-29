import type { DeskSummary } from "../../../core/frame-types.ts";

/**
 * The chat list helpers the phone shares (phone/home.tsx, phone/model.ts): the agent chips, the filter, and the live
 * and archived lists in their order.
 */

/** One chip per agent: the agents the server lists, plus any agent only the desks know, with its live desk count. */
export function agentChips(agents: Array<{ id: string; name: string }>, desks: DeskSummary[]): Array<{ id: string; name: string | null; count: number }> {
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

/** The filter: one agent (or null for all) and a lowercased query against title, scope and agent name. */
export function deskMatches(d: DeskSummary, agentFilter: string | null, q: string): boolean {
  return (
    (!agentFilter || d.agent_id === agentFilter) &&
    (!q || (d.title ?? "").toLowerCase().includes(q) || d.scope.toLowerCase().includes(q) || (d.agent_name ?? "").toLowerCase().includes(q))
  );
}

/** The main list: live desks (the shared sheet aside), pinned first, then by recency. */
export function liveDesks(desks: DeskSummary[], agentFilter: string | null, q: string): DeskSummary[] {
  return desks
    .filter((d) => d.status === "live" && d.scope !== "shared" && deskMatches(d, agentFilter, q))
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (b.last_active ?? "").localeCompare(a.last_active ?? ""));
}

/** The folded group at the bottom: archived and deleted, in the mod's order. */
export function archivedDesks(desks: DeskSummary[], agentFilter: string | null, q: string): DeskSummary[] {
  return desks.filter((d) => d.status !== "live" && deskMatches(d, agentFilter, q));
}

// The mark and the pin / archive rules live in the sidebar's model; the phone imports them from here.
export { deskMark, type MarkKind } from "./sidebar-model";
