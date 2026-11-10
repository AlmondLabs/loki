import { agentLane, agentOfLaneId, type Lane, type ResolvedLane } from "../../../core/attention/lanes.ts";
import { ownerAgentOf, type AttentionItem } from "../../../core/attention/model.ts";
import { createSessionValue } from "./session-value";

/**
 * The active lane on this device (plan 087, KTD4). Lanes are shared by every Mac and the phone; which one is active is
 * this device's own, kept in localStorage until the person switches, so the phone may sit in Everything while the Mac
 * sits in Work (R10). "" is Everything, and a new device starts there.
 */

/** Which shell keeps the value: each has its own key, so a Mac's browser tab and the shell never share one by accident. */
export type LaneDevice = "desktop" | "phone";

/** The localStorage key each shell keeps its active lane's id under. */
export const LANE_KEYS: Record<LaneDevice, string> = { desktop: "loki.desktop.lane", phone: "loki.phone.lane" };

/**
 * The stored active lane id for one shell, over `storage` (localStorage unless a test hands another). Anything stored
 * is kept as it is, even an id no lane has: it is read leniently by resolveLane, never rewritten until the person
 * switches, so a lane whose definition has not come yet is still on when it does.
 */
export function createActiveLaneStore(device: LaneDevice, storage: () => Storage = () => localStorage) {
  return createSessionValue(LANE_KEYS[device], (raw) => raw ?? "", storage);
}

const stores: Record<LaneDevice, ReturnType<typeof createActiveLaneStore>> = {
  desktop: createActiveLaneStore("desktop"),
  phone: createActiveLaneStore("phone"),
};

/** This shell's active lane id ("" is Everything) and its setter, `[id, setId]`, the same wherever it is read. */
export function useActiveLaneId(device: LaneDevice): [string, (id: string) => void] {
  return stores[device].use();
}

/**
 * The lane a stored id stands for, or null for Everything (KTD4). A lane the person made resolves while it is in the
 * list; an id the list lacks reads as Everything, and so does any id before the lanes first come (null). An agent's
 * built-in lane resolves from its id alone while the agent is known, by the agents list or a card of its, so it stays
 * on once its cards are worked through (R20); once the agent is gone the device is in Everything.
 */
export function resolveLane(lanes: Lane[] | null, items: AttentionItem[], agents: Array<{ id: string; name: string }>, id: string): ResolvedLane | null {
  if (!id) return null;
  const agentId = agentOfLaneId(id);
  if (agentId !== null) {
    const agent = agents.find((a) => a.id === agentId);
    const lane = agentLane(items, agentId);
    if (lane.count > 0) return lane;
    // No cards in Flow: the agent's own name, since agentLane can only name it from a card.
    if (agent) return { ...lane, name: agent.name };
    return items.some((i) => ownerAgentOf(i) === agentId) ? lane : null;
  }
  return lanes?.find((l) => l.id === id) ?? null;
}
