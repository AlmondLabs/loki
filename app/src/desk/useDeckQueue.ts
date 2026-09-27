import { useEffect, useRef, useState } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import { catchUpQueue, mergeQueue, type Decision } from "../../../core/attention/queue.ts";

/**
 * The pass's queue and what it has decided so far. The current card never moves under your hands,
 * but the queue stays live: new items join at the end, items resolved elsewhere drop out, decided
 * ones fall out. The count in the header follows. `items` are the ones the agent pill lets through;
 * a new pill (`filter`) builds the queue afresh from them, so the card on top changes with it.
 */
export function useDeckQueue(items: AttentionItem[], showSnoozed: boolean, filter: string | null = null) {
  const [queue, setQueue] = useState<AttentionItem[]>(() => catchUpQueue(items, showSnoozed));
  const [decided, setDecided] = useState<Decision[]>([]);
  const filterRef = useRef(filter);

  // Live merge while open.
  useEffect(() => {
    const refilter = filterRef.current !== filter;
    filterRef.current = filter;
    setQueue((q) => mergeQueue(refilter ? [] : q, items, decided, showSnoozed));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, showSnoozed, filter]);

  return { queue, setQueue, decided, setDecided };
}
