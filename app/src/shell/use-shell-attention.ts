import { useAttention } from "../../../core/attention/use-attention.ts";
import { resolveDesktopLane, useActiveLaneId } from "../shared/active-lane";
import { pageActivity, pageVisibility } from "../shared/page-activity";
import type { Workspace } from "./types";

export function useShellAttention(desk: Workspace) {
  const { attention } = desk;
  const [laneId, setLaneId] = useActiveLaneId("desktop");
  const catchUp = useAttention({
    lane: { id: laneId, setId: setLaneId, lanes: attention.lanes, setLanes: attention.setLanes, resolve: resolveDesktopLane },
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
    listConversations: attention.listFlow,
    sent: (rt) => desk.models.sentIn(rt.conversation_id, rt.agent_id),
    activity: pageActivity,
    visibility: pageVisibility,
  });
  return catchUp;
}
