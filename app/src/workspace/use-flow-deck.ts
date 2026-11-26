import { useEffect, useEffectEvent, useMemo, useState } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import { inLane, laneItems, type ResolvedLane } from "../../../core/attention/lanes.ts";
import { kindItems, type FlowKind } from "./flow-kinds";
import { idOf, flowQueue } from "../../../core/attention/queue.ts";
import { rowAfter, type DeckMoveApi } from "./deck-moves";
import { prefetchOutside, type OutsideThreadSource } from "./outside-card";
import { useDeckActions } from "./use-deck-actions";
import { useDeckQueue } from "./use-deck-queue";

export function answeredElsewhere(item: AttentionItem, items: readonly AttentionItem[], resting: boolean, touched: ReadonlySet<string>): boolean {
  const id = idOf(item);
  const now = items.find((i) => idOf(i) === id);
  if (now && flowQueue([now], resting).length > 0) return false;
  return !(now?.status === "running" && touched.has(id));
}

export function liveRows(queue: readonly AttentionItem[], live: ReadonlyMap<string, AttentionItem>): AttentionItem[] {
  return queue.map((i) => live.get(idOf(i)) ?? i);
}

export interface FlowDeckOptions {
  items: AttentionItem[];
  lane: ResolvedLane | null;
  kind?: FlowKind;
  moves: DeckMoveApi;
  onSignIn?: () => void;
  onShown?: (item: AttentionItem) => void;
  loadHistory: (item: AttentionItem) => void;
  outsideSource?: OutsideThreadSource | null;
}

export function useFlowDeck({ items, lane, kind = "all", moves, onSignIn, onShown, loadHistory, outsideSource = null }: FlowDeckOptions) {
  const shown = useMemo(() => kindItems(laneItems(items, lane), kind), [items, lane, kind]);
  const [resting, setResting] = useState(false);
  const { queue, setQueue, decided: allDecided, setDecided, selected: row, select, selectedNow } = useDeckQueue(shown, lane, resting, kind);
  const decided = lane ? allDecided.filter((d) => inLane(d.item, lane)) : allDecided;
  const live = useMemo(() => new Map(items.map((i) => [idOf(i), i])), [items]);
  const rows = useMemo(() => liveRows(queue, live), [queue, live]);
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());

  const current = row ? (live.get(idOf(row)) ?? row) : undefined;
  const elsewhere = !!current && answeredElsewhere(current, shown, resting, touched);
  const actionable = () => {
    const at = selectedNow();
    const item = at ? (live.get(idOf(at)) ?? at) : undefined;
    return item && !answeredElsewhere(item, shown, resting, touched) ? item : undefined;
  };
  const actions = useDeckActions({ current, selected: actionable, queue, select, decided: allDecided, lane, setDecided, setQueue, moves, onSignIn });

  const touch = (item: AttentionItem) => {
    const id = idOf(item);
    setTouched((t) => (t.has(id) ? t : new Set(t).add(id)));
  };
  const remove = (item: AttentionItem) => {
    const id = idOf(item);
    if (current && idOf(current) === id) select(rowAfter(queue, id));
    setQueue((q) => q.filter((i) => idOf(i) !== id));
  };

  const currentId = current ? idOf(current) : null;
  const cardShown = useEffectEvent(() => {
    if (!current) return;
    onShown?.(current);
  });
  useEffect(() => {
    if (currentId) cardShown();
  }, [currentId]);

  const loadCurrent = useEffectEvent(() => {
    if (current && !current.outside) loadHistory(current);
    const idx = current ? rows.findIndex((r) => idOf(r) === idOf(current)) : -1;
    const next = idx >= 0 ? rows[idx + 1] : undefined;
    if (!next) return;
    if (next.outside) prefetchOutside(next, outsideSource);
    else loadHistory(next);
  });
  useEffect(() => loadCurrent(), [currentId]);

  return {
    shown,
    queue,
    rows,
    current,
    elsewhere,
    select,
    decided,
    resting,
    goThrough: () => setResting(true),
    actions,
    touch,
    remove,
  };
}

export type FlowDeck = ReturnType<typeof useFlowDeck>;
