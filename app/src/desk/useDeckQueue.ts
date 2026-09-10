import { useEffect, useState } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import { catchUpQueue, mergeQueue, type Decision } from "../../../core/attention/queue.ts";

/**
 * The pass's queue and what it has decided so far. The current card never moves under your hands,
 * but the queue stays live: new items join at the end, items resolved elsewhere drop out, decided
 * ones fall out. The count in the header follows.
 */
export function useDeckQueue(items: AttentionItem[], showSnoozed: boolean) {
  const [queue, setQueue] = useState<AttentionItem[]>(() => catchUpQueue(items, showSnoozed));
  const [decided, setDecided] = useState<Decision[]>([]);

  // Live merge while open.
  useEffect(() => {
    setQueue((q) => mergeQueue(q, items, decided, showSnoozed));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, showSnoozed]);

  return { queue, setQueue, decided, setDecided };
}
