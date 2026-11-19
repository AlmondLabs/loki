import { useEffect, useState, useSyncExternalStore } from "react";
import { clockText, followLane, untilTime } from "../../../core/attention/lane-times.ts";
import type { FlowLane } from "../../../core/attention/use-attention.ts";
import { laneStore, type LaneDevice } from "./active-lane";
import { pageActivity } from "./page-activity";

const CHECK_EVERY_MS = 30_000;

export function useLaneFollower(device: LaneDevice, flow: Pick<FlowLane, "lanes" | "laneId" | "setLaneId">, held = false): string | null {
  const store = laneStore(device);
  const switchedAt = useSyncExternalStore(store.subscribeSwitched, store.switchedAt, store.switchedAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const check = () => setNow(Date.now());
    const timer = setInterval(check, CHECK_EVERY_MS);
    const stopWatching = pageActivity(check);
    return () => {
      clearInterval(timer);
      stopWatching();
    };
  }, []);
  const { lanes, laneId, setLaneId } = flow;
  useEffect(() => {
    const next = followLane(lanes, switchedAt, held, new Date(now));
    if (next === null) return;
    if (next === laneId) store.recordSwitch();
    else setLaneId(next, "schedule");
  }, [lanes, laneId, setLaneId, switchedAt, held, now, store]);
  const until = lanes ? untilTime(lanes, laneId, new Date(now)) : null;
  return until ? clockText(until) : null;
}
