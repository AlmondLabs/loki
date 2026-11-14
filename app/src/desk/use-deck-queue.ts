import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import { inLane, type ResolvedLane } from "../../../core/attention/lanes.ts";
import { byScore } from "../../../core/attention/priority.ts";
import { idOf, inboxQueue, leaveRow, mergeQueue, type Decision } from "../../../core/attention/queue.ts";

/**
 * The rows after a lane switch (plan 087, KTD6; plan 2026-11-14-1330, KTD5): the new lane's cards sorted afresh by
 * score, the selected card among them when the new lane holds it; otherwise it is left as it was, with nothing recorded
 * on it. Cards moved past this visit stay out, in any lane, until something new comes, since the visit carries across.
 */
export function switchLane(
  queue: AttentionItem[],
  items: AttentionItem[],
  lane: ResolvedLane | null,
  decided: Decision[],
  resting: boolean,
  selectedId: string | null,
): AttentionItem[] {
  const selected = queue.find((i) => idOf(i) === selectedId);
  const kept = selected && (!lane || inLane(selected, lane)) ? [selected] : [];
  return byScore(mergeQueue(kept, items, decided, { resting, selectedId: kept.length ? selectedId : null }));
}

/** The row a selection names, else the first row, as a list with nothing picked shows it. */
const selectedOf = (queue: AttentionItem[], id: string | null) => queue.find((i) => idOf(i) === id) ?? queue.at(0);

/**
 * The visit's rows, the selected card and what the visit has decided so far. The rows stay live without reordering:
 * new items join under the selection by score, chats that leave Flow drop out, decided ones fall out (mergeQueue).
 * `items` are the cards the active `lane` holds; a switch to another lane sorts the rows afresh from them (switchLane).
 * `resting` lets the cards Next has rested in too (core/attention/rest.ts), those moved past in this visit included,
 * once you ask to go through them, sorted afresh as well.
 */
export function useDeckQueue(items: AttentionItem[], lane: ResolvedLane | null = null, resting = false) {
  const [queue, setQueue] = useState<AttentionItem[]>(() => inboxQueue(items, resting));
  const [decided, setDecided] = useState<Decision[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The selection as last set, read by a move in the same event that committed it (a highlight, then E: AE4).
  const picked = useRef<string | null>(null);
  const selected = selectedOf(queue, selectedId);
  const pinned = selected ? idOf(selected) : null;
  // A lane is known by its id: an agent lane is a new object whenever its count changes.
  const laneId = lane?.id ?? "";
  const laneRef = useRef(laneId);
  const restingRef = useRef(resting);

  // Live merge while open.
  const merge = useEffectEvent((switched: boolean, again: boolean) =>
    setQueue((q) =>
      again
        ? mergeQueue([], items, [], { resting })
        : switched
          ? switchLane(q, items, lane, decided, resting, pinned)
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

  /** Select a card by id, or null for the first row; a card held only because it was selected goes as the selection leaves it (R11). */
  const select = (id: string | null) => {
    picked.current = id;
    setSelectedId(id);
    if (pinned !== null && pinned !== id) setQueue((q) => leaveRow(q, pinned, items, resting));
  };
  /** The selected row at this moment, a selection made earlier in the same event included. */
  const selectedNow = () => selectedOf(queue, picked.current);

  return { queue, setQueue, decided, setDecided, selected, select, selectedNow };
}
