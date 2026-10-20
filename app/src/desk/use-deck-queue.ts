import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import { inboxQueue, mergeQueue, type Decision } from "../../../core/attention/queue.ts";

/**
 * The visit's queue and what it has decided so far. The current card never moves under your hands,
 * but the queue stays live: new items join by score, chats that leave the Inbox drop out, decided
 * ones fall out. The counts in the header follow. `items` are the ones the agent pill lets through;
 * a new pill (`filter`) builds the queue afresh from them, so the card on top changes with it. `resting` lets the
 * cards Next has rested in too (core/attention/rest.ts), those moved past in this visit included, once you ask to
 * go through them.
 */
export function useDeckQueue(items: AttentionItem[], filter: string | null = null, resting = false) {
  const [queue, setQueue] = useState<AttentionItem[]>(() => inboxQueue(items, resting));
  const [decided, setDecided] = useState<Decision[]>([]);
  const filterRef = useRef(filter);
  const restingRef = useRef(resting);

  // Live merge while open.
  const merge = useEffectEvent((refilter: boolean, again: boolean) => setQueue((q) => mergeQueue(refilter ? [] : q, items, again ? [] : decided, resting)));
  useEffect(() => {
    const again = restingRef.current !== resting;
    const refilter = filterRef.current !== filter || again;
    filterRef.current = filter;
    restingRef.current = resting;
    merge(refilter, again);
  }, [items, filter, resting]);

  return { queue, setQueue, decided, setDecided };
}
