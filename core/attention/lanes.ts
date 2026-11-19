import { ownerAgentOf, type AttentionItem } from "./model.ts";
import { catchUpQueue, inboxQueue } from "./queue.ts";

/** One side of a lane: every agent or account, now and later, or the ones picked by id ([] is none). */
export type LaneSide = "all" | string[];

export interface Lane {
  id: string;
  name: string;
  /** Agent ids whose chats the lane holds. */
  chats: LaneSide;
  /** Account ids (`gmail:<address>`, `slack:<team>:<user>`, `jira:<site>:<user>`) whose cards the lane holds. */
  accounts: LaneSide;
  /** When the lane switches on by itself (plan 2026-11-19-1851). Missing or empty means only by hand. */
  times?: LaneWindow[];
}

/**
 * A window of a lane's switching times: `days` are weekdays (0 is Sunday), `start` and `end` are "HH:MM" on a 24-hour
 * clock in each device's own zone, and an end at or before the start runs past midnight. `since` is the ISO time the
 * window was added or last changed; its starts and ends before then never switch a device.
 */
export interface LaneWindow {
  days: number[];
  start: string;
  end: string;
  since: string;
}

export interface AgentLane {
  id: string;
  name: string;
  agent_id: string;
  count: number;
}

export type ResolvedLane = Lane | AgentLane;

const AGENT_LANE = "agent:";

export const agentLaneId = (agentId: string) => `${AGENT_LANE}${agentId}`;

export const agentOfLaneId = (id: string): string | null => (id.startsWith(AGENT_LANE) ? id.slice(AGENT_LANE.length) : null);

const isSide = (v: unknown): v is LaneSide => v === "all" || (Array.isArray(v) && v.every((id) => typeof id === "string"));

function isLane(v: unknown): v is Lane {
  if (!v || typeof v !== "object") return false;
  const l = v as Partial<Record<keyof Lane, unknown>>;
  return typeof l.id === "string" && l.id !== "" && typeof l.name === "string" && l.name.trim() !== "" && isSide(l.chats) && isSide(l.accounts);
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function isWindow(v: unknown): v is LaneWindow {
  if (!v || typeof v !== "object") return false;
  const w = v as Partial<Record<keyof LaneWindow, unknown>>;
  return (
    Array.isArray(w.days) &&
    w.days.length > 0 &&
    w.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) &&
    typeof w.start === "string" &&
    HHMM.test(w.start) &&
    typeof w.end === "string" &&
    HHMM.test(w.end) &&
    w.start !== w.end &&
    typeof w.since === "string" &&
    !Number.isNaN(Date.parse(w.since))
  );
}

function withGoodTimes(lane: Lane): Lane {
  if (!("times" in lane)) return lane;
  const times: unknown = lane.times;
  const good = Array.isArray(times) ? times.filter(isWindow) : [];
  if (Array.isArray(times) && good.length === times.length) return lane;
  const { times: _bad, ...rest } = lane;
  return good.length > 0 ? { ...rest, times: good } : rest;
}

export function parseLanes(v: unknown): Lane[] {
  return Array.isArray(v) ? v.filter(isLane).map(withGoodTimes) : [];
}

const onSide = (side: LaneSide, id: string) => side === "all" || side.includes(id);

export function inLane(item: AttentionItem, lane: ResolvedLane): boolean {
  if ("agent_id" in lane) return ownerAgentOf(item) === lane.agent_id;
  return item.outside ? onSide(lane.accounts, item.outside.account_id) : onSide(lane.chats, item.agent_id);
}

export function laneItems(items: AttentionItem[], lane: ResolvedLane | null): AttentionItem[] {
  return lane ? items.filter((i) => inLane(i, lane)) : items;
}

export function otherLanesCount(items: AttentionItem[], lane: ResolvedLane | null): number {
  return catchUpQueue(items).length - catchUpQueue(laneItems(items, lane)).length;
}

const ownerNameOf = (i: AttentionItem): string => (i.outside ? i.outside.owner_name : i.agent_name) ?? "agent";

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

export function laneEvent(id: string): { kind: "everything" | "own" | "agent"; agent: string | null } {
  if (!id) return { kind: "everything", agent: null };
  const agent = agentOfLaneId(id);
  return agent !== null ? { kind: "agent", agent } : { kind: "own", agent: null };
}

export function agentLane(items: AttentionItem[], agentId: string): AgentLane {
  const listed = agentLanes(items).find((l) => l.agent_id === agentId);
  if (listed) return listed;
  const one = items.find((i) => ownerAgentOf(i) === agentId);
  return { id: agentLaneId(agentId), name: one ? ownerNameOf(one) : "agent", agent_id: agentId, count: 0 };
}
