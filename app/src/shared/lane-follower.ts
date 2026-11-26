import { useEffect, useState, useSyncExternalStore } from "react";
import { clockText, followStep, untilTime } from "../../../core/attention/lane-times.ts";
import type { FlowLane } from "../../../core/attention/use-attention.ts";
import { laneStore, type LaneDevice } from "./active-lane";
import { pageActivity } from "./page-activity";
import { useReplyHeld } from "./reply-hold";

const CHECK_EVERY_MS = 30_000;

export function useLaneFollower(device: LaneDevice, flow: Pick<FlowLane, "lanes" | "laneId" | "setLaneId">): string | null {
  const store = laneStore(device);
  const held = useReplyHeld();
  const switchedAt = useSyncExternalStore(store.subscribeSwitched, store.switchedAt, store.switchedAt);
  const [now, setNow] = useState(() => Date.now());
  const hasTimes = !!flow.lanes?.some((l) => (l.times?.length ?? 0) > 0);
  useEffect(() => {
    if (!hasTimes) return;
    const check = () => setNow(Date.now());
    const timer = setInterval(check, CHECK_EVERY_MS);
    const stopWatching = pageActivity(check);
    return () => {
      clearInterval(timer);
      stopWatching();
    };
  }, [hasTimes]);
  const { lanes, laneId, setLaneId } = flow;
  useEffect(() => {
    const step = followStep(lanes, switchedAt, held, laneId, new Date(now));
    if (step?.kind === "record") store.recordSwitch();
    else if (step?.kind === "switch") setLaneId(step.to, "schedule");
  }, [lanes, laneId, setLaneId, switchedAt, held, now, store]);
  const until = lanes ? untilTime(lanes, laneId, new Date(now)) : null;
  return until ? clockText(until) : null;
}
