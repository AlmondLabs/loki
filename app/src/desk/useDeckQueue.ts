import { useEffect, useRef, useState } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import { inboxQueue, mergeQueue, type Decision } from "../../../core/attention/queue.ts";

/**
 * The visit's queue and what it has decided so far. The current card never moves under your hands,
 * but the queue stays live: new items join by score, chats that leave the Inbox drop out, decided
 * ones fall out. The counts in the header follow. `items` are the ones the agent pill lets through;
 * a new pill (`filter`) builds the queue afresh from them, so the card on top changes with it.
 */
export function useDeckQueue(items: AttentionItem[], filter: string | null = null) {
  const [queue, setQueue] = useState<AttentionItem[]>(() => inboxQueue(items));
  const [decided, setDecided] = useState<Decision[]>([]);
  const filterRef = useRef(filter);

  // Live merge while open.
  useEffect(() => {
    const refilter = filterRef.current !== filter;
    filterRef.current = filter;
    setQueue((q) => mergeQueue(refilter ? [] : q, items, decided));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, filter]);

  return { queue, setQueue, decided, setDecided };
}
