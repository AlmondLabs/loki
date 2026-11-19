import { agentLane, agentOfLaneId, type Lane, type ResolvedLane } from "../../../core/attention/lanes.ts";
import { ownerAgentOf, type AttentionItem } from "../../../core/attention/model.ts";
import { createSessionValue } from "./session-value";

export type LaneDevice = "desktop" | "phone";

export const LANE_KEYS: Record<LaneDevice, string> = { desktop: "loki.desktop.lane", phone: "loki.phone.lane" };

export const LANE_SWITCH_KEYS: Record<LaneDevice, string> = { desktop: "loki.desktop.lane_switched", phone: "loki.phone.lane_switched" };

export function createActiveLaneStore(device: LaneDevice, storage: () => Storage = () => localStorage, clock: () => number = Date.now) {
  const id = createSessionValue(LANE_KEYS[device], (raw) => raw ?? "", storage);
  const switched = createSessionValue(LANE_SWITCH_KEYS[device], (raw) => raw ?? "", storage);
  const recordSwitch = () => switched.set(new Date(clock()).toISOString());
  const set = (next: string) => {
    recordSwitch();
    id.set(next);
  };
  const switchedAt = () => {
    const t = Date.parse(switched.get());
    return Number.isNaN(t) ? null : t;
  };
  const use = (): [string, (next: string) => void] => [id.use()[0], set];
  return { get: id.get, set, use, recordSwitch, switchedAt, subscribeSwitched: switched.subscribe };
}

const stores: Record<LaneDevice, ReturnType<typeof createActiveLaneStore>> = {
  desktop: createActiveLaneStore("desktop"),
  phone: createActiveLaneStore("phone"),
};

export function useActiveLaneId(device: LaneDevice): [string, (id: string) => void] {
  return stores[device].use();
}

export function laneStore(device: LaneDevice) {
  return stores[device];
}

export function resolveLane(lanes: Lane[] | null, items: AttentionItem[], agents: Array<{ id: string; name: string }>, id: string): ResolvedLane | null {
  if (!id) return null;
  const agentId = agentOfLaneId(id);
  if (agentId !== null) {
    const agent = agents.find((a) => a.id === agentId);
    const lane = agentLane(items, agentId);
    if (lane.count > 0) return lane;
    if (agent) return { ...lane, name: agent.name };
    return items.some((i) => ownerAgentOf(i) === agentId) ? lane : null;
  }
  return lanes?.find((l) => l.id === id) ?? null;
}

export function resolveDesktopLane(lanes: Lane[] | null, items: AttentionItem[], agents: Array<{ id: string; name: string }>, id: string): ResolvedLane | null {
  return agentOfLaneId(id) === null ? resolveLane(lanes, items, agents, id) : null;
}
