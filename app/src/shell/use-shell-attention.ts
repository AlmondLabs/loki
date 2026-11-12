import { useAttention } from "../../../core/attention/use-attention.ts";
import { resolveLane, useActiveLaneId } from "../shared/active-lane";
import { pageActivity, pageVisibility } from "../shared/page-activity";
import type { Desk } from "./types";

/**
 * The attention model a desktop window works from: this Mac's lane (plan 087), the mod's seen, focus and rest state,
 * and the chats on disk, all through the window's link to the daemon. The main window and the Settings window (plan
 * 2026-11-12-1505, U18) each hold one, so both read the same cards, agents, labels and providers. `capture` is the
 * window's analytics, which the main window tags with the view on screen.
 */
export function useShellAttention(desk: Desk, capture: (event: string, properties?: Record<string, unknown>) => void) {
  const { attention } = desk;
  const [laneId, setLaneId] = useActiveLaneId("desktop");
  const catchUp = useAttention({
    lane: { id: laneId, setId: setLaneId, lanes: attention.lanes, setLanes: attention.setLanes, resolve: resolveLane },
    enabled: attention.available,
    makeClient: attention.makeClient,
    seen: attention.seen,
    viewed: attention.viewed,
    focus: attention.focus,
    engage: attention.engage,
    rests: attention.rests,
    rest: attention.rest,
    returnTimes: attention.returnTimes,
    markSeen: attention.markSeen,
    unmarkSeen: attention.unmarkSeen,
    loadLocalHistory: attention.loadHistory,
    loadLocalStep: attention.loadStep,
    listConversations: attention.listInbox,
    capture,
    // The model picker's recent models are least recently used: a message into a chat moves its model to the front.
    sent: (rt) => desk.models.sentIn(rt.conversation_id, rt.agent_id),
    activity: pageActivity,
    visibility: pageVisibility,
  });
  return { catchUp, laneId };
}
