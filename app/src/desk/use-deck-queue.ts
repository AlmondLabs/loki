import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import { inLane, type ResolvedLane } from "../../../core/attention/lanes.ts";
import { inboxQueue, mergeQueue, type Decision } from "../../../core/attention/queue.ts";

/**
 * The queue after a lane switch (plan 087, KTD6): the card on top stays on top when the new lane holds it; otherwise
 * the queue is built afresh from the new lane's cards and the card is left as it was, with nothing recorded on it.
 * Cards moved past this visit stay out, in any lane, until something new comes, since the visit carries across.
 */
export function switchLane(queue: AttentionItem[], items: AttentionItem[], lane: ResolvedLane | null, decided: Decision[], resting: boolean): AttentionItem[] {
  const head = queue.at(0);
  return mergeQueue(head && (!lane || inLane(head, lane)) ? [head] : [], items, decided, resting);
}

/**
 * The visit's queue and what it has decided so far. The current card never moves under your hands,
 * but the queue stays live: new items join by score, chats that leave Flow drop out, decided
 * ones fall out. The counts in the header follow. `items` are the cards the active `lane` holds; a switch to another
 * lane rebuilds the queue from them (switchLane). `resting` lets the cards Next has rested in too
 * (core/attention/rest.ts), those moved past in this visit included, once you ask to go through them.
 */
export function useDeckQueue(items: AttentionItem[], lane: ResolvedLane | null = null, resting = false) {
  const [queue, setQueue] = useState<AttentionItem[]>(() => inboxQueue(items, resting));
  const [decided, setDecided] = useState<Decision[]>([]);
  // A lane is known by its id: an agent lane is a new object whenever its count changes.
  const laneId = lane?.id ?? "";
  const laneRef = useRef(laneId);
  const restingRef = useRef(resting);

  // Live merge while open.
  const merge = useEffectEvent((switched: boolean, again: boolean) =>
    setQueue((q) =>
      again ? mergeQueue([], items, [], resting) : switched ? switchLane(q, items, lane, decided, resting) : mergeQueue(q, items, decided, resting),
    ),
  );
  useEffect(() => {
    const again = restingRef.current !== resting;
    const switched = laneRef.current !== laneId;
    laneRef.current = laneId;
    restingRef.current = resting;
    merge(switched, again);
  }, [items, laneId, resting]);

  return { queue, setQueue, decided, setDecided };
}
