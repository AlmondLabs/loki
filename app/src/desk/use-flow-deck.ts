import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import { inLane, laneItems, type ResolvedLane } from "../../../core/attention/lanes.ts";
import { kindItems, type FlowKind } from "./flow-kinds";
import { idOf, inboxQueue, type Decision } from "../../../core/attention/queue.ts";
import { rowAfter, type DeckMoveApi } from "./deck-moves";
import { prefetchOutside, type OutsideThreadSource } from "./outside-card";
import { useDeckActions } from "./use-deck-actions";
import { useDeckQueue } from "./use-deck-queue";

export type PassSummaryHandler = (pass: {
  decided: number;
  next: number;
  archive: number;
  approve: number;
  deny: number;
  replies: number;
  shown: number;
  duration_ms: number;
}) => void;

export interface VisitTally {
  decided: Decision[];
  replies: number;
  onPass?: PassSummaryHandler;
}

export function createVisit(began: number, now: () => number = Date.now) {
  const shown = new Set<string>();
  let ended = false;
  return {
    show(id: string) {
      shown.add(id);
    },
    end({ decided, replies, onPass }: VisitTally) {
      if (ended) return;
      ended = true;
      if (!onPass || (!decided.length && !replies)) return;
      const by = (via: Decision["via"]) => decided.filter((x) => x.via === via).length;
      onPass({
        decided: decided.length,
        next: by("next"),
        archive: by("archive"),
        approve: by("approve"),
        deny: by("deny"),
        replies,
        shown: shown.size,
        duration_ms: now() - began,
      });
    },
  };
}

export function endOnPageHide(page: Pick<EventTarget, "addEventListener" | "removeEventListener">, end: () => void): () => void {
  page.addEventListener("pagehide", end);
  return () => page.removeEventListener("pagehide", end);
}

export function answeredElsewhere(item: AttentionItem, items: readonly AttentionItem[], resting: boolean, touched: ReadonlySet<string>): boolean {
  const id = idOf(item);
  const now = items.find((i) => idOf(i) === id);
  if (now && inboxQueue([now], resting).length > 0) return false;
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
  onPass?: PassSummaryHandler;
  onShown?: (item: AttentionItem) => void;
  loadHistory: (item: AttentionItem) => void;
  outsideSource?: OutsideThreadSource | null;
}

export function useFlowDeck({ items, lane, kind = "all", moves, onSignIn, onPass, onShown, loadHistory, outsideSource = null }: FlowDeckOptions) {
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

  const [visit] = useState(() => createVisit(Date.now()));
  const tally = useRef<VisitTally>({ decided: allDecided, replies: actions.replies, onPass });
  useEffect(() => {
    tally.current = { decided: allDecided, replies: actions.replies, onPass };
  });
  useEffect(() => {
    const end = () => visit.end(tally.current);
    const stop = endOnPageHide(window, end);
    return () => {
      stop();
      end();
    };
  }, [visit]);

  const currentId = current ? idOf(current) : null;
  const cardShown = useEffectEvent((id: string) => {
    if (!current) return;
    visit.show(id);
    onShown?.(current);
  });
  useEffect(() => {
    if (currentId) cardShown(currentId);
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
