/**
 * Lanes (plan 082): the slice of work that reaches the person right now. A lane is a name and two sides, the agents
 * whose chats it holds and the Gmail and Slack accounts whose cards it holds, each side "all" or a picked list (KTD2).
 * An empty list is none, so "chats only" and "no chats" are both lanes. "all" takes in agents and accounts added later;
 * a picked id the device does not know matches nothing, which is how deleting an agent or account leaves every lane
 * without editing it on every Mac (R7).
 *
 * Each agent also has a built-in lane, its chats and the accounts it owns, listed while it has cards in Flow (R18).
 * Everything is no lane at all (null) and holds every card. Flow and its badges read a lane's items; the chat list and
 * search never do (KTD3).
 */
import { ownerAgentOf, type AttentionItem } from "./model.ts";
import { catchUpQueue, inboxQueue } from "./queue.ts";

/** One side of a lane: every agent or account, now and later, or the ones picked by id ([] is none). */
export type LaneSide = "all" | string[];

/** A lane the person made, as the shared marks store keeps it (KTD2): a chat matches `chats`, an outside card `accounts`. */
export interface Lane {
  id: string;
  name: string;
  /** Agent ids whose chats the lane holds. */
  chats: LaneSide;
  /** Account ids (`gmail:<address>`, `slack:<team>:<user>`) whose cards the lane holds. */
  accounts: LaneSide;
}

/** An agent's built-in lane (R18): its chats and the cards of the accounts it owns. It cannot be edited. */
export interface AgentLane {
  /** agentLaneId(agent_id), so it never collides with a lane the person made. */
  id: string;
  name: string;
  agent_id: string;
  /** How many of its cards are in Flow, which the switcher shows and orders by. */
  count: number;
}

/** A lane as Flow applies it: one the person made or an agent's built-in one. Everything is null. */
export type ResolvedLane = Lane | AgentLane;

/** A built-in agent lane's id, derived from the agent so every device names it the same way. */
export const agentLaneId = (agentId: string) => `agent:${agentId}`;

const isSide = (v: unknown): v is LaneSide => v === "all" || (Array.isArray(v) && v.every((id) => typeof id === "string"));

/** Whether a value is a whole lane: an id and a name that are not empty, and two sides. */
function isLane(v: unknown): v is Lane {
  if (!v || typeof v !== "object") return false;
  const l = v as Partial<Record<keyof Lane, unknown>>;
  return typeof l.id === "string" && l.id !== "" && typeof l.name === "string" && l.name.trim() !== "" && isSide(l.chats) && isSide(l.accounts);
}

/**
 * The lanes in what a client, a paired Mac or the file holds: a malformed lane is dropped and the rest kept, so one bad
 * entry from an older or newer loki does not cost the person every lane. Anything but a list reads as no lanes.
 */
export function parseLanes(v: unknown): Lane[] {
  return Array.isArray(v) ? v.filter(isLane) : [];
}

const onSide = (side: LaneSide, id: string) => side === "all" || side.includes(id);

/** Whether a lane holds this card: a chat by its agent, an outside card by its account, a built-in lane by owner (KTD3). */
export function inLane(item: AttentionItem, lane: ResolvedLane): boolean {
  if ("agent_id" in lane) return ownerAgentOf(item) === lane.agent_id;
  return item.outside ? onSide(lane.accounts, item.outside.account_id) : onSide(lane.chats, item.agent_id);
}

/** The cards a lane holds, in the order they came; Everything (null) holds every card, as the same list. */
export function laneItems(items: AttentionItem[], lane: ResolvedLane | null): AttentionItem[] {
  return lane ? items.filter((i) => inLane(i, lane)) : items;
}

/**
 * How many cards need the person in other lanes, Flow's quiet line (R14, KTD5): the needs-you count of every card less
 * that of the lane's, the same set the red badges count, so a card in two other lanes counts once. 0 in Everything.
 */
export function otherLanesCount(items: AttentionItem[], lane: ResolvedLane | null): number {
  return catchUpQueue(items).length - catchUpQueue(laneItems(items, lane)).length;
}

/** The name a card gives its owning agent: an outside card names the account's owner, a chat its agent. */
const ownerNameOf = (i: AttentionItem): string => (i.outside ? i.outside.owner_name : i.agent_name) ?? "agent";

/**
 * The built-in lanes the switcher lists (R18, KTD5): one per agent with cards in Flow, busiest first, then by name.
 * A card from an agent's account files under that agent, and a chat names its agent better than such a card does.
 */
export function agentLanes(items: AttentionItem[]): AgentLane[] {
  const by = new Map<string, AgentLane>();
  for (const i of inboxQueue(items)) {
    const agentId = ownerAgentOf(i);
    const lane = by.get(agentId) ?? { id: agentLaneId(agentId), name: ownerNameOf(i), agent_id: agentId, count: 0 };
    if (!i.outside && i.agent_name) lane.name = i.agent_name;
    lane.count++;
    by.set(agentId, lane);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * What `inbox_filtered` says of a lane switched to (KTD11): its kind, and the agent for a built-in agent lane. A lane
 * the person made goes by its kind alone, so its name never leaves the device.
 */
export function laneEvent(lane: ResolvedLane | null): { kind: "everything" | "own" | "agent"; agent: string | null } {
  if (!lane) return { kind: "everything", agent: null };
  return "agent_id" in lane ? { kind: "agent", agent: lane.agent_id } : { kind: "own", agent: null };
}

/**
 * One agent's built-in lane, for the active lane on a device: from agentLanes while it has cards, else with a count of
 * 0 and a name from any card of its, so a lane emptied by working through it stays on until the person leaves it.
 */
export function agentLane(items: AttentionItem[], agentId: string): AgentLane {
  const listed = agentLanes(items).find((l) => l.agent_id === agentId);
  if (listed) return listed;
  const one = items.find((i) => ownerAgentOf(i) === agentId);
  return { id: agentLaneId(agentId), name: one ? ownerNameOf(one) : "agent", agent_id: agentId, count: 0 };
}
