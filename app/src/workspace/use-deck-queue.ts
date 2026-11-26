import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import { inLane, type ResolvedLane } from "../../../core/attention/lanes.ts";
import { byScore } from "../../../core/attention/priority.ts";
import { idOf, flowQueue, leaveRow, mergeQueue, type Decision } from "../../../core/attention/queue.ts";
import { inKind, type FlowKind } from "./flow-kinds";

export function switchLane(
  queue: AttentionItem[],
  items: AttentionItem[],
  lane: ResolvedLane | null,
  decided: Decision[],
  resting: boolean,
  selectedId: string | null,
  kind: FlowKind = "all",
): AttentionItem[] {
  const selected = queue.find((i) => idOf(i) === selectedId);
  const kept = selected && (!lane || inLane(selected, lane)) && inKind(selected, kind) ? [selected] : [];
  return byScore(mergeQueue(kept, items, decided, { resting, selectedId: kept.length ? selectedId : null }));
}

const selectedOf = (queue: AttentionItem[], id: string | null) => queue.find((i) => idOf(i) === id) ?? queue.at(0);

export function useDeckQueue(items: AttentionItem[], lane: ResolvedLane | null = null, resting = false, kind: FlowKind = "all") {
  const [queue, setQueue] = useState<AttentionItem[]>(() => flowQueue(items, resting));
  const [decided, setDecided] = useState<Decision[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const picked = useRef<string | null>(null);
  const selected = selectedOf(queue, selectedId);
  const pinned = selected ? idOf(selected) : null;
  const laneId = `${lane?.id ?? ""}\u0000${kind}`;
  const laneRef = useRef(laneId);
  const restingRef = useRef(resting);

  const merge = useEffectEvent((switched: boolean, again: boolean) =>
    setQueue((q) =>
      again
        ? mergeQueue([], items, [], { resting })
        : switched
          ? switchLane(q, items, lane, decided, resting, pinned, kind)
          : mergeQueue(q, items, decided, { resting, selectedId: pinned }),
    ),
  );
  useEffect(() => {
    const again = restingRef.current !== resting;
    const switched = laneRef.current !== laneId;
    laneRef.current = laneId;
    restingRef.current = resting;
    merge(switched, again);
  }, [items, laneId, resting]);

  const select = (id: string | null) => {
    picked.current = id;
    setSelectedId(id);
    if (pinned !== null && pinned !== id) setQueue((q) => leaveRow(q, pinned, items, resting));
  };
  const selectedNow = () => selectedOf(queue, picked.current);

  return { queue, setQueue, decided, setDecided, selected, select, selectedNow };
}
